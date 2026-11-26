"""Presentation and offline inspection helpers; never open or write a device."""

import hashlib
import json
import os
import struct
import sys
import tempfile
import time
import zlib
from pathlib import Path

import profile_config as cfg

VERSION = "1.3.3"


class Progress:
    """Throttled stderr progress. Redirected output gets one line per phase."""

    def __init__(self, enabled=True, stream=None):
        self.enabled = enabled
        self.stream = stream or sys.stderr
        self.phase = None
        self.started = self.last = 0
        self.active = False

    def __call__(self, phase, done=0, total=0):
        if not self.enabled:
            return
        now = time.monotonic()
        new = phase != self.phase
        if new:
            self.close()
            self.phase = phase
            self.started = now
        tty = self.stream.isatty()
        complete = total > 0 and done >= total
        if not new and not complete and (not tty or now - self.last < 0.15):
            return
        self.last = now
        if total:
            fraction = min(1.0, done / total)
            elapsed = now - self.started
            text = f"{phase}: {fraction:6.1%}  {done:,}/{total:,} bytes"
            if done and elapsed > 0.5:
                text += f"  {done / elapsed / 1024:.1f} KiB/s"
                if not complete:
                    text += f"  ~{(total - done) * elapsed / done:.0f}s remaining"
        else:
            text = phase
        print(
            ("\r" if tty else "") + text + ("    " if tty else ""),
            end="\n" if not tty or complete or not total else "",
            file=self.stream,
            flush=True,
        )
        self.active = tty and bool(total) and not complete

    def close(self):
        if self.active:
            print(file=self.stream, flush=True)
        self.active = False


def read_config(path):
    try:
        c = json.loads(Path(path).read_text(encoding="utf-8-sig"))
        cfg.encode(c)
        return c
    except (KeyError, TypeError, ValueError, AttributeError, struct.error) as error:
        raise ValueError(f"Invalid profile file {path}: {error}") from error


def save_json(path, value, overwrite=False):
    """Publish a complete, verified file; preserve existing exports by default."""
    path = Path(path)
    content = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        tmp = Path(f.name)
        try:
            f.write(content.encode("utf-8"))
            f.flush()
            os.fsync(f.fileno())
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
    try:
        if json.loads(tmp.read_text(encoding="utf-8")) != value:
            raise OSError("Export failed disk verification")
        if overwrite:
            os.replace(tmp, path)
        else:
            try:
                os.link(tmp, path)
            except FileExistsError as error:
                raise ValueError(
                    f"{path} already exists. Choose a new name or use --force."
                ) from error
    finally:
        tmp.unlink(missing_ok=True)


def config_summary(c):
    cfg.encode(c)
    return dict(
        kind="custom profiles",
        schema=c["version"],
        transport=["Auto (physical switch)", "Wired only", "2.4 GHz only"][
            c["transport"]
        ],
        initial_profile="Last used" if c["initial_profile"] == 255 else c["initial_profile"] + 1,
        receiver_pairing=(
            "present" if bytes.fromhex(c["bond"]) != bytes(12) else "not configured"
        ),
        profiles=[
            dict(
                number=i + 1,
                name=p["name"],
                color="#" + p["color"],
                polling_hz=p["report_hz"],
                base_dpi=p["layers"][0]["dpi"],
                base_motion=cfg.MODES[p["layers"][0]["motion"]],
                layers=len(p["layers"]),
            )
            for i, p in enumerate(c["profiles"])
        ],
    )


def human_status(result):
    """Readable units and names without changing the machine-readable API."""
    result = dict(result)
    explanations = {
        "protected": "Original data locked; use adopt with a backup filename",
        "formatting": "Migration interrupted; retry adopt with the original backup",
        "owned": "Custom settings active",
        "restoring": "Restoration interrupted; retry with the same original backup",
        "restored": "Original data restored and locked",
        "conflict": "Migration journal conflict; keep and use the original backup",
    }
    if result.get("storage") in explanations:
        result["storage_detail"] = explanations[result["storage"]]
    if "profile" in result:
        result["profile"] += 1
        result["mode"] = {0: "Inherit", 1: "Pointer", 2: "Scroll"}.get(
            result["mode"], result["mode"]
        )
        result["held_buttons"] = [
            cfg.BUTTONS[i] for i in range(7) if result["buttons"] & (1 << i)
        ]
        del result["buttons"]
        mask = result.pop("layers")
        result["active_layers"] = [0] + [i for i in range(1, 8) if mask & (1 << i)]
        result["uptime_seconds"] = round(result.pop("uptime_ms") / 1000, 2)
        result["sensor_result"] = (
            "OK" if result["sensor_result"] == 0 else result["sensor_result"]
        )
    return result


