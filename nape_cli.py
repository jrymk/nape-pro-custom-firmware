"""User-facing Nape device manager. Protocol clients stay in nape.py."""

import argparse
import json
import os
import struct
import sys
from pathlib import Path

import profile_config as cfg
from nape_support import (
    VERSION,
    Progress,
    config_summary,
    inspect_user_data,
    human_status,
    print_info,
    read_config,
    save_json,
)

def parser_for(api):
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--no-progress",
        action="store_true",
        default=argparse.SUPPRESS,
        help="Suppress phase/progress output on stderr",
    )
    common.add_argument(
        "--debug",
        action="store_true",
        default=argparse.SUPPRESS,
        help="Show a Python traceback on error",
    )
    parser = argparse.ArgumentParser(
        prog="nape",
        parents=[common],
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description=f"Nape Pro Device Manager {VERSION}\nUSB maintenance and profiles for experimental custom firmware.",
        epilog="""Examples:
  nape devices
  nape status
  nape backup-info original.npb
  nape update --image np-custom-firmware-1.0.11.bin
  nape config-read profiles.json
  nape config-write profiles.json
  nape configure

First install: install --image <custom.bin>, then adopt original.npb.
Return to stock: restore-stock original.npb --image <official-1.3.3.bin>.
The .npb backup is 44 KiB of user data, NOT firmware or a full flash dump.
Profiles are exported as JSON. Keep personal backups separate from releases.
All device commands use the trackball's USB cable; no wireless updating.
Use 'nape COMMAND --help' for details. No background app is required.
Exit codes: 0 success, 1 operation failed, 2 usage error, 3 boot unverified, 130 interrupted.""",
    )
    parser.add_argument(
        "--version", action="version", version=f"Nape Pro Device Manager {VERSION}"
    )
    sub = parser.add_subparsers(dest="action", metavar="COMMAND")

    def add(name, help_text, detail=None, machine=False):
        p = sub.add_parser(
            name,
            help=help_text,
            description=detail or help_text,
            parents=[common],
            formatter_class=argparse.RawDescriptionHelpFormatter,
        )
        if machine:
            p.add_argument(
                "--json",
                action="store_true",
                help="Print machine-readable JSON to stdout",
            )
        return p

    add("devices", "List connected trackball and receiver HID interfaces", machine=True)
    add("status", "Show storage and live input status", machine=True)
    add("input-status", "Show sensor, motion, recovery and USB status", machine=True)
    add("stock-info", "Read the stock USB updater version", machine=True)
    add("configure", "Open the standalone profile editor")
    add("config-resume", "Cancel a partial profile upload and resume saved settings")
    p = add(
        "config-read",
        "Export all eight custom profiles to JSON",
        "Read custom profiles over USB. Includes receiver pairing; keep the export private.\nRequires owned storage and normal mode. Existing files are protected by default.",
    )
    p.add_argument("path", type=Path, help="Output JSON filename")
    p.add_argument(
        "--force", action="store_true", help="Replace an existing JSON export"
    )
    for name, text in (
        ("config-write", "Validate, upload, save and read back profile JSON"),
        ("config-info", "Inspect a profile JSON file offline"),
    ):
        p = add(name, text, machine=name == "config-info")
        p.add_argument("path", type=Path)
    p = add(
        "backup-info",
        "Verify and describe a .npb user-data archive offline",
        machine=True,
    )
    p.add_argument("backup", type=Path)
    p = add(
        "image-info",
        "Validate and describe a packaged firmware image offline",
        machine=True,
    )
    p.add_argument("image", type=Path)
    p = add(
        "prepare-bin",
        "Prepare MPTool files and address instructions offline",
        "Validate/pack an application or repair its MD5 filename.\n"
        "Extract .npb user data, or preserve a sector-aligned raw dump.\n"
        "Raw dumps require their original mapped readback --address.\n"
        "Writes a .bin, JSON manifest and instructions; never opens a device.\n"
        "Examples:\n"
        "  nape prepare-bin firmware.bin\n"
        "  nape prepare-bin original.npb\n"
        "  nape prepare-bin ReadbackFlash.bin --type dump --address 0x04000000",
        machine=True,
    )
    p.add_argument(
        "path",
        type=Path,
        help="Application, MP-wrapped application, .npb, or raw readback",
    )
    p.add_argument("--type", choices=("auto", "app", "backup", "dump"), default="auto")
    p.add_argument(
        "--address",
        type=lambda s: int(s, 0),
        help="Original mapped read address, e.g. 0x04000000; required for raw dumps",
    )
    p.add_argument(
        "--out-dir",
        type=Path,
        default=Path("mptool-ready"),
        help="Output directory (default: ./mptool-ready); existing differing files are never replaced",
    )
    for name, text in (
        ("backup-uart", "Extract stock user data from a full 1 MiB UART dump"),
        ("verify-backup", "Compare every archived byte against a full UART dump"),
    ):
        p = add(
            name,
            text,
            text
            + ".\nOffline operation; does not open the serial port or flash a device.",
        )
        p.add_argument("backup", type=Path)
        p.add_argument(
            "--dump",
            type=Path,
            required=True,
            help="Full 1 MiB readback from this same device",
        )
    for name, text in (
        ("backup", "Save and verify protected stock user data (.npb)"),
        (
            "adopt",
            "Back up stock data, verify the disk copy, then adopt custom storage",
        ),
        (
            "restore-data",
            "Restore original stock user data and lock it against custom writes",
        ),
        (
            "restore-stock",
            "Restore original user data, then flash official stock 1.3.3",
        ),
    ):
        p = add(
            name,
            text,
            text
            + ".\nRequires custom firmware over USB. Use this device's original .npb.\nArchives contain exactly 45,056 user-data bytes, not firmware/ROM/eFuses.\nCustom profiles: use config-read/config-write instead. Existing backups are never overwritten.",
        )
        p.add_argument(
            "backup", type=Path, help="Original stock user-data archive (.npb)"
        )
        if name == "restore-stock":
            p.add_argument(
                "--image",
                type=Path,
                required=True,
                help="Verified official Nape Pro 1.3.3 application .bin",
            )
    for name, text in (
        ("install", "Install custom firmware through stock 1.3.3-r USB updater"),
        ("update", "Update custom firmware over USB, including recovery mode"),
    ):
        p = add(
            name,
            text,
            text
            + ".\n--image is required to prevent accidentally installing an old fallback.\nChecks model, layout, ROM compatibility and image SHA-256 before transfer.\nUser data is retained. Completion requires the application to reconnect.",
        )
        p.add_argument(
            "--image",
            type=Path,
            required=True,
            help="Packaged custom application .bin, NOT an MP wrapper or full dump",
        )
    return parser


