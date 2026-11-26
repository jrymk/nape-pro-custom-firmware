// Explicit NPCFG002 codec. Keep byte-compatible with profile_config.py.
export const SIZE = 4896;
export const BUTTONS = ["01", "02", "03", "04", "M1", "M2", "Round"];
export const MODES = ["Inherit", "Pointer", "Scroll", "None"];
export const KINDS = [
  "Transparent",
  "Disabled",
  "Output",
  "Hold layer",
  "Layer + unused release",
  "Set DPI",
  "Set motion",
  "Set LED",
  "Reset overrides",
  "Toggle layer",
  "Press output",
  "Hold DPI",
  "Hold motion",
  "Hold LED",
  "Layer + release DPI",
  "Layer + release motion",
  "Layer + release LED",
  "Layer + release reset",
  "Repeat output",
];
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const MEDIA = [
  "PLAYPAUSE",
  "NEXTTRACK",
  "PREVTRACK",
  "MEDIASTOP",
  "MUTE",
  "VOLUMEUP",
  "VOLUMEDOWN",
  "EJECT",
];
const KEY = {
  ENTER: 40,
  ESC: 41,
  BACKSPACE: 42,
  TAB: 43,
  SPACE: 44,
  MINUS: 45,
  EQUAL: 46,
  PLUS: 46,
  DELETE: 76,
  RIGHT: 79,
  LEFT: 80,
  DOWN: 81,
  UP: 82,
};
for (let i = 0; i < 26; i++) KEY[String.fromCharCode(65 + i)] = 4 + i;
for (let i = 0; i < 10; i++) KEY[String((i + 1) % 10)] = 30 + i;
for (let i = 0; i < 12; i++) KEY[`F${i + 1}`] = 58 + i;
const REVERSE = Object.fromEntries(
  Object.entries(KEY)
    .filter(([n]) => n !== "PLUS")
    .map(([n, v]) => [v, n]),
);
export function action(text) {
  if (typeof text !== "string") throw Error("Action must be text.");
  text = text.trim().toUpperCase();
  if (!text || text === "NONE") return 0;
  const media = MEDIA.indexOf(text);
  if (media >= 0) return 0x4001 + media;
  const scroll = {
    SCROLLUP: 9,
    SCROLLDOWN: 10,
    SCROLLLEFT: 11,
    SCROLLRIGHT: 12,
  };
  if (scroll[text]) return scroll[text];
  if (/^MOUSE[1-8]$/.test(text)) return Number(text.slice(5));
  const parts = text.split("+"),
    key = parts.pop();
  let mods = 0;
  for (const part of parts) {
    const bit = { CTRL: 1, SHIFT: 2, ALT: 4, GUI: 8 }[part];
    if (!bit) throw Error(`Unknown modifier: ${part}`);
    mods |= bit;
  }
  const code = /^USAGE[0-9A-F]{2}$/.test(key)
    ? parseInt(key.slice(5), 16)
    : KEY[key];
  if (!code || code < 4 || code > 115)
    throw Error(
      `Unknown keyboard key: ${key}. Use a letter, F1–F12, named key or USAGE04–USAGE73.`,
    );
  if (key === "PLUS") mods |= 2;
  return 0x8000 | (mods << 7) | code;
}
export function actionName(code) {
  if (!code) return "None";
  if (code >= 0x4001 && code <= 0x4008) return MEDIA[code - 0x4001];
  if (code >= 9 && code <= 12)
    return ["ScrollUp", "ScrollDown", "ScrollLeft", "ScrollRight"][code - 9];
  if (code <= 8) return `Mouse${code}`;
  if (
    !(code & 0x8000) ||
    code & 0x7800 ||
    (code & 127) < 4 ||
    (code & 127) > 115
  )
    throw Error("Unsupported keyboard action.");
  const mods = (code >> 7) & 15;
  return [
    ...Object.entries({ CTRL: 1, SHIFT: 2, ALT: 4, GUI: 8 })
      .filter(([, b]) => mods & b)
      .map(([n]) => n),
    REVERSE[code & 127] ||
      `USAGE${(code & 127).toString(16).padStart(2, "0").toUpperCase()}`,
  ].join("+");
}
export function blankBinding(kind = 0) {
  return { kind, layer: 0, action: "None", value: 0 };
}
export function defaults() {
  const colors = [
    "FF6400",
    "A000FF",
    "C8C8C8",
    "00B4FF",
    "00C846",
    "FF0064",
    "5050FF",
    "FFB400",
  ];
  return {
    version: 2,
    selector: 6,
    initial_profile: 255,
    transport: 0,
    bond: "00".repeat(12),
    debounce_ms: 4,
    profiles: colors.map((color, i) => ({
      name: `Profile ${i + 1}`,
      disabled: false,
      color,
      report_hz: 500,
      selector_action: "None",
      layers: Array.from({ length: 8 }, (_, l) => {
        const buttons = Array.from({ length: 7 }, () => blankBinding());
        if (!l) {
          for (let b = 0; b < 4; b++)
            buttons[b] = { ...blankBinding(2), action: `Mouse${b + 1}` };
          buttons[4] = { kind: 4, layer: 1, action: "Mouse5", value: 0 };
          buttons[5] = { ...blankBinding(3), layer: 2 };
        }
        return {
          dpi: l === 0 ? 1600 : l === 2 ? 400 : 0,
          motion: l === 0 ? 1 : l === 1 ? 2 : 0,
          led_override: l === 1 || l === 2,
          color: l === 1 ? "00B400" : l === 2 ? "0000B4" : "000000",
          scroll_counts: l === 0 ? 16 : 0,
          orientation: l === 0 ? 1 : 0,
          wheel: ["Inherit", "Inherit"],
          buttons,
        };
      }),
    })),
  };
}
function integer(x, min, max, name) {
  if (!Number.isInteger(x) || x < min || x > max)
    throw Error(`${name}: expected ${min}–${max}.`);
  return x;
}
function rgb(value) {
  if (typeof value !== "string" || !/^#?[0-9a-f]{6}$/i.test(value))
    throw Error("Use a six-digit RGB color.");
  return fromHex(value.replace("#", ""));
}
export function fromHex(s) {
  if (typeof s !== "string" || s.length % 2 || !/^[0-9a-f]*$/i.test(s))
    throw Error("Invalid hexadecimal data.");
  return Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16));
}
export function hex(bytes) {
  return Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
}
export function encode(c) {
  if (
    !c ||
    c.version !== 2 ||
    !Array.isArray(c.profiles) ||
    c.profiles.length !== 8
  )
    throw Error("Expected eight version-two profiles.");
  if (
    c.profiles.every((p) => p.disabled) ||
    c.profiles[c.initial_profile]?.disabled
  )
    throw Error("Startup profile must be enabled; keep at least one profile.");
  const out = new Uint8Array(SIZE),
    v = new DataView(out.buffer);
  out.set(encoder.encode("NPCFG002"));
  out[8] = integer(c.selector, 0, 6, "Selector");
  out[9] =
    c.initial_profile === 255
      ? 255
      : integer(c.initial_profile, 0, 7, "Initial profile");
  out[11] = integer(c.transport, 0, 2, "Transport");
  const bond = fromHex(c.bond);
  if (bond.length !== 12)
    throw Error("Receiver pairing must contain 12 bytes.");
  out.set(bond, 12);
  v.setUint16(24, integer(c.debounce_ms, 1, 30, "Debounce"), true);
  if (c.led_correction) {
    out[26] = integer(c.led_correction.gamma, 10, 40, "Gamma (tenths)");
    ["red", "green", "blue", "brightness"].forEach(
      (key, i) => (out[28 + i] = integer(c.led_correction[key], 0, 100, key)),
    );
  }
  let pos = 32;
  c.profiles.forEach((p, pi) => {
    if (
      typeof p.name !== "string" ||
      p.name.includes("\0") ||
      encoder.encode(p.name).length > 23
    )
      throw Error(`Profile ${pi + 1}: name must fit in 23 UTF-8 bytes.`);
    if (
      ![125, 250, 500, 1000].includes(p.report_hz) ||
      !Array.isArray(p.layers) ||
      p.layers.length !== 8
    )
      throw Error(`Profile ${pi + 1}: invalid polling rate or layer count.`);
    out.set(encoder.encode(p.name), pos);
    out.set(rgb(p.color), pos + 24);
    if (p.disabled !== undefined && typeof p.disabled !== "boolean")
      throw Error("Profile disabled must be boolean.");
    out[pos + 27] = Number(!!p.disabled);
    v.setUint16(pos + 28, p.report_hz, true);
    v.setUint16(pos + 30, action(p.selector_action), true);
    pos += 32;
    p.layers.forEach((l, li) => {
      if (l.dpi !== 0) integer(l.dpi, 400, 4000, `Layer ${li} DPI`);
      integer(l.motion, 0, 3, "Motion");
      if (li === 0 && (!l.dpi || !l.motion))
        throw Error("The base layer needs its own DPI and motion mode.");
      if (typeof l.led_override !== "boolean")
        throw Error("LED override must be true or false.");
      if (!Array.isArray(l.buttons) || l.buttons.length !== 7)
        throw Error("Each layer needs seven button bindings.");
      v.setUint16(pos, l.dpi, true);
      out[pos + 2] = l.motion;
      out[pos + 3] = Number(l.led_override);
      out.set(rgb(l.color), pos + 4);
      v.setUint16(
        pos + 8,
        integer(l.scroll_counts, 0, 4000, "Scroll sensitivity"),
        true,
      );
      out[pos + 10] = integer(
        l.orientation,
        li === 0 ? 1 : 0,
        4,
        "Orientation",
      );
      const wheel = l.wheel;
      if (!Array.isArray(wheel) || wheel.length !== 2)
        throw Error("Two wheel directions are required.");
      wheel.forEach((name, i) => {
        const value =
          name === "Inherit" ? 0 : name === "Disabled" ? 0x7fff : action(name);
        if (!value && name !== "Inherit")
          throw Error("Use Inherit or Disabled for wheel actions.");
        v.setUint16(pos + 12 + i * 2, value, true);
      });
      l.buttons.forEach((b, bi) => {
        integer(b.kind, 0, 18, "Action kind");
        integer(b.layer, 0, 7, "Layer");
        integer(b.value, 0, 0xffffffff, "Action value");
        const a = action(b.action);
        if (bi === c.selector && ![0, 1].includes(b.kind))
          throw Error("The profile selector uses its separate tap action.");
        if ([3, 4, 9, 14, 15, 16, 17].includes(b.kind))
          integer(b.layer, 1, 7, "Target layer");
        else if (b.layer !== 0)
          throw Error("Only layer actions have a target layer.");
        if (
          ([2, 10, 18].includes(b.kind) && !a) ||
          (![2, 4, 10, 18].includes(b.kind) && a)
        )
          throw Error("Invalid output for this action.");
        if ([5, 11, 14].includes(b.kind))
          integer(b.value, 400, 4000, "Action DPI");
        if ([6, 12, 15].includes(b.kind))
          integer(b.value, 1, 3, "Action motion");
        if ([7, 13, 16].includes(b.kind))
          integer(b.value, 0, 0xffffff, "Action color");
        if (b.kind === 18) integer(b.value, 20, 2000, "Repeat interval");
        if (
          ![5, 6, 7, 11, 12, 13, 14, 15, 16, 18].includes(b.kind) &&
          b.value !== 0
        )
          throw Error("This action has no numeric value.");
        const o = pos + 16 + bi * 8;
        out[o] = b.kind;
        out[o + 1] = b.layer;
        v.setUint16(o + 2, a, true);
        const counts = integer(
          b.scroll_counts ?? 0,
          0,
          4000,
          "Scroll sensitivity",
        );
        if (counts && (![6, 12, 15].includes(b.kind) || b.value !== 2))
          throw Error("Scroll sensitivity is only valid for scroll actions.");
        v.setUint32(o + 4, b.value + counts * 65536, true);
      });
      pos += 72;
    });
  });
  return out;
}
export function decode(bytes) {
  if (bytes.length !== SIZE || decoder.decode(bytes.slice(0, 8)) !== "NPCFG002")
    throw Error("Unsupported profile configuration.");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    c = defaults();
  Object.assign(c, {
    selector: bytes[8],
    initial_profile: bytes[9],
    transport: bytes[11],
    bond: hex(bytes.slice(12, 24)),
    debounce_ms: v.getUint16(24, true),
  });
  if (bytes[26])
    c.led_correction = Object.fromEntries(
      ["gamma", "red", "green", "blue", "brightness"].map((key, i) => [
        key,
        bytes[[26, 28, 29, 30, 31][i]],
      ]),
    );
  let pos = 32;
  c.profiles.forEach((p) => {
    const name = bytes.slice(pos, pos + 24),
      end = name.indexOf(0);
    if (end < 0) throw Error("Unterminated profile name.");
    Object.assign(p, {
      name: decoder.decode(name.slice(0, end)),
      disabled: !!bytes[pos + 27],
      color: hex(bytes.slice(pos + 24, pos + 27)).toUpperCase(),
      report_hz: v.getUint16(pos + 28, true),
      selector_action: actionName(v.getUint16(pos + 30, true)),
    });
    pos += 32;
    p.layers.forEach((l) => {
      Object.assign(l, {
        dpi: v.getUint16(pos, true),
        motion: bytes[pos + 2],
        led_override: !!bytes[pos + 3],
        color: hex(bytes.slice(pos + 4, pos + 7)).toUpperCase(),
        scroll_counts: v.getUint16(pos + 8, true),
        orientation: bytes[pos + 10],
        wheel: [0, 1].map((i) => {
          const value = v.getUint16(pos + 12 + i * 2, true);
          return !value
            ? "Inherit"
            : value === 0x7fff
              ? "Disabled"
              : actionName(value);
        }),
      });
      l.buttons = l.buttons.map((_, i) => {
        const o = pos + 16 + i * 8;
        const motionAction = [6, 12, 15].includes(bytes[o]);
        const value = v.getUint32(o + 4, true);
        return {
          ...(motionAction && value >>> 16
            ? { scroll_counts: value >>> 16 }
            : {}),
          kind: bytes[o],
          layer: bytes[o + 1],
          action: actionName(v.getUint16(o + 2, true)),
          value: motionAction ? value & 0xffff : value,
        };
      });
      pos += 72;
    });
  });
  const check = encode(c);
  if (check.some((x, i) => x !== bytes[i]))
    throw Error("Configuration contains unsupported or noncanonical fields.");
  return c;
}
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function crc8(bytes) {
  let c = 255;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = ((c << 1) ^ (c & 128 ? 7 : 0)) & 255;
  }
  return c;
}
export async function importBond(raw) {
  if (
    raw.length !== 45112 ||
    decoder.decode(raw.slice(0, 8)) !== "NAPEBK01" ||
    decoder.decode(raw.slice(8, 16)) !== "KCZKNAPE"
  )
    throw Error("Expected a Nape .npb backup.");
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (v.getUint32(16, true) !== 0xf5000 || v.getUint32(20, true) !== 0xb000)
    throw Error("Unexpected backup range.");
  const data = raw.slice(56),
    digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  if (digest.some((b, i) => b !== raw[24 + i]))
    throw Error("Backup SHA-256 mismatch.");
  const records = [];
  for (let base = 0; base < 0xa000; base += 4096)
    for (let pos = 0; pos < 4096; pos += 8) {
      const a = data.slice(base + pos, base + pos + 8),
        d = new DataView(a.buffer),
        key = d.getUint16(0, true),
        offset = d.getUint16(2, true),
        size = d.getUint16(4, true);
      if (
        crc8(a.slice(0, 7)) !== a[7] ||
        key >= 0xfffe ||
        a[6] !== 255 ||
        offset + size > pos
      )
        continue;
      records.push([key, data.slice(base + offset, base + offset + size)]);
    }
  const keyBytes = encoder.encode("pptsync/bondinfo");
  const ids = new Set(
    records
      .filter(
        ([, d]) =>
          d.length === keyBytes.length && d.every((x, i) => x === keyBytes[i]),
      )
      .map(([k]) => k),
  );
  if (ids.size !== 1)
    throw Error("No unique stock receiver pairing record found.");
  const id = ([...ids][0] + 0x4000) & 65535,
    values = new Set(records.filter(([k]) => k === id).map(([, d]) => hex(d)));
  if (values.size !== 1)
    throw Error("Ambiguous historical receiver pairing records.");
  const bond = fromHex([...values][0]);
  if (bond.length !== 12) throw Error("Invalid receiver pairing record.");
  const b = new DataView(bond.buffer);
  if (
    [b.getUint32(0, true), b.getUint32(8, true)].every(
      (x) => x === 0 || x === 0xffffffff,
    )
  )
    throw Error("Invalid receiver addresses.");
  return hex(bond);
}
