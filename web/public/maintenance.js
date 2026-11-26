// File formats and maintenance operations shared by the Device panel and tests.
// No network requests: firmware and personal archives stay in this browser.
import { hex } from "./schema.js";
export const USER_LEN = 0xb000;
export const STOCK_SHA =
  "2a8838e93ebad24f34663c6203adf701244270441c44618e13de7ed5d083cc89";
const text = new TextEncoder();
const ascii = (b) => new TextDecoder().decode(b);
export const equal = (a, b) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
export const sha = async (b) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", b));
const u32 = (b, at) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true);
export async function validateImage(bytes, { stock = false } = {}) {
  const hash = hex(await sha(bytes));
  if (
    bytes.length < 4096 ||
    bytes.length > 0x59000 ||
    ascii(bytes.slice(0x208, 0x210)) !== "KCZKNAPE" ||
    hex(bytes.slice(0x1ac, 0x1bc)) !== "ebfc0ab8ef26ee11ab0f2f10ef11d43d" ||
    hex(bytes.slice(0x1a2, 0x1a8)) !== "0f000101a937" ||
    u32(bytes, 0x1c8) !== 0x0402d000 ||
    u32(bytes, 0x1a8) + 0x500 !== bytes.length ||
    !equal(await sha(bytes.slice(0x1a0)), bytes.slice(0x180, 0x1a0))
  )
    throw Error(
      "Expected a packaged Nape Pro application .bin, not a full flash dump or MPTool wrapper.",
    );
  if (stock ? hash !== STOCK_SHA : !ascii(bytes).includes("NAPE-MAINT/v1\0"))
    throw Error(
      stock
        ? "Stock restoration requires the verified official stock application image. Download it from the GitHub firmware releases link."
        : "Expected custom Nape maintenance firmware.",
    );
  return {
    bytes: bytes.length,
    sha256: hash,
    kind: stock ? "Stock application" : "Custom application",
    address: "0x0402D000",
  };
}
export async function archive(data) {
  if (data.length !== USER_LEN) throw Error("Incomplete user data.");
  const out = new Uint8Array(56 + USER_LEN),
    v = new DataView(out.buffer);
  out.set(text.encode("NAPEBK01KCZKNAPE"));
  v.setUint32(16, 0xf5000, true);
  v.setUint32(20, USER_LEN, true);
  out.set(await sha(data), 24);
  out.set(data, 56);
  return out;
}
export async function loadArchive(raw) {
  if (
    raw.length !== 56 + USER_LEN ||
    ascii(raw.slice(0, 16)) !== "NAPEBK01KCZKNAPE" ||
    u32(raw, 16) !== 0xf5000 ||
    u32(raw, 20) !== USER_LEN
  )
    throw Error(
      "Expected a 44 KiB Nape user-data .npb archive (not firmware).",
    );
  const data = raw.slice(56);
  if (!equal(await sha(data), raw.slice(24, 56)))
    throw Error("Backup SHA-256 mismatch.");
  return data;
}
export async function saveVerified(handle, bytes) {
  const existing = new Uint8Array(await (await handle.getFile()).arrayBuffer());
  if (existing.length && !equal(existing, bytes))
    throw Error(
      "That file already contains a different backup. Choose a new filename.",
    );
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (e) {
    await writable.abort().catch(() => {});
    throw e;
  }
  const readback = new Uint8Array(await (await handle.getFile()).arrayBuffer());
  if (!equal(readback, bytes))
    throw Error("Saved file readback differs. Adoption has not started.");
  await loadArchive(readback);
}
export async function snapshot(client, progress = () => {}) {
  const data = new Uint8Array(USER_LEN);
  for (let i = 0; i < USER_LEN; i += 48) {
    const n = Math.min(48, USER_LEN - i),
      chunk = await client.request(2, i, Uint8Array.of(n));
    if (chunk.length !== n) throw Error("Incomplete user-data read.");
    data.set(chunk, i);
    progress((i + n) / USER_LEN, "Reading stock user data");
  }
  if (!equal(await client.request(11), await sha(data)))
    throw Error("Backup differs from the device SHA-256.");
  return data;
}
export async function adopt(client, raw, progress = () => {}) {
  const data = await loadArchive(raw);
  const state = (await client.info()).state;
  // The device requires a complete read in this session before first adoption.
  // An interrupted formatting pass instead verifies the original journal digest.
  if (["protected", "restored", "conflict"].includes(state)) {
    if (!equal(await snapshot(client, progress), data))
      throw Error(
        "This backup does not match the device’s original user data. Adoption has not started.",
      );
  }
  await client.request(3, 0, await sha(data));
  if ((await client.info()).state !== "owned")
    throw Error("Custom storage adoption did not commit.");
}
export async function backupAndAdopt(
  client,
  handle,
  progress = () => {},
  adoptAfter = true,
) {
  const state = (await client.info()).state;
  if (!["protected", "restored"].includes(state))
    throw Error(
      "Fresh backup requires protected/restored stock data. For interrupted adoption, select the original verified .npb.",
    );
  const raw = await archive(await snapshot(client, progress));
  progress(1, "Saving and verifying the backup file");
  await saveVerified(handle, raw);
  if (adoptAfter) {
    progress(1, "Backup verified; adopting custom storage");
    await adopt(client, raw, progress);
  }
  return raw;
}
async function stream(client, op, data, progress, label) {
  for (let i = 0; i < data.length; i += 48) {
    await client.request(op, i, data.slice(i, i + 48));
    progress(Math.min(i + 48, data.length) / data.length, label);
  }
}
export async function restoreData(
  client,
  raw,
  progress = () => {},
  { confirmDifferent = async () => false } = {},
) {
  const data = await loadArchive(raw);
  if (ascii(data.slice(0, 8)) === "NPSTOR01")
    throw Error(
      "This archive contains custom storage, not stock user data. Choose a stock .npb backup.",
    );
  const digest = await sha(data);
  progress(0, "Checking stock backup against the device");
  try {
    await client.request(4, 0, digest);
  } catch (e) {
    if (e.code !== 3)
      throw Error(`Cannot begin restoration: ${e.message}`, { cause: e });
    const message =
      "This backup is not the one saved during the last adoption. Restoring it will replace your current settings and pairing data with this different snapshot. Only continue if it is a stock backup for your Nape Pro. Continue?";
    if (!(await confirmDifferent(message))) return false;
    if ((await client.status()).firmware < 0x1000b)
      throw Error(
        "Restoring a different backup requires firmware 1.0.11 or newer. Update custom firmware first; no user data was changed.",
      );
    await client.request(12, 0x4f4c4442, digest);
  }
  await stream(client, 5, data, progress, "Restoring stock user data");
  try {
    await client.request(6);
  } catch (e) {
    throw Error(
      `User-data verification/commit failed: ${e.message}. Retry with the same archive.`,
      { cause: e },
    );
  }
  if (
    !["protected", "restored", "conflict"].includes((await client.info()).state)
  )
    throw Error("Restored data was not protected.");
  if (!equal(await snapshot(client, progress), data))
    throw Error("Restored data readback differs.");
  return true;
}
export async function updateFirmware(
  client,
  image,
  progress = () => {},
  { stock = false, onActivation = () => {} } = {},
) {
  await validateImage(image, { stock });
  progress(0, "Preparing firmware staging area");
  await client.request(7, image.length, await sha(image));
  await stream(client, 8, image, progress, "Uploading firmware");
  progress(1, "Verifying staged firmware");
  await client.request(9);
  // Any failure after this point may be a reset before the acknowledgment.
  onActivation();
  await client.request(10);
}
export async function extractBackup(dump) {
  if (dump.length !== 0x100000)
    throw Error("Expected a full 1 MiB UART dump starting at 0x04000000.");
  return archive(dump.slice(0xf5000));
}
export async function verifyBackup(raw, dump) {
  const data = await loadArchive(raw);
  if (dump.length !== 0x100000 || !equal(data, dump.slice(0xf5000)))
    throw Error("Backup differs from the UART dump.");
}
// Stock updater uses report B2/B1 and a different framing protocol.
export class StockHID {
  constructor(device) {
    this.device = device;
    this.seq = 0;
    this.pending = null;
    this.receive = this.receive.bind(this);
  }
  static matches(d) {
    return (
      d.vendorId === 0x3434 &&
      d.productId === 0x0440 &&
      d.collections?.some((c) => c.usagePage === 0x8c && c.usage === 1)
    );
  }
  static async choose() {
    const [device] = await navigator.hid.requestDevice({
      filters: [
        { vendorId: 0x3434, productId: 0x0440, usagePage: 0x8c, usage: 1 },
      ],
    });
    if (!device) throw Error("No stock updater selected.");
    return device;
  }
  async open() {
    if (!this.device.opened) await this.device.open();
    this.device.addEventListener("inputreport", this.receive);
  }
  async close() {
    this.device.removeEventListener("inputreport", this.receive);
    if (this.device.opened) await this.device.close();
  }
  receive(event) {
    if (event.reportId !== 0xb1 || !this.pending) return;
    const p = this.pending,
      b = new Uint8Array(
        event.data.buffer,
        event.data.byteOffset,
        event.data.byteLength,
      );
    const reject = (msg) => {
      clearTimeout(p.timer);
      this.pending = null;
      p.reject(Error(msg));
    };
    if (b.length !== 32) return reject("Malformed stock report.");
    p.parts.push(...b);
    const r = Uint8Array.from(p.parts),
      n = r[2];
    if (r[0] !== 0xaa || r[1] !== 0x55 || n < 6 || n > 59 || r[3] !== (n ^ 255))
      return reject("Malformed stock reply.");
    if (r.length < n + 5) return;
    const body = r.slice(5, 5 + n - 2),
      sum = r[5 + n - 2] | (r[5 + n - 1] << 8);
    if (
      body.reduce((a, b) => a + b, 0) !== sum ||
      ![0xa1, 0xa3].includes(body[0]) ||
      body[1] !== p.seq ||
      body[2] !== p.op ||
      body[3] !== 0
    )
      return reject("Stock updater rejected command or checksum.");
    clearTimeout(p.timer);
    this.pending = null;
    p.resolve(body.slice(4));
  }
  async command(op, data = new Uint8Array(), reply = true) {
    if (this.pending) throw Error("Stock transfer already active.");
    this.seq = (this.seq % 255) + 1;
    const body = Uint8Array.of(op, ...data),
      n = body.length + 2,
      frame = new Uint8Array(32);
    if (n + 5 > 32) throw Error("Stock packet too large.");
    frame.set([0xaa, 0x56, n, n ^ 255, this.seq]);
    frame.set(body, 5);
    new DataView(frame.buffer).setUint16(
      5 + body.length,
      body.reduce((a, b) => a + b, 0),
      true,
    );
    if (!reply) {
      await this.device.sendReport(0xb2, frame);
      return;
    }
    return new Promise((resolve, reject) => {
      this.pending = {
        resolve,
        reject,
        op,
        seq: this.seq,
        parts: [],
        timer: setTimeout(() => {
          this.pending = null;
          reject(Error("Stock updater timed out."));
        }, 12000),
      };
      this.device.sendReport(0xb2, frame).catch((e) => {
        if (this.pending) {
          clearTimeout(this.pending.timer);
          this.pending = null;
          reject(e);
        }
      });
    });
  }
  async identify() {
    const d = await this.command(0x60);
    if (
      d.length < 22 ||
      ascii(d.slice(0, 10)).replace(/\0+$/, "") !== "KCZKNAPE"
    )
      throw Error("Wrong stock device model.");
    this.version = ascii(d.slice(12, 22)).replace(/\0+$/, "");
    return this.version;
  }
  async install(image, progress = () => {}, onActivation = () => {}) {
    await validateImage(image);
    if ((await this.identify()) !== "1.3.3-r")
      throw Error("First install currently supports stock 1.3.3-r only.");
    await this.command(0x62, Uint8Array.of(0));
    await this.command(0x63);
    let crc = 0xffffffff;
    const wire = new Uint8Array(4),
      v = new DataView(wire.buffer);
    for (let i = 0; i < image.length; i += 16) {
      const chunk = image.slice(i, i + 16);
      for (const b of chunk) {
        crc ^= b;
        for (let j = 0; j < 8; j++)
          crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      v.setUint32(0, crc >>> 0, true);
      if (!equal(await this.command(0x64, chunk), Uint8Array.of(0, ...wire)))
        throw Error(`Stock transfer CRC mismatch at ${i}.`);
      progress(
        Math.min(i + 16, image.length) / image.length,
        "Uploading through stock updater",
      );
    }
    if (
      !equal(
        await this.command(0x65, Uint8Array.of(...wire, ...wire)),
        Uint8Array.of(0, ...wire),
      )
    )
      throw Error("Stock updater verification failed.");
    onActivation();
    await this.command(0x66, new Uint8Array(), false);
  }
}
