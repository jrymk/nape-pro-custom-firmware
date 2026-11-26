"""USB maintenance for a wired Keychron Nape Pro. Run with --help."""

import hashlib
import os
import secrets
import struct
import sys
import tempfile
import time
import zlib
from pathlib import Path

USER_BASE, USER_LEN = 0xF5000, 0xB000
MODEL = b"KCZKNAPE"
FAMILY = b"NAPE-MAINT/v1\0"
STOCK = bytes.fromhex(
    "2a8838e93ebad24f34663c6203adf701244270441c44618e13de7ed5d083cc89"
)
ROM = bytes.fromhex("ebfc0ab8ef26ee11ab0f2f10ef11d43d")
STATE = ["protected", "formatting", "owned", "restoring", "restored", "conflict"]
ERRORS = [
    "ok",
    "invalid packet",
    "operation unavailable in current state",
    "digest mismatch",
    "flash I/O failed",
    "wrong application image",
    "wrong transfer offset",
    "unexpected physical flash layout",
    "journal conflict",
]
(
    INFO,
    READ,
    ADOPT,
    RBEGIN,
    RDATA,
    REND,
    FBEGIN,
    FDATA,
    FCHECK,
    ACTIVATE,
    SNAPSHOT_HASH,
) = range(1, 12)
WIRE = struct.Struct("<2sBBIIBB2x48s")
ARCHIVE = struct.Struct("<8s8sII32s")
TOOL_DIR = (
    Path(sys.executable if getattr(sys, "frozen", False) else __file__).resolve().parent
)
DEFAULT_FW = TOOL_DIR / "Nape-Pro-maintenance.bin"
DEFAULT_STOCK = TOOL_DIR / "Keychron-Nape-Pro-1.3.3.bin"
if not DEFAULT_STOCK.exists():
    DEFAULT_STOCK = TOOL_DIR.parent / DEFAULT_STOCK.name


class BootUnverified(OSError):
    """Activation was attempted, but a successful application boot was not verified."""


def sha(data):
    return hashlib.sha256(data).digest()


def read_image(path, stock):
    return validate_image(path.read_bytes(), stock)


def validate_image(data, stock=False):
    """Validate packaged application bytes, also used by offline MP preparation."""
    if not (
        4096 <= len(data) <= 0x59000
        and data[0x208:0x210] == MODEL
        and data[0x1AC:0x1BC] == ROM
        and data[0x1A2:0x1A8] == bytes.fromhex("0f000101a937")
        and int.from_bytes(data[0x1C8:0x1CC], "little") == 0x0402D000
        and int.from_bytes(data[0x1A8:0x1AC], "little") + 0x500 == len(data)
        and sha(data[0x1A0:]) == data[0x180:0x1A0]
    ):
        raise ValueError("Expected a packaged Nape Pro RTL8762G application update.")
    if stock and sha(data) != STOCK:
        raise ValueError(
            "Rollback currently supports the verified official 1.3.3 image."
        )
    if not stock and FAMILY not in data:
        raise ValueError("Expected a custom Nape maintenance application.")
    return data


def load_backup(path):
    raw = path.read_bytes()
    expected_size = ARCHIVE.size + USER_LEN
    if len(raw) != expected_size:
        raise ValueError(f"Backup must be {expected_size} bytes.")
    data = raw[ARCHIVE.size :]
    if raw[: ARCHIVE.size] != ARCHIVE.pack(
        b"NAPEBK01", MODEL, USER_BASE, USER_LEN, sha(data)
    ):
        raise ValueError("Backup header or SHA-256 mismatch.")
    return data


def save_verified(path, data):
    if len(data) != USER_LEN:
        raise ValueError("Incomplete stock data.")
    if not path.exists():
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as out:
            tmp = Path(out.name)
        try:
            with tmp.open("wb") as out:
                out.write(
                    ARCHIVE.pack(b"NAPEBK01", MODEL, USER_BASE, USER_LEN, sha(data))
                )
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
            if load_backup(tmp) != data:
                raise OSError("Backup failed its disk verification.")
            try:
                os.link(
                    tmp, path
                )  # Atomic publication without replacing an existing backup.
            except FileExistsError:
                pass
            if os.name == "posix":
                fd = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
        finally:
            tmp.unlink(missing_ok=True)
    if load_backup(path) != data:
        raise ValueError("Existing backup differs. Choose a new filename.")


