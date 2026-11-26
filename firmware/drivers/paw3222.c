/* PAW3222 register sequence recovered from retail 1.3.3. No stock executable
 * code. */
#include "board_input.h"
#include <rtl_pinmux.h>
#include <rtl_rcc.h>
#include <rtl_spi3w.h>
#include <zephyr/kernel.h>
static uint8_t product_id;
static uint16_t current_dpi;
static int ready(void) {
  for (unsigned i = 0; i < 200; i++) {
    if (SPI3W_GetFlagStatus(SPI3W_FLAG_BUSY) != SET)
      return 0;
    k_busy_wait(1);
  }
  return -ETIMEDOUT;
}
static int read_reg(uint8_t reg, uint8_t *out) {
  int rc = ready();
  if (rc)
    return rc;
  SPI3W_ClearRxDataLen();
  SPI3W_StartRead(reg, 1);
  rc = ready();
  if (rc)
    return rc;
  for (unsigned i = 0; i < 200; i++) {
    if (SPI3W_GetRxDataLen()) {
      SPI3W_ReadBuf(out, 1);
      return 0;
    }
    k_busy_wait(1);
  }
  return -ETIMEDOUT;
}
static int write_reg(uint8_t reg, uint8_t val) {
  int rc = ready();
  if (rc)
    return rc;
  SPI3W_StartWrite(reg | 0x80, val);
  return ready();
}
uint8_t nape_sensor_id(void) { return product_id; }
int nape_sensor_dpi(uint16_t dpi) {
  if (dpi == current_dpi)
    return 0;
  if (dpi < 400 || dpi > 4000)
    return -EINVAL;
  int rc = write_reg(9, 0x5a);
  if (rc)
    return rc;
  rc = write_reg(0x0d, MAX(16, dpi / 30));
  if (rc)
    return rc;
  rc = write_reg(0x0e, MAX(16, dpi / 29));
  if (rc)
    return rc;
  rc = write_reg(9, 0);
  if (!rc)
    current_dpi = dpi;
  return rc;
}
int nape_sensor_init(void) {
  const uint8_t pads[] = {P4_0, P4_1, P4_3};
  const uint8_t funcs[] = {SPI2W_CLK, SPI2W_DATA, SPI2W_CS};
  for (unsigned i = 0; i < 3; i++) {
    Pad_Config(pads[i], PAD_PINMUX_MODE, PAD_IS_PWRON, PAD_PULL_NONE,
               PAD_OUT_ENABLE, PAD_OUT_HIGH);
    Pinmux_Config(pads[i], funcs[i]);
  }
  RCC_PeriphClockCmd(APBPeriph_SPI3W, APBPeriph_SPI3W_CLOCK, ENABLE);
  SPI3W_InitTypeDef s;
  SPI3W_StructInit(&s);
  s.SPI3W_SysClock = 20000000;
  s.SPI3W_Speed = 2000000;
  s.SPI3W_Mode = SPI3W_3WIRE_MODE;
  s.SPI3W_ReadDelay = 3;
  s.SPI3W_OutputDelay = SPI3W_OE_DELAY_NONE;
  s.SPI3W_ExtMode = SPI3W_NORMAL_MODE;
  SPI3W_Init(&s);
  SPI3W_SetResyncTime(2);
  SPI3W_ResyncSignalCmd(ENABLE);
  for (unsigned i = 0; SPI3W_GetFlagStatus(SPI3W_FLAG_RESYNC_BUSY) == SET;
       i++) {
    if (i >= 200)
      return -ETIMEDOUT;
    k_busy_wait(1);
  }
  SPI3W_ResyncSignalCmd(DISABLE);
  SPI3W_Cmd(ENABLE);
  k_msleep(2);
  int rc = read_reg(0, &product_id);
  if (rc)
    return rc;
  if (product_id != 0x30)
    return -ENODEV;
  rc = write_reg(6, 0x80);
  if (rc)
    return rc;
  k_msleep(2);
  static const uint8_t init[][2] = {
      {9, 0x5a},    {0xd, 0x23},  {0xe, 0x24},  {0x19, 4},    {0x2b, 0x6d},
      {0x30, 0x2e}, {0x4b, 4},    {0x5c, 0xd3}, {0x7f, 1},    {6, 0x14},
      {0x31, 0x25}, {0x34, 0xc4}, {0x36, 0xcc}, {0x37, 0x42}, {0x38, 1},
      {0x3a, 0x76}, {0x3b, 0x34}, {0x42, 0x39}, {0x43, 0xf2}, {0x44, 0x39},
      {0x45, 0xf0}, {0x46, 0x12}, {0x47, 0x39}, {0x48, 0xe3}, {0x49, 0x48},
      {0x4a, 0xd3}, {0x4b, 0x98}, {0x64, 0x46}, {0x71, 0x28}, {0x72, 0x28},
      {0x7f, 0},    {9, 0}};
  for (unsigned i = 0; i < ARRAY_SIZE(init); i++) {
    rc = write_reg(init[i][0], init[i][1]);
    if (rc)
      return rc;
  }
  uint8_t unused;
  read_reg(2, &unused);
  read_reg(3, &unused);
  read_reg(4, &unused);
  read_reg(0x12, &unused);
  current_dpi = 0;
  return nape_sensor_dpi(1600);
}
int nape_sensor_read(int16_t *x, int16_t *y) {
  *x = *y = 0;
  uint8_t status, lo_x, lo_y, hi;
  int rc = read_reg(2, &status);
  if (rc)
    return rc;
  if (!(status & 0x80))
    return 0;
  rc = read_reg(3, &lo_x);
  if (rc)
    return rc;
  rc = read_reg(4, &lo_y);
  if (rc)
    return rc;
  rc = read_reg(0x12, &hi);
  if (rc)
    return rc;
  if (status & 0x18)
    return -EOVERFLOW;
  int xx = ((hi & 0xf0) << 4) | lo_x, yy = ((hi & 15) << 8) | lo_y;
  *x = xx >= 2048 ? xx - 4096 : xx;
  *y = yy >= 2048 ? yy - 4096 : yy;
  return 0;
}
