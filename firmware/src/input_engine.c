#include "input_engine.h"
#include <string.h>

static void emit(struct nape_input *e, uint8_t kind, uint16_t code, int32_t x,
                 int32_t y) {
  struct nape_input_event event = {kind, e->profile, code, x, y};
  if (e->emit)
    e->emit(e->context, &event);
}
static bool valid(const struct nape_input_config *c) {
  if (!c || c->selector_button >= NAPE_BUTTONS)
    return false;
  for (unsigned p = 0; p < NAPE_PROFILES; ++p) {
    const struct nape_profile *pr = &c->profile[p];
    if (!pr->report_hz || !pr->layer[0].dpi ||
        pr->layer[0].motion == NAPE_INHERIT)
      return false;
    for (unsigned l = 0; l < NAPE_LAYERS; ++l) {
      if (pr->layer[l].motion > NAPE_NONE || pr->layer[l].orientation > 4)
        return false;
      for (unsigned b = 0; b < NAPE_BUTTONS; ++b) {
        struct nape_binding v = pr->layer[l].button[b];
        if (v.kind > NAPE_REPEAT_OUTPUT)
          return false;
        if ((v.kind == NAPE_LAYER_HOLD || v.kind == NAPE_LAYER_RELEASE ||
             v.kind == NAPE_LAYER_TOGGLE ||
             (v.kind >= NAPE_LAYER_RELEASE_DPI &&
              v.kind <= NAPE_LAYER_RELEASE_RESET)) &&
            (v.layer == 0 || v.layer >= NAPE_LAYERS))
          return false;
        if ((v.kind == NAPE_OUTPUT || v.kind == NAPE_PRESS_OUTPUT ||
             v.kind == NAPE_REPEAT_OUTPUT) &&
            !v.output)
          return false;
        if (v.kind == NAPE_REPEAT_OUTPUT && (v.value < 20 || v.value > 2000))
          return false;
        if (b == c->selector_button && v.kind != NAPE_DISABLED &&
            v.kind != NAPE_TRANSPARENT)
          return false; /* selector has a separate tap binding */
      }
    }
  }
  return true;
}
bool nape_input_init(struct nape_input *e, const struct nape_input_config *c,
                     uint8_t profile, nape_input_emit fn, void *context) {
  if (!e || profile >= NAPE_PROFILES || !valid(c) ||
      c->profile[profile].disabled)
    return false;
  memset(e, 0, sizeof(*e));
  e->config = c;
  e->profile = profile;
  e->preview = profile;
  e->emit = fn;
  e->context = context;
  return true;
}
static struct nape_binding resolve(const struct nape_input *e, unsigned b) {
  for (int l = NAPE_LAYERS - 1; l >= 0; --l) {
    if (l && !e->layer_refs[l] && !(e->toggled & (1u << l)))
      continue;
    struct nape_binding v = e->config->profile[e->profile].layer[l].button[b];
    if (v.kind != NAPE_TRANSPARENT)
      return v;
  }
  return (struct nape_binding){.kind = NAPE_DISABLED};
}
static bool output_held(const struct nape_input *e, uint16_t output) {
  for (unsigned b = 0; b < NAPE_BUTTONS; ++b)
    if (e->held[b].binding.kind == NAPE_OUTPUT &&
        e->held[b].binding.output == output)
      return true;
  return false;
}
static void tap(struct nape_input *e, uint16_t output) {
  /* A tap must not release an action another physical button is holding. */
  if (output && !output_held(e, output)) {
    emit(e, NAPE_ACTION_DOWN, output, 0, 0);
    emit(e, NAPE_ACTION_UP, output, 0, 0);
  }
}
static void used(struct nape_input *e) {
  e->selector_used = true;
  for (unsigned b = 0; b < NAPE_BUTTONS; ++b)
    if (e->physical & (1u << b))
      e->held[b].used = true;
}
static bool layer_hold(uint8_t kind) {
  return kind == NAPE_LAYER_HOLD || kind == NAPE_LAYER_RELEASE ||
         (kind >= NAPE_LAYER_RELEASE_DPI && kind <= NAPE_LAYER_RELEASE_RESET);
}
static void setting(struct nape_input *e, uint8_t kind, uint32_t value) {
  switch (kind) {
  case NAPE_SET_DPI:
    e->override_dpi = value;
    break;
  case NAPE_SET_MOTION:
    e->override_motion = nape_motion_mode(value);
    e->override_scroll_counts = nape_motion_counts(value);
    break;
  case NAPE_SET_LED:
    e->override_led = true;
    e->led_rgb[0] = value >> 16;
    e->led_rgb[1] = value >> 8;
    e->led_rgb[2] = value;
    break;
  case NAPE_RESET_OVERRIDES:
    e->override_dpi = 0;
    e->override_motion = 0;
    e->override_led = false;
    break;
  }
}
/* Temporary settings are resolved from held owners, never restored from stale
 * snapshots. Releasing owners in any order reveals the next held/persistent
 * value. */
