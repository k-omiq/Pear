#!/usr/bin/env bash
# Builds the Linux AppImage from the .deb that `tauri build --bundles deb`
# produced, and signs it for the updater when a signing key is in the
# environment.
#
# Why not Tauri's own AppImage? Its linuxdeploy step bundles the whole desktop
# stack (GTK, GLib, WebKitGTK and its JavaScriptCore, ICU, GStreamer) from the
# build host. WebKitGTK then spawns its helper processes (WebKitWebProcess,
# WebKitNetworkProcess) from the path compiled into the library, which is the
# host's, and a release build of WebKit ignores WEBKIT_EXEC_PATH. So the UI
# process ran the bundled WebKit while the helpers ran whatever the host had,
# and on any distro but the build host's the two disagreed: blank window on
# Debian, Fedora, Arch, and a hard failure on hosts whose helpers live under
# another path (/usr/libexec, /usr/lib/webkit2gtk-4.1). Mixing a host WebKit
# with bundled GTK/GLib is no better, the symbol versions drift the other way.
#
# This AppImage bundles nothing from the desktop stack. The app links the
# host's GTK and WebKitGTK 4.1 exactly like the .deb does, so UI process,
# helpers and injected bundle are always one version, on every distro. The
# price is that the host must have webkit2gtk-4.1 installed; AppRun checks
# for it and prints the install command when it is missing. Likewise the
# host's glibc and libstdc++ must be at least as new as the binaries need;
# AppRun says so in words instead of a loader error, and the build fails when
# the .deb's Depends would let apt install it somewhere it cannot run.
#
# Usage: scripts/build-appimage.sh <app.deb> <out.AppImage>
# Needs: dpkg-deb, readelf (binutils), file, desktop-file-utils, and a
#        Debian/Ubuntu build host (its dpkg symbols files map glibc/libstdc++
#        symbol versions to package versions).
# Env:   TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD) -> also writes <out>.sig
#        APPIMAGETOOL: path to an appimagetool binary (downloaded when unset)
set -euo pipefail

DEB=${1:?deb path}
OUT=${2:?output AppImage path}
OUT=$(realpath -m "$OUT")

# Pinned so a build is reproducible; bump on purpose.
APPIMAGETOOL_VERSION=1.9.0
ARCH=$(uname -m)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
APPDIR="$WORK/AppDir"

dpkg-deb -x "$DEB" "$APPDIR"

# The deb ships one desktop entry and hicolor icons; appimagetool wants the
# entry and a same-named icon at the AppDir root.
DESKTOP=$(ls "$APPDIR"/usr/share/applications/*.desktop | head -1)
ICON_NAME=$(sed -n 's/^Icon=//p' "$DESKTOP" | head -1)
cp "$DESKTOP" "$APPDIR/"
ICON=$(ls -S "$APPDIR"/usr/share/icons/hicolor/*/apps/"$ICON_NAME".png | head -1)
cp "$ICON" "$APPDIR/$ICON_NAME.png"
ln -sf "$ICON_NAME.png" "$APPDIR/.DirIcon"

BIN=$(sed -n 's/^Exec=//p' "$DESKTOP" | head -1 | cut -d' ' -f1)

# --- glibc / libstdc++ floor -------------------------------------------------
# Neither this AppImage nor the .deb carries libc or libstdc++, so the host
# must have at least the newest symbol versions any ELF file in the package
# asks for (pyke's ONNX Runtime and Dawn pull x86_64 up to GLIBC_2.39 and
# GLIBCXX_3.4.32; see the release.yml matrix). Read them from the built files
# rather than trusting a number in a config.
VERSIONS=$(find "$APPDIR/usr" -type f -exec readelf -V --wide {} + 2>/dev/null || true)
NEED_GLIBC=$(printf '%s\n' "$VERSIONS" | grep -o 'GLIBC_[0-9][0-9.]*[0-9]' | sed 's/^GLIBC_//' | sort -uV | tail -1)
NEED_GLIBCXX=$(printf '%s\n' "$VERSIONS" | grep -o 'GLIBCXX_[0-9][0-9.]*[0-9]' | sed 's/^GLIBCXX_//' | sort -uV | tail -1)
[ -n "$NEED_GLIBC" ] || { echo "build-appimage: found no GLIBC_ version needs in $DEB (is readelf installed?)" >&2; exit 1; }

