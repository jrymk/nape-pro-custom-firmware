#include "board_input.h"
#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>
static const struct device *a, *b;
static const uint8_t pins[] = {16, 27, 26, 3, 31, 1, 4};
static const uint8_t banks[] = {0, 0, 0, 1, 0, 1, 1};
static int ring_previous, ring_count;
bool nape_recovery_chord(void) {
  const struct device *ga = DEVICE_DT_GET(DT_NODELABEL(gpioa));
  const struct device *gb = DEVICE_DT_GET(DT_NODELABEL(gpiob));
  if (!device_is_ready(ga) || !device_is_ready(gb))
    return true;
  if (gpio_pin_configure(ga, 31, GPIO_INPUT | GPIO_PULL_UP) ||
      gpio_pin_configure(gb, 1, GPIO_INPUT | GPIO_PULL_UP) ||
      gpio_pin_configure(gb, 4, GPIO_INPUT | GPIO_PULL_UP))
    return true;
  /* All three must remain held across a short settling/debounce interval. */
  k_busy_wait(100);
  for (unsigned i = 0; i < 5; i++) {
    if (gpio_pin_get(ga, 31) != 0 || gpio_pin_get(gb, 1) != 0 ||
        gpio_pin_get(gb, 4) != 0)
      return false;
    k_msleep(1);
  }
  return true;
}
int nape_buttons_init(void) {
  a = DEVICE_DT_GET(DT_NODELABEL(gpioa));
  b = DEVICE_DT_GET(DT_NODELABEL(gpiob));
  if (!device_is_ready(a) || !device_is_ready(b))
    return -ENODEV;
  for (unsigned i = 0; i < 7; i++) {
    int rc = gpio_pin_configure(banks[i] ? b : a, pins[i],
                                GPIO_INPUT | GPIO_PULL_UP);
    if (rc)
      return rc;
  }
  int rc = gpio_pin_configure(a, 18, GPIO_INPUT);
  if (rc)
    return rc;
  rc = gpio_pin_configure(b, 19, GPIO_INPUT | GPIO_PULL_UP);
  if (rc)
    return rc;
  rc = gpio_pin_configure(b, 20, GPIO_INPUT | GPIO_PULL_UP);
  if (rc)
    return rc;
  ring_previous = (gpio_pin_get(b, 19) > 0) | ((gpio_pin_get(b, 20) > 0) << 1);
  return 0;
}
uint8_t nape_buttons_read(void) {
  uint8_t mask = 0;
  for (unsigned i = 0; i < 7; i++)
    if (gpio_pin_get(banks[i] ? b : a, pins[i]) == 0)
      mask |= 1u << i;
  return mask;
}
bool nape_radio_switch(void) { return gpio_pin_get(a, 18) == 0; }
int nape_ring_read(void) {
  static const int8_t table[16] = {0,  -1, 1, 0, 1, 0, 0,  -1,
                                   -1, 0,  0, 1, 0, 1, -1, 0};
  int now = (gpio_pin_get(b, 19) > 0) | ((gpio_pin_get(b, 20) > 0) << 1);
  if ((now ^ ring_previous) == 3)
    ring_count = 0;
  else
    ring_count += table[(ring_previous << 2) | now];
  ring_previous = now;
  int steps = ring_count / 4;
  ring_count -= steps * 4;
  return -steps; /* Physical clockwise is the positive/CW logical direction. */
}
