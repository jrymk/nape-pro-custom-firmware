"""NPCFG002 profile codec and USB configuration client shared by CLI and GUI."""

import struct
import zlib

MEDIA = ('PLAYPAUSE', 'NEXTTRACK', 'PREVTRACK', 'MEDIASTOP', 'MUTE', 'VOLUMEUP', 'VOLUMEDOWN', 'EJECT')

SIZE = 32 + 8 * (32 + 8 * 72)
KINDS = [
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
  "Press output", "Hold DPI", "Hold motion", "Hold LED",
  "Layer + release DPI", "Layer + release motion", "Layer + release LED",
  "Layer + release reset", "Repeat output",
]
ORIENTATIONS = ["Inherit", "Round at top", "Round at right", "Round at bottom", "Round at left"]
MODES = ["Inherit", "Pointer", "Scroll", "None"]
BUTTONS = ["01", "02", "03", "04", "M1", "M2", "Bluetooth / profile selector"]


def color(value):
    value = str(value).removeprefix("#")
    if len(value) != 6:
        raise ValueError("Colors must contain six hex digits, e.g. FF6400")
    return bytes.fromhex(value)


def action(text):
    text = text.strip().upper()
    if text in ("", "NONE"):
        return 0
    if text in ("SCROLLUP", "SCROLLDOWN", "SCROLLLEFT", "SCROLLRIGHT"):
        return 9 + ("SCROLLUP", "SCROLLDOWN", "SCROLLLEFT", "SCROLLRIGHT").index(text)
    if text in MEDIA:
        return 0x4001 + MEDIA.index(text)
    if text.startswith("MOUSE"):
        n = int(text[5:])
        if not 1 <= n <= 8:
            raise ValueError("Mouse buttons are Mouse1 through Mouse8")
        return n
    parts = text.split("+")
    mods = 0
    for part in parts[:-1]:
        mods |= {"CTRL": 1, "SHIFT": 2, "ALT": 4, "GUI": 8}[part]
    key = parts[-1]
    names = {
        "ENTER": 40,
        "ESC": 41,
        "BACKSPACE": 42,
        "TAB": 43,
        "SPACE": 44,
        "MINUS": 45,
        "EQUAL": 46,
        "PLUS": 46,
        "DELETE": 76,
        "RIGHT": 79,
        "LEFT": 80,
        "DOWN": 81,
        "UP": 82,
    }
    names.update({chr(65 + i): 4 + i for i in range(26)})
    names.update({str((i + 1) % 10): 30 + i for i in range(10)})
    names.update({f"F{i+1}": 58 + i for i in range(12)})
    if key.startswith("USAGE"):
        code = int(key[5:], 16)
    else:
        code = names[key]
    if key == "PLUS":
        mods |= 2
    if not 4 <= code <= 115:
        raise ValueError("Keyboard usage must be 04..73 hex")
    return 0x8000 | (mods << 7) | code


def action_name(code):
    if not code:
        return "None"
    if 0x4001 <= code <= 0x4008:
        return MEDIA[code - 0x4001]
    if 9 <= code <= 12:
        return ("ScrollUp", "ScrollDown", "ScrollLeft", "ScrollRight")[code - 9]
    if code <= 8:
        return f"Mouse{code}"
    mods = (code >> 7) & 255
    names = [
        n
        for n, bit in [("CTRL", 1), ("SHIFT", 2), ("ALT", 4), ("GUI", 8)]
        if mods & bit
    ]
    if mods & 0xF0:
        raise ValueError("Editor currently supports left modifiers only")
    key = code & 127
    named = {
        40: "ENTER",
        41: "ESC",
        42: "BACKSPACE",
        43: "TAB",
        44: "SPACE",
        45: "MINUS",
        46: "EQUAL",
        76: "DELETE",
        79: "RIGHT",
        80: "LEFT",
        81: "DOWN",
        82: "UP",
    }
    named.update({4 + i: chr(65 + i) for i in range(26)})
    named.update({30 + i: str((i + 1) % 10) for i in range(10)})
    named.update({58 + i: f"F{i+1}" for i in range(12)})
    return "+".join(names + [named.get(key, f"USAGE{key:02X}")])


