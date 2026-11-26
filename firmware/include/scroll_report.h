#ifndef NAPE_SCROLL_REPORT_H
#define NAPE_SCROLL_REPORT_H
#include <stdbool.h>
#include <stdint.h>

/* Independent 250 Hz axes, immediate first report after idle. Never put two
 * nonzero scroll axes in the same report: Windows exposes one wheel delta per
 * mouse input packet. Alternate when both are ready, retaining all remainders. */
#define NAPE_SCROLL_INTERVAL_MS 4u
struct nape_scroll_report {
  uint32_t last_sent[2];
  uint8_t sent;
  bool next_pan;
};
static inline int16_t nape_scroll_delta(int32_t pending, unsigned multiplier,
                                        bool radio) {
  /* Keep division signed: negative low-resolution deltas must not become
   * enormous positive scroll reports through unsigned integer promotion. */
  int32_t value = pending / (120 / (int32_t)multiplier);
  int32_t limit = radio ? 127 : 32767;
  return value > limit ? limit : value < -limit ? -limit : value;
}
static inline bool nape_scroll_due(const struct nape_scroll_report *s,
                                  unsigned axis, uint32_t now) {
  return !(s->sent & (1u << axis)) ||
         (uint32_t)(now - s->last_sent[axis]) >= NAPE_SCROLL_INTERVAL_MS;
}
static inline void nape_scroll_select(const struct nape_scroll_report *s,
                                     uint32_t now, int16_t *wheel, int16_t *pan) {
  if (!nape_scroll_due(s, 0, now)) *wheel = 0;
  if (!nape_scroll_due(s, 1, now)) *pan = 0;
  if (*wheel && *pan) {
    if (s->next_pan) *wheel = 0;
    else *pan = 0;
  }
}
static inline void nape_scroll_sent(struct nape_scroll_report *s, uint32_t now,
                                   int16_t wheel, int16_t pan) {
  if (!wheel && !pan) return;
  unsigned axis = pan ? 1 : 0;
  s->sent |= 1u << axis;
  s->last_sent[axis] = now;
  s->next_pan = !axis;
}
#endif
