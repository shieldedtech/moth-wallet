// C ABI of libmoth_native (native/src/lib.rs). Used as Moth's bridging header.
#include <stddef.h>
#include <stdint.h>
int32_t mn_prover_start(const char *params_dir, uint16_t port, uint32_t workers);
int32_t mn_inproc_start(const char *params_dir, uint32_t workers);
int32_t mn_inproc_call(const char *method, const char *path, const uint8_t *body, size_t body_len,
                       uint8_t **out, size_t *out_len);
void mn_free(uint8_t *ptr, size_t len);
