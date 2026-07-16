#include <stddef.h>
#include <stdint.h>

#include "playfair.h"

enum {
    KEY_MESSAGE_BYTES = 164,
    ENCRYPTED_KEY_BYTES = 72,
    CLEAR_KEY_BYTES = 16,
};

static unsigned char io_buffer[KEY_MESSAGE_BYTES + ENCRYPTED_KEY_BYTES + CLEAR_KEY_BYTES];

/* Keep the freestanding build independent of a WASI/libc runtime. */
void *memcpy(void *destination, const void *source, size_t length)
{
    unsigned char *out = destination;
    const unsigned char *in = source;
    for (size_t i = 0; i < length; i++) {
        out[i] = in[i];
    }
    return destination;
}

__attribute__((export_name("playfair_io_ptr")))
uint32_t playfair_io_ptr(void)
{
    return (uint32_t)(uintptr_t)io_buffer;
}

__attribute__((export_name("playfair_decrypt_io")))
void playfair_decrypt_io(void)
{
    playfair_decrypt(
        io_buffer,
        io_buffer + KEY_MESSAGE_BYTES,
        io_buffer + KEY_MESSAGE_BYTES + ENCRYPTED_KEY_BYTES
    );
}
