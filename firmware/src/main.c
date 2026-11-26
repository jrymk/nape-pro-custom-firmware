#include "indicator.h"
#include "service.h"
#include <flash_nor_device.h>
#include <patch_header_check.h>
#include <string.h>
#include <wdt/inc/rtl_wdt.h>
#include <zephyr/kernel.h>
#include <zephyr/usb/class/usb_hid.h>
#include <zephyr/usb/usb_device.h>
#ifdef NAPE_MAIN
#include "board_input.h"
#include "runtime.h"
static bool recovery_mode;
#endif
#if defined(CONFIG_UART_CONSOLE)
#include <zephyr/sys/printk.h>
#define BOOT_LOG(...) printk(__VA_ARGS__)
#else
#define BOOT_LOG(...) ((void)0)
#endif

#define FLASH_BASE 0x04000000u
/* Realtek boot ROM entry used by the stock updater for activation. */
extern void chip_reset(WDTMode_TypeDef mode);
static bool layout_matches;
static const uint8_t descriptor[] = {
    0x06, 0x5d, 0xff, 0x09, 1, 0xa1, 1, 0x15, 0, 0x26, 0xff, 0,   0x75,
    8,    0x95, 64,   0x09, 2, 0x81, 2, 0x09, 3, 0x91, 2,    0xc0};
K_MSGQ_DEFINE(requests, sizeof(struct packet), 2, 4);
K_SEM_DEFINE(sent, 0, 1);
static atomic_t epoch;
bool board_layout_ok(void) { return layout_matches; }
static bool inside(uint32_t a, size_t n, uint32_t base, uint32_t size) {
  return a >= base && a - base < size && n <= size - (a - base);
}
static bool permitted(uint32_t a, size_t n) {
  return inside(a, n, JOURNAL, SECTOR) || inside(a, n, USER_BASE, USER_LEN) ||
         inside(a, n, OTA_BASE, OTA_LEN);
}
bool board_read(uint32_t a, void *out, size_t n) {
  return permitted(a, n) &&
         flash_nor_read_locked(FLASH_BASE + a, out, n) == FLASH_NOR_RET_SUCCESS;
}
bool board_write(uint32_t a, const void *input, size_t n) {
  if (!layout_matches || !permitted(a, n))
    return false;
  const uint8_t *src = input;
  uint8_t data[256], verify[256];
  while (n) {
    size_t count = MIN(n, 256u - (a & 255u));
    memcpy(data, src, count); /* ROM writer requires a RAM source. */
    if (flash_nor_write_locked(FLASH_BASE + a, data, count) !=
            FLASH_NOR_RET_SUCCESS ||
        !board_read(a, verify, count) || memcmp(data, verify, count))
      return false;
    a += count;
    src += count;
    n -= count;
  }
  return true;
}
bool board_erase(uint32_t a) {
  if (!layout_matches || (a & (SECTOR - 1)) || !permitted(a, SECTOR))
    return false;
  unsigned key = irq_lock();
  FLASH_NOR_RET_TYPE rc =
      flash_nor_erase_locked(FLASH_BASE + a, FLASH_NOR_ERASE_SECTOR);
  irq_unlock(key);
  if (rc != FLASH_NOR_RET_SUCCESS)
    return false;
  uint8_t check[256];
  for (size_t i = 0; i < SECTOR; i += sizeof(check)) {
    if (!board_read(a + i, check, sizeof(check)))
      return false;
    for (size_t k = 0; k < sizeof(check); k++)
      if (check[k] != 0xff)
        return false;
  }
  return true;
}
static void received(const struct device *dev) {
  struct packet p;
  uint32_t count = 0;
  if (!hid_int_ep_read(dev, (uint8_t *)&p, sizeof(p), &count) &&
      count == sizeof(p))
    k_msgq_put(&requests, &p, K_NO_WAIT);
}
static void transmitted(const struct device *dev) {
  ARG_UNUSED(dev);
  k_sem_give(&sent);
}
static void usb_status(enum usb_dc_status_code status, const uint8_t *param) {
  ARG_UNUSED(param);
#ifdef NAPE_MAIN
  if (status == USB_DC_CONFIGURED)
    nape_runtime_usb(true);
  if (status == USB_DC_RESET || status == USB_DC_DISCONNECTED)
    nape_runtime_usb(false);
#endif
  if (status == USB_DC_RESET || status == USB_DC_DISCONNECTED) {
    atomic_inc(&epoch);
    k_msgq_purge(&requests);
  }
}
static const struct hid_ops ops = {.int_out_ready = received,
                                   .int_in_ready = transmitted};
