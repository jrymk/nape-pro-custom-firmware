#pragma once
#include "input_engine.h"
#include "service.h"
#define NAPE_CONFIG_VERSION 2u
#define NAPE_START_LAST 255u
#define NAPE_CONFIG_SIZE (32u + 8u * (32u + 8u * 72u))
struct nape_config {
  struct nape_input_config input;
  uint8_t initial_profile, transport, bond[12];
  uint16_t debounce_ms;
  /* gamma in tenths; zero selects default correction. Gains/brightness in %. */
  uint8_t led_gamma, led_gain[3], led_brightness;
};
bool nape_config_decode(struct nape_config *, const uint8_t *, size_t);
void nape_config_encode(uint8_t *, const struct nape_config *);
void nape_config_default(struct nape_config *);
uint32_t nape_crc32(const void *, size_t);
bool nape_config_load(struct nape_config *);
uint32_t nape_config_generation(void);
bool nape_config_transfer_active(void);
int nape_profile_history_load(uint32_t generation);
bool nape_profile_history_save(uint8_t profile, uint32_t generation);
int nape_config_command(const struct packet *, struct packet *);