static const struct nape_binding *temporary(const struct nape_input *e,
                                            uint8_t kind) {
  const struct nape_held_binding *latest = NULL;
  for (unsigned b = 0; b < NAPE_BUTTONS; b++)
    if (e->held[b].binding.kind == kind &&
        (!latest || (int32_t)(e->held[b].order - latest->order) > 0))
      latest = &e->held[b];
  return latest ? &latest->binding : NULL;
}
static void release(struct nape_input *e, unsigned b) {
  struct nape_held_binding held = e->held[b];
  memset(&e->held[b], 0, sizeof(e->held[b]));
  if (held.binding.kind == NAPE_OUTPUT && !output_held(e, held.binding.output))
    emit(e, NAPE_ACTION_UP, held.binding.output, 0, 0);
  if (layer_hold(held.binding.kind)) {
    --e->layer_refs[held.binding.layer];
    if (held.binding.kind == NAPE_LAYER_RELEASE && !held.used)
      tap(e, held.binding.output);
    if (held.binding.kind >= NAPE_LAYER_RELEASE_DPI && !held.used)
      setting(e, NAPE_SET_DPI + held.binding.kind - NAPE_LAYER_RELEASE_DPI,
              held.binding.value);
    emit(e, NAPE_CONTEXT_CHANGED, 0, 0, 0);
  }
  if (held.binding.kind >= NAPE_HOLD_DPI && held.binding.kind <= NAPE_HOLD_LED)
    emit(e, NAPE_CONTEXT_CHANGED, 0, 0, 0);
}
static void clear_held(struct nape_input *e) {
  /* Clear outputs once per action even if multiple physical buttons own it. */
  for (unsigned b = 0; b < NAPE_BUTTONS; ++b) {
    struct nape_binding binding = e->held[b].binding;
    memset(&e->held[b], 0, sizeof(e->held[b]));
    if (binding.kind == NAPE_OUTPUT && !output_held(e, binding.output))
      emit(e, NAPE_ACTION_UP, binding.output, 0, 0);
  }
  memset(e->layer_refs, 0, sizeof(e->layer_refs));
  e->toggled = 0;
  e->override_dpi = 0;
  e->override_motion = 0;
  e->override_led = false;
  e->suppressed = e->physical;
  e->selector_used = true;
  e->selecting = false;
  e->preview = e->profile;
}
void nape_input_cancel(struct nape_input *e) {
  bool selecting = e->selecting;
  clear_held(e);
  if (selecting)
    emit(e, NAPE_PROFILE_PREVIEW, e->profile, 0, 0);
  emit(e, NAPE_CONTEXT_CHANGED, 0, 0, 0);
}
bool nape_input_select_profile(struct nape_input *e, uint8_t profile) {
  if (profile >= NAPE_PROFILES || e->config->profile[profile].disabled)
    return false;
  if (profile == e->profile)
    return true;
  clear_held(e);
  e->profile = profile;
  e->preview = profile;
  emit(e, NAPE_PROFILE_COMMIT, profile, 0, 0);
  emit(e, NAPE_CONTEXT_CHANGED, 0, 0, 0);
  return true;
}
void nape_input_button(struct nape_input *e, uint8_t b, bool down,
                       uint32_t now) {
  if (b >= NAPE_BUTTONS)
    return;
  uint8_t bit = 1u << b;
  if (!!(e->physical & bit) == down)
    return; /* duplicate/debounce event */
  if (down)
    e->physical |= bit;
  else
    e->physical &= (uint8_t)~bit;
  if (e->suppressed & bit) {
    if (!down)
      e->suppressed &= (uint8_t)~bit;
    return;
  }
  if (b == e->config->selector_button) {
    if (down) {
      ++e->layer_refs[NAPE_LAYERS - 1];
      emit(e, NAPE_CONTEXT_CHANGED, 0, 0, 0);
      e->selector_at = now;
      e->selector_used = !!(e->physical & ~bit);
      e->selecting = false;
      e->preview = e->profile;
    } else {
      --e->layer_refs[NAPE_LAYERS - 1];
      emit(e, NAPE_CONTEXT_CHANGED, 0, 0, 0);
      if (e->selecting) {
        uint8_t selected = e->preview;
        e->selecting = false;
        if (selected == e->profile)
          emit(e, NAPE_PROFILE_PREVIEW, e->profile, 0, 0);
        else
          nape_input_select_profile(e, selected);
      } else if (!e->selector_used) {
        if (e->config->profile[e->profile].selector_tap)
          used(e);
        tap(e, e->config->profile[e->profile].selector_tap);
      }
    }
    return;
  }
  if (!down) {
    release(e, b);
    return;
  }
  struct nape_binding binding = resolve(e, b);
  /* Disabled presses do not consume an unused-release action. A resolved
   * action does, including transparent fallback and nested layer changes. */
  if (binding.kind != NAPE_DISABLED && binding.kind != NAPE_TRANSPARENT)
    used(e);
  bool already = output_held(e, binding.output);
  e->held[b] = (struct nape_held_binding){
      .binding = binding, .at = now, .order = ++e->order, .used = false};
  if (binding.kind == NAPE_OUTPUT && !already)
    emit(e, NAPE_ACTION_DOWN, binding.output, 0, 0);
  if (binding.kind == NAPE_PRESS_OUTPUT || binding.kind == NAPE_REPEAT_OUTPUT)
    tap(e, binding.output);
  if (layer_hold(binding.kind)) {
    ++e->layer_refs[binding.layer];
    emit(e, NAPE_CONTEXT_CHANGED, 0, 0, 0);
  }
  switch (binding.kind) {
  case NAPE_HOLD_DPI:
  case NAPE_HOLD_MOTION:
  case NAPE_HOLD_LED:
    break;
  case NAPE_SET_DPI:
  case NAPE_SET_MOTION:
  case NAPE_SET_LED:
  case NAPE_RESET_OVERRIDES:
    setting(e, binding.kind, binding.value);
    break;
  case NAPE_LAYER_TOGGLE:
    e->toggled ^= 1u << binding.layer;
    break;
  default:
    return;
  }
  emit(e, NAPE_CONTEXT_CHANGED, 0, 0, 0);
}
void nape_input_tick(struct nape_input *e, uint32_t now) {
  for (unsigned b = 0; b < NAPE_BUTTONS; b++) {
    struct nape_held_binding *h = &e->held[b];
    if (h->binding.kind == NAPE_REPEAT_OUTPUT &&
        now - h->at >= h->binding.value) {
      h->at = now; /* No catch-up burst after a delayed worker tick. */
      tap(e, h->binding.output);
    }
  }
}
void nape_input_wheel(struct nape_input *e, int32_t steps) {
  if (!steps)
    return;
  used(e);
  uint8_t bit = 1u << e->config->selector_button;
  if ((e->physical & bit) || e->layer_refs[7] || (e->toggled & (1u << 7))) {
    if (e->suppressed & bit)
      return;
    e->selecting = true;
    unsigned count = 0;
    for (unsigned i = 0; i < NAPE_PROFILES; i++)
      if (!e->config->profile[i].disabled)
        count++;
    if (!count)
      return;
    unsigned remaining = (steps < 0 ? -(int64_t)steps : (int64_t)steps) % count;
    int direction = steps < 0 ? -1 : 1;
    while (remaining--) {
      do {
        e->preview = (e->preview + direction + NAPE_PROFILES) % NAPE_PROFILES;
      } while (e->config->profile[e->preview].disabled);
    }
    emit(e, NAPE_PROFILE_PREVIEW, e->preview, 0, 0);
    if (!(e->physical & bit)) {
      e->selecting = false;
      nape_input_select_profile(e, e->preview);
    }
  } else {
    unsigned direction = steps > 0 ? 0 : 1;
    uint16_t output = 0;
    for (int l = NAPE_LAYERS - 1; l >= 0; l--) {
      if (l && !e->layer_refs[l] && !(e->toggled & (1u << l)))
        continue;
      output = e->config->profile[e->profile].layer[l].wheel[direction];
      if (output)
        break;
    }
    if (!output) {
      emit(e, NAPE_WHEEL, 0, steps, 0);
      return;
    }
    if (output == 0x7fff)
      return;
    if (output >= 9 && output <= 12) {
      int32_t count = steps > 0 ? steps : -steps;
      emit(e, NAPE_WHEEL, 0,
           output == 9    ? count
           : output == 10 ? -count
                          : 0,
           output == 12   ? count
           : output == 11 ? -count
                          : 0);
    } else {
      /* A rotary detent is a tap, never a held physical button. */
      int32_t count = steps > 0 ? steps : -steps;
      while (count--)
        tap(e, output);
    }
  }
}
struct nape_motion_settings
nape_input_motion_settings(const struct nape_input *e) {
  const struct nape_profile *p = &e->config->profile[e->profile];
  struct nape_motion_settings s = {p->layer[0].dpi, p->report_hz,
                                   p->layer[0].motion, p->layer[0].orientation};
  for (unsigned l = 1; l < NAPE_LAYERS; ++l)
    if (e->layer_refs[l] || (e->toggled & (1u << l))) {
      if (p->layer[l].dpi)
        s.dpi = p->layer[l].dpi;
      if (p->layer[l].motion != NAPE_INHERIT)
        s.mode = p->layer[l].motion;
      /* Orientation inheritance is always from base, not an intermediate layer.
       */
      s.orientation = p->layer[l].orientation ? p->layer[l].orientation
                                              : p->layer[0].orientation;
    }
  if (e->override_dpi)
    s.dpi = e->override_dpi;
  if (e->override_motion)
    s.mode = e->override_motion;
  const struct nape_binding *held_dpi = temporary(e, NAPE_HOLD_DPI);
  const struct nape_binding *held_motion = temporary(e, NAPE_HOLD_MOTION);
  if (held_dpi)
    s.dpi = held_dpi->value;
  if (held_motion)
    s.mode = nape_motion_mode(held_motion->value);
  return s;
}
void nape_input_motion(struct nape_input *e, int32_t x, int32_t y) {
  if (!x && !y)
    return;
  struct nape_motion_settings settings = nape_input_motion_settings(e);
  if (settings.mode == NAPE_NONE)
    return;
  /* Inherited pointer movement must not cancel an unused layer key because
   * of ball jitter. Explicit layer motion/DPI overrides count as use. */
  const struct nape_profile *p = &e->config->profile[e->profile];
  for (unsigned l = 1; l < NAPE_LAYERS; ++l)
    if (e->layer_refs[l] &&
        (p->layer[l].dpi || p->layer[l].motion != NAPE_INHERIT ||
         p->layer[l].orientation)) {
      used(e);
      break;
    }
  int32_t original_x = x;
  switch (settings.orientation) {
  case 2:
    x = -y;
    y = original_x;
    break;
  case 3:
    x = -x;
    y = -y;
    break;
  case 4:
    x = y;
    y = -original_x;
    break;
  default:
    break;
  }
  emit(e, NAPE_MOTION, settings.mode, x, y);
}