int main(void) {
#ifdef NAPE_MAIN
  recovery_mode = nape_recovery_chord();
  if (recovery_mode)
    nape_runtime_recovery();
#endif
  BOOT_LOG("NAPE main: checking ROM layout\n");
  layout_matches = supported_layout(
      is_ota_support_bank_switch(), get_header_addr_by_img_id(IMG_MCUAPP),
      get_active_bank_image_size_by_img_id(IMG_MCUAPP),
      flash_nor_get_bank_addr(FLASH_OTA_TMP),
      flash_nor_get_bank_size(FLASH_OTA_TMP),
      flash_nor_get_bank_addr(FLASH_FTL));
  BOOT_LOG("NAPE layout match=%d; inspecting settings\n", layout_matches);
  service_boot();
  enum state storage = service_storage_state();
  BOOT_LOG("NAPE storage=%d; starting indicator and HID\n", storage);
  indicator_set(storage);
#ifdef NAPE_MAIN
  if (recovery_mode)
    indicator_recovery();
  int input_rc = nape_mouse_usb_init();
  if (input_rc) {
    recovery_mode = true;
    nape_runtime_recovery();
    indicator_recovery();
  }
#endif
  const struct device *hid = device_get_binding("HID_0");
  if (!hid) {
    BOOT_LOG("NAPE HID_0 missing\n");
    return -ENODEV;
  }
  usb_hid_register_device(hid, descriptor, sizeof(descriptor), &ops);
  int rc = usb_hid_init(hid);
  BOOT_LOG("NAPE hid_init=%d\n", rc);
  if (rc)
    return rc;
  rc = usb_enable(usb_status);
  BOOT_LOG("NAPE usb_enable=%d\n", rc);
  if (rc)
    return rc;
#ifdef NAPE_MAIN
  if (!recovery_mode && storage == OWNED)
    nape_runtime_start();
#endif
  struct packet p, r, previous = {0}, cached = {0};
  atomic_val_t last_epoch = atomic_get(&epoch);
  for (;;) {
#ifdef NAPE_MAIN
    if (service_idle() && !nape_config_transfer_active())
      nape_runtime_poll();
#endif
    if (k_msgq_get(&requests, &p, K_MSEC(100)))
      continue;
    if (last_epoch != atomic_get(&epoch)) {
      service_reset();
      previous.version = 0;
      last_epoch = atomic_get(&epoch);
    }
    bool live_read = p.op == INFO;
#ifdef NAPE_MAIN
    live_read |= p.op == 0x30 || p.op == 0x31;
#endif
#ifdef CONFIG_REALTEK_PPT
    live_read |= p.op == 0x20 || p.op == 0x25 || p.op == 0x27;
#endif
    if (!live_read && previous.version && !memcmp(&p, &previous, sizeof(p)))
      r = cached;
    else {
      service_handle(&p, &r);
#ifdef NAPE_MAIN
      if (r.status == OK && (p.op == FW_BEGIN || p.op == RESTORE_BEGIN ||
                            p.op == RESTORE_BEGIN_OVERRIDE))
        nape_runtime_pause();
#endif
      if (p.op == ADOPT || p.op == RESTORE_END)
        indicator_set(service_storage_state());
#ifdef NAPE_MAIN
      if (p.op == ADOPT && r.status == OK && !recovery_mode)
        nape_runtime_start();
#endif
      previous = p;
      cached = r;
    }
    k_sem_reset(&sent);
    uint32_t n;
    if (!hid_int_ep_write(hid, (uint8_t *)&r, sizeof(r), &n) && n == sizeof(r))
      k_sem_take(&sent, K_SECONDS(1));
    if ((p.op == FW_ACTIVATE
#ifdef CONFIG_REALTEK_PPT
         || p.op == 0x26
#endif
         ) &&
        r.status == OK) {
      k_msleep(50);
      chip_reset(RESET_ALL);
    }
  }
}
