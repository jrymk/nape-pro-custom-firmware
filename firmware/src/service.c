#include "service.h"
#include <string.h>
#include <tinycrypt/sha256.h>
#ifdef NAPE_MAIN
#include "profile_config.h"
void nape_config_reset_transfer(void);
#endif
#ifdef CONFIG_REALTEK_PPT
int radio_probe_request(const struct packet *p, struct packet *r);
bool radio_probe_busy(void);
#endif

bool supported_layout(bool bank_switch, uint32_t app_address,
                      uint32_t app_length, uint32_t ota_address,
                      uint32_t ota_length, uint32_t ftl_address) {
  /* The retail config gives OTA 16 KiB more than the stock app can use
   * without overwriting its own Zephyr settings. Always enforce OTA_LEN. */
  bool public_map = ota_length == OTA_LEN && ftl_address == 0x040f5000;
  bool retail_map = ota_length == 0x5d000 && ftl_address == 0x040f9000;
  return !bank_switch && app_address == 0x0402d000 && app_length == 0x5d000 &&
         ota_address == 0x04000000 + OTA_BASE && (public_map || retail_map);
}

/* Journal seal and phase are separate NOR writes. Each phase transition clears
 * one bit. */
struct journal {
  uint8_t seal[8], original[32], check[32], phase;
};
static const uint8_t seal[8] = {'N', 'P', 'J', 'R', 'N', 'L', '0', '1'};
static const uint8_t stock_sha[32] = {
    0x2a, 0x88, 0x38, 0xe9, 0x3e, 0xba, 0xd2, 0x4f, 0x34, 0x66, 0x3c,
    0x62, 0x03, 0xad, 0xf7, 0x01, 0x24, 0x42, 0x70, 0x44, 0x1c, 0x44,
    0x61, 0x8e, 0x13, 0xde, 0x7e, 0xd5, 0xd0, 0x83, 0xcc, 0x89};
static const uint8_t rom_id[16] = {0xeb, 0xfc, 0x0a, 0xb8, 0xef, 0x26,
                                   0xee, 0x11, 0xab, 0x0f, 0x2f, 0x10,
                                   0xef, 0x11, 0xd4, 0x3d};
static const uint8_t custom_magic[8] = {'N', 'P', 'S', 'T', 'O', 'R', '0', '1'};
/* No writes take place during reset or state discovery. */
enum transfer { IDLE, BACKUP, RESTORE, VERIFIED_RESTORE, UPDATE, CHECKED };
static struct {
  enum transfer kind;
  uint32_t token, next, size;
  bool stock, snapshot_done, restore_override;
  uint8_t digest[32];
} tx;
bool service_idle(void) {
  return tx.kind == IDLE || (tx.kind == BACKUP && tx.snapshot_done);
}
static union {
  uint8_t restore[USER_LEN];
#ifdef NAPE_MAIN
  struct {
    uint8_t wire[8192];
    struct nape_config decoded;
  } config;
#endif
  struct {
    uint8_t first[SECTOR], page[SECTOR];
  } fw;
} buf;
static uint8_t io[256];
#ifdef NAPE_MAIN
uint8_t *service_scratch(void) { return buf.restore; }
struct nape_config *service_config_candidate(void) {
  return &buf.config.decoded;
}
#endif

void service_reset(void) {
  memset(&tx, 0, sizeof(tx));
#ifdef NAPE_MAIN
  nape_config_reset_transfer();
#endif
}

static uint32_t get32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
         ((uint32_t)p[3] << 24);
}
static void sha(const void *p, size_t len, uint8_t out[32]) {
  struct tc_sha256_state_struct ctx;
  tc_sha256_init(&ctx);
  tc_sha256_update(&ctx, p, len);
  tc_sha256_final(out, &ctx);
}
static bool hash_flash(uint32_t addr, uint32_t len, uint8_t out[32]) {
  struct tc_sha256_state_struct ctx;
  tc_sha256_init(&ctx);
  while (len) {
    size_t n = len < sizeof(io) ? len : sizeof(io);
    if (!board_read(addr, io, n))
      return false;
    tc_sha256_update(&ctx, io, n);
    addr += n;
    len -= n;
  }
  tc_sha256_final(out, &ctx);
  return true;
}
static bool blank(uint32_t addr, size_t len) {
  while (len) {
    size_t n = len < sizeof(io) ? len : sizeof(io);
    if (!board_read(addr, io, n))
      return false;
    for (size_t i = 0; i < n; i++)
      if (io[i] != 0xff)
        return false;
    addr += n;
    len -= n;
  }
  return true;
}
static void make_journal(struct journal *j, const uint8_t digest[32]) {
  memcpy(j->seal, seal, 8);
  memcpy(j->original, digest, 32);
  sha(j, 40, j->check);
  j->phase = 0xff;
}
/* First custom sector: format signature, little-endian schema version, sector
 * count, stock snapshot SHA-256, then SHA-256 of the preceding 48 bytes. */
