/* Single input owner. Board drivers, action resolution and transports stay
 * separate. */
#include "runtime.h"
#include "board_input.h"
#include "indicator.h"
#include "motion_processor.h"
#include "report_transport.h"
#include "scroll_report.h"
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/byteorder.h>
static struct nape_config config;
static struct nape_input engine;
K_MUTEX_DEFINE(input_lock);
K_SEM_DEFINE(input_tick, 0, 1);
static void tick(struct k_timer *timer) {
  ARG_UNUSED(timer);
  k_sem_give(&input_tick);
}
K_TIMER_DEFINE(input_clock, tick, NULL);
static bool running, started, radio_on, sensor_ok;
static bool recovery, launched;
static bool preview_active;
static uint8_t pre_preview_profile;
static uint8_t raw, stable, buttons, keyboard[8], last_mode, last_orientation;
static uint32_t changed[7], samples, errors, unsupported;
static int sensor_result;
static uint16_t keys[7];
static int32_t dx, dy, wheel, pan;
static struct nape_motion_processor motion;
static struct nape_scroll_report scroll_report;
static atomic_t usb_epoch;
static atomic_val_t seen_epoch;
static bool seen_radio_link;
static uint16_t last_counts;
static bool mouse_dirty, key_dirty;
static uint8_t consumer;
static bool consumer_dirty;
static int32_t bounded(int32_t n) { return CLAMP(n, -1000000, 1000000); }
static int16_t take16(int32_t n) { return CLAMP(n, -32767, 32767); }
static void reports(void) {
  if (mouse_dirty || dx || dy || wheel || pan) {
    int16_t x = take16(dx), y = take16(dy);
    int32_t wm = radio_on ? 1 : nape_usb_scroll_multiplier(0),
             pm = radio_on ? 1 : nape_usb_scroll_multiplier(1);
    uint32_t now = k_uptime_get_32();
    int16_t w = nape_scroll_delta(wheel, wm, radio_on);
    int16_t p = nape_scroll_delta(pan, pm, radio_on);
    nape_scroll_select(&scroll_report, now, &w, &p);
    bool sent = (mouse_dirty || x || y || w || p) &&
                (radio_on ? nape_radio_mouse(buttons, x, y, w, p)
                          : nape_usb_mouse(buttons, x, y, w, p));
    if (sent) {
      dx -= x;
      dy -= y;
      wheel -= w * (120 / wm);
      pan -= p * (120 / pm);
      if (w || p)
        nape_scroll_sent(&scroll_report, now, w, p);
      mouse_dirty = false;
    }
  }
  if (key_dirty && !radio_on && nape_usb_keyboard(keyboard))
    key_dirty = false;
  if (consumer_dirty && !radio_on && nape_usb_consumer(consumer))
    consumer_dirty = false;
}
static void color(void) {
  uint8_t rgb[3];
  nape_input_color(&engine, rgb);
  bool held = (engine.physical & ~engine.suppressed) &
              (1u << engine.config->selector_button);
  indicator_rgb(rgb, held && !engine.selecting);
}
static void action(uint16_t code, bool down) {
  if (code >= 1 && code <= 8) {
    if (down)
      buttons |= 1u << (code - 1);
    else
      buttons &= ~(1u << (code - 1));
    mouse_dirty = true;
  } else if (code >= 9 && code <= 12) {
    if (!down)
      return;
    if (code == 9)
      wheel = bounded(wheel + 120);
    if (code == 10)
      wheel = bounded(wheel - 120);
    if (code == 11)
      pan = bounded(pan - 120);
    if (code == 12)
      pan = bounded(pan + 120);
  } else if (code >= 0x4001 && code <= 0x4008) {
    if (radio_on) {
      unsupported++;
      return;
    }
    uint8_t bit = 1u << (code - 0x4001);
    if (down)
      consumer |= bit;
    else
      consumer &= ~bit;
    consumer_dirty = true;
  } else if (code & 0x8000) {
    if (radio_on) {
      unsupported++;
      return;
    }
    for (unsigned i = 0; i < 7; i++) {
      if (down && !keys[i]) {
        keys[i] = code;
        break;
      }
      if (!down && keys[i] == code) {
        keys[i] = 0;
        break;
      }
    }
    memset(keyboard, 0, 8);
    unsigned count = 0;
    for (unsigned i = 0; i < 7; i++)
      if (keys[i]) {
        keyboard[0] |= (keys[i] >> 7) & 255;
        uint8_t key = keys[i] & 127;
        bool exists = false;
        for (unsigned j = 0; j < count && j < 6; j++)
          exists |= keyboard[j + 2] == key;
        if (!exists && count < 6)
          keyboard[2 + count++] = key;
        else if (!exists) {
          memset(keyboard + 2, 1, 6);
          break;
        }
      }
    key_dirty = true;
  }
  reports();
}
static void event(void *ctx, const struct nape_input_event *e) {
  ARG_UNUSED(ctx);
  switch (e->kind) {
  case NAPE_ACTION_DOWN:
    action(e->code, true);
    break;
  case NAPE_ACTION_UP:
    action(e->code, false);
    break;
  case NAPE_WHEEL:
    if (radio_on ? nape_radio_connected() : nape_usb_ready()) {
      wheel = bounded(wheel + e->x * 120);
      pan = bounded(pan + e->y * 120);
    }
    break;
  case NAPE_MOTION: {
    if (radio_on ? !nape_radio_connected() : !nape_usb_ready())
      break;
    struct nape_motion_output out = nape_motion_process(
        &motion, e->code, nape_input_scroll_counts(&engine), e->x, e->y);
    dx = bounded(dx + out.x);
    dy = bounded(dy + out.y);
    wheel = bounded(wheel + out.wheel);
    pan = bounded(pan + out.pan);
    break;
  }
  case NAPE_CONTEXT_CHANGED: {
    uint8_t mode = nape_input_motion_settings(&engine).mode;
    uint8_t orientation = nape_input_motion_settings(&engine).orientation;
    uint16_t counts = nape_input_scroll_counts(&engine);
    if (mode != last_mode || counts != last_counts ||
        orientation != last_orientation) {
      memset(&motion, 0, sizeof(motion));
      wheel = pan = 0;
      last_mode = mode;
      last_orientation = orientation;
      last_counts = counts;
    }
    color();
    break;
  }
  case NAPE_PROFILE_PREVIEW:
  case NAPE_PROFILE_COMMIT:
    color();
    break;
  }
}
void nape_runtime_pause(void) {
  k_mutex_lock(&input_lock, K_FOREVER);
  if (running)
    nape_input_cancel(&engine);
  running = false;
  dx = dy = wheel = pan = 0;
  memset(&scroll_report, 0, sizeof(scroll_report));
  memset(&motion, 0, sizeof(motion));
  memset(keyboard, 0, 8);
  consumer = 0;
  memset(keys, 0, sizeof(keys));
  buttons = 0;
  mouse_dirty = key_dirty = consumer_dirty = true;
  reports();
  k_mutex_unlock(&input_lock);
  nape_radio_stop();
  radio_on = false;
}
static void apply_at(const struct nape_config *new_config, uint8_t profile) {
  if (recovery)
    return;
  nape_runtime_pause();
  k_mutex_lock(&input_lock, K_FOREVER);
  config = *new_config;
  indicator_calibrate(config.led_gamma, config.led_gain, config.led_brightness);
  running = nape_input_init(&engine, &config.input, profile, event, NULL);
  if (started) {
    raw = stable = nape_buttons_read();
    engine.physical = stable;
    engine.suppressed = stable;
  }
  last_mode = nape_input_motion_settings(&engine).mode;
  last_orientation = nape_input_motion_settings(&engine).orientation;
  last_counts = nape_input_scroll_counts(&engine);
  color();
  k_mutex_unlock(&input_lock);
}
static uint8_t startup_profile(const struct nape_config *c) {
  int profile = c->initial_profile;
  if (profile == NAPE_START_LAST) {
    if (engine.config)
      profile = preview_active ? pre_preview_profile : engine.profile;
    else
      profile = nape_profile_history_load(nape_config_generation());
  }
  if (profile >= 0 && profile < NAPE_PROFILES &&
      !c->input.profile[profile].disabled)
    return profile;
  for (unsigned i = 0; i < NAPE_PROFILES; i++)
    if (!c->input.profile[i].disabled)
      return i;
  return 0;
}
void nape_runtime_apply(const struct nape_config *new_config) {
  uint8_t profile = startup_profile(new_config);
  preview_active = false;
  apply_at(new_config, profile);
}
void nape_runtime_preview(const struct nape_config *new_config, bool enabled,
                          uint8_t profile) {
  if (enabled && !preview_active)
    pre_preview_profile = engine.profile;
  if (profile == 255)
    profile = !enabled && preview_active ? pre_preview_profile : engine.profile;
  if (profile >= NAPE_PROFILES || new_config->input.profile[profile].disabled)
    profile = startup_profile(new_config);
  apply_at(new_config, profile);
  preview_active = enabled;
}
/* Called by the maintenance thread, which owns all flash transactions. Wait
 * for a settled selection and never persist an editor's temporary preview. */