def defaults():
    colors = [
        "FF6400",
        "A000FF",
        "C8C8C8",
        "00B4FF",
        "00C846",
        "FF0064",
        "5050FF",
        "FFB400",
    ]
    c = dict(
        version=2,
        selector=6,
        initial_profile=255,
        transport=0,
        bond="00" * 12,
        debounce_ms=4,
        profiles=[],
    )
    for p in range(8):
        layers = []
        for l in range(8):
            layers.append(
                dict(
                    dpi=1600 if l == 0 else 400 if l == 2 else 0,
                    motion=1 if l == 0 else 2 if l == 1 else 0,
                    led_override=l in (1, 2),
                    color="00B400" if l == 1 else "0000B4" if l == 2 else "000000",
                    scroll_counts=16 if l == 0 else 0,
                    orientation=1 if l == 0 else 0,
                    wheel=["Inherit", "Inherit"],
                    buttons=[
                        dict(kind=0, layer=0, action="None", value=0) for _ in range(7)
                    ],
                )
            )
        for b in range(4):
            layers[0]["buttons"][b].update(kind=2, action=f"Mouse{b+1}")
        layers[0]["buttons"][4].update(kind=4, layer=1, action="Mouse5")
        layers[0]["buttons"][5].update(kind=3, layer=2)
        c["profiles"].append(
            dict(
                name=f"Profile {p+1}",
                disabled=False,
                color=colors[p],
                report_hz=500,
                selector_action="None",
                layers=layers,
            )
        )
    return c


