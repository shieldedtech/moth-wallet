// C ABI of libmoth_native (native/src/lib.rs). Used as Moth's bridging header.
#include <stdint.h>
int32_t mn_prover_start(const char *params_dir, uint16_t port, uint32_t workers);
int32_t mn_static_start(const char *dir, uint16_t port);