def open_device(stock=False):
    import hid

    page = 0x8C if stock else 0xFF5D
    devices = [
        d
        for d in hid.enumerate(0x3434, 0x0440)
        if (d.get("usage_page"), d.get("usage")) == (page, 1)
    ]
    if len(devices) != 1:
        name = "stock USB updater" if stock else "custom maintenance interface"
        raise OSError(
            f"Found {len(devices)} matching {name} devices. Connect exactly one trackball using its own USB data cable. "
            "The receiver or UART adapter alone is not enough. Run nape devices to inspect interfaces; close other configuration tools."
        )
    dev = hid.device()
    dev.open_path(devices[0]["path"])
    return dev


class Maintenance:
    def __init__(self, device, progress=None):
        self.dev = device
        self.progress = progress or (lambda *args: None)
        self.token = secrets.randbelow(0xFFFFFFFF) + 1

    def request(self, op, offset=0, data=b""):
        if len(data) > 48:
            raise ValueError("Packet exceeds HID report capacity.")
        raw = WIRE.pack(b"NP", 1, op, self.token, offset, len(data), 0, data)
        if self.dev.write(b"\0" + raw) != 65:
            raise OSError("Incomplete HID write.")
        # HID input reports are broadcast to open clients on Windows. Status
        # polling in an editor must not be mistaken for this transaction's reply.
        deadline = time.monotonic() + 12
        reply = b""
        while time.monotonic() < deadline:
            reply = bytes(self.dev.read(64, max(1, int((deadline-time.monotonic())*1000))))
            if not reply or len(reply) != 64 or reply[:12] == raw[:12]:
                break
        if len(reply) != 64 or reply[:12] != raw[:12]:
            raise OSError(
                f"Missing or mismatched response to command {op}. Reconnect and retry the operation."
            )
        size, status = reply[12:14]
        if status:
            raise OSError(
                ERRORS[status] if status < len(ERRORS) else f"Device error {status}"
            )
        if size > 48:
            raise OSError("Malformed HID reply.")
        return reply[16 : 16 + size]

    def states(self):
        body = self.request(INFO)
        if (
            len(body) != 2 + len(FAMILY)
            or body[2:] != FAMILY
            or max(body[:2]) >= len(STATE)
        ):
            raise ValueError("Unexpected maintenance firmware.")
        return STATE[body[0]], STATE[body[1]]

    def state(self):
        return self.states()[0]

    def snapshot(self):
        data = bytearray()
        self.progress("Reading user data", 0, USER_LEN)
        while len(data) < USER_LEN:
            count = min(48, USER_LEN - len(data))
            chunk = self.request(READ, len(data), bytes([count]))
            if len(chunk) != count:
                raise OSError("Incomplete user-data read.")
            data.extend(chunk)
            self.progress("Reading user data", len(data), USER_LEN)
        self.progress("Verifying user-data SHA-256 on the device")
        if self.request(SNAPSHOT_HASH) != sha(data):
            raise OSError("User-data read differs from the device's SHA-256.")
        return bytes(data)

    def migrate(self, path):
        mode = self.state()
        if mode in ("formatting", "owned"):
            data = load_backup(path)
        elif mode in ("protected", "restored", "conflict"):
            data = self.snapshot()
            if mode == "conflict" and not path.exists():
                raise ValueError(
                    "Journal conflict. Retry with your original verified backup."
                )
            save_verified(path, data)
        else:
            raise ValueError(
                "Finish the interrupted restoration with the original backup."
            )
        self.progress("Backup verified on disk; adopting custom storage")
        self.request(ADOPT, data=sha(data))
        if self.state() != "owned":
            raise OSError("Custom storage did not commit.")

    def restore(self, data):
        self.progress("Beginning original user-data restoration")
        self.request(RBEGIN, data=sha(data))
        self.stream(RDATA, data)
        self.progress("Verifying and protecting restored user data")
        self.request(REND)
        if self.state() not in ("protected", "restored", "conflict"):
            raise OSError("Restored data is not protected.")

    def stream(self, op, data):
        phase = {
            RDATA: "Restoring user data",
            FDATA: "Uploading firmware",
            0x33: "Uploading profiles",
        }.get(op, "Transferring data")
        self.progress(phase, 0, len(data))
        for pos in range(0, len(data), 48):
            self.request(op, pos, data[pos : pos + 48])
            self.progress(phase, min(pos + 48, len(data)), len(data))

    def update(self, image):
        self.progress("Preparing firmware staging area")
        self.request(FBEGIN, len(image), sha(image))
        self.stream(FDATA, image)
        self.progress("Verifying staged firmware SHA-256")
        self.request(FCHECK)
        self.progress("Activating verified firmware")
        self.request(ACTIVATE)


