#include "stock_codec.h"

static uint16_t crc_byte(uint16_t crc, uint8_t value)
{
    crc ^= (uint16_t)value << 8;
    for (unsigned bit = 0; bit < 8; ++bit)
        crc = (uint16_t)((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0));
    return crc;
}

/* Stock 0x0012ac74: XOR first, then CRC the transformed bytes. This is a fixed
 * XOR, not Bluetooth's channel-seeded LFSR and not encryption. */
uint16_t nape_rf_whiten_crc(uint8_t *data, size_t len)
{
    uint16_t crc = 0xffff;
    for (size_t i = 0; i < len; ++i) {
        data[i] ^= 0x9c;
        crc = crc_byte(crc, data[i]);
    }
    return crc;
}

/* Stock 0x0012ac38: CRC the received bytes before undoing the XOR. */
uint16_t nape_rf_unwhiten_crc(uint8_t *data, size_t len)
{
    uint16_t crc = 0xffff;
    for (size_t i = 0; i < len; ++i) {
        crc = crc_byte(crc, data[i]);
        data[i] ^= 0x9c;
    }
    return crc;
}

static void put16(uint8_t *out, uint16_t value)
{
    out[0] = (uint8_t)value;
    out[1] = (uint8_t)(value >> 8);
}

/* Stock 0x00126dc0, payload passed to 0x0012426c. The type byte is observed
 * as 1 even on this trackball; do not replace it with a guessed mouse enum. */
size_t nape_rf_pair_request(uint8_t out[16], uint16_t interval_us)
{
    out[0] = 1;
    put16(out + 1, interval_us);
    put16(out + 3, 1);
    put16(out + 5, 3);
    out[7] = 1;
    put16(out + 8, 0x3434);
    put16(out + 10, 0x0440);
    for (unsigned i = 12; i < 16; ++i) out[i] = 0;
    return 16;
}

size_t nape_rf_connect_request(uint8_t out[3], uint16_t interval_us)
{
    out[0] = 4;
    put16(out + 1, interval_us);
    return 3;
}

static int valid_address(uint32_t address)
{
    return address != 0 && address != UINT32_MAX;
}

size_t nape_rf_mouse_report(uint8_t out[8], uint8_t buttons, int16_t x,
                            int16_t y, int16_t wheel, int16_t pan)
{
    out[0]=0x3f;out[1]=buttons;
    put16(out+2,(uint16_t)x);put16(out+4,(uint16_t)y);
    out[6]=(uint8_t)wheel;out[7]=(uint8_t)pan;
    return 8;
}

unsigned nape_rf_select_address(const uint32_t bond[3], unsigned preference,
                                uint32_t *address)
{
    unsigned first = preference == 2 ? 2 : 0;
    unsigned second = first ^ 2;
    if (valid_address(bond[first])) {
        *address = bond[first];
        return first == 0 ? 1 : 2;
    }
    if (valid_address(bond[second])) {
        *address = bond[second];
        return second == 0 ? 1 : 2;
    }
    return 0;
}

void nape_rf_update_bond(uint32_t bond[3], unsigned secondary,
                         uint32_t address, uint8_t route)
{
    bond[secondary ? 2 : 0] = address;
    bond[1] = route;
}

size_t nape_rf_frame(uint8_t *out, size_t capacity, uint8_t sequence,
                     uint8_t route, const uint8_t *pdu, size_t pdu_len)
{
    /* Conservative bound from the public MD1R raw-buffer size, 62 bytes. */
    if (!out || !pdu || !pdu_len || pdu_len > 59 || capacity < pdu_len + 3)
        return 0;
    out[0] = (sequence & 3) | ((route & 7) << 5);
    for (size_t i = 0; i < pdu_len; ++i) out[i + 1] = pdu[i];
    uint16_t crc = nape_rf_whiten_crc(out, pdu_len + 1);
    put16(out + pdu_len + 1, crc);
    return pdu_len + 3;
}
