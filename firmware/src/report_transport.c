#include "report_transport.h"
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/usb/class/usb_hid.h>
#include <zephyr/usb/usb_device.h>
static const struct device *hid;
static atomic_t configured;
static uint8_t multipliers[3] = {3, 0, 0};
K_SEM_DEFINE(report_ready, 1, 1);
/* Report 1 mouse, report 2 keyboard, feature report 3 scroll multipliers.
 * Resolution multipliers are scoped to separate wheel logical collections. */
static const uint8_t descriptor[] = {
    0x05, 1, 0x09, 2, 0xa1, 1, 0x85, 1, 0x09, 1, 0xa1, 0, 0x05, 9, 0x19, 1,
    0x29, 8, 0x15, 0, 0x25, 1, 0x75, 1, 0x95, 8, 0x81, 2, 0x05, 1, 0x09, 0x30,
    0x09, 0x31, 0x16, 1, 0x80, 0x26, 0xff, 0x7f, 0x75, 16, 0x95, 2, 0x81, 6,
    0xa1, 2, 0x85, 3, 0x09, 0x48, 0x15, 0, 0x25, 1, 0x35, 1, 0x45, 120, 0x75, 8,
    0x95, 1, 0xb1, 2, 0x85, 1, 0x09, 0x38, 0x35, 0, 0x45, 0, 0x16, 1, 0x80,
    0x26, 0xff, 0x7f, 0x75, 16, 0x95, 1, 0x81, 6, 0xc0, 0xa1, 2, 0x85, 3, 0x09,
    0x48, 0x15, 0, 0x25, 1, 0x35, 1, 0x45, 120, 0x75, 8, 0x95, 1, 0xb1, 2, 0x85,
    1, 0x05, 0x0c, 0x0a, 0x38, 2, 0x35, 0, 0x45, 0, 0x16, 1, 0x80, 0x26, 0xff,
    0x7f, 0x75, 16, 0x95, 1, 0x81, 6, 0xc0, 0xc0, 0xc0, 0x05, 1, 0x09, 6, 0xa1,
    1, 0x85, 2, 0x05, 7, 0x19, 0xe0, 0x29, 0xe7, 0x15, 0, 0x25, 1, 0x75, 1,
    0x95, 8, 0x81, 2, 0x75, 8, 0x95, 1, 0x81, 1, 0x19, 0, 0x29, 0x73, 0x15, 0,
    0x25, 0x73, 0x75, 8, 0x95, 6, 0x81, 0, 0xc0,
    /* Report 4: consumer controls; one independently held bit per usage. */
    0x05, 0x0c, 0x09, 1, 0xa1, 1, 0x85, 4, 0x15, 0, 0x25, 1, 0x35, 0, 0x45, 1,
    0x75, 1, 0x95, 8, 0x09, 0xcd, 0x09, 0xb5, 0x09, 0xb6, 0x09, 0xb7, 0x09,
    0xe2, 0x09, 0xe9, 0x09, 0xea, 0x09, 0xb8, 0x81, 2, 0xc0};
static void complete(const struct device *dev) {
  ARG_UNUSED(dev);
  k_sem_give(&report_ready);
}
static int get(const struct device *dev, struct usb_setup_packet *s,
               int32_t *len, uint8_t **data) {
  ARG_UNUSED(dev);
  if (s->wValue != 0x0303)
    return -ENOTSUP;
  *data = multipliers;
  *len = 3;
  return 0;
}
static int set(const struct device *dev, struct usb_setup_packet *s,
               int32_t *len, uint8_t **data) {
  ARG_UNUSED(dev);
  if (s->wValue != 0x0303 || *len != 3 || (*data)[0] != 3 || (*data)[1] > 1 ||
      (*data)[2] > 1)
    return -ENOTSUP;
  memcpy(multipliers, *data, 3);
  return 0;
}
static const struct hid_ops ops = {
    .int_in_ready = complete, .get_report = get, .set_report = set};
int nape_mouse_usb_init(void) {
  hid = device_get_binding("HID_1");
  if (!hid)
    return -ENODEV;
  usb_hid_register_device(hid, descriptor, sizeof(descriptor), &ops);
  return usb_hid_init(hid);
}
void nape_reports_usb(bool ready) {
  atomic_set(&configured, ready);
  if (!ready) {
    multipliers[1] = multipliers[2] = 0;
    k_sem_give(&report_ready);
  }
}
bool nape_usb_ready(void) { return atomic_get(&configured) != 0; }
unsigned nape_usb_scroll_multiplier(unsigned axis) {
  return multipliers[axis + 1] ? 120 : 1;
}
static bool send(const uint8_t *data, size_t len) {
  if (!nape_usb_ready() || k_sem_take(&report_ready, K_MSEC(5)))
    return false;
  uint32_t actual = 0;
  int rc = hid_int_ep_write(hid, data, len, &actual);
  if (rc || actual != len) {
    k_sem_give(&report_ready);
    return false;
  }
  return true;
}
bool nape_usb_mouse(uint8_t buttons, int16_t x, int16_t y, int16_t wheel,
                    int16_t pan) {
  uint8_t p[10] = {1, buttons};
  sys_put_le16(x, p + 2);
  sys_put_le16(y, p + 4);
  sys_put_le16(wheel, p + 6);
  sys_put_le16(pan, p + 8);
  return send(p, sizeof(p));
}
bool nape_usb_keyboard(const uint8_t report[8]) {
  uint8_t p[9] = {2};
  memcpy(p + 1, report, 8);
  return send(p, 9);
}
bool nape_usb_consumer(uint8_t buttons) {
  const uint8_t p[2] = {4, buttons};
  return send(p, sizeof(p));
}
