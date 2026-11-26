/* Stock-receiver link backend and USB diagnostics. All radio state is owned by
 * the radio thread; persistence belongs to the profile configuration module. */
#include "patch_header_check.h"
#include "ppt_simple.h"
#include "rom_api_for_zephyr.h"
#include "service.h"
#include "stock_codec.h"
#include "vector_table.h"
#include <soc.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/byteorder.h>
#ifdef NAPE_MAIN
#include "report_transport.h"
K_MSGQ_DEFINE(mouse_reports, 8, 32, 4);
static atomic_t streaming;
K_SEM_DEFINE(stream_tick, 0, 1);
static void stream_timer(struct k_timer *timer) {
  ARG_UNUSED(timer);
  k_sem_give(&stream_tick);
}
K_TIMER_DEFINE(stream_clock, stream_timer, NULL);
bool nape_radio_connected(void) { return atomic_get(&streaming) != 0; }
bool nape_radio_mouse(uint8_t buttons, int16_t x, int16_t y, int8_t wheel,
                      int8_t pan) {
  uint8_t pdu[8];
  nape_rf_mouse_report(pdu, buttons, x, y, wheel, pan);
  return atomic_get(&streaming) && !k_msgq_put(&mouse_reports, pdu, K_NO_WAIT);
}
#endif
extern const T_ROM_HEADER_FORMAT nonsecure_rom_header;
extern void _isr_wrapper(void);
static atomic_t stage, event_code, tx_count, rx_count, result, busy,
    stop_request;
static atomic_t irq_count, timeout_count;
static atomic_t valid_count, exchange_tx, exchange_rx, connection_found;
static atomic_t mouse_tx[3], mouse_rx[3];
static uint8_t last_receive[16], capture[64], current_channel;
static uint16_t capture_len, capture_stack, capture_rssi;
static struct k_spinlock status_lock;
static bool initialized;
struct radio_command {
  uint8_t op, bond[12], click;
};
K_MSGQ_DEFINE(radio_commands, sizeof(struct radio_command), 1, 4);
K_SEM_DEFINE(radio_done, 0, 1);
static const uint16_t channels[] = {2432, 2447, 2462, 2477, 2407, 2422,
                                    2437, 2452, 2442, 2457, 2472, 2413};

static void radio_isr(void) {
  atomic_inc(&irq_count);
  PRO_MISR_TYPE flags = {.d16 = RD_PPT_REG(PRO_MISR)};
  if (flags.tx_int) {
    (void)RD_PPT_REG(PRO_TX_STACK);
    (void)RD_PPT_REG(PRO_TX_LENGTH);
    atomic_inc(&tx_count);
  }
  if (flags.rx_int) {
    PRO_RX_STACK_TYPE stack = {.d16 = RD_PPT_REG(PRO_RX_STACK)};
    uint16_t len = RD_PPT_REG(PRO_LENGTH);
    /* BZDMA needs BUFFER RAM, not the CPU's interrupt stack. */
    uint8_t *raw = ppt_ctx->rx_buffer;
    if (len <= 63)
      ppt_pop_rx_fifo(0, raw, len + 2);
    else
      ppt_flush_rx_fifo();
    uint16_t rssi = RD_PPT_REG(PRO_RSSI);
    (void)RD_PPT_REG(PRO_RX_HS_UPPER);
    if (stack.rx_hit && !stack.rx_time_out && len > 3 && len <= 63) {
      uint16_t expected = sys_get_le16(raw + len);
      uint16_t crc = nape_rf_unwhiten_crc(raw + 2, len - 2);
      k_spinlock_key_t key = k_spin_lock(&status_lock);
      capture_len = MIN(len + 2, sizeof(capture));
      capture_stack = stack.d16;
      capture_rssi = rssi;
      memcpy(capture, raw, capture_len);
      memset(last_receive, 0, sizeof(last_receive));
      memcpy(last_receive, raw + 2, MIN(len - 2, sizeof(last_receive)));
      k_spin_unlock(&status_lock, key);
      atomic_inc(&rx_count);
      if (!((expected ^ crc) & 0xfeff) && !stack.is_max_length) {
        atomic_inc(&valid_count);
        /* Stock 0x12722c accepts MD1R opcode 7 in reconnect state;
         * the older one-byte response is opcode 5. */
        atomic_set(
            &event_code,
            ((len == 4 && raw[3] == 5) || (len == 6 && raw[3] == 7)) ? 3 : 6);
      } else
        atomic_set(&event_code, 7);
    } else
      atomic_inc(&timeout_count);
    k_sem_give(&radio_done);
  }
  if (flags.kill_ptx_int)
    WR_PPT_REG(PRO_MISR, BIT4);
  if (flags.kill_prx_int)
    WR_PPT_REG(PRO_MISR, BIT5);
  if (flags.reset_trig_int)
    WR_PPT_REG(PRO_MISR, BIT6);
}