void nape_input_color(const struct nape_input *e, uint8_t rgb[3]) {
  const struct nape_profile *p =
      &e->config->profile[e->selecting ? e->preview : e->profile];
  memcpy(rgb, p->rgb, 3);
  if (e->selecting || ((e->physical & ~e->suppressed) &
                       (1u << e->config->selector_button)))
    return;
  for (unsigned l = 0; l < NAPE_LAYERS; ++l)
    if ((!l || e->layer_refs[l] || (e->toggled & (1u << l))) &&
        p->layer[l].led_override)
      memcpy(rgb, p->layer[l].rgb, 3);
  if (e->override_led)
    memcpy(rgb, e->led_rgb, 3);
  const struct nape_binding *held = temporary(e, NAPE_HOLD_LED);
  if (held) {
    rgb[0] = held->value >> 16;
    rgb[1] = held->value >> 8;
    rgb[2] = held->value;
  }
}
uint16_t nape_input_scroll_counts(const struct nape_input *e) {
  const struct nape_profile *p = &e->config->profile[e->profile];
  uint16_t count = NAPE_SCROLL_COUNTS_DEFAULT;
  for (unsigned l = 0; l < NAPE_LAYERS; ++l)
    if ((!l || e->layer_refs[l] || (e->toggled & (1u << l))) &&
        p->layer[l].scroll_counts)
      count = p->layer[l].scroll_counts;
  const struct nape_binding *held = temporary(e, NAPE_HOLD_MOTION);
  if (held) {
    uint16_t action_counts = nape_motion_counts(held->value);
    return action_counts ? action_counts : count;
  }
  return e->override_motion && e->override_scroll_counts
             ? e->override_scroll_counts
             : count;
}
