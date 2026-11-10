#!/usr/bin/env bash
# Builds the ONNX Runtime the x86_64 Linux release links, at the plain x86-64
# baseline, so the app starts on CPUs without AVX.
#
# Why this exists: ort-sys downloads pyke's prebuilt ONNX Runtime, and pyke
# compiles every x86_64 build with -march=x86-64-v3 and
# onnxruntime_USE_AVX2=ON (src/build.ts in pykeio/ort-artifacts). That puts
# AVX2 in ordinary code, protobuf's static initialisers included, so the
# executable dies with SIGILL before main() on a CPU like the Pentium Silver
# N5030 (Gemini Lake: SSE4.2, no AVX). pyke's Dawn library is built the same
# way.
#
# This runs pyke's own build tool at the commit that produced the 1.28.0
# archives ort-sys 2.0.0-rc.13 pins, with those two flags removed and nothing
# else changed: same ONNX Runtime source, same patches, same clang, same
# WebGPU options, same single-file static library. MLAS still compiles its
# AVX2 and AVX-512 kernels in their own files and picks one at run time from
# CPUID, so newer CPUs keep the fast matrix kernels.
#
# Output: <out-dir>/libonnxruntime.a and <out-dir>/libwebgpu_dawn.so, the same
# two files as pyke's x86_64-unknown-linux-gnu+webgpu archive. Point
# ORT_LIB_PATH at <out-dir> for the cargo build; src-tauri/build.rs then links
# and stages Dawn from there.
#
# Needs on PATH: git, deno 2, cmake >= 3.26, ninja, clang-21 and clang++-21
# (the pyke tool hard-codes those names on Linux). The composite action
# .github/actions/onnxruntime-baseline installs them.
#
# Usage: scripts/ci/build-onnxruntime-baseline.sh <out-dir>
set -euo pipefail

OUT=${1:?usage: build-onnxruntime-baseline.sh <out-dir>}

# Bump all three together when ort-sys moves to a new ONNX Runtime. The ORT
# commit is the v1.28.0 tag; the pyke commit is the one whose build produced
# the ms@1.28.0 archives (2026-07-25).
ORT_VERSION=1.28.0
ORT_COMMIT=da9b5e364c465de65c49d91e696cd6485270757f
PYKE_COMMIT=25d68de62d14300838a44c104261e0a773d44f8d

WORK=${ORT_WORK_DIR:-${RUNNER_TEMP:-/tmp}/ort-baseline-work}
rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK"

echo "::group::Fetch pyke ort-artifacts at $PYKE_COMMIT"
git init -q ort-artifacts
git -C ort-artifacts fetch -q --depth 1 https://github.com/pykeio/ort-artifacts "$PYKE_COMMIT"
git -C ort-artifacts checkout -q FETCH_HEAD
echo "::endgroup::"

# The pyke tool clones branch rel-<version> itself unless ./onnxruntime is
# already on a branch of that name. Clone the release tag instead, so the
# source is exactly the tagged commit, and name the branch the tool expects.
echo "::group::Fetch ONNX Runtime v$ORT_VERSION"
git clone -q --depth 1 --branch "v$ORT_VERSION" --recurse-submodules --shallow-submodules \
  https://github.com/microsoft/onnxruntime ort-artifacts/onnxruntime
got=$(git -C ort-artifacts/onnxruntime rev-parse HEAD)
if [ "$got" != "$ORT_COMMIT" ]; then
  echo "v$ORT_VERSION is $got, expected $ORT_COMMIT" >&2
  exit 1
fi
git -C ort-artifacts/onnxruntime switch -q -c "rel-$ORT_VERSION"
echo "::endgroup::"

# Drop the AVX2 flags. Each line must be there exactly once before and gone
# after: a pyke commit that moved or renamed them must fail here, not ship a
# library that still needs AVX.
BUILD_TS=ort-artifacts/src/build.ts
for line in "args.push('-Donnxruntime_USE_AVX2=ON');" "compilerFlags.push('-march=x86-64-v3');"; do
  n=$(grep -cF "$line" "$BUILD_TS" || true)
  if [ "$n" != 1 ]; then
    echo "expected one '$line' in $BUILD_TS, found $n" >&2
    exit 1
  fi
  grep -vF "$line" "$BUILD_TS" > "$BUILD_TS.new"
  mv "$BUILD_TS.new" "$BUILD_TS"
done
if grep -nE 'AVX2|x86-64-v' "$BUILD_TS"; then
  echo "$BUILD_TS still asks for AVX2 above" >&2
  exit 1
fi

echo "::group::Build ONNX Runtime (static, WebGPU)"
(cd ort-artifacts && deno run -A src/build.ts -v "$ORT_VERSION" -s --webgpu -N)
echo "::endgroup::"

mkdir -p "$OUT"
for f in libonnxruntime.a libwebgpu_dawn.so; do
  cp "ort-artifacts/artifact/onnxruntime/lib/$f" "$OUT/$f"
done
ls -la "$OUT"
