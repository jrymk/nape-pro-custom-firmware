#pragma once
#include <stdbool.h>
#include <stdint.h>

/* Logical buttons, after board mapping/debounce. No GPIO or transport IDs. */
#define NAPE_PROFILES 8
#define NAPE_LAYERS 8 /* base + seven overlays; higher active layer wins */
#define NAPE_BUTTONS 7
#define NAPE_SCROLL_COUNTS_DEFAULT 16u

/* Motion action value: mode in low 16 bits, counts per detent in high 16.
 * Zero counts inherits the active layer. Pointer actions use zero counts. */
static inline uint16_t nape_motion_mode(uint32_t value) {
  return value & 0xffff;
}
static inline uint16_t nape_motion_counts(uint32_t value) {
  return value >> 16;
}
static inline uint32_t nape_motion_value(uint16_t mode, uint16_t counts) {
  return mode | (uint32_t)counts << 16;
}

enum nape_binding_kind {
  NAPE_TRANSPARENT,
  NAPE_DISABLED,
  NAPE_OUTPUT,
  NAPE_LAYER_HOLD,
  NAPE_LAYER_RELEASE,
  NAPE_SET_DPI,
  NAPE_SET_MOTION,
  NAPE_SET_LED,
  NAPE_RESET_OVERRIDES,
  NAPE_LAYER_TOGGLE,
  NAPE_PRESS_OUTPUT,
  NAPE_HOLD_DPI,
  NAPE_HOLD_MOTION,
  NAPE_HOLD_LED,
  NAPE_LAYER_RELEASE_DPI,
  NAPE_LAYER_RELEASE_MOTION,
  NAPE_LAYER_RELEASE_LED,
  NAPE_LAYER_RELEASE_RESET,
  NAPE_REPEAT_OUTPUT
};
enum nape_motion_mode {
  NAPE_INHERIT,
  NAPE_POINTER,
  NAPE_SCROLL,
  NAPE_NONE
};
struct nape_binding {
  uint8_t kind, layer;
  uint16_t output; /* action ID, or unused-release action; 0 = none */
  uint32_t value;  /* DPI, motion mode, or 0xRRGGBB for setter actions */
};
struct nape_layer {
  struct nape_binding button[NAPE_BUTTONS];
  uint16_t dpi;        /* 0 inherits from lower layer */
  uint8_t motion;      /* NAPE_INHERIT inherits */
  uint8_t orientation; /* 0 inherits; 1=0, 2=90, 3=180, 4=270 degrees CW */
  bool led_override;
  uint8_t rgb[3];
  uint16_t
      wheel[2]; /* CW/CCW: 0 inherit, 0x7fff disabled, otherwise tap action */
  uint16_t scroll_counts; /* counts per wheel detent; 0 inherits */
};
struct nape_profile {
  char name[24];
  bool disabled; /* unused slot; legacy configurations enable every profile */
  uint8_t rgb[3];
  uint16_t
      report_hz; /* requested rate; transport/sensor must validate support */
  uint16_t
      selector_tap; /* action when selector is tapped without other input */
  struct nape_layer layer[NAPE_LAYERS];
};
struct nape_input_config {
  uint8_t selector_button;
  struct nape_profile profile[NAPE_PROFILES];
};
enum nape_input_event_kind {
  NAPE_ACTION_DOWN,
  NAPE_ACTION_UP,
  NAPE_WHEEL,
  NAPE_MOTION,
  NAPE_PROFILE_PREVIEW,
  NAPE_PROFILE_COMMIT,
  NAPE_CONTEXT_CHANGED
};
struct nape_input_event {
  uint8_t kind, profile;
  uint16_t code;
  int32_t x, y;
};
struct nape_motion_settings {
  uint16_t dpi, report_hz;
  uint8_t mode, orientation;
};
typedef void (*nape_input_emit)(void *, const struct nape_input_event *);
struct nape_held_binding {
  struct nape_binding binding;
  uint32_t at, order;
  bool used;
};
struct nape_input {
  const struct nape_input_config *config;
  nape_input_emit emit;
  void *context;
  struct nape_held_binding held[NAPE_BUTTONS];
  uint8_t profile, preview, physical, suppressed, layer_refs[NAPE_LAYERS];
  uint32_t selector_at;
  uint32_t order;
  bool selector_used, selecting;
  uint8_t toggled;
  uint16_t override_dpi;
  uint8_t override_motion;
  uint16_t override_scroll_counts;
  bool override_led;
  uint8_t led_rgb[3];
};

/* Single-threaded caller; config remains immutable/alive; callbacks must not
 * reenter. This module never allocates, writes flash, or sends HID itself. */
bool nape_input_init(struct nape_input *, const struct nape_input_config *,
                     uint8_t initial_profile, nape_input_emit, void *context);
void nape_input_button(struct nape_input *, uint8_t button, bool down,
                       uint32_t now_ms);
void nape_input_wheel(struct nape_input *, int32_t detents);
void nape_input_tick(struct nape_input *, uint32_t now_ms);
void nape_input_motion(struct nape_input *, int32_t x, int32_t y);
struct nape_motion_settings
nape_input_motion_settings(const struct nape_input *);
void nape_input_color(const struct nape_input *, uint8_t rgb[3]);
uint16_t nape_input_scroll_counts(const struct nape_input *);
/* Release outputs before changing profile; held physical buttons are ignored
 * until released. Also useful when replacing settings or losing a transport. */
void nape_input_cancel(struct nape_input *);
bool nape_input_select_profile(struct nape_input *, uint8_t profile);