# The Debian package version that first shipped a symbol version node, from
# the build host's dpkg symbols files (the data dpkg-shlibdeps uses).
first_shipped() { # <package> <version node>
  awk -v n="$2@$2" '$1 == n { print $2; exit }' \
    "/var/lib/dpkg/info/$1:$(dpkg --print-architecture).symbols" 2>/dev/null
}
# The ">=" version a Depends field gives a package, empty when it gives none.
declared() { # <package>
  dpkg-deb -f "$DEB" Depends | tr ',' '\n' | sed -n "s/^ *$1 *(>= *\([^) ]*\) *).*/\1/p" | head -1
}
# Fail the build when the .deb lets apt install it on a system it cannot run
# on: bundle.linux.deb.depends in src-tauri/tauri.linux.conf.json must cover
# what the binaries need, on every architecture that builds it.
check_floor() { # <package> <version node>
  local need have
  need=$(first_shipped "$1" "$2")
  [ -n "$need" ] || { echo "build-appimage: no $1 symbols entry for $2 on this build host" >&2; exit 1; }
  have=$(declared "$1")
  if [ -z "$have" ] || dpkg --compare-versions "$have" lt "$need"; then
    echo "build-appimage: the binaries need $2, so the .deb must depend on '$1 (>= $need)';" \
      "its Depends is '$(dpkg-deb -f "$DEB" Depends)'. Raise it in src-tauri/tauri.linux.conf.json." >&2
    exit 1
  fi
  echo "floor ok: $2 -> $1 (>= $need), deb declares (>= $have)" >&2
  FLOOR_VERSION=$need
}
check_floor libc6 "GLIBC_$NEED_GLIBC"
GCC_FLOOR=""
if [ -n "$NEED_GLIBCXX" ]; then check_floor libstdc++6 "GLIBCXX_$NEED_GLIBCXX"; GCC_FLOOR=$FLOOR_VERSION; fi

