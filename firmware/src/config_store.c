/* Two independently verified slots. The ownership superblock is never changed.
 */
#include "profile_config.h"
#include "runtime.h"
#include <string.h>
#define SLOT_SIZE 0x2000u
#define SLOT0 (USER_BASE + SECTOR)
extern uint8_t *service_scratch(void);
#define staging (service_scratch())
extern struct nape_config *service_config_candidate(void);
#define candidate (*service_config_candidate())
_Static_assert(8192 + sizeof(struct nape_config) <= USER_LEN,
               "shared scratch capacity");
static uint32_t token, next, wanted_crc, generation;
static int current = -1;
static bool preview_transfer;
static uint8_t preview_profile;
uint32_t nape_config_generation(void) { return generation; }
bool nape_config_transfer_active(void) { return token != 0; }
static uint32_t rd(const uint8_t *p) {
  return p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
         ((uint32_t)p[3] << 24);
}
static void wr(uint8_t *p, uint32_t n) {
  for (unsigned i = 0; i < 4; i++)
    p[i] = n >> (i * 8);
}
void nape_config_reset_transfer(void) { token = next = 0; }
static bool read_slot(unsigned slot, uint32_t *gen) {
  uint32_t base = SLOT0 + slot * SLOT_SIZE;
  uint8_t h[32];
  if (!board_read(base, h, 32) || memcmp(h, "NPCOM001", 8) ||
      rd(h + 12) != NAPE_CONFIG_SIZE || rd(h + 20) != nape_crc32(h + 8, 12) ||
      !board_read(base + 32, staging, NAPE_CONFIG_SIZE) ||
      rd(h + 16) != nape_crc32(staging, NAPE_CONFIG_SIZE) ||
      !nape_config_decode(&candidate, staging, NAPE_CONFIG_SIZE))
    return false;
  *gen = rd(h + 8);
  return true;
}
bool nape_config_load(struct nape_config *out) {
  current = -1;
  generation = 0;
  nape_config_default(out);
  if (service_storage_state() != OWNED)
    return false;
  for (unsigned slot = 0; slot < 2; slot++) {
    uint32_t g;
    if (read_slot(slot, &g) && (current < 0 || (int32_t)(g - generation) > 0)) {
      current = slot;
      generation = g;
    }
  }
  if (current >= 0) {
    uint32_t g;
    if (!read_slot(current, &g))
      return false;
    *out = candidate;
  }
  return current >= 0;
}
int nape_config_command(const struct packet *p, struct packet *r) {
  if (p->op == 0x30) {
    if (p->len || p->offset)
      return BAD_PACKET;
    nape_runtime_status(r->data);
    wr(r->data + 32, NAPE_CONFIG_SIZE);
    wr(r->data + 36, generation);
    r->len = 48;
    return OK;
  }
  if (service_storage_state() != OWNED || nape_runtime_is_recovery())
    return BAD_STATE;
  if (p->op == 0x31) {
    if (p->len != 1 || !p->data[0] || p->data[0] > 48 ||
        p->offset >= NAPE_CONFIG_SIZE ||
        p->data[0] > NAPE_CONFIG_SIZE - p->offset || token)
      return BAD_PACKET;
    if (current < 0) {
      nape_config_default(&candidate);
      nape_config_encode(staging, &candidate);
    } else if (!board_read(SLOT0 + current * SLOT_SIZE + 32, staging,
                           NAPE_CONFIG_SIZE))
      return IO_ERROR;
    memcpy(r->data, staging + p->offset, p->data[0]);
    r->len = p->data[0];
    return OK;
  }
  if (p->op == 0x32 || p->op == 0x36) {
    if (p->offset != NAPE_CONFIG_SIZE ||
        (p->len != 4 && !(p->op == 0x36 && p->len == 5)))
      return BAD_PACKET;
    preview_transfer = p->op == 0x36;
    preview_profile = p->len == 5 ? p->data[4] : 255;
    if (preview_profile != 255 && preview_profile >= NAPE_PROFILES)
      return BAD_PACKET;
    if (!preview_transfer)
      nape_runtime_pause();
#ifdef CONFIG_REALTEK_PPT
    extern bool radio_probe_busy(void);
    if (!preview_transfer && radio_probe_busy())
      return BAD_STATE;
#endif
    token = p->session;
    next = 0;
    wanted_crc = rd(p->data);
    return OK;
  }
  if (p->op == 0x35) {
    if (p->len || p->offset)
      return BAD_PACKET;
    nape_config_reset_transfer();
    nape_config_load(&candidate);
    nape_runtime_apply(&candidate);
    return OK;
  }
  if (p->op == 0x38) {
    if (p->len || p->offset)
      return BAD_PACKET;
    nape_config_reset_transfer();
    nape_config_load(&candidate);
    nape_runtime_preview(&candidate, false, 255);
    return OK;
  }
  if (!token || token != p->session)
    return BAD_STATE;
  if (p->op == 0x33) {
    if (!p->len || p->offset != next || p->len > NAPE_CONFIG_SIZE - next)
      return BAD_POSITION;
    memcpy(staging + next, p->data, p->len);
    next += p->len;
    return OK;
  }
  if (p->op != (preview_transfer ? 0x37 : 0x34) || p->len || p->offset)
    return BAD_PACKET;
  if (next != NAPE_CONFIG_SIZE || nape_crc32(staging, next) != wanted_crc)
    return WRONG_DIGEST;
  if (!nape_config_decode(&candidate, staging, next))
    return BAD_PACKET;
  if (preview_transfer) {
    nape_runtime_preview(&candidate, true, preview_profile);
    wr(r->data, wanted_crc);
    r->len = 4;
    nape_config_reset_transfer();
    return OK;
  }
  unsigned slot = current == 0 ? 1 : 0;
  uint32_t base = SLOT0 + slot * SLOT_SIZE;
  uint8_t h[32] = {0};
  memcpy(h, "NPCOM001", 8);
  wr(h + 8, generation + 1);
  wr(h + 12, NAPE_CONFIG_SIZE);
  wr(h + 16, wanted_crc);
  wr(h + 20, nape_crc32(h + 8, 12));
  for (unsigned off = 0; off < SLOT_SIZE; off += SECTOR)
    if (!board_erase(base + off))
      return IO_ERROR;
  if (!board_write(base + 32, staging, next) ||
      !board_write(base + 8, h + 8, 24) || !board_write(base, h, 8))
    return IO_ERROR;
  uint32_t g;
  if (!read_slot(slot, &g))
    return IO_ERROR;
  current = slot;
  generation = g;
  nape_config_reset_transfer();
  nape_runtime_apply(&candidate);
  return OK;
}