static bool radio_init(void) {
  atomic_set(&stage, 1);
  phy_hw_control_init(false);
  atomic_set(&stage, 2);
  phy_init(false);
  atomic_set(&stage, 3);
  thermal_tracking_timer_init();
  atomic_set(&stage, 4);
  T_ROM_HEADER_FORMAT *header = (void *)STACK_ROM_ADDRESS;
  if (memcmp(header->uuid, nonsecure_rom_header.uuid, UUID_SIZE)) {
    atomic_set(&result, 1);
    return false;
  }
  ((BOOL_PATCH_FUNC)header->entry_ptr)();
  RamVectorTableUpdate(BTMAC_VECTORn, (IRQ_Fun)_isr_wrapper);
  RamVectorTableUpdate(BTMAC_WRAP_AROUND_VECTORn, (IRQ_Fun)_isr_wrapper);
  atomic_set(&stage, 5);
  ppt_reg_handler(radio_isr);
  ppt_init();
  if (!ppt_ctx->tx_buffer[0] || !ppt_ctx->rx_buffer) {
    atomic_set(&result, 2);
    return false;
  }
  atomic_set(&stage, 10);
  ppt_phy_param_t phy = {
      .bank = 0, .channel = 0, .rx_phy = PPT_PHY_TYPE_BLE_2M};
  ppt_set_phy_param(&phy);
  ppt_phy_entry_param_t tx_phy = {.preamble_len = 1,
                                  .tx_phy = PPT_PHY_TYPE_BLE_2M};
  ppt_white_entry_param_t whitening = {.len = 0, .value = {0x91, 0x53}};
  for (unsigned i = 0; i < 3; ++i) {
    ppt_set_phy_entry_param(i, &tx_phy);
    ppt_set_white_entry_param(i, &whitening);
  }
  ppt_white_param_t white = {.enable = false};
  ppt_set_white_param(&white);
  ppt_pkt_format_t format = {.addr_len = 4,
                             .hp_len = 0,
                             .length_len = 6,
                             .hs_len = 3,
                             .header_order = PPT_FIELD_BIT_ORDER_MSB,
                             .payload_order = PPT_FIELD_BIT_ORDER_MSB};
  ppt_set_pkt_format(&format);
  ppt_crc_param_t crc = {.len = 0, .include_addr = false};
  ppt_set_crc_param(&crc);
  WR_PPT_REG_FIELD(PRO_RESET_CTRL_REG, fw_rst_enable, 1);
  WR_PPT_REG_FIELD(PRO_RX_MATCH_CONTROL, use_maxlength_compare, 1);
  WR_PPT_REG_FIELD(PRO_MAX_LENGTH, max_length, 63);
  /* Stock MD1R timing at 0x1253c8. */
  WR_PPT_REG(PRO_2M_TRX_ON_DELAY, 0x2836);
  WR_PPT_REG(PRO_RX_TIMEOUT_DELAY,
             (RD_PPT_REG(PRO_RX_TIMEOUT_DELAY) & 0x0f00) | 0x10c8);
  ppt_set_tifs(80);
  /* Stock reconnect explicitly selects RF TX gain; a reset default is not a
   * transmit-power setting. Start at 0 dBm for this short-range diagnostic. */
  ppt_set_tx_power_dbm(0.0f);
  atomic_set(&stage, 11);
  initialized = true;
  return true;
}

static void set_address(uint32_t address) {
  ppt_tx_addr_t tx = {0};
  ppt_rx_addr_t rx = {.enable = true};
  sys_put_le32(address, tx.tx_addr);
  sys_put_le32(address, rx.rx_addr);
  ppt_set_tx_addr(0, &tx);
  ppt_set_rx_addr(0, &rx);
}

