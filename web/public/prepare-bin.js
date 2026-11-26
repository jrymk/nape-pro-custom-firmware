// MD5 is required only by MPTool's filename convention, not for image integrity.
import { validateImage, loadArchive, sha, STOCK_SHA } from "./maintenance.js";
import { hex } from "./schema.js";
export function md5(input) {
  const n = Math.ceil((input.length + 9) / 64) * 64,
    b = new Uint8Array(n),
    v = new DataView(b.buffer);
  b.set(input);
  b[input.length] = 128;
  v.setUint32(n - 8, (input.length * 8) >>> 0, true);
  v.setUint32(n - 4, Math.floor(input.length / 0x20000000), true);
  let a0 = 0x67452301,
    b0 = 0xefcdab89,
    c0 = 0x98badcfe,
    d0 = 0x10325476;
  const shifts = [
    [7, 12, 17, 22],
    [5, 9, 14, 20],
    [4, 11, 16, 23],
    [6, 10, 15, 21],
  ];
  for (let off = 0; off < n; off += 64) {
    let a = a0,
      b = b0,
      c = c0,
      d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const x =
          (a +
            f +
            Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) +
            v.getUint32(off + g * 4, true)) |
          0,
        s = shifts[i >> 4][i % 4];
      a = d;
      d = c;
      c = b;
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16),
    o = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((x, i) => o.setInt32(i * 4, x, true));
  return hex(out);
}
function u32(x) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, x, true);
  return b;
}
function wrapper(image) {
  const size = u32(image.length),
    version = [0x31, 0x30, 0, 0],
    fields = [
      [1, [0, 3]],
      [2, version],
      [3, [0, ...Array(31).fill(255)]],
      [4, size],
      [0x11, [1]],
      [0x12, [0xa9, 0x37]],
      [0x13, u32(0x0402d000)],
      [0x14, size],
      [0x15, [0]],
      [0x16, version],
      [0x22, [2]],
      [0x100, [15]],
    ];
  const out = new Uint8Array(512);
  let i = 0;
  for (const [tag, value] of fields) {
    out.set([tag & 255, tag >> 8, value.length, ...value], i);
    i += 3 + value.length;
  }
  return out;
}
export async function prepareBin(raw, type, address = null) {
  let data, target, route, prefix, notes, length;
  if (type === "app") {
    const wrapped = hex(raw.slice(0, 5)) === "0100020003",
      image = wrapped ? raw.slice(512) : raw;
    await validateImage(image, { stock: hex(await sha(image)) === STOCK_SHA });
    const header = wrapper(image);
    if (wrapped && header.some((b, i) => b !== raw[i]))
      throw Error("Unknown MP wrapper metadata; refusing to replace it.");
    data = new Uint8Array(512 + image.length);
    data.set(header);
    data.set(image, 512);
    target = 0x0402d000;
    length = image.length;
    prefix = "APP";
    route = "RD/Debug > Browse > APP image";
    notes =
      "Check APP address 0x0402D000. Disable chip erase and unrelated writes. The 512-byte wrapper is MPTool metadata, not raw flash bytes.";
  } else if (type === "backup") {
    data = await loadArchive(raw);
    target = 0x040f5000;
    length = data.length;
    prefix = "USERDATA-040F5000";
    route = "RD/Debug > User Data";
    notes =
      "Raw stock user data only. Prefer Restore stock data in this app: MPTool bypasses the migration journal.";
  } else if (type === "dump") {
    if (address === null)
      throw Error("Enter the original mapped readback address.");
    target = address;
    data = raw;
    length = data.length;
    prefix = `RAW-${target.toString(16).toUpperCase().padStart(8, "0")}`;
    route = "RD/Debug > User Data";
    if (
      !Number.isSafeInteger(target) ||
      !length ||
      target % 4096 ||
      length % 4096
    )
      throw Error("Raw address and length must be whole 4096-byte sectors.");
    notes =
      "Raw bytes preserved. Full raw restoration through MPTool is not validated end-to-end; verify address/size and read back afterward.";
  } else throw Error("Choose application, archive or dump.");
  if (address !== null && address !== target)
    throw Error("Address differs from the required target.");
  if (target < 0x04000000 || target + length > 0x04100000)
    throw Error("Range exceeds the Nape Pro 1 MiB flash.");
  const filename = `${prefix}-${md5(data)}.bin`;
  return {
    data,
    filename,
    manifest: {
      format: "NAPE-MPTOOL-PREP/1",
      kind: type,
      output: filename,
      output_bytes: data.length,
      programmed_bytes: length,
      address: `0x${target.toString(16).toUpperCase()}`,
      md5: md5(data),
      sha256: hex(await sha(data)),
      mptool_route: route,
      notes,
    },
  };
}
