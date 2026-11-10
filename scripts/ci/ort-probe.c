/* Smallest program that brings ONNX Runtime up: static initialisers, the
 * C API table, and one OrtEnv. scripts/ci/check-ort-baseline.sh links it
 * against a static libonnxruntime.a and runs it under qemu with a CPU model
 * that has no AVX, so a library built for a newer x86-64 level dies with
 * SIGILL here instead of on a user's machine.
 *
 * No onnxruntime_c_api.h on purpose: only the first entries of OrtApi are
 * used, and their order is part of ONNX Runtime's stable ABI. */
#include <stdio.h>

typedef struct OrtStatus OrtStatus;
typedef struct OrtEnv OrtEnv;
typedef struct {
  OrtStatus *(*CreateStatus)(int, const char *);
  int (*GetErrorCode)(const OrtStatus *);
  const char *(*GetErrorMessage)(const OrtStatus *);
  OrtStatus *(*CreateEnv)(int, const char *, OrtEnv **);
} OrtApiHead;
typedef struct {
  const OrtApiHead *(*GetApi)(unsigned);
  const char *(*GetVersionString)(void);
} OrtApiBase;

extern const OrtApiBase *OrtGetApiBase(void);

int main(void) {
  const OrtApiBase *base = OrtGetApiBase();
  const OrtApiHead *api = base->GetApi(1);
  OrtEnv *env = NULL;
  OrtStatus *st = api->CreateEnv(3 /* ORT_LOGGING_LEVEL_ERROR */, "probe", &env);
  if (st) {
    fprintf(stderr, "CreateEnv failed: %s\n", api->GetErrorMessage(st));
    return 1;
  }
  printf("onnxruntime %s ok\n", base->GetVersionString());
  return 0;
}
