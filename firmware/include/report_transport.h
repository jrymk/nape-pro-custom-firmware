#pragma once
#include <stdbool.h>
#include <stdint.h>
int nape_mouse_usb_init(void);
void nape_reports_usb(bool configured);
bool nape_usb_ready(void);
bool nape_usb_mouse(uint8_t buttons, int16_t x, int16_t y, int16_t wheel,
                    int16_t pan);
bool nape_usb_keyboard(const uint8_t report[8]);
bool nape_usb_consumer(uint8_t buttons);
unsigned nape_usb_scroll_multiplier(unsigned axis);
bool nape_radio_start(const uint8_t bond[12]);
bool nape_radio_connected(void);
void nape_radio_stop(void);
bool nape_radio_mouse(uint8_t buttons, int16_t x, int16_t y, int8_t wheel,
                      int8_t pan);