static void mouse_test(bool click) {
  uint8_t pdu[8], wire[16];
  unsigned seq = 64;
  atomic_set(&stage, 14);
  const unsigned counts[] = {16, 64, 128};
  for (unsigned phase = 0; phase < 3; ++phase) {
    /* Once a press could have been sent, always attempt releases, even
     * when USB requests stop. Never send movement or wheel input. */
    uint8_t buttons = phase == 1 && click && !atomic_get(&stop_request) ? 1 : 0;
    nape_rf_mouse_report(pdu, buttons, 0, 0, 0, 0);
    for (unsigned i = 0; i < counts[phase]; ++i, ++seq) {
      ppt_reset_tx_fifo(0);
      ppt_set_hp(0, 1 | ((seq & 3) << 1));
      size_t len = nape_rf_frame(wire, sizeof(wire), seq, 0, pdu, sizeof(pdu));
      ppt_push_tx_data(len, wire);
      k_sem_reset(&radio_done);
      uint32_t before = atomic_get(&valid_count);
      atomic_inc(&mouse_tx[phase]);
      ppt_execute_instruction(PPT_HW_INSTRUCTION_PTX_ENABLE);
      if (k_sem_take(&radio_done, K_MSEC(3))) {
        atomic_set(&result, 4);
        /* Hardware state is unknown; a release retry after a later
         * reconnect is safer than restarting this peripheral here. */
        atomic_set(&stage, 15);
        return;
      }
      if (atomic_get(&valid_count) != before)
        atomic_inc(&mouse_rx[phase]);
      k_busy_wait(900);
      if (phase < 2 && atomic_get(&stop_request))
        break;
    }
  }
  atomic_set(&stage, 15);
}

static void reconnect(const uint8_t bytes[12], bool mouse, bool click) {
  uint32_t bond[3];
  for (unsigned i = 0; i < 3; ++i)
    bond[i] = sys_get_le32(bytes + i * 4);
  uint8_t pdu[3], wire[8];
  uint32_t address;
  nape_rf_connect_request(pdu, 1000);
  if (!nape_rf_select_address(bond, 1, &address)) {
    atomic_set(&result, 3);
    return;
  }
  atomic_clear(&connection_found);
  atomic_clear(&exchange_tx);
  atomic_clear(&exchange_rx);
  for (unsigned i = 0; i < 3; ++i) {
    atomic_clear(&mouse_tx[i]);
    atomic_clear(&mouse_rx[i]);
  }
  atomic_set(&stage, 6);
  atomic_set(&event_code, 0);
  set_address(address);
  ppt_ptx_mode_ext_t mode = {.base = {.ack_mode = true,
                                      .periodic_mode = false,
                                      .periodic_interval = 7},
                             .retransmit_times = 0xffff};
  ppt_set_ptx_mode_ext(&mode);
  for (unsigned attempt = 0; attempt < 1200 && !atomic_get(&stop_request);
       ++attempt) {
    current_channel = attempt % (sizeof(channels) / sizeof(channels[0]));
    ppt_set_phy_channel(channels[current_channel]);
    ppt_set_hp(0, 0);
    ppt_reset_tx_fifo(0);
    size_t len =
        nape_rf_frame(wire, sizeof(wire), attempt, 0, pdu, sizeof(pdu));
    ppt_push_tx_data(len, wire);
    k_sem_reset(&radio_done);
    ppt_execute_instruction(PPT_HW_INSTRUCTION_PTX_ENABLE);
    if (k_sem_take(&radio_done, K_MSEC(3))) {
      atomic_set(&result, 4);
      break; /* Stop on unknown hardware state. */
    }
    if (atomic_get(&event_code) == 3) {
      atomic_set(&connection_found, 1);
      break;
    }
    k_usleep(1000);
    if (attempt == 599 && nape_rf_select_address(bond, 2, &address))
      set_address(address);
  }
  atomic_set(&stage, 8);
  if (!atomic_get(&connection_found) || atomic_get(&stop_request))
    return;
  /* A bounded link test: opcode 0 is the stock empty PDU. No keyboard,
   * mouse, pairing or receiver configuration commands are sent. */
  atomic_set(&stage, 12);
  const uint8_t empty = 0;
  for (unsigned i = 0; i < 64 && !atomic_get(&stop_request); ++i) {
    ppt_reset_tx_fifo(0);
    ppt_set_hp(0, 1 | ((i & 3) << 1));
    size_t len = nape_rf_frame(wire, sizeof(wire), i, 0, &empty, 1);
    ppt_push_tx_data(len, wire);
    k_sem_reset(&radio_done);
    uint32_t before = atomic_get(&valid_count);
    atomic_inc(&exchange_tx);
    ppt_execute_instruction(PPT_HW_INSTRUCTION_PTX_ENABLE);
    if (k_sem_take(&radio_done, K_MSEC(3))) {
      atomic_set(&result, 4);
      break;
    }
    if (atomic_get(&valid_count) != before)
      atomic_inc(&exchange_rx);
    k_busy_wait(900);
  }
  atomic_set(&stage, 13);
  if (mouse && atomic_get(&exchange_rx) && !atomic_get(&result) &&
      !atomic_get(&stop_request))
    mouse_test(click);
}