static void superblock(uint8_t out[80], const uint8_t original[32]) {
  memset(out, 0, 80);
  memcpy(out, custom_magic, 8);
  out[8] = 1;
  out[12] = 10;
  memcpy(out + 16, original, 32);
  sha(out, 48, out + 48);
}
static bool valid_journal(const struct journal *j) {
  uint8_t check[32];
  sha(j, 40, check);
  return !memcmp(j->seal, seal, 8) && !memcmp(j->check, check, 32);
}
static bool possible_torn_write(const struct journal *old,
                                const struct journal *wanted) {
  const uint8_t *a = (const uint8_t *)old, *b = (const uint8_t *)wanted;
  for (size_t i = 0; i < sizeof(*old); i++)
    if ((a[i] & b[i]) != b[i])
      return false;
  return blank(JOURNAL + sizeof(*old), SECTOR - sizeof(*old));
}
static bool custom_header(uint8_t original[32]) {
  uint8_t actual[80], expected[80];
  if (!board_read(USER_BASE, actual, sizeof(actual)) ||
      memcmp(actual, custom_magic, 8))
    return false;
  superblock(expected, actual + 16);
  if (memcmp(actual, expected, sizeof(actual)))
    return false;
  memcpy(original, actual + 16, 32);
  return true;
}
static bool install_journal(const struct journal *wanted) {
  const uint8_t *record = (const uint8_t *)wanted;
  return board_write(JOURNAL + 8, record + 8, 64) &&
         board_write(JOURNAL, record, 8);
}
static enum state state(struct journal *j) {
  memset(j, 0, sizeof(*j));
  if (!board_read(JOURNAL, j, sizeof(*j)))
    return CONFLICT;
  if (!valid_journal(j)) {
    /* A ROM update may erase the whole application slot, including its last
     * sector. The versioned NVS superblock independently preserves ownership.
     */
    struct journal wanted;
    uint8_t digest[32];
    if (custom_header(digest)) {
      make_journal(&wanted, digest);
      if (!possible_torn_write(j, &wanted))
        return CONFLICT;
      *j = wanted;
      return OWNED;
    }
    return blank(JOURNAL, SECTOR) ? PROTECTED : CONFLICT;
  }
  switch (j->phase) {
  case 0xff: {
    uint8_t original[32];
    return custom_header(original) && !memcmp(original, j->original, 32)
               ? OWNED
               : FORMATTING;
  }
  case 0xfe: {
    uint8_t expected[80], actual[80];
    superblock(expected, j->original);
    return board_read(USER_BASE, actual, 80) && !memcmp(actual, expected, 80)
               ? OWNED
               : CONFLICT;
  }
  case 0xfd:
  case 0xfc:
    return RESTORING;
  case 0xf9:
  case 0xf8:
    return RESTORED;
  default:
    return CONFLICT;
  }
}
static enum state boot_state;
enum state service_storage_state(void) {
  struct journal j;
  return board_layout_ok() ? state(&j) : CONFLICT;
}
void service_boot(void) {
  service_reset();
  boot_state = service_storage_state();
}
static bool set_phase(uint8_t phase) {
  return board_write(JOURNAL + offsetof(struct journal, phase), &phase, 1);
}
static bool same_user(const uint8_t wanted[32]) {
  uint8_t actual[32];
  return hash_flash(USER_BASE, USER_LEN, actual) && !memcmp(actual, wanted, 32);
}
static int adopt(const struct packet *p) {
  struct journal actual, expected;
  enum state s = state(&actual);
  if (p->len != 32)
    return BAD_PACKET;
  if (s == OWNED && !memcmp(actual.original, p->data, 32))
    return OK;
  if (s == FORMATTING) {
    if (memcmp(actual.original, p->data, 32))
      return WRONG_DIGEST;
  } else {
    if (s == RESTORING || s == OWNED)
      return BAD_STATE;
    if (tx.kind != BACKUP || tx.next != USER_LEN || tx.token != p->session)
      return BAD_STATE;
    if (!same_user(p->data))
      return WRONG_DIGEST;
    make_journal(&expected, p->data);
    if (s == RESTORED && !board_erase(JOURNAL))
      return IO_ERROR;
    if (s == CONFLICT) {
      /* A torn initial write may only contain a subset of this exact journal.
       * Never erase an unrecognized, previously occupied application tail. */
      if (!possible_torn_write(&actual, &expected))
        return JOURNAL_BUSY;
    }
    if (!install_journal(&expected) || state(&actual) != FORMATTING)
      return IO_ERROR;
  }
  service_reset();
  for (unsigned i = 0; i < 10; i++)
    if (!board_erase(USER_BASE + i * SECTOR))
      return IO_ERROR;
  uint8_t sb[80];
  superblock(sb, p->data);
  if (!board_write(USER_BASE, sb, sizeof(sb)) || !set_phase(0xfe))
    return IO_ERROR;
  return state(&actual) == OWNED ? OK : IO_ERROR;
}
static int begin_restore(const struct packet *p, bool override) {
  struct journal j;
  enum state s = state(&j);
  if (p->len != 32)
    return BAD_PACKET;
  if (override) {
    if (p->offset != RESTORE_OVERRIDE_CONFIRM)
      return BAD_PACKET;
    /* A torn replacement journal is retryable only for this same archive,
     * unless the intact custom header still identifies our storage. */
    if (s == CONFLICT && !valid_journal(&j)) {
      uint8_t original[32];
      struct journal wanted;
      make_journal(&wanted, p->data);
      wanted.phase = 0xfc;
      if (!custom_header(original) && !possible_torn_write(&j, &wanted))
        return JOURNAL_BUSY;
    }
  } else if (s == CONFLICT && valid_journal(&j) && j.phase == 0xfe) {
    if (memcmp(j.original, p->data, 32))
      return WRONG_DIGEST;
  } else if (s == PROTECTED || s == CONFLICT) {
    /* Re-entry after journal cleanup: accepting an identical image is
     * read-only. */
    if (!same_user(p->data))
      return WRONG_DIGEST;
  } else if (memcmp(j.original, p->data, 32))
    return WRONG_DIGEST;
  service_reset();
  tx.kind = RESTORE;
  tx.restore_override = override;
  tx.size = USER_LEN;
  tx.token = p->session;
  memcpy(tx.digest, p->data, 32);
  return OK;
}
static int finish_restore(void) {
  uint8_t digest[32];
  sha(buf.restore, USER_LEN, digest);
  if (memcmp(digest, tx.digest, 32))
    return WRONG_DIGEST;
  struct journal j;
  enum state s = state(&j);
  if (tx.restore_override) {
    /* Only replace the journal after the entire incoming archive passes SHA.
     * Seal a RESTORING record before touching NVS, so a reboot never adopts or
     * runs partially restored data. Power cuts can retry the explicit command. */
    if (!valid_journal(&j) || memcmp(j.original, digest, 32) ||
        (j.phase != 0xfc && j.phase != 0xf8)) {
      make_journal(&j, digest);
      j.phase = 0xfc;
      if (!board_erase(JOURNAL) || !set_phase(j.phase) || !install_journal(&j))
        return IO_ERROR;
    }
    s = RESTORING;
  } else if (s == CONFLICT && valid_journal(&j) && j.phase == 0xfe)
    s = OWNED;
  if (s == PROTECTED || s == RESTORED || s == CONFLICT)
    return same_user(digest) ? OK : WRONG_DIGEST;
  if (s != OWNED && s != RESTORING && s != FORMATTING)
    return BAD_STATE;
  if (memcmp(j.original, digest, 32))
    return WRONG_DIGEST;
  if (s == OWNED && j.phase == 0xff) {
    /* Restore the transaction journal before overwriting its NVS counterpart.
     */
    if (!install_journal(&j))
      return IO_ERROR;
  }
  uint8_t restoring_phase = j.phase & ~2u;
  if (!set_phase(restoring_phase))
    return IO_ERROR;
  for (uint32_t k = 0; k < USER_LEN; k += SECTOR) {
    bool equal = true;
    for (size_t i = 0; i < SECTOR; i += sizeof(io)) {
      if (!board_read(USER_BASE + k + i, io, sizeof(io)))
        return IO_ERROR;
      if (memcmp(io, buf.restore + k + i, sizeof(io))) {
        equal = false;
        break;
      }
    }
    if (!equal && (!board_erase(USER_BASE + k) ||
                   !board_write(USER_BASE + k, buf.restore + k, SECTOR)))
      return IO_ERROR;
  }
  if (!same_user(digest) || !set_phase(restoring_phase & ~4u))
    return IO_ERROR;
  return OK;
}
static bool has_family(const uint8_t *data, size_t size) {
  for (size_t i = 0; i + sizeof(FAMILY) <= size; i++)
    if (!memcmp(data + i, FAMILY, sizeof(FAMILY)))
      return true;
  return false;
}
static int begin_update(const struct packet *p) {
  if (p->len != 32 || p->offset < SECTOR || p->offset > OTA_LEN)
    return BAD_PACKET;
  struct journal j;
  enum state s = state(&j);
  bool stock = !memcmp(stock_sha, p->data, 32);
  if ((!stock && s == CONFLICT) || s == FORMATTING || s == RESTORING)
    return BAD_STATE;
  if (stock) {
    /* A matching import during this session proves the protected bytes, even
     * when power was lost after removing the journal but before activation. */
    if (s == RESTORED) {
      if (!same_user(j.original))
        return WRONG_DIGEST;
    } else if ((s != PROTECTED && s != CONFLICT) ||
               tx.kind != VERIFIED_RESTORE || tx.token != p->session ||
               !same_user(tx.digest))
      return BAD_STATE;
  }
  service_reset();
  tx.stock = stock;
  tx.size = p->offset;
  tx.token = p->session;
  memcpy(tx.digest, p->data, 32);
  if (!board_erase(OTA_BASE))
    return IO_ERROR;
  tx.kind = UPDATE;
  return OK;
}
static int transfer_data(const struct packet *p, enum transfer kind) {
  if (tx.kind != kind || tx.token != p->session)
    return BAD_STATE;
  if (!p->len || p->offset != tx.next || p->len > tx.size - tx.next)
    return BAD_POSITION;
  if (kind == RESTORE) {
    memcpy(buf.restore + tx.next, p->data, p->len);
    tx.next += p->len;
    return OK;
  }
  size_t used = 0;
  while (used < p->len) {
    uint32_t page = tx.next & ~(SECTOR - 1), inner = tx.next - page;
    size_t count = p->len - used;
    if (count > SECTOR - inner)
      count = SECTOR - inner;
    uint8_t *dst = page ? buf.fw.page : buf.fw.first;
    memcpy(dst + inner, p->data + used, count);
    used += count;
    tx.next += count;
    if (page && (inner + count == SECTOR || tx.next == tx.size)) {
      if (!board_erase(OTA_BASE + page) ||
          !board_write(OTA_BASE + page, dst, inner + count)) {
        service_reset();
        return IO_ERROR;
      }
    }
  }
  return OK;
}
static int check_update(void) {
  uint8_t *h = buf.fw.first;
  if (h[0x1a2] != 15 || h[0x1a4] != 1 || h[0x1a5] != 1 || h[0x1a6] != 0xa9 ||
      h[0x1a7] != 0x37 || get32(h + 0x1a8) != tx.size - 0x500 ||
      memcmp(h + 0x1ac, rom_id, 16) || get32(h + 0x1c8) != 0x0402d000 ||
      memcmp(h + 0x208, "KCZKNAPE", 8))
    return WRONG_IMAGE;
  struct tc_sha256_state_struct whole, inner;
  uint8_t hash[32];
  tc_sha256_init(&whole);
  tc_sha256_init(&inner);
  tc_sha256_update(&whole, h, SECTOR);
  tc_sha256_update(&inner, h + 0x1a0, SECTOR - 0x1a0);
  bool family = has_family(h, SECTOR);
  uint8_t window[sizeof(FAMILY) - 1 + sizeof(io)];
  memcpy(window, h + SECTOR - sizeof(FAMILY) + 1, sizeof(FAMILY) - 1);
  for (uint32_t pos = SECTOR; pos < tx.size;) {
    size_t n = tx.size - pos;
    if (n > sizeof(io))
      n = sizeof(io);
    if (!board_read(OTA_BASE + pos, io, n))
      return IO_ERROR;
    tc_sha256_update(&whole, io, n);
    tc_sha256_update(&inner, io, n);
    memcpy(window + sizeof(FAMILY) - 1, io, n);
    family |= has_family(window, sizeof(FAMILY) - 1 + n);
    memmove(window, window + n, sizeof(FAMILY) - 1);
    pos += n;
  }
  tc_sha256_final(hash, &whole);
  if (memcmp(hash, tx.digest, 32))
    return WRONG_DIGEST;
  tc_sha256_final(hash, &inner);
  if (memcmp(hash, h + 0x180, 32) || (!tx.stock && !family))
    return WRONG_IMAGE;
  /* Keep Realtek's not_ready bit set until the final single-bit commit. */
  const uint8_t staged_flags = h[0x1a4] | 0x80;
  if (!board_write(OTA_BASE, h, 0x1a4) ||
      !board_write(OTA_BASE + 0x1a5, h + 0x1a5, SECTOR - 0x1a5) ||
      !board_write(OTA_BASE + 0x1a4, &staged_flags, 1))
    return IO_ERROR;
  tx.kind = CHECKED;
  return OK;
}
static int command(const struct packet *p, struct packet *r) {
  struct journal j;
#ifdef CONFIG_REALTEK_PPT
  if (radio_probe_busy() && ((p->op >= ADOPT && p->op <= FW_ACTIVATE) ||
                             p->op == RESTORE_BEGIN_OVERRIDE))
    return BAD_STATE;
#endif
  switch (p->op) {
  case INFO:
    r->data[0] = state(&j);
    r->data[1] = boot_state;
    memcpy(r->data + 2, FAMILY, sizeof(FAMILY));
    r->len = 2 + sizeof(FAMILY);
    return OK;
  case READ_USER: {
    if (p->len != 1 || !p->data[0] || p->data[0] > 48)
      return BAD_PACKET;
    if (!p->offset) {
      service_reset();
      tx.kind = BACKUP;
      tx.token = p->session;
    }
    if (tx.kind != BACKUP || tx.token != p->session || p->offset != tx.next ||
        p->data[0] > USER_LEN - tx.next)
      return BAD_POSITION;
    if (!board_read(USER_BASE + tx.next, r->data, p->data[0]))
      return IO_ERROR;
    r->len = p->data[0];
    tx.next += r->len;
    return OK;
  }
  case ADOPT:
    return adopt(p);
  case SNAPSHOT_HASH:
    if (tx.kind != BACKUP || tx.token != p->session || tx.next != USER_LEN)
      return BAD_STATE;
    if (!hash_flash(USER_BASE, USER_LEN, r->data))
      return IO_ERROR;
    r->len = 32;
    tx.snapshot_done = true;
    return OK;
  case RESTORE_BEGIN:
    return begin_restore(p, false);
  case RESTORE_BEGIN_OVERRIDE:
    return begin_restore(p, true);
  case RESTORE_DATA:
    return transfer_data(p, RESTORE);
  case RESTORE_END: {
    if (tx.kind != RESTORE || tx.token != p->session || tx.next != USER_LEN)
      return BAD_STATE;
    int rc = finish_restore();
    if (rc == OK)
      tx.kind = VERIFIED_RESTORE;
    return rc;
  }
  case FW_BEGIN:
#ifdef CONFIG_REALTEK_PPT
    if (radio_probe_busy())
      return BAD_STATE;
#endif
    return begin_update(p);
  case FW_DATA:
    return transfer_data(p, UPDATE);
  case FW_CHECK:
    if (tx.kind != UPDATE || tx.token != p->session || tx.next != tx.size)
      return BAD_STATE;
    return check_update();
  case FW_ACTIVATE:
    if (tx.kind != CHECKED || tx.token != p->session)
      return BAD_STATE;
    if (tx.stock && state(&j) == RESTORED &&
        (!same_user(j.original) || !board_erase(JOURNAL)))
      return IO_ERROR;
    if (!board_write(OTA_BASE + 0x1a4, buf.fw.first + 0x1a4, 1))
      return IO_ERROR;
    return OK;
  default:
#ifdef NAPE_MAIN
    if (p->op >= 0x30 && p->op <= 0x38) {
      if (p->op != 0x30 && tx.kind != IDLE && tx.kind != BACKUP)
        return BAD_STATE;
      if (p->op == 0x32 || p->op == 0x36)
        service_reset();
      return nape_config_command(p, r);
    }
#endif
#ifdef CONFIG_REALTEK_PPT
    if (p->op >= 0x20 && p->op <= 0x28) {
      if (p->op != 0x20 && p->op != 0x25 && p->op != 0x27 && state(&j) != OWNED)
        return BAD_STATE;
      if (p->op != 0x20 && p->op != 0x25 && p->op != 0x27 && tx.kind != IDLE &&
          tx.kind != BACKUP)
        return BAD_STATE;
      return radio_probe_request(p, r);
    }
#endif
    return BAD_PACKET;
  }
}
void service_handle(const struct packet *p, struct packet *r) {
  memset(r, 0, sizeof(*r));
  memcpy(r, p, 12);
  if (memcmp(p->magic, "NP", 2) || p->version != 1 || !p->session ||
      p->len > 48 || p->status || p->reserved[0] || p->reserved[1])
    r->status = BAD_PACKET;
  else if (!board_layout_ok())
    r->status = WRONG_LAYOUT;
  else
    r->status = command(p, r);
}
