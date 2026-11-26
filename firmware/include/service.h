#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* All addresses are relative offsets in the trackball's main NOR flash. */
#define SECTOR 4096u
#define USER_BASE 0xf5000u
#define USER_LEN 0xb000u
#define JOURNAL 0x89000u
#define OTA_BASE 0x9c000u
#define OTA_LEN 0x59000u
#define RESTORE_OVERRIDE_CONFIRM 0x4f4c4442u /* explicit older-backup consent */
#define FAMILY "NAPE-MAINT/v1"
enum state { PROTECTED, FORMATTING, OWNED, RESTORING, RESTORED, CONFLICT };
enum op {
  INFO = 1,
  READ_USER,
  ADOPT,
  RESTORE_BEGIN,
  RESTORE_DATA,
  RESTORE_END,
  FW_BEGIN,
  FW_DATA,
  FW_CHECK,
  FW_ACTIVATE,
  SNAPSHOT_HASH,
  RESTORE_BEGIN_OVERRIDE
};
enum result {
  OK,
  BAD_PACKET,
  BAD_STATE,
  WRONG_DIGEST,
  IO_ERROR,
  WRONG_IMAGE,
  BAD_POSITION,
  WRONG_LAYOUT,
  JOURNAL_BUSY
};
struct packet {
  uint8_t magic[2], version, op;
  uint32_t session, offset;
  uint8_t len, status, reserved[2], data[48];
};
_Static_assert(sizeof(struct packet) == 64 &&
                   offsetof(struct packet, data) == 16,
               "wire layout");
/* Platform operations run on one thread. Writes and erases must verify
 * readback. */
bool board_read(uint32_t addr, void *out, size_t len);
bool board_write(uint32_t addr, const void *in, size_t len);
bool board_erase(uint32_t sector);
bool board_layout_ok(void);
bool supported_layout(bool bank_switch, uint32_t app_address,
                      uint32_t app_length, uint32_t ota_address,
                      uint32_t ota_length, uint32_t ftl_address);
void service_reset(void);
bool service_idle(void);
void service_boot(void);
enum state service_storage_state(void);
void service_handle(const struct packet *in, struct packet *out);
