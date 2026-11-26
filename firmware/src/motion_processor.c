#include "motion_processor.h"
#include "input_engine.h"
struct nape_motion_output nape_motion_process(struct nape_motion_processor *p,
                                              uint8_t mode, uint16_t counts,
                                              int16_t x, int16_t y) {
  struct nape_motion_output out = {0};
  if (!counts)
    counts = NAPE_SCROLL_COUNTS_DEFAULT;
  if (mode != p->mode || counts != p->counts) {
    p->remainder_x = p->remainder_y = 0;
    p->mode = mode;
    p->counts = counts;
  }
  if (mode == NAPE_POINTER) {
    out.x = x;
    out.y = y;
  } else if (mode == NAPE_SCROLL) {
    p->remainder_x += x;
    p->remainder_y += y;
    /* Stock Nape behavior: one step on one axis. Vertical has priority;
     * clear BOTH accumulators after a step so diagonal motion cannot create
     * an unwanted sideways backlog. Counts is the adjustable step threshold. */
    if (p->remainder_y >= counts || p->remainder_y <= -(int32_t)counts)
      out.wheel = p->remainder_y < 0 ? 120 : -120;
    else if (p->remainder_x >= counts || p->remainder_x <= -(int32_t)counts)
      out.pan = p->remainder_x < 0 ? -120 : 120;
    if (out.wheel || out.pan)
      p->remainder_x = p->remainder_y = 0;
  }
  return out;
}
