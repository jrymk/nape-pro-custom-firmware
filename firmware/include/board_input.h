#pragma once
#include <stdbool.h>
#include <stdint.h>
int nape_buttons_init(void);
bool nape_recovery_chord(void);
uint8_t nape_buttons_read(void);
bool nape_radio_switch(void);
int nape_ring_read(void);
int nape_sensor_init(void);
int nape_sensor_dpi(uint16_t dpi);
int nape_sensor_read(int16_t *x, int16_t *y);
uint8_t nape_sensor_id(void);
