#pragma once
#include "service.h"

void indicator_set(enum state state);
void indicator_rgb(const uint8_t rgb[3], bool blink);
void indicator_recovery(void);
void indicator_calibrate(uint8_t gamma, const uint8_t gains[3], uint8_t brightness);
void indicator_color(enum state state, uint32_t elapsed_ms, uint8_t rgb[3]);
