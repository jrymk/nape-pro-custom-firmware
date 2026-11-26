import { SIZE, encode, decode, crc32 } from "./schema.js";
const ERRORS = [
  "OK",
  "Invalid packet",
  "Operation unavailable in this state",
  "Digest mismatch",
  "Flash I/O failed",
  "Wrong application image",
  "Wrong transfer offset",
  "Unexpected flash layout",
  "Journal conflict",
];
export const STATES = [
  "protected",
  "formatting",
  "owned",
  "restoring",
  "restored",
  "conflict",
];
export class NapeHID {
  constructor(device, { timeout = 12000, onDisconnect = () => {} } = {}) {
    this.device = device;
    this.timeout = timeout;
    this.onDisconnect = onDisconnect;
    this.token = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
    this.queue = Promise.resolve();
    this.pending = null;
    this.failed = false;
    this.report = (e) => this.receive(e);
    this.disconnected = (e) => {
      if (e.device === device) {
        this.fail(
          Error("Trackball disconnected. Unsaved changes are retained."),
        );
        onDisconnect();
      }
    };
  }
  static supported() {
    return !!globalThis.navigator?.hid && globalThis.isSecureContext;
  }
  static matches(device) {
    return (
      device.vendorId === 0x3434 &&
      device.productId === 0x0440 &&
      device.collections?.some((c) => c.usagePage === 0xff5d && c.usage === 1)
    );
  }
  static async authorized() {
    if (!this.supported()) return [];
    return (await navigator.hid.getDevices()).filter((d) => this.matches(d));
  }
  static async choose() {
    if (!this.supported())
      throw Error(
        "WebHID needs desktop Chrome or Edge on HTTPS or localhost. You can still edit and export JSON offline.",
      );
    const devices = await navigator.hid.requestDevice({
      filters: [
        { vendorId: 0x3434, productId: 0x0440, usagePage: 0xff5d, usage: 1 },
      ],
    });
    if (!devices.length)
      throw Error(
        "No device selected. Connect the trackball’s own USB cable and use custom firmware.",
      );
    return devices[0];
  }
  async open() {
    if (
      !this.device.collections?.some(
        (c) => c.usagePage === 0xff5d && c.usage === 1,
      )
    )
      throw Error("Select the custom maintenance interface.");
    if (!this.device.opened) await this.device.open();
    this.device.addEventListener("inputreport", this.report);
    globalThis.navigator?.hid?.addEventListener(
      "disconnect",
      this.disconnected,
    );
  }
  fail(error) {
    this.failed = true;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(error);
    }
  }
  async close() {
    this.fail(Error("USB connection closed."));
    this.device.removeEventListener("inputreport", this.report);
    globalThis.navigator?.hid?.removeEventListener(
      "disconnect",
      this.disconnected,
    );
    if (this.device.opened) await this.device.close();
  }
  receive(event) {
    if (!this.pending || event.reportId !== 0) return;
    const data = new Uint8Array(
        event.data.buffer,
        event.data.byteOffset,
        event.data.byteLength,
      ),
      p = this.pending;
    if (data.length !== 64) {
      this.fail(Error("Malformed USB response. Reconnect before retrying."));
      return;
    }
    if (p.frame.slice(0, 12).some((x, i) => x !== data[i])) return; // Ignore an unrelated report; never accept a stale operation.
    clearTimeout(p.timer);
    this.pending = null;
    if (data[12] > 48) {
      this.failed = true;
      p.reject(Error("Malformed response length. Reconnect."));
      return;
    }
    if (data[13]) {
      const error = Error(ERRORS[data[13]] || `Device error ${data[13]}`);
      error.code = data[13];
      error.operation = p.frame[3];
      p.reject(error);
      return;
    }
    p.resolve(data.slice(16, 16 + data[12]));
  }
  request(op, offset = 0, data = new Uint8Array()) {
    const task = () => {
      if (this.failed || !this.device.opened)
        throw Error("USB session unavailable. Reconnect before retrying.");
      if (data.length > 48) throw Error("USB payload exceeds 48 bytes.");
      const frame = new Uint8Array(64),
        v = new DataView(frame.buffer);
      frame.set([78, 80, 1, op]);
      v.setUint32(4, this.token, true);
      v.setUint32(8, offset, true);
      frame[12] = data.length;
      frame.set(data, 16);
      return new Promise((resolve, reject) => {
        this.pending = {
          frame,
          resolve,
          reject,
          timer: setTimeout(
            () =>
              this.fail(
                Error(
                  "USB request timed out. Reconnect; use the local utility’s config-resume if input is paused.",
                ),
              ),
            this.timeout,
          ),
        };
        // WebHID takes the report ID separately (unlike hidapi's leading zero).
        Promise.resolve()
          .then(() => this.device.sendReport(0, frame))
          .catch((e) => this.fail(Error(`USB write failed: ${e.message}`)));
      });
    };
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
  async info() {
    const data = await this.request(1);
    if (
      data.length !== 16 ||
      new TextDecoder().decode(data.slice(2)) !== "NAPE-MAINT/v1\0" ||
      data[0] >= STATES.length ||
      data[1] >= STATES.length
    )
      throw Error("Unexpected firmware family.");
    return { state: STATES[data[0]], bootState: STATES[data[1]] };
  }
  async status() {
    const d = await this.request(0x30);
    if (d.length !== 48 || d[0] !== 1)
      throw Error("This firmware does not support the profile editor.");
    const v = new DataView(d.buffer);
    return {
      running: !!d[1],
      profile: d[2],
      buttons: d[3],
      sensor: d[4],
      radio: !!d[5],
      mode: d[6],
      usb: !!d[7],
      sensorResult: v.getInt32(8, true),
      samples: v.getUint32(12, true),
      errors: v.getUint32(16, true),
      dpi: v.getUint16(24, true),
      layers: d[26],
      recovery: !!d[27],
      configVersion: d[42],
      previewActive: !!d[43],
      firmware: v.getUint32(44, true),
    };
  }
  async requireCurrent() {
    if (!currentFirmware(await this.status()))
      throw Error(
        "Update to the current firmware before editing settings (configuration v2 required). Nothing was written.",
      );
  }
  async read(progress = () => {}) {
    await this.requireCurrent();
    let data = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i += 48) {
      const n = Math.min(48, SIZE - i),
        chunk = await this.request(0x31, i, Uint8Array.of(n));
      if (chunk.length !== n) throw Error("Incomplete configuration read.");
      data.set(chunk, i);
      progress(Math.min(i + n, SIZE) / SIZE);
    }
    return decode(data);
  }
  async upload(
    config,
    progress = () => {},
    { preview = false, profile = 255 } = {},
  ) {
    await this.requireCurrent();
    const data = encode(config),
      crc = new Uint8Array(preview ? 5 : 4);
    new DataView(crc.buffer).setUint32(0, crc32(data), true);
    if (preview) crc[4] = profile;
    await this.request(preview ? 0x36 : 0x32, SIZE, crc);
    for (let i = 0; i < SIZE; i += 48) {
      await this.request(0x33, i, data.slice(i, i + 48));
      progress((Math.min(i + 48, SIZE) / SIZE) * 0.65);
    }
    if (preview) {
      const reply = await this.request(0x37);
      if (
        reply.length !== 4 ||
        new DataView(reply.buffer, reply.byteOffset, 4).getUint32(0, true) !==
          crc32(data)
      )
        throw Error("Live preview verification failed.");
      progress(1);
      return;
    }
    await this.request(0x34);
    const readback = encode(await this.read((p) => progress(0.65 + p * 0.35)));
    if (readback.some((x, i) => x !== data[i]))
      throw Error(
        "Saved configuration readback differs. Read from device before making more changes.",
      );
  }
  async resume() {
    await this.request(0x35);
  }
  async discardPreview() {
    await this.requireCurrent();
    await this.request(0x38);
  }
}
export function currentFirmware(status) {
  return status?.configVersion === 2 && status.firmware >= 0x10009;
}
export function firmwareVersion(value) {
  return `${value >>> 16}.${(value >>> 8) & 255}.${value & 255}`;
}