def encode(c):
    if c["version"] != 2 or len(c["profiles"]) != 8:
        raise ValueError("Expected eight version-two profiles")
    if (
        not 0 <= c["selector"] < 7
        or c["initial_profile"] not in (*range(8), 255)
        or c["transport"] not in (0, 1, 2)
    ):
        raise ValueError("Invalid global settings")
    if not 1 <= c["debounce_ms"] <= 30:
        raise ValueError("Invalid timing")
    bond = bytes.fromhex(c["bond"])
    if len(bond) != 12:
        raise ValueError("Receiver bond must contain 12 bytes")
    if all(p.get("disabled", False) for p in c["profiles"]) or (c["initial_profile"] != 255 and c["profiles"][c["initial_profile"]].get("disabled", False)):
        raise ValueError("Startup profile must be enabled")
    out = bytearray(SIZE)
    out[:8] = b"NPCFG002"
    struct.pack_into(
        "<4B12sHH",
        out,
        8,
        c["selector"],
        c["initial_profile"],
        0,
        c["transport"],
        bond,
        c["debounce_ms"],
        0,
    )
    correction = c.get("led_correction")
    if correction is not None:
        gamma = correction["gamma"]
        values = [correction[k] for k in ("red", "green", "blue", "brightness")]
        if not isinstance(gamma, int) or not 10 <= gamma <= 40 or any(not isinstance(x, int) or not 0 <= x <= 100 for x in values):
            raise ValueError("LED correction: gamma 10..40 (tenths), gains/brightness 0..100")
        out[26] = gamma
        out[28:32] = bytes(values)
    pos = 32
    for p in c["profiles"]:
        name = p["name"].encode("utf-8")
        if len(name) > 23 or b"\0" in name:
            raise ValueError("Profile names must fit in 23 UTF-8 bytes")
        if p["report_hz"] not in (125, 250, 500, 1000) or len(p["layers"]) != 8:
            raise ValueError("Invalid profile")
        struct.pack_into(
            "<24s3sxHH",
            out,
            pos,
            name,
            color(p["color"]),
            p["report_hz"],
            action(p["selector_action"]),
        )
        if not isinstance(p.get("disabled", False), bool):
            raise ValueError("Profile disabled must be boolean")
        out[pos+27] = int(p.get("disabled", False))
        pos += 32
        for idx, l in enumerate(p["layers"]):
            if l["dpi"] != 0 and not 400 <= l["dpi"] <= 4000:
                raise ValueError("DPI must be 400..4000, or 0 to inherit")
            if l["motion"] not in (0, 1, 2, 3) or (
                idx == 0 and (not l["dpi"] or not l["motion"])
            ):
                raise ValueError("Base layer requires DPI and motion")
            if not 0 <= l["scroll_counts"] <= 4000 or len(l["buttons"]) != 7:
                raise ValueError("Invalid layer")
            struct.pack_into(
                "<HBB3sxH6x",
                out,
                pos,
                l["dpi"],
                l["motion"],
                bool(l["led_override"]),
                color(l["color"]),
                l["scroll_counts"],
            )
            orientation = l["orientation"]
            if orientation not in range(1 if idx == 0 else 0, 5):
                raise ValueError("Orientation must be 0 inherit or 1..4 quarter turns")
            out[pos + 10] = orientation
            wheel = l.get("wheel", ["Inherit", "Inherit"])
            if len(wheel) != 2:
                raise ValueError("Two wheel directions required")
            for i, name in enumerate(wheel):
                code = 0 if name == "Inherit" else 0x7fff if name == "Disabled" else action(name)
                if not code and name != "Inherit":
                    raise ValueError("Use Inherit or Disabled for wheel actions")
                struct.pack_into("<H", out, pos + 12 + i * 2, code)
            for b, v in enumerate(l["buttons"]):
                kind = v["kind"]
                target = v["layer"]
                a = action(v["action"])
                value = v["value"]
                if not 0 <= kind < len(KINDS):
                    raise ValueError("Unknown binding")
                if b == c["selector"] and kind not in (0, 1):
                    raise ValueError("Profile selector has a separate release action")
                if kind in (3, 4, 9, 14, 15, 16, 17):
                    if not 1 <= target <= 7:
                        raise ValueError("Layer target must be 1..7")
                elif target:
                    raise ValueError("Only layer bindings have a target")
                if (kind in (2, 10, 18) and not a) or (kind not in (2, 4, 10, 18) and a):
                    raise ValueError("Invalid output action for binding")
                if kind in (5, 11, 14) and not 400 <= value <= 4000:
                    raise ValueError("DPI action must be 400..4000")
                if kind in (6, 12, 15) and value not in (1, 2, 3):
                    raise ValueError("Motion action: 1 pointer, 2 scroll, 3 none")
                if kind in (7, 13, 16) and not 0 <= value <= 0xFFFFFF:
                    raise ValueError("LED action must be an RGB color")
                if kind == 18 and not 20 <= value <= 2000:
                    raise ValueError("Repeat interval must be 20..2000 ms")
                if kind not in (5, 6, 7, 11, 12, 13, 14, 15, 16, 18) and value:
                    raise ValueError("This binding has no value")
                counts = v.get("scroll_counts", 0)
                if not isinstance(counts, int) or not 0 <= counts <= 4000 or (counts and (kind not in (6, 12, 15) or value != 2)):
                    raise ValueError("Scroll sensitivity requires a scroll action and 0..4000 counts")
                wire_value = value | (counts << 16) if kind in (6, 12, 15) else value
                struct.pack_into("<BBHI", out, pos + 16 + 8 * b, kind, target, a, wire_value)
            pos += 72
    return bytes(out)


