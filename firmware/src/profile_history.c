/* Last-used profile journal, separate from configuration slots. A new record
 * occupies 16 bytes; alternate sectors are erased only when the current one is
 * full. A torn write/erase leaves the previous committed record available. */
#include "profile_config.h"
#include <string.h>
#define HISTORY_BASE (USER_BASE + 5u * SECTOR)
#define RECORD_SIZE 16u
#define RECORDS_PER_SECTOR (SECTOR / RECORD_SIZE)
static int tail = -1;
static uint32_t sequence, saved_generation;
static uint8_t saved_profile = 255;
static bool scanned;
static uint32_t get32(const uint8_t *p) {
  return p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 |
         (uint32_t)p[3] << 24;
}
static void put32(uint8_t *p, uint32_t v) {
  for (unsigned i = 0; i < 4; i++)
    p[i] = v >> (8 * i);
}
static bool blank(const uint8_t *p) {
  for (unsigned i = 0; i < RECORD_SIZE; i++)
    if (p[i] != 255)
      return false;
  return true;
}
int nape_profile_history_load(uint32_t generation) {
  int profile = -1;
  uint32_t matching_sequence = 0;
  scanned = false;
  tail = -1;
  sequence = 0;
  saved_profile = 255;
  for (unsigned i = 0; i < 2 * RECORDS_PER_SECTOR; i++) {
    uint8_t r[RECORD_SIZE];
    if (!board_read(HISTORY_BASE + i * RECORD_SIZE, r, sizeof(r)))
      return -1;
    if (r[8] >= NAPE_PROFILES || memcmp(r + 9, "PR2", 3) ||
        get32(r + 12) != nape_crc32(r, 12))
      continue;
    uint32_t seq = get32(r), gen = get32(r + 4);
    if (tail < 0 || (int32_t)(seq - sequence) > 0) {
      tail = i;
      sequence = seq;
      saved_generation = gen;
      saved_profile = r[8];
    }
    if (gen == generation &&
        (profile < 0 || (int32_t)(seq - matching_sequence) > 0)) {
      profile = r[8];
      matching_sequence = seq;
    }
  }
  scanned = true;
  return profile;
}
bool nape_profile_history_save(uint8_t profile, uint32_t generation) {
  if (profile >= NAPE_PROFILES || service_storage_state() != OWNED)
    return false;
  if (!scanned)
    nape_profile_history_load(generation);
  if (!scanned)
    return false;
  if (tail >= 0 && saved_generation == generation && saved_profile == profile)
    return true;
  unsigned sector = tail < 0 ? 0 : (unsigned)tail / RECORDS_PER_SECTOR;
  unsigned slot = tail < 0 ? 0 : (unsigned)tail + 1;
  uint8_t r[RECORD_SIZE];
  for (; slot < (sector + 1) * RECORDS_PER_SECTOR; slot++) {
    if (!board_read(HISTORY_BASE + slot * RECORD_SIZE, r, sizeof(r)))
      return false;
    if (blank(r))
      break;
  }
  if (slot == (sector + 1) * RECORDS_PER_SECTOR) {
    sector = 1 - sector;
    slot = sector * RECORDS_PER_SECTOR;
    if (!board_erase(HISTORY_BASE + sector * SECTOR))
      return false;
  }
  put32(r, sequence + 1);
  put32(r + 4, generation);
  r[8] = profile;
  memcpy(r + 9, "PR2", 3);
  put32(r + 12, nape_crc32(r, 12));
  uint32_t address = HISTORY_BASE + slot * RECORD_SIZE;
  uint8_t check[RECORD_SIZE];
  if (!board_write(address, r, 12) || !board_write(address + 12, r + 12, 4) ||
      !board_read(address, check, sizeof(check)) || memcmp(r, check, sizeof(r)))
    return false;
  tail = slot;
  sequence++;
  saved_generation = generation;
  saved_profile = profile;
  return true;
}