def inspect_backup(api, path):
    data = api.load_backup(path)
    return dict(
        file=str(path.resolve()),
        format="NAPEBK01",
        integrity="SHA-256 verified",
        user_data_bytes=len(data),
        flash_offset="0xF5000..0xFFFFF",
        sha256=api.sha(data).hex(),
        identity="No hardware serial or capture timestamp stored in this archive format",
        contents=inspect_user_data(data),
    )


def execute(api, args, progress):
    action = args.action
    machine = getattr(args, "json", False)
    if action == "prepare-bin":
        from nape_mptool import prepare

        print_info(
            prepare(api, args.path, args.out_dir, args.type, args.address), machine
        )
        return
    if action == "configure":
        from nape_config_app import main

        main()
        return
    if action == "devices":
        import hid

        devices = []
        for d in hid.enumerate(0x3434, 0):
            if d["product_id"] in (0x0440, 0xD026):
                devices.append(
                    dict(
                        product=d.get("product_string"),
                        pid=f"0x{d['product_id']:04X}",
                        usage_page=hex(d.get("usage_page", 0)),
                        usage=d.get("usage"),
                        interface=d.get("interface_number"),
                    )
                )
        print_info(
            dict(
                interfaces=devices,
                note="Maintenance requires the trackball's own USB cable; the receiver is not an updater.",
            ),
            machine,
        )
        return
    if action == "backup-info":
        print_info(inspect_backup(api, args.backup), machine)
        return
    if action in ("config-info", "config-write"):
        config = read_config(args.path)  # Validate before opening the device.
        if action == "config-info":
            print_info(config_summary(config), machine)
            return
    if action == "image-info":
        stock = api.sha(args.image.read_bytes()) == api.STOCK
        image = api.read_image(args.image, stock)
        print_info(
            dict(
                file=str(args.image.resolve()),
                kind="official 1.3.3" if stock else "custom application",
                bytes=len(image),
                sha256=api.sha(image).hex(),
                application_address="0x0402D000",
                integrity="model/layout/ROM/header hash verified",
                note="File checks do not prove that the image will boot on hardware.",
            ),
            machine,
        )
        return
    if action in ("verify-backup", "backup-uart"):
        dump = args.dump.read_bytes()
        if len(dump) != api.USER_BASE + api.USER_LEN:
            raise ValueError(
                "Expected a full 1 MiB UART dump starting at flash offset zero."
            )
        if action == "backup-uart":
            size = struct.unpack_from("<I", dump, 0x2D000 + 0x1A8)[0] + 0x500
            if api.sha(dump[0x2D000 : 0x2D000 + size]) != api.STOCK:
                raise ValueError(
                    "UART extraction requires the verified stock 1.3.3 application in the dump."
                )
            api.save_verified(args.backup, dump[api.USER_BASE :])
        if api.load_backup(args.backup) != dump[api.USER_BASE :]:
            raise ValueError("Archive and UART dump have different user data.")
        print("Verified: all 45,056 user-data bytes match the UART dump.")
        print_info(inspect_backup(api, args.backup))
        return

    image = (
        api.read_image(args.image, action == "restore-stock")
        if hasattr(args, "image")
        else None
    )
    backup = api.load_backup(args.backup) if action.startswith("restore-") else None
    if backup is not None and backup[:8] == b"NPSTOR01":
        raise ValueError(
            "This is custom user data, not the original stock backup. Use config-write for custom profiles."
        )
    if image:
        progress(
            f"Validated {args.image.name}: {len(image):,} bytes, SHA-256 {api.sha(image).hex()}"
        )
    progress("Connecting to the trackball over USB")
    device = api.open_device(action in ("stock-info", "install"))
    try:
        m = api.Maintenance(device, progress=progress)
        if action == "stock-info":
            print_info(
                dict(model="KCZKNAPE", version=api.StockUpdater(device).identify()),
                machine,
            )
        elif action == "install":
            api.StockUpdater(device, progress=progress).install(image)
        elif action in ("status", "input-status"):
            result = {}
            if action == "status":
                current, boot = m.states()
                result.update(storage=current, storage_at_boot=boot)
            try:
                result.update(cfg.status(m))
            except (OSError, ValueError) as error:
                if action == "input-status":
                    raise
                result["input_status"] = f"Unavailable on this build: {error}"
            if not machine:
                result = human_status(result)
            print_info(result, machine)
        elif action == "config-resume":
            m.request(0x35)
            print("Saved configuration resumed; incomplete upload discarded.")
        elif action == "config-read":
            config = cfg.read(m)
            save_json(args.path, config, args.force)
            print(f"Verified profile export: {args.path.resolve()}")
            print_info(config_summary(config))
        elif action == "config-write":
            cfg.upload(m, config)
            print("Configuration saved, applied and read back byte-for-byte.")
            print_info(config_summary(config))
        elif action == "backup":
            if m.state() not in ("protected", "restored"):
                raise ValueError(
                    "Stock backup requires protected/restored stock data. For custom profiles use config-read; retain your original .npb."
                )
            api.save_verified(args.backup, m.snapshot())
            print_info(inspect_backup(api, args.backup))
        elif action == "adopt":
            m.migrate(args.backup)
            print(
                f"Custom storage active. Verified original backup: {args.backup.resolve()}"
            )
        elif action.startswith("restore-"):
            m.restore(backup)
            print(
                "Original user data verified on device and protected against custom writes."
            )
            if action == "restore-stock":
                m.update(image)
        elif action == "update":
            m.update(image)
    finally:
        device.close()
    if action in ("install", "update", "restore-stock"):
        progress("Activation sent; waiting up to 25 seconds for USB boot verification")
        print(
            api.wait_for_boot(
                action == "restore-stock", require_disconnect=action == "update"
            )
        )


