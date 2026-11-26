#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/pwm.h>
#include <zephyr/kernel.h>
#if defined(CONFIG_UART_CONSOLE)
#include <zephyr/sys/printk.h>
#endif
#include "indicator.h"
#include "led_gamma_table.h"

static const struct pwm_dt_spec led[] = {
    PWM_DT_SPEC_GET(DT_NODELABEL(red_led)),
    PWM_DT_SPEC_GET(DT_NODELABEL(green_led)),
    PWM_DT_SPEC_GET(DT_NODELABEL(blue_led)),
};
static atomic_t requested_state = ATOMIC_INIT(CONFLICT);
static atomic_t custom_color = ATOMIC_INIT(-1);
static atomic_t recovery;
static atomic_t calibration_gamma = ATOMIC_INIT(22);
static atomic_t calibration_scale = ATOMIC_INIT(0x64646464);
void indicator_calibrate(uint8_t gamma, const uint8_t gains[3], uint8_t brightness) {
  atomic_set(&calibration_scale, gamma ? ((uint32_t)gains[0] << 24) |
      ((uint32_t)gains[1] << 16) | ((uint32_t)gains[2] << 8) | brightness : 0x64646464);
  atomic_set(&calibration_gamma, gamma ? gamma : 22);
}
static const struct gpio_dt_spec led_power =
    GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), led_power_gpios);
static bool power_ready;
static void draw(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(animation, draw);

void indicator_set(enum state state) {
  if (!power_ready) {
    int rc = gpio_is_ready_dt(&led_power)
                 ? gpio_pin_configure_dt(&led_power, GPIO_OUTPUT_ACTIVE)
                 : -ENODEV;
#if defined(CONFIG_UART_CONSOLE)
    printk("NAPE LED power GPIOB2 init=%d\n", rc);
#endif
    if (rc)
      return;
    power_ready = true;
  }
  atomic_set(&requested_state, state);
  k_work_reschedule(&animation, K_NO_WAIT);
}
void indicator_rgb(const uint8_t rgb[3], bool blink) {
  uint32_t value = ((uint32_t)rgb[0] << 16) | ((uint32_t)rgb[1] << 8) |
                   rgb[2] | (blink ? (1u << 24) : 0);
  if ((uint32_t)atomic_set(&custom_color, value) != value)
    k_work_reschedule(&animation, K_NO_WAIT);
}
void indicator_recovery(void) {
  atomic_set(&recovery, 1);
  indicator_set(OWNED);
}

static void draw(struct k_work *work) {
  ARG_UNUSED(work);
  static int previous = -1;
  static uint32_t started;
  enum state state = atomic_get(&requested_state);
  uint32_t now = k_uptime_get_32();
  if ((int)state != previous) {
    previous = state;
    started = now;
  }
  uint32_t elapsed = now - started;
  static uint32_t selection_started;
  static int last_custom = -1;
  int custom = atomic_get(&custom_color);
  bool blink = state == OWNED && !atomic_get(&recovery) && custom >= 0 &&
               (custom & (1u << 24));
  if (custom != last_custom) {
    selection_started = now;
    last_custom = custom;
  }
  uint8_t rgb[3];
  indicator_color(state, elapsed, rgb);
  if (atomic_get(&recovery)) {
    rgb[0] = rgb[2] = 0;
    rgb[1] = elapsed % 500 < 25 ? 160 : 0;
  } else if (state == OWNED && custom >= 0) {
    uint32_t color = custom;
    rgb[0] = color >> 16;
    rgb[1] = color >> 8;
    rgb[2] = color;
  }
  if (blink && (now - selection_started) % 250 >= 125)
    rgb[0] = rgb[1] = rgb[2] = 0;
  /* LUT retains 16-bit duty precision after gamma, before timer quantization. */
  uint8_t gamma = atomic_get(&calibration_gamma);
  const uint16_t *curve = nape_led_gamma[gamma - 10];
  uint32_t scale = atomic_get(&calibration_scale);
  /* Recovery/protection colors stay visible even with user brightness zero. */
  bool calibrated = state == OWNED && !atomic_get(&recovery);
  for (size_t i = 0; i < ARRAY_SIZE(led); ++i) {
    uint32_t gain = calibrated ? (scale >> (24 - 8*i)) & 255 : 100;
    uint32_t brightness = calibrated ? scale & 255 : 100;
    uint32_t duty = calibrated ? curve[rgb[i]] : rgb[i] * 257u;
    uint32_t pulse = ((uint64_t)led[i].period * duty * gain * brightness +
                      327675000u) / 655350000u;
    if (device_is_ready(led[i].dev))
      pwm_set_pulse_dt(&led[i], pulse);
  }
  if (state != CONFLICT) {
    uint32_t interval = atomic_get(&recovery) || blink ? 25 : state == OWNED ? 20 : 250;
    uint32_t phase = blink ? now - selection_started : elapsed;
    k_work_schedule(&animation, K_MSEC(interval - phase % interval));
  }
}
