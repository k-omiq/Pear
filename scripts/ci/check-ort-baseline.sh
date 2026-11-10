#!/usr/bin/env bash
# Proves an x86_64 ONNX Runtime build starts on a CPU without AVX.
#
# Links scripts/ci/ort-probe.c against <lib-dir>/libonnxruntime.a (and Dawn,
# when the directory has it) and runs the probe twice under qemu user mode:
# once as Nehalem (SSE4.2, no AVX - the class of the Pentium Silver N5030 that
# reported the crash) and once as Haswell (AVX2) as a control. qemu raises
# SIGILL for an AVX instruction on a CPU model without it, exactly like the
# real chip. pyke's stock 1.28.0 library fails the Nehalem run in
# google::protobuf::internal::OnShutdownRun, before main().
#
# Needs: gcc, g++, qemu-user (qemu-x86_64). On a non-x86 host, set CC and CXX
# to x86_64 cross compilers and QEMU_LD_PREFIX to their sysroot.
#
# Usage: scripts/ci/check-ort-baseline.sh <lib-dir>
set -euo pipefail

LIB=$(cd "${1:?usage: check-ort-baseline.sh <lib-dir>}" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

dawn=()
if [ -f "$LIB/libwebgpu_dawn.so" ]; then
  dawn=(-L"$LIB" -Wl,--push-state,--no-as-needed -lwebgpu_dawn -Wl,--pop-state -Wl,-rpath,"$LIB")
fi
"${CC:-gcc}" -c "$HERE/ort-probe.c" -o "$TMP/probe.o"
"${CXX:-g++}" "$TMP/probe.o" "$LIB/libonnxruntime.a" "${dawn[@]}" -lpthread -ldl -o "$TMP/probe"

for cpu in Haswell Nehalem; do
  echo "== probe as $cpu"
  qemu-x86_64 -cpu "$cpu" "$TMP/probe"
done