def run(api, argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = parser_for(api)
    args = parser.parse_args(argv)
    if not args.action:
        parser.print_help()
        return 0
    progress = Progress(not getattr(args, "no_progress", False))
    try:
        execute(api, args, progress)
        return 0
    except KeyboardInterrupt:
        progress.close()
        print(
            "Interrupted. A transfer may be incomplete; inspect status before retrying.",
            file=sys.stderr,
        )
        return 130
    except (OSError, ValueError, ImportError) as error:
        progress.close()
        if getattr(args, "debug", False):
            raise
        print(f"Error [{args.action}]: {error}", file=sys.stderr)
        if isinstance(error, api.BootUnverified):
            print(
                "Do not assume boot succeeded. Try the recovery chord (Bluetooth + M1 + M2 at power-on); UART is needed if application recovery cannot start.",
                file=sys.stderr,
            )
            return 3
        if args.action == "config-write":
            print(
                "If input is paused, run 'nape config-resume'. Then read back profiles to check which save committed.",
                file=sys.stderr,
            )
        elif args.action in ("restore-data", "restore-stock", "adopt"):
            print(
                "Keep the original backup. Reconnect and inspect 'nape status'; retry with the same verified backup.",
                file=sys.stderr,
            )
        elif args.action in ("install", "update"):
            print(
                "Do not assume the update completed. Reconnect and inspect 'nape status' or 'nape stock-info' before retrying.",
                file=sys.stderr,
            )
        return 1
    finally:
        progress.close()
