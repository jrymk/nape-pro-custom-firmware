#pragma once
#include "profile_config.h"
void nape_runtime_start(void);
void nape_runtime_poll(void);
void nape_runtime_recovery(void);
bool nape_runtime_is_recovery(void);
void nape_runtime_apply(const struct nape_config *);
void nape_runtime_preview(const struct nape_config *, bool enabled,
                          uint8_t profile);
void nape_runtime_pause(void);
void nape_runtime_usb(bool configured);
void nape_runtime_status(uint8_t out[48]);
int nape_mouse_usb_init(void);
