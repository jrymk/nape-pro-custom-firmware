"""Offline MPTool preparation for the verified 1 MiB Nape Pro layout.

The ID_APP TLVs below match Realtek prepend_header output for this target.
They are checked byte-for-byte against vendor-generated wrappers in tests.
An MP wrapper is tool metadata, not bytes to write with a raw programmer.
"""

import hashlib
import json
import os
import struct
import tempfile
from pathlib import Path

FLASH_BASE = 0x04000000
FLASH_SIZE = 0x100000
APP_ADDRESS = FLASH_BASE + 0x2D000
MP_SIZE = 512


def app_wrapper(image):
    def tlv(tag, value):
        return struct.pack("<HB", tag, len(value)) + value

    size = struct.pack("<I", len(image))
    # Same manufacturing version metadata as our verified mp.ini/packer.
    version = bytes.fromhex("31300000")
    fields = [
        (0x01, bytes.fromhex("0003")),
        (0x02, version),
        (0x03, b"\0" + b"\xff" * 31),
        (0x04, size),
        (0x11, b"\x01"),
        (0x12, bytes.fromhex("a937")),
        (0x13, struct.pack("<I", APP_ADDRESS)),
        (0x14, size),
        (0x15, b"\0"),
        (0x16, version),
        (0x22, b"\x02"),
        (0x100, b"\x0f"),
    ]
    return b"".join(tlv(tag, value) for tag, value in fields).ljust(MP_SIZE, b"\0")


def publish(path, data):
    """Atomic publication without replacing inputs or unrelated existing files."""
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError(f"Output already exists with different contents: {path}")
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        tmp = Path(f.name)
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    try:
        if tmp.read_bytes() != data:
            raise OSError("Prepared file failed disk verification")
        try:
            os.link(tmp, path)
        except FileExistsError:
            if path.read_bytes() != data:
                raise ValueError(f"Output appeared with different contents: {path}")
    finally:
        tmp.unlink(missing_ok=True)


def prepare(api, source, out_dir, kind="auto", address=None):
    source, out_dir = Path(source), Path(out_dir)
    raw = source.read_bytes()
    looks_backup = raw[:8] == b"NAPEBK01" or source.suffix.lower() == ".npb"
    looks_mp = raw[:5] == bytes.fromhex("0100020003")
    looks_app = raw[0x208:0x210] == api.MODEL
    detected = "backup" if looks_backup else "app" if looks_mp or looks_app else "dump"
    if kind == "auto":
        if detected == "dump" and len(raw) != FLASH_SIZE:
            raise ValueError(
                "Unrecognized file. For a partial raw readback specify --type dump --address <original-read-address>."
            )
        kind = detected
    elif kind != detected and detected != "dump":
        raise ValueError(
            f"Input looks like {detected}, not {kind}; refusing to reinterpret its headers."
        )
    notes = []
    if kind == "app":
        image = raw[MP_SIZE:] if looks_mp else raw
        api.validate_image(image, stock=api.sha(image) == api.STOCK)
        if looks_mp:
            if raw[:MP_SIZE] != app_wrapper(image):
                raise ValueError(
                    "MP wrapper metadata differs from the verified Nape template. Refusing to repair unknown fields."
                )
            data = raw  # Only repair the name, never replace existing metadata.
            notes.append(
                "Existing verified MP wrapper preserved; MD5 filename regenerated."
            )
        else:
            data = app_wrapper(image) + image
            notes.append("Added 512-byte MP wrapper; application payload unchanged.")
        target = APP_ADDRESS
        length = len(image)
        route = "RD/Debug > Browse > APP image"
        prefix = "APP"
        notes.append(
            "Check the APP row address is 0x0402D000. Program only this row; disable full-chip erase and unrelated image/config/user-data writes."
        )
    elif kind == "backup":
        data = api.load_backup(source)
        target = FLASH_BASE + api.USER_BASE
        length = len(data)
        route = "RD/Debug > User Data (raw file plus explicit address)"
        prefix = f"USERDATA-{target:08X}"
        notes.append(
            "Verified NAPEBK01 SHA-256 and removed only its 56-byte archive header. This is user data, not a full flash image."
        )
        notes.append(
            "Prefer nape restore-data for original stock backups: raw MPTool writes bypass the migration journal/protection workflow."
        )
    elif kind == "dump":
        if address is None:
            raise ValueError(
                "Raw dumps do not record their start address. Supply --address from the readback operation (0x04000000 for a confirmed full dump)."
            )
        target = address
        data = raw
        length = len(data)
        route = "RD/Debug > User Data (raw file plus explicit address)"
        prefix = f"RAW-{target:08X}"
        if not length or target % 4096 or length % 4096:
            raise ValueError(
                "Raw dump preparation requires a nonempty whole-sector dump: address and size must be multiples of 4096."
            )
        notes.append(
            "Raw bytes preserved exactly; no application or manufacturing header added. The MD5 suffix is a content label, not an APP conversion."
        )
        notes.append(
            "MPTool whole-range raw restoration has not been validated end-to-end. Verify the accepted address/size and read back for comparison; preparation does not prove restorability."
        )
    else:
        raise ValueError(f"Unsupported input kind: {kind}")
    if address is not None and address != target:
        raise ValueError(
            f"This file requires address 0x{target:08X}; refusing override 0x{address:08X}."
        )
    if target < FLASH_BASE or target + length > FLASH_BASE + FLASH_SIZE:
        raise ValueError(
            "Target range is outside this Nape Pro's 1 MiB flash (0x04000000..0x040FFFFF)."
        )
    digest = hashlib.md5(data, usedforsecurity=False).hexdigest()
    filename = f"{prefix}-{digest}.bin"
    output = out_dir / filename
    if output.resolve() == source.resolve():
        raise ValueError(
            "Output would be the input file; choose a different --out-dir."
        )
    info = dict(
        format="NAPE-MPTOOL-PREP/1",
        kind=kind,
        input=source.name,
        input_sha256=api.sha(raw).hex(),
        output=filename,
        output_bytes=len(data),
        programmed_bytes=length,
        address=f"0x{target:08X}",
        last_address=f"0x{target + length - 1:08X}",
        flash_offset=f"0x{target - FLASH_BASE:06X}",
        md5=digest,
        sha256=api.sha(data).hex(),
        mptool_route=route,
        notes=notes,
    )
    manifest = (json.dumps(info, indent=2) + "\n").encode("utf-8")
    instructions = (
        f"MPTool preparation: {kind}\nFile: {filename}\n"
        f"Target: 0x{target:08X}\nProgrammed size: 0x{length:X} ({length:,} bytes)\n"
        f"Last address: 0x{target + length - 1:08X}\nRoute: {route}\n\n"
        + "\n\n".join(notes)
        + "\n\nPreparation is offline; no device was programmed.\n"
    ).encode("utf-8")
    outputs = {
        output: data,
        output.with_suffix(".json"): manifest,
        output.with_suffix(".txt"): instructions,
    }
    # Preflight every destination before creating any output.
    for path, body in outputs.items():
        if path.exists() and path.read_bytes() != body:
            raise ValueError(f"Output already exists with different contents: {path}")
    out_dir.mkdir(parents=True, exist_ok=True)
    for path, body in outputs.items():
        publish(path, body)
    return dict(
        info,
        output=str(output.resolve()),
        instructions=str(output.with_suffix(".txt").resolve()),
    )