def decode(data):
    if len(data) != SIZE or data[:8] != b"NPCFG002":
        raise ValueError("Unsupported profile configuration")
    c = defaults()
    selector, initial, reserved, transport, bond, debounce, reserved_time = struct.unpack_from(
        "<4B12sHH", data, 8
    )
    c.update(
        selector=selector,
        initial_profile=initial,
        transport=transport,
        bond=bond.hex(),
        debounce_ms=debounce,
    )
    if data[26]:
        c["led_correction"] = dict(zip(("gamma", "red", "green", "blue", "brightness"), [data[26], *data[28:32]]))
    pos = 32
    for p in c["profiles"]:
        name, rgb, hz, a = struct.unpack_from("<24s3sxHH", data, pos)
        if data[pos+27] > 1:
            raise ValueError("Invalid disabled profile flag")
        p["disabled"] = bool(data[pos+27])
        pos += 32
        p.update(
            name=name.split(b"\0")[0].decode("utf-8"),
            color=rgb.hex().upper(),
            report_hz=hz,
            selector_action=action_name(a),
        )
        for l in p["layers"]:
            dpi, mode, led, rgb, count = struct.unpack_from("<HBB3sxH6x", data, pos)
            l.update(
                dpi=dpi,
                motion=mode,
                led_override=bool(led),
                color=rgb.hex().upper(),
                scroll_counts=count,
                orientation=data[pos + 10],
                wheel=["Inherit" if a == 0 else "Disabled" if a == 0x7fff else action_name(a) for a in struct.unpack_from("<HH", data, pos + 12)],
            )
            for i in range(7):
                kind, target, a, value = struct.unpack_from(
                    "<BBHI", data, pos + 16 + i * 8
                )
                l["buttons"][i] = dict(
                    kind=kind, layer=target, action=action_name(a), value=value & 0xffff if kind in (6, 12, 15) else value
                )
                if kind in (6, 12, 15) and value >> 16:
                    l["buttons"][i]["scroll_counts"] = value >> 16
            pos += 72
    if encode(c) != data:
        raise ValueError("Configuration contains unsupported or noncanonical fields")
    return c


def require_current(client):
    device = client.request(0x30)
    if len(device) != 48 or device[42] != 2 or struct.unpack_from("<I", device, 44)[0] < 0x10009:
        raise ValueError("Update to the current firmware before editing settings (configuration v2 required).")


def read(client):
    require_current(client)
    progress = getattr(client, "progress", lambda *args: None)
    progress("Reading profiles", 0, SIZE)
    data = bytearray()
    for i in range(0, SIZE, 48):
        count = min(48, SIZE - i)
        chunk = client.request(0x31, i, bytes([count]))
        if len(chunk) != count:
            raise OSError("Incomplete profile read")
        data.extend(chunk)
        progress("Reading profiles", len(data), SIZE)
    return decode(bytes(data))


def upload(client, c):
    data = encode(c)
    require_current(client)
    client.request(0x32, SIZE, struct.pack("<I", zlib.crc32(data)))
    client.stream(0x33, data)
    getattr(client, "progress", lambda *args: None)("Committing profiles to flash")
    client.request(0x34)
    if encode(read(client)) != data:
        raise OSError("Configuration readback mismatch")


def status(client):
    d = client.request(0x30)
    if len(d) != 48 or d[0] != 1:
        raise ValueError("Firmware does not support this editor")
    version = struct.unpack_from("<I", d, 44)[0]
    return dict(
        running=bool(d[1]),
        profile=d[2],
        buttons=d[3],
        sensor_id=hex(d[4]),
        radio=bool(d[5]),
        mode=d[6],
        usb=bool(d[7]),
        sensor_result=struct.unpack_from("<i", d, 8)[0],
        samples=struct.unpack_from("<I", d, 12)[0],
        sensor_errors=struct.unpack_from("<I", d, 16)[0],
        unsupported=struct.unpack_from("<I", d, 20)[0],
        dpi=struct.unpack_from("<H", d, 24)[0],
        layers=d[26],
        recovery=bool(d[27]),
        uptime_ms=struct.unpack_from("<I", d, 28)[0],
        scroll_multipliers=list(d[40:42]),
        firmware_version=f"{version >> 16}.{(version >> 8) & 255}.{version & 255}",
    )
