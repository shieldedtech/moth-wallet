#include <stdint.h>
char *mn_bench_run(const char *params_dir, uint32_t iterations, uint32_t threads);
void mn_bench_free(char *s);
int32_t mn_ksweep_run(const char *params_dir, const char *keys_dir, const char *ks, uint32_t rounds, uint32_t threads, const char *out);
