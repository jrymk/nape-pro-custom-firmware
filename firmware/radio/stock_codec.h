#ifndef NAPE_STOCK_RADIO_CODEC_H
#define NAPE_STOCK_RADIO_CODEC_H
#include <stddef.h>
#include <stdint.h>

/* Reconstructed from Nape Pro 1.3.3; these are packet helpers, not a radio
 * scheduler. No MMIO, flash, Zephyr, or vendor binary dependencies. */
uint16_t nape_rf_whiten_crc(uint8_t *data, size_t len);
uint16_t nape_rf_unwhiten_crc(uint8_t *data, size_t len);
size_t nape_rf_pair_request(uint8_t out[16], uint16_t interval_us);
size_t nape_rf_connect_request(uint8_t out[3], uint16_t interval_us);
/* Stock 0x123b90 mouse PDU. Wheel fields retain their low eight bits. */
size_t nape_rf_mouse_report(uint8_t out[8], uint8_t buttons, int16_t x,
                            int16_t y, int16_t wheel, int16_t pan);
/* Returns selected slot 1/2, or 0 if both addresses are invalid. The middle
 * bond word is intentionally unused here, as in the stock selection wrapper. */
unsigned nape_rf_select_address(const uint32_t bond[3], unsigned preference,
                                uint32_t *address);
/* Stock paired-event merge, reconstructed separately from flash persistence. */
void nape_rf_update_bond(uint32_t bond[3], unsigned secondary,
                         uint32_t address, uint8_t route);
/* Emits the software portion of a control packet (no hardware length/preamble).
 * Returns zero for invalid arguments or insufficient capacity. */
size_t nape_rf_frame(uint8_t *out, size_t capacity, uint8_t sequence,
                     uint8_t route, const uint8_t *pdu, size_t pdu_len);
#endif