void nape_runtime_poll(void) {
  static uint8_t pending = NAPE_START_LAST;
  static uint32_t pending_generation, since;
  k_mutex_lock(&input_lock, K_FOREVER);
  bool eligible = running && !recovery && !preview_active &&
                  !engine.selecting &&
                  config.initial_profile == NAPE_START_LAST;
  uint8_t profile = engine.profile;
  k_mutex_unlock(&input_lock);
  if (!eligible) {
    pending = NAPE_START_LAST;
    return;
  }
  uint32_t now = k_uptime_get_32(), generation = nape_config_generation();
  if (pending != profile || pending_generation != generation) {
    pending = profile;
    pending_generation = generation;
    since = now;
  } else if (now - since >= 750) {
    nape_profile_history_save(profile, generation);
    since = now;
  }
}
void nape_runtime_usb(bool ready) {
  nape_reports_usb(ready);
  atomic_inc(&usb_epoch);
}
void nape_runtime_recovery(void) { recovery = true; }
bool nape_runtime_is_recovery(void) { return recovery; }
void nape_runtime_status(uint8_t out[48]) {
  k_mutex_lock(&input_lock, K_FOREVER);
  memset(out, 0, 48);
  out[0] = 1;
  out[1] = running;
  out[2] = engine.profile;
  out[3] = stable;
  out[4] = nape_sensor_id();
  out[5] = radio_on;
  out[6] = last_mode;
  out[7] = nape_usb_ready();
  sys_put_le32(sensor_result, out + 8);
  sys_put_le32(samples, out + 12);
  sys_put_le32(errors, out + 16);
  sys_put_le32(unsupported, out + 20);
  if (engine.config)
    sys_put_le16(nape_input_motion_settings(&engine).dpi, out + 24);
  out[27] = recovery;
  sys_put_le32(k_uptime_get_32(), out + 28);
  out[40] = nape_usb_scroll_multiplier(0);
  out[41] = nape_usb_scroll_multiplier(1);
  out[42] = NAPE_CONFIG_VERSION;
  out[43] = preview_active;
  /* Version 1.0.11: major << 16 | minor << 8 | patch. */
  sys_put_le32(0x0001000Bu, out + 44);
  out[26] = engine.toggled;
  for (unsigned i = 0; i < 8; i++)
    if (engine.layer_refs[i])
      out[26] |= 1u << i;
  k_mutex_unlock(&input_lock);
}
static bool bond_valid(void) {
  uint32_t a = sys_get_le32(config.bond), b = sys_get_le32(config.bond + 8);
  return (a && a != UINT32_MAX) || (b && b != UINT32_MAX);
}
static void loop(void *a, void *b, void *c) {
  ARG_UNUSED(a);
  ARG_UNUSED(b);
  ARG_UNUSED(c);
  sensor_result = nape_buttons_init();
  if (sensor_result) {
    running = false;
    return;
  }
  sensor_result = nape_sensor_init();
  sensor_ok = !sensor_result;
  started = true;
  k_timer_start(&input_clock, K_MSEC(1), K_MSEC(1));
  uint32_t last_sample = 0;
  for (;;) {
    k_mutex_lock(&input_lock, K_FOREVER);
    if (running) {
      bool want_radio =
          bond_valid() && (config.transport == 2 ||
                           (config.transport == 0 && nape_radio_switch()));
      if (want_radio != radio_on) {
        nape_input_cancel(&engine);
        reports();
        dx = dy = wheel = pan = 0;
        if (want_radio)
          radio_on = nape_radio_start(config.bond);
        else {
          nape_radio_stop();
          radio_on = false;
        }
        mouse_dirty = key_dirty = consumer_dirty = true;
      }
      bool link = nape_radio_connected();
      if ((!radio_on && seen_epoch != atomic_get(&usb_epoch)) ||
          (radio_on && link != seen_radio_link)) {
        nape_input_cancel(&engine);
        dx = dy = wheel = pan = 0;
        mouse_dirty = key_dirty = consumer_dirty = true;
      }
      seen_epoch = atomic_get(&usb_epoch);
      seen_radio_link = link;
      uint32_t now = k_uptime_get_32();
      uint8_t next_raw = nape_buttons_read();
      for (unsigned i = 0; i < 7; i++) {
        uint8_t bit = 1u << i;
        if ((next_raw ^ raw) & bit)
          changed[i] = now;
        if (((stable ^ next_raw) & bit) &&
            now - changed[i] >= config.debounce_ms) {
          stable ^= bit;
          nape_input_button(&engine, i, !!(stable & bit), now);
        }
      }
      raw = next_raw;
      nape_input_tick(&engine, now);
      int ring = nape_ring_read();
      if (ring)
        nape_input_wheel(&engine, ring);
      struct nape_motion_settings m = nape_input_motion_settings(&engine);
      if (now - last_sample >= 1000 / m.report_hz) {
        last_sample = now;
        if (sensor_ok) {
          int16_t x, y;
          int rc = nape_sensor_dpi(m.dpi);
          if (!rc)
            rc = nape_sensor_read(&x, &y);
          if (rc) {
            errors++;
            sensor_result = rc;
          } else {
            samples++;
            nape_input_motion(&engine, x, y);
          }
        }
        reports();
      }
    }
    k_mutex_unlock(&input_lock);
    k_sem_take(&input_tick, K_FOREVER);
  }
}
K_THREAD_DEFINE(input_worker, 4096, loop, NULL, NULL, NULL, 6, 0,
                SYS_FOREVER_MS);
void nape_runtime_start(void) {
  if (recovery)
    return;
  if (launched) {
    if (!running) {
      nape_config_load(&config);
      nape_runtime_apply(&config);
    }
    return;
  }
  launched = true;
  nape_config_load(&config);
  nape_runtime_apply(&config);
  k_thread_start(input_worker);
}
