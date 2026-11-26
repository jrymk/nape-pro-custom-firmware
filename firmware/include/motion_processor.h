#pragma once
#include <stdint.h>
/* Transport-neutral wheel units: 120 per detent. Fractional sensor counts are
 * retained between samples. Future gesture/dial processors belong here. */
struct nape_motion_processor {
  int32_t remainder_x, remainder_y;
  uint16_t counts;
  uint8_t mode;
};
struct nape_motion_output {
  int32_t x, y, wheel, pan;
};
struct nape_motion_output nape_motion_process(struct nape_motion_processor *,
                                              uint8_t mode, uint16_t counts,
                                              int16_t x, int16_t y);
