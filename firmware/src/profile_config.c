/* Versioned wire encoding, independent of compiler packing and native structs.
 */
#include "profile_config.h"
#include <string.h>
static uint16_t r16(const uint8_t *p) { return p[0] | ((uint16_t)p[1] << 8); }
static uint32_t r32(const uint8_t *p) {
  return r16(p) | ((uint32_t)r16(p + 2) << 16);
}
static void w16(uint8_t *p, uint16_t v) {
  p[0] = v;
  p[1] = v >> 8;
}
static void w32(uint8_t *p, uint32_t v) {
  w16(p, v);
  w16(p + 2, v >> 16);
}
uint32_t nape_crc32(const void *data, size_t n) {
  const uint8_t *p = data;
  uint32_t c = ~0u;
  while (n--) {
    c ^= *p++;
    for (unsigned i = 0; i < 8; i++)
      c = (c >> 1) ^ (0xedb88320u & -(c & 1));
  }
  return ~c;
}
static bool action_valid(uint16_t a) {
  return a <= 12 || (a >= 0x4001 && a <= 0x4008) ||
         ((a & 0x8000) && !(a & 0x7800) && (a & 127) >= 4 && (a & 127) <= 115);
}
bool nape_config_decode(struct nape_config *c, const uint8_t *wire, size_t n) {
  if (n != NAPE_CONFIG_SIZE || memcmp(wire, "NPCFG002", 8))
    return false;
  memset(c, 0, sizeof(*c));
  c->input.selector_button = wire[8];
  c->initial_profile = wire[9];
  c->transport = wire[11];
  memcpy(c->bond, wire + 12, 12);
  c->debounce_ms = r16(wire + 24);
  c->led_gamma = wire[26];
  memcpy(c->led_gain, wire + 28, 3);
  c->led_brightness = wire[31];
  if (c->input.selector_button >= 7 ||
      (c->initial_profile >= 8 && c->initial_profile != NAPE_START_LAST) ||
      wire[10] || c->transport > 2 || c->debounce_ms < 1 ||
      c->debounce_ms > 30 || wire[27])
    return false;
  if (c->led_gamma && (c->led_gamma < 10 || c->led_gamma > 40))
    return false;
  for (unsigned i = 28; i < 32; i++)
    if (wire[i] > 100 || (!c->led_gamma && wire[i]))
      return false;
  const uint8_t *p = wire + 32;
  for (unsigned i = 0; i < 8; i++) {
    struct nape_profile *pr = &c->input.profile[i];
    memcpy(pr->name, p, 24);
    if (pr->name[23])
      return false;
    memcpy(pr->rgb, p + 24, 3);
    pr->disabled = p[27] != 0;
    if (p[27] > 1)
      return false;
    pr->report_hz = r16(p + 28);
    pr->selector_tap = r16(p + 30);
    p += 32;
    if ((pr->report_hz != 125 && pr->report_hz != 250 && pr->report_hz != 500 &&
         pr->report_hz != 1000) ||
        !action_valid(pr->selector_tap))
      return false;
    for (unsigned l = 0; l < 8; l++, p += 72) {
      struct nape_layer *ly = &pr->layer[l];
      ly->dpi = r16(p);
      ly->motion = p[2];
      ly->led_override = p[3];
      memcpy(ly->rgb, p + 4, 3);
      ly->scroll_counts = r16(p + 8);
      ly->orientation = p[10];
      if (ly->orientation > 4 || (!l && !ly->orientation))
        return false;
      if ((ly->dpi && (ly->dpi < 400 || ly->dpi > 4000)) ||
          ly->motion > NAPE_NONE || p[3] > 1 ||
          (!l && (!ly->dpi || !ly->motion)) || ly->scroll_counts > 4000 || p[7])
        return false;
      if (p[11])
        return false;
      for (unsigned d = 0; d < 2; d++) {
        ly->wheel[d] = r16(p + 12 + d * 2);
        if (ly->wheel[d] != 0x7fff && !action_valid(ly->wheel[d]))
          return false;
      }
      for (unsigned b = 0; b < 7; b++) {
        const uint8_t *q = p + 16 + b * 8;
        struct nape_binding *v = &ly->button[b];
        v->kind = q[0];
        v->layer = q[1];
        v->output = r16(q + 2);
        v->value = r32(q + 4);
        if (v->kind > NAPE_REPEAT_OUTPUT || !action_valid(v->output))
          return false;
        if (b == c->input.selector_button && v->kind != NAPE_TRANSPARENT &&
            v->kind != NAPE_DISABLED)
          return false;
        bool layer = v->kind == NAPE_LAYER_HOLD ||
                     v->kind == NAPE_LAYER_RELEASE ||
                     v->kind == NAPE_LAYER_TOGGLE ||
                     (v->kind >= NAPE_LAYER_RELEASE_DPI &&
                      v->kind <= NAPE_LAYER_RELEASE_RESET);
        if (layer && (!v->layer || v->layer >= 8))
          return false;
        if (!layer && v->layer)
          return false;
        if ((v->kind == NAPE_OUTPUT || v->kind == NAPE_PRESS_OUTPUT ||
             v->kind == NAPE_REPEAT_OUTPUT) &&
            !v->output)
          return false;
        if (v->kind != NAPE_OUTPUT && v->kind != NAPE_LAYER_RELEASE &&
            v->kind != NAPE_PRESS_OUTPUT && v->kind != NAPE_REPEAT_OUTPUT &&
            v->output)
          return false;
        if ((v->kind == NAPE_SET_DPI || v->kind == NAPE_HOLD_DPI ||
             v->kind == NAPE_LAYER_RELEASE_DPI) &&
            (v->value < 400 || v->value > 4000))
          return false;
        if ((v->kind == NAPE_SET_MOTION || v->kind == NAPE_HOLD_MOTION ||
             v->kind == NAPE_LAYER_RELEASE_MOTION) &&
            (nape_motion_mode(v->value) < NAPE_POINTER ||
             nape_motion_mode(v->value) > NAPE_NONE ||
             nape_motion_counts(v->value) > 4000 ||
             (nape_motion_mode(v->value) != NAPE_SCROLL &&
              nape_motion_counts(v->value))))
          return false;
        if ((v->kind == NAPE_SET_LED || v->kind == NAPE_HOLD_LED ||
             v->kind == NAPE_LAYER_RELEASE_LED) &&
            v->value > 0xffffff)
          return false;
        if (v->kind == NAPE_REPEAT_OUTPUT && (v->value < 20 || v->value > 2000))
          return false;
        if (v->kind != NAPE_SET_DPI && v->kind != NAPE_SET_MOTION &&
            v->kind != NAPE_SET_LED &&
            !(v->kind >= NAPE_HOLD_DPI && v->kind <= NAPE_LAYER_RELEASE_LED) &&
            v->kind != NAPE_REPEAT_OUTPUT && v->value)
          return false;
      }
    }
  }
  if (c->initial_profile != NAPE_START_LAST)
    return !c->input.profile[c->initial_profile].disabled;
  for (unsigned i = 0; i < NAPE_PROFILES; i++)
    if (!c->input.profile[i].disabled)
      return true;
  return false;
}
void nape_config_encode(uint8_t *wire, const struct nape_config *c) {
  memset(wire, 0, NAPE_CONFIG_SIZE);
  memcpy(wire, "NPCFG002", 8);
  wire[8] = c->input.selector_button;
  wire[9] = c->initial_profile;
  wire[11] = c->transport;
  memcpy(wire + 12, c->bond, 12);
  w16(wire + 24, c->debounce_ms);
  wire[26] = c->led_gamma;
  memcpy(wire + 28, c->led_gain, 3);
  wire[31] = c->led_brightness;
  uint8_t *p = wire + 32;
  for (unsigned i = 0; i < 8; i++) {
    const struct nape_profile *pr = &c->input.profile[i];
    memcpy(p, pr->name, 24);
    memcpy(p + 24, pr->rgb, 3);
    p[27] = pr->disabled;
    w16(p + 28, pr->report_hz);
    w16(p + 30, pr->selector_tap);
    p += 32;
    for (unsigned l = 0; l < 8; l++, p += 72) {
      const struct nape_layer *ly = &pr->layer[l];
      w16(p, ly->dpi);
      p[2] = ly->motion;
      p[3] = ly->led_override;
      memcpy(p + 4, ly->rgb, 3);
      w16(p + 8, ly->scroll_counts);
      p[10] = ly->orientation;
      for (unsigned d = 0; d < 2; d++)
        w16(p + 12 + d * 2, ly->wheel[d]);
      for (unsigned b = 0; b < 7; b++) {
        const struct nape_binding *v = &ly->button[b];
        uint8_t *q = p + 16 + b * 8;
        q[0] = v->kind;
        q[1] = v->layer;
        w16(q + 2, v->output);
        w32(q + 4, v->value);
      }
    }
  }
}
void nape_config_default(struct nape_config *c) {
  memset(c, 0, sizeof(*c));
  c->input.selector_button = 6;
  c->initial_profile = NAPE_START_LAST;
  c->debounce_ms = 4;
  const uint8_t colors[8][3] = {{255, 100, 0}, {160, 0, 255}, {200, 200, 200},
                                {0, 180, 255}, {0, 200, 70},  {255, 0, 100},
                                {80, 80, 255}, {255, 180, 0}};
  for (unsigned p = 0; p < 8; p++) {
    struct nape_profile *pr = &c->input.profile[p];
    memcpy(pr->name, "Profile 1", 10);
    pr->name[8] = '1' + p;
    memcpy(pr->rgb, colors[p], 3);
    pr->report_hz = 500;
    struct nape_layer *l = &pr->layer[0];
    l->dpi = 1600;
    l->motion = NAPE_POINTER;
    l->orientation = 1;
    l->scroll_counts = NAPE_SCROLL_COUNTS_DEFAULT;
    for (unsigned b = 0; b < 4; b++)
      l->button[b] =
          (struct nape_binding){.kind = NAPE_OUTPUT, .output = b + 1};
    l->button[4] = (struct nape_binding){
        .kind = NAPE_LAYER_RELEASE, .layer = 1, .output = 5};
    l->button[5] = (struct nape_binding){.kind = NAPE_LAYER_HOLD, .layer = 2};
    pr->layer[1].motion = NAPE_SCROLL;
    pr->layer[1].led_override = true;
    pr->layer[1].rgb[1] = 180;
    pr->layer[2].dpi = 400;
    pr->layer[2].led_override = true;
    pr->layer[2].rgb[2] = 180;
  }
}
