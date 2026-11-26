"""Build and package the RTL8762GKU USB maintenance application."""

import argparse
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

from nape import read_image, sha

ROOT = Path(__file__).resolve().parent
REPOS = {
    "zephyr-src": ("Keychron/zephyr", "2c11634850f7d6b04e55a253d4506a6e7c8bd673"),
    "realtek-hal": ("Keychron/hal_realtek", "3c8e0bf787d80bc98c0fe4041f660ee1bf091206"),
    "cmsis": ("zephyrproject-rtos/cmsis", "5a00331455dd74e31e80efa383a489faea0590e3"),
    "tinycrypt": (
        "zephyrproject-rtos/tinycrypt",
        "3e9a49d2672ec01435ffbf0d788db6d95ef28de0",
    ),
    "keychron-zmk": ("Keychron/zmk", "7f8d16732a3782e237915bff30a1f67de09268b7"),
}


def checkout(directory, repository, revision):
    url = f"https://github.com/{repository}.git"
    if not directory.exists():
        directory.mkdir(parents=True)
        subprocess.run(["git", "init", "-q"], cwd=directory, check=True)
        subprocess.run(
            ["git", "remote", "add", "origin", url], cwd=directory, check=True
        )
    origin = subprocess.check_output(
        ["git", "remote", "get-url", "origin"], cwd=directory, text=True
    ).strip()
    if origin != url:
        raise ValueError(
            f"Unexpected Git origin in {directory}. Choose a dedicated build directory."
        )
    current = subprocess.run(
        ["git", "rev-parse", "--verify", "-q", "HEAD"],
        cwd=directory,
        stdout=subprocess.PIPE,
        text=True,
        check=False,
    )
    if current.returncode:
        subprocess.run(
            ["git", "fetch", "--depth=1", "origin", revision], cwd=directory, check=True
        )
        subprocess.run(
            ["git", "checkout", "--detach", revision], cwd=directory, check=True
        )
    elif current.stdout.strip() != revision:
        raise ValueError(
            f"{directory} is on another revision. Choose a fresh build directory."
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--work",
        type=Path,
        required=True,
        help="Dedicated build and dependency directory",
    )
    parser.add_argument(
        "--toolchain",
        type=Path,
        required=True,
        help="GNU Arm toolchain root containing bin/",
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--main-firmware", action="store_true", help="Build configurable mouse firmware"
    )
    args = parser.parse_args()
    if args.main_firmware:
        if not args.output:
            parser.error("Main firmware requires an explicit --output")
    work = args.work.resolve()
    for name, (repo, commit) in REPOS.items():
        checkout(work / name, repo, commit)
    zephyr = work / "zephyr-src"
    patch = ROOT / "firmware/zephyr-usb-only.patch"
    git_apply = [
        "git",
        "-c",
        "core.whitespace=nowarn",
        "apply",
        "--ignore-space-change",
    ]
    if subprocess.run(
        [*git_apply, "--reverse", "--check", patch],
        cwd=zephyr,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode:
        subprocess.run([*git_apply, "--check", patch], cwd=zephyr, check=True)
        subprocess.run([*git_apply, patch], cwd=zephyr, check=True)
    env = os.environ.copy()
    env.update(
        ZEPHYR_BASE=zephyr.as_posix(),
        ZEPHYR_TOOLCHAIN_VARIANT="gnuarmemb",
        GNUARMEMB_TOOLCHAIN_PATH=args.toolchain.resolve().as_posix(),
    )
    env["PATH"] = str(Path(sys.executable).parent) + os.pathsep + env["PATH"]
    build = work / ("nape-main-build" if args.main_firmware else "nape-build")
    output = args.output or ROOT / "Nape-Pro-maintenance.bin"
    options = [f"-DNAPE_MAIN={'ON' if args.main_firmware else 'OFF'}"]
    if args.main_firmware:
        configs = ";".join((ROOT / "firmware" / name).as_posix()
                           for name in ("radio.conf", "main.conf"))
        options.append(f"-DEXTRA_CONF_FILE={configs}")
    modules = ";".join(
        (work / name).as_posix() for name in ("cmsis", "realtek-hal", "tinycrypt")
    )
    subprocess.run(
        [
            "cmake",
            "-G",
            "Ninja",
            "-S",
            ROOT / "firmware",
            "-B",
            build,
            "-DBOARD=nape_pro",
            f"-DZEPHYR_MODULES={modules}",
            f"-DPYTHON_EXECUTABLE={Path(sys.executable).as_posix()}",
            *options,
        ],
        env=env,
        check=True,
    )
    subprocess.run(["cmake", "--build", build, "--parallel", "8"], env=env, check=True)
    system = {
        "Windows": "windows-x86_64",
        "Linux": "linux-x86_64",
        "Darwin": "darwin-arm64",
    }[platform.system()]
    tools = work / "keychron-zmk/app/tools"
    exe = "prepend_header.exe" if os.name == "nt" else "prepend_header"
    packer = tools / "prepend_header" / system / exe
    packed = build / "zephyr/maintenance.bin"
    shutil.copyfile(build / "zephyr/zephyr.bin", packed)
    shutil.copyfile(tools / "mp.ini", packed.parent / "mp.ini")
    subprocess.run(
        [
            packer,
            "-t",
            "app_code",
            "-p",
            packed.name,
            "-m",
            "1",
            "-c",
            "sha256",
            "-b",
            "15",
        ],
        cwd=packed.parent,
        check=True,
    )
    data = read_image(packed, stock=False)
    output.write_bytes(data)
    print(f"{output}  {len(data)} bytes  SHA-256 {sha(data).hex()}")


if __name__ == "__main__":
    main()