class StockUpdater:
    def __init__(self, device, progress=None):
        self.dev = device
        self.progress = progress or (lambda *args: None)
        self.seq = 0

    def command(self, op, data=b"", expect_reply=True):
        self.seq = self.seq % 255 + 1
        body = bytes([op]) + data
        size = len(body) + 2
        frame = (
            bytes([0xAA, 0x56, size, size ^ 255, self.seq])
            + body
            + struct.pack("<H", sum(body))
        )
        if len(frame) > 32:
            raise ValueError("Stock report is too large.")
        if self.dev.write(b"\xb2" + frame.ljust(32, b"\0")) != 33:
            raise OSError("Incomplete stock HID write.")
        if not expect_reply:
            return b""

        def receive():
            part = bytes(self.dev.read(33, 5000))
            if len(part) != 33 or part[0] != 0xB1:
                raise OSError("Missing stock update reply.")
            return part[1:]

        reply = receive()
        n = reply[2]
        if reply[:2] != b"\xaa\x55" or not 6 <= n <= 59 or reply[3] != n ^ 255:
            raise OSError("Malformed stock reply.")
        if n + 5 > 32:
            reply += receive()
        body = reply[5 : 5 + n - 2]
        checksum = int.from_bytes(reply[5 + n - 2 : 5 + n], "little")
        if (
            sum(body) != checksum
            or body[0] not in (0xA1, 0xA3)
            or body[1:4] != bytes([self.seq, op, 0])
        ):
            raise OSError(
                f"Stock firmware rejected command 0x{op:02x} or reply integrity failed."
            )
        return body[4:]

    def identify(self):
        model = self.command(0x60)
        if len(model) < 22 or model[:10].rstrip(b"\0") != MODEL:
            raise ValueError("Stock updater does not identify as KCZKNAPE.")
        return model[12:22].rstrip(b"\0").decode("ascii")

    def install(self, image):
        version = self.identify()
        if version != "1.3.3-r":
            raise ValueError(
                f"Stock updater {version!r} is untested. First install supports 1.3.3-r."
            )
        self.progress(f"Stock {version} identified; preparing firmware staging area")
        self.command(0x62, b"\0")
        self.command(0x63)
        crc = 0
        self.progress("Uploading through stock updater", 0, len(image))
        for pos in range(0, len(image), 16):
            chunk = image[pos : pos + 16]
            crc = zlib.crc32(chunk, crc)
            reply = self.command(0x64, chunk)
            if reply != b"\0" + struct.pack("<I", crc ^ 0xFFFFFFFF):
                raise OSError(f"Device CRC differs at file offset 0x{pos:x}.")
            self.progress(
                "Uploading through stock updater", min(pos + 16, len(image)), len(image)
            )
        self.progress("Verifying stock-updater CRC")
        wire_crc = struct.pack("<I", crc ^ 0xFFFFFFFF)
        if self.command(0x65, wire_crc * 2) != b"\0" + wire_crc:
            raise OSError("Stock updater failed application integrity verification.")
        self.progress("Activating custom firmware")
        self.command(0x66, expect_reply=False)


def wait_for_boot(stock, require_disconnect=False):
    deadline = time.monotonic() + 25
    if require_disconnect:
        import hid

        while time.monotonic() < deadline:
            if not any(
                d.get("usage_page") == 0xFF5D for d in hid.enumerate(0x3434, 0x0440)
            ):
                break
            time.sleep(0.03)
        else:
            raise BootUnverified(
                "Activation was acknowledged. USB disconnect was not observed; reboot is unverified."
            )
    while time.monotonic() < deadline:
        dev = None
        try:
            dev = open_device(stock)
            if stock:
                version = StockUpdater(dev).identify()
                if "1.3.3" not in version:
                    raise ValueError(f"Unexpected stock version {version}.")
                return f"Stock {version} reconnected."
            return f"Custom USB application reconnected and responded. Storage is {Maintenance(dev).state()}."
        except OSError as error:
            if dev is not None and str(error) == ERRORS[7]:
                raise
            time.sleep(0.4)
        finally:
            if dev is not None:
                dev.close()
    raise BootUnverified(
        "Activation was sent. The expected USB application has not reappeared; boot is unverified."
    )


def main():
    from nape_cli import run

    return run(sys.modules[__name__])


if __name__ == "__main__":
    sys.exit(main())