#ifdef NAPE_MAIN
/* Initial live backend: stock ACK framing, keepalives, and rescan on loss.
 * Adaptive hopping and low-power scheduling remain separate work. */
static void stream_mouse(const uint8_t bond[12]) {
  uint8_t pdu[8] = {0x3f}, wire[16];
  unsigned seq = 0, misses = 0;
  bool pending = false;
  atomic_clear(&streaming);
  k_timer_start(&stream_clock, K_MSEC(1), K_MSEC(1));
  while (!atomic_get(&stop_request)) {
    if (!atomic_get(&connection_found) || misses >= 16) {
      atomic_clear(&streaming);
      k_msgq_purge(&mouse_reports);
      reconnect(bond, false, false);
      pending = false;
      misses = 0;
      memset(pdu, 0, 8);
      pdu[0] = 0x3f;
      if (atomic_get(&result))
        break;
      if (!atomic_get(&connection_found)) {
        k_msleep(100);
        continue;
      }
      atomic_set(&streaming, 1);
    }
    atomic_set(&stage, 16);
    if (!pending) {
      /* Repeat button state, never relative movement, during idle. */
      memset(pdu + 2, 0, 6);
      k_msgq_get(&mouse_reports, pdu, K_NO_WAIT);
      pending = true;
    }
    ppt_reset_tx_fifo(0);
    ppt_set_hp(0, 1 | ((seq & 3) << 1));
    size_t n = nape_rf_frame(wire, sizeof(wire), seq, 0, pdu, 8);
    ppt_push_tx_data(n, wire);
    k_sem_reset(&radio_done);
    uint32_t before = atomic_get(&valid_count);
    ppt_execute_instruction(PPT_HW_INSTRUCTION_PTX_ENABLE);
    if (k_sem_take(&radio_done, K_MSEC(3))) {
      atomic_set(&result, 4);
      break;
    }
    if (atomic_get(&valid_count) != before) {
      pending = false;
      seq++;
      misses = 0;
    } else
      misses++;
    k_sem_take(&stream_tick, K_FOREVER);
  }
  atomic_clear(&streaming);
  k_msgq_purge(&mouse_reports);
  k_timer_stop(&stream_clock);
  /* Best-effort neutral release on orderly stop. */
  if (!atomic_get(&result) && atomic_get(&connection_found))
    mouse_test(false);
}
bool nape_radio_start(const uint8_t bond[12]) {
  if (!atomic_cas(&busy, 0, 1))
    return false;
  struct radio_command cmd = {.op = 0x29};
  memcpy(cmd.bond, bond, 12);
  if (k_msgq_put(&radio_commands, &cmd, K_NO_WAIT)) {
    atomic_clear(&busy);
    return false;
  }
  return true;
}
void nape_radio_stop(void) {
  if (!atomic_get(&busy))
    return;
  atomic_set(&stop_request, 1);
  struct radio_command cmd = {.op = 0x23};
  k_msgq_put(&radio_commands, &cmd, K_MSEC(50));
  for (unsigned i = 0; i < 500 && atomic_get(&busy); i++)
    k_msleep(1);
}
#endif

static void radio_thread(void *a, void *b, void *c) {
  ARG_UNUSED(a);
  ARG_UNUSED(b);
  ARG_UNUSED(c);
  struct radio_command cmd;
  while (true) {
    k_msgq_get(&radio_commands, &cmd, K_FOREVER);
    if (cmd.op == 0x23) {
      if (initialized) {
        ppt_execute_instruction(PPT_HW_INSTRUCTION_PTX_DISABLE);
        k_msleep(5);
        WR_PPT_REG(PRO_IMR, 0xffff);
      }
      atomic_set(&stage, 7);
      atomic_clear(&busy);
      continue;
    }
    atomic_clear(&stop_request);
    atomic_set(&result, 0);
    if (!initialized && !radio_init()) {
      atomic_set(&stage, 9);
      continue;
    }
    WR_PPT_REG(PRO_IMR, 0);
    if (cmd.op == 0x21 || cmd.op == 0x28)
      reconnect(cmd.bond, cmd.op == 0x28, cmd.click);
#ifdef NAPE_MAIN
    if (cmd.op == 0x29) {
      atomic_clear(&connection_found);
      stream_mouse(cmd.bond);
    }
#endif
  }
}
K_THREAD_DEFINE(radio_worker, 4096, radio_thread, NULL, NULL, NULL, 5, 0, 0);