def crc8(data):
    crc = 0xff
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ (7 if crc & 0x80 else 0)) & 0xff
    return crc

def extract_bond(user_data):
    """Accept only an unambiguous CRC-checked stock bond, not a guessed newest record."""
    user_data = bytes(user_data)
    if len(user_data) != 0xb000:
        raise ValueError('Expected the verified 44 KiB stock settings archive')
    records = []
    for base in range(0, 0xa000, 4096):
        for pos in range(0, 4096, 8):
            ate = user_data[base + pos:base + pos + 8]
            key, offset, size, part, crc = struct.unpack('<HHHBB', ate)
            if crc8(ate[:7]) != crc or key >= 0xfffe or part != 0xff or offset + size > pos:
                continue
            records.append((key, user_data[base + offset:base + offset + size]))
    ids = {key for key, data in records if data == b'pptsync/bondinfo'}
    if len(ids) != 1:
        raise ValueError('No unique stock receiver-pairing record found')
    value_id = (ids.pop() + 0x4000) & 0xffff
    candidates = {data for key, data in records if key == value_id}
    if len(candidates) != 1:
        raise ValueError('Ambiguous historical pairing records; refusing to guess')
    bond = candidates.pop()
    if len(bond) != 12:
        raise ValueError('Invalid stock receiver-pairing record')
    primary, _, secondary = struct.unpack('<III', bond)
    if all(address in (0, 0xffffffff) for address in (primary, secondary)):
        raise ValueError('Invalid stock receiver-pairing record')
    return bond


def inspect_user_data(data):
    """Recognize owned header and select slots using firmware's wraparound rule."""
    if len(data) != 0xB000:
        raise ValueError("Expected 45,056 user-data bytes")
    result = dict(
        kind="stock or unrecognized user data",
        profiles=None,
        note="Stock profile names/mappings are not decoded; this is not a full flash image.",
    )
    if data[:8] != b"NPSTOR01":
        try:
            extract_bond(data)
            result["receiver_pairing"] = "unique CRC-checked stock record found"
        except ValueError:
            result["receiver_pairing"] = (
                "not found or ambiguous (not proof of absent pairing)"
            )
        return result
    expected = b"NPSTOR01" + struct.pack("<II", 1, 10) + data[16:48]
    if data[:80] != expected + hashlib.sha256(expected).digest():
        raise ValueError("Custom storage signature found, but its header is invalid")
    result.update(
        kind="custom user data",
        original_stock_sha256=data[16:48].hex(),
        note="Inspect/export profiles separately; do not use this archive for stock rollback.",
    )
    selected = None
    slots = []
    for slot, offset in enumerate((0x1000, 0x3000)):
        h = data[offset : offset + 32]
        generation, size, crc, header_crc = struct.unpack_from("<4I", h, 8)
        payload = data[offset + 32 : offset + 32 + cfg.SIZE]
        valid = (
            h[:8] == b"NPCOM001"
            and size == cfg.SIZE
            and zlib.crc32(h[8:20]) == header_crc
            and zlib.crc32(payload) == crc
        )
        c = None
        if valid:
            try:
                c = cfg.decode(payload)
            except (ValueError, KeyError, UnicodeError, struct.error):
                valid = False
        slots.append(
            dict(slot=slot, valid=valid, generation=generation if valid else None)
        )
        if valid and (
            selected is None or 0 < (generation - selected[0]) & 0xFFFFFFFF < 0x80000000
        ):
            selected = generation, slot, c
    result["slots"] = slots
    if selected:
        result.update(
            generation=selected[0],
            selected_slot=selected[1],
            configuration=config_summary(selected[2]),
        )
    else:
        result["note"] += " No valid saved slot; firmware uses defaults."
    return result


def print_info(info, as_json=False):
    if as_json:
        print(json.dumps(info, indent=2, ensure_ascii=False))
        return
    for key, value in info.items():
        if key == "profiles" and isinstance(value, list):
            print("Profiles (numbers 1-8; layer numbers 0-7):")
            for p in value:
                print(
                    f"  {p['number']}. {p['name']} | {p['base_dpi']} DPI | "
                    f"{p['polling_hz']} Hz | {p['base_motion']} | {p['color']} | {p['layers']} layers"
                )
        elif isinstance(value, dict):
            print(f"{key.replace('_', ' ').capitalize()}:")
            print_info(value)
        elif value is not None:
            print(f"{key.replace('_', ' ').capitalize()}: {value}")