# Oldest release of a few big distributions whose glibc is new enough, for
# AppRun's too-old message. glibc per release: Ubuntu 22.04 2.35, 24.04 2.39,
# 24.10 2.40, 25.04 2.41, 25.10 2.42; Debian 12 2.36, 13 2.41; Fedora 38 2.37,
# 39 2.38, 40 2.39, 41 2.40, 42 2.41, 43 2.42.
NEWER=""
for family in "Ubuntu 22.04:2.35 24.04:2.39 24.10:2.40 25.04:2.41 25.10:2.42" \
              "Debian 12:2.36 13:2.41" \
              "Fedora 38:2.37 39:2.38 40:2.39 41:2.40 42:2.41 43:2.42"; do
  for release in ${family#* }; do
    if dpkg --compare-versions "${release#*:}" ge "$NEED_GLIBC"; then
      NEWER="$NEWER${NEWER:+, }${family%% *} ${release%%:*}"
      break
    fi
  done
done
[ -z "$NEWER" ] || NEWER="$NEWER and later releases are new enough."

# AppRun. Quoted heredoc so nothing in it expands now; the @...@ placeholders
# are filled in below.
cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/sh
# Runs the app against the host's glibc, libstdc++, GTK and WebKitGTK; see
# scripts/build-appimage.sh, which wrote this file and the floors below.
HERE=$(dirname "$(readlink -f "$0")")
NEED_GLIBC=@NEED_GLIBC@
NEED_GLIBCXX=@NEED_GLIBCXX@

fail() {
  echo "$1" >&2
  if command -v zenity >/dev/null 2>&1; then zenity --error --no-wrap --text="$1" 2>/dev/null; fi
  exit 1
}

# version_lt A B: true when dotted version A is older than B.
version_lt() {
  a=$1. b=$2.
  while [ -n "$a$b" ]; do
    x=${a%%.*} y=${b%%.*}
    a=${a#*.} b=${b#*.}
    [ "${x:-0}" -lt "${y:-0}" ] && return 0
    [ "${x:-0}" -gt "${y:-0}" ] && return 1
  done
  return 1
}

# find_lib NAME: print where the dynamic loader would find NAME. The ld.so
# cache first, by absolute path: ldconfig lives in /sbin or /usr/sbin, which a
# normal user's PATH often lacks (Debian). Then LD_LIBRARY_PATH and the usual
# library directories, multiarch ones included, for systems without a cache.
find_lib() {
  for ldc in /sbin/ldconfig /usr/sbin/ldconfig /usr/bin/ldconfig /bin/ldconfig $(command -v ldconfig 2>/dev/null); do
    [ -x "$ldc" ] || continue
    p=$("$ldc" -p 2>/dev/null | sed -n "s|^[[:space:]]*$1 (.*) => ||p" | head -1)
    [ -n "$p" ] && [ -e "$p" ] && { echo "$p"; return 0; }
  done
  old_ifs=$IFS; IFS=:
  for d in $LD_LIBRARY_PATH; do
    [ -n "$d" ] && [ -e "$d/$1" ] && { IFS=$old_ifs; echo "$d/$1"; return 0; }
  done
  IFS=$old_ifs
  for d in /lib64 /usr/lib64 /lib /usr/lib /usr/local/lib /lib/*-linux-gnu* /usr/lib/*-linux-gnu*; do
    [ -e "$d/$1" ] && { echo "$d/$1"; return 0; }
  done
  return 1
}

TOO_OLD="This version of Pear needs a newer Linux than this one."
NEWER="@NEWER@"

HAVE_GLIBC=$(getconf GNU_LIBC_VERSION 2>/dev/null | sed -n 's/^glibc //p')
[ -n "$HAVE_GLIBC" ] || HAVE_GLIBC=$(ldd --version 2>/dev/null | sed -n '1s/.* \([0-9][0-9.]*\)$/\1/p')
case $HAVE_GLIBC in
  '' | *[!0-9.]*) ;; # not glibc, or cannot tell: let the loader speak
  *) if version_lt "$HAVE_GLIBC" "$NEED_GLIBC"; then
       fail "$TOO_OLD

It needs the GNU C library (glibc) $NEED_GLIBC or newer; this system has $HAVE_GLIBC.
$NEWER"
     fi ;;
esac

if [ -n "$NEED_GLIBCXX" ] && LIBSTDCXX=$(find_lib libstdc++.so.6) &&
   ! grep -q -F "GLIBCXX_$NEED_GLIBCXX" "$LIBSTDCXX" 2>/dev/null; then
  fail "$TOO_OLD

It needs the GNU C++ library (libstdc++) from GCC @GCC_FLOOR@ or newer
(GLIBCXX_$NEED_GLIBCXX); $LIBSTDCXX is older.
$NEWER"
fi

if ! find_lib libwebkit2gtk-4.1.so.0 >/dev/null; then
  fail "Pear needs WebKitGTK 4.1 from your distribution.

Install it and run the AppImage again:
  Debian / Ubuntu / Mint:  sudo apt install libwebkit2gtk-4.1-0
  Fedora:                  sudo dnf install webkit2gtk4.1
  Arch / Manjaro:          sudo pacman -S webkit2gtk-4.1
  openSUSE:                sudo zypper install libwebkit2gtk-4_1-0"
fi

exec "$HERE/usr/bin/@BIN@" "$@"
EOF
sed -i.bak \
  -e "s|@NEED_GLIBC@|$NEED_GLIBC|" \
  -e "s|@NEED_GLIBCXX@|$NEED_GLIBCXX|" \
  -e "s|@GCC_FLOOR@|${GCC_FLOOR:-13}|" \
  -e "s|@NEWER@|$NEWER|" \
  -e "s|@BIN@|$BIN|" \
  "$APPDIR/AppRun"
rm -f "$APPDIR/AppRun.bak"
chmod +x "$APPDIR/AppRun"

if [ -z "${APPIMAGETOOL:-}" ]; then
  CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/appimagetool"
  APPIMAGETOOL="$CACHE/appimagetool-$APPIMAGETOOL_VERSION-$ARCH.AppImage"
  if [ ! -x "$APPIMAGETOOL" ]; then
    mkdir -p "$CACHE"
    curl -fsSL -o "$APPIMAGETOOL" \
      "https://github.com/AppImage/appimagetool/releases/download/$APPIMAGETOOL_VERSION/appimagetool-$ARCH.AppImage"
    chmod +x "$APPIMAGETOOL"
  fi
fi

mkdir -p "$(dirname "$OUT")"
# --no-appstream: no metainfo shipped. Extract-and-run: CI runners have no FUSE.
APPIMAGE_EXTRACT_AND_RUN=1 ARCH="$ARCH" "$APPIMAGETOOL" --no-appstream "$APPDIR" "$OUT"

if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  # Reads TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  # from the environment; writes <out>.sig, which latest.json publishes.
  npx tauri signer sign "$OUT"
fi
ls -la "$OUT"*