bool radio_probe_busy(void) { return atomic_get(&busy) != 0; }
int radio_probe_request(const struct packet *p, struct packet *r) {
  if (p->op == 0x26)
    return (p->len || p->offset) ? BAD_PACKET : OK;
  if (p->op == 0x27) {
    /* Diagnostic reads only: ROM and on-chip SRAM, never MMIO or flash. */
    uint32_t addr = p->offset;
    if (p->len != 1 || !p->data[0] || p->data[0] > 48)
      return BAD_PACKET;
    uint32_t end = addr + p->data[0];
    if (end < addr || !((addr < 0x80000 && end <= 0x80000) ||
                        (addr >= 0x100000 && end <= 0x140000)))
      return BAD_PACKET;
    memcpy(r->data, (const void *)addr, p->data[0]);
    r->len = p->data[0];
    return OK;
  }
  if (p->op == 0x20) {
    if (p->len || p->offset)
      return BAD_PACKET;
    uint32_t fields[] = {atomic_get(&stage),    atomic_get(&event_code),
                         atomic_get(&tx_count), atomic_get(&rx_count),
                         atomic_get(&result),   atomic_get(&busy)};
    for (unsigned i = 0; i < sizeof(fields) / sizeof(fields[0]); ++i)
      sys_put_le32(fields[i], r->data + i * 4);
    k_spinlock_key_t key = k_spin_lock(&status_lock);
    memcpy(r->data + 24, last_receive, 16);
    k_spin_unlock(&status_lock, key);
    r->len = 40;
    return OK;
  }
  if (p->op == 0x25) {
    if (p->len || p->offset > 4)
      return BAD_PACKET;
    if (p->offset == 4) {
      for (unsigned i = 0; i < 3; ++i) {
        sys_put_le32(atomic_get(&mouse_tx[i]), r->data + i * 8);
        sys_put_le32(atomic_get(&mouse_rx[i]), r->data + i * 8 + 4);
      }
      r->len = 24;
      return OK;
    }
    if (p->offset == 3) {
      uint32_t values[] = {atomic_get(&connection_found),
                           atomic_get(&exchange_tx), atomic_get(&exchange_rx),
                           atomic_get(&valid_count)};
      for (unsigned i = 0; i < 4; ++i)
        sys_put_le32(values[i], r->data + 4 * i);
      r->len = 16;
      return OK;
    }
    if (p->offset == 2) {
      unsigned key = irq_lock();
      memcpy(r->data, &radio_worker->callee_saved,
             sizeof(radio_worker->callee_saved));
      sys_put_le32(radio_worker->arch.basepri, r->data + 36);
      sys_put_le32(radio_worker->arch.mode, r->data + 40);
      irq_unlock(key);
      r->len = 44;
      return OK;
    }
    k_spinlock_key_t key = k_spin_lock(&status_lock);
    sys_put_le16(capture_len, r->data);
    sys_put_le16(capture_stack, r->data + 2);
    sys_put_le16(capture_rssi, r->data + 4);
    r->data[6] = current_channel;
    r->data[7] = (uint8_t)atomic_get(&irq_count);
    sys_put_le32(atomic_get(&timeout_count), r->data + 8);
    memcpy(r->data + 12, capture + p->offset * 32, 32);
    k_spin_unlock(&status_lock, key);
    r->len = 44;
    return OK;
  }
  if (p->op != 0x21 && p->op != 0x23 && p->op != 0x24 && p->op != 0x28)
    return BAD_PACKET;
  if (p->offset || p->len != (p->op == 0x28 ? 13 : p->op == 0x21 ? 12 : 0))
    return BAD_PACKET;
  if (p->op == 0x28 && p->data[12] > 1)
    return BAD_PACKET;
  if (p->op != 0x23 && !atomic_cas(&busy, 0, 1))
    return BAD_STATE;
  if (p->op == 0x23)
    atomic_set(&stop_request, 1);
  struct radio_command cmd = {.op = p->op};
  if (p->len)
    memcpy(cmd.bond, p->data, 12);
  cmd.click = p->op == 0x28 ? p->data[12] : 0;
  if (k_msgq_put(&radio_commands, &cmd, K_NO_WAIT)) {
    if (p->op != 0x23)
      atomic_clear(&busy);
    return BAD_STATE;
  }
  return OK;
}
