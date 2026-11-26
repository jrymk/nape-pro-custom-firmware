#include "indicator.h"

void indicator_color(enum state state, uint32_t elapsed_ms, uint8_t rgb[3]) {
  rgb[0] = rgb[1] = rgb[2] = 0;
  if (state == CONFLICT)
    return;
  if (state != OWNED) {
    if (elapsed_ms % 500 < 250) {
      rgb[0] = 255;
      rgb[1] = 32;
    }
    return;
  }

  /* One second per transition: red, yellow, green, cyan, blue, magenta. */
  static const uint8_t wheel[7][3] = {
      {255, 0, 0}, {255, 255, 0}, {0, 255, 0}, {0, 255, 255},
      {0, 0, 255}, {255, 0, 255}, {255, 0, 0}};
  unsigned segment = (elapsed_ms / 1000) % 6;
  unsigned blend = elapsed_ms % 1000;
  for (unsigned i = 0; i < 3; ++i)
    rgb[i] =
        (wheel[segment][i] * (1000 - blend) + wheel[segment + 1][i] * blend) /
        1000;
}
