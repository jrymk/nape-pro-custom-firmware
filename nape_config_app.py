"""Standalone profile editor. USB is needed only for reading or uploading settings."""

import copy
import json
import queue
import threading
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, colorchooser
from pathlib import Path
import nape
import profile_config as cfg


class Editor:
    def __init__(self, root):
        self.root = root
        self.config = cfg.defaults()
        self.current = (0, 0)
        self.loading = False
        self.results = queue.Queue()
        self.busy = False
        root.title("Nape Pro — Profiles")
        root.geometry("1140x900")
        root.minsize(1080, 860)
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TButton", padding=7)
        outer = ttk.Frame(root, padding=18)
        outer.pack(fill="both", expand=True)
        ttk.Label(outer, text="Nape Pro", font=("Segoe UI", 22, "bold")).pack(
            anchor="w"
        )
        ttk.Label(
            outer,
            text="Eight profiles • Eight layers each • Runs on your trackball",
            font=("Segoe UI", 11),
        ).pack(anchor="w", pady=(0, 12))
        toolbar = ttk.Frame(outer)
        toolbar.pack(fill="x")
        self.operation_buttons = []
        for label, fn in [
            ("Read device", self.read),
            ("Upload & save", self.upload),
            ("Device status", self.status),
            ("Open JSON", self.open),
            ("Save JSON", self.save),
            ("Import receiver bond", self.bond),
        ]:
            b = ttk.Button(toolbar, text=label, command=fn)
            b.pack(side="left", padx=(0, 5))
            self.operation_buttons.append(b)
        self.message = tk.StringVar(
            value="Offline defaults. Read the device before editing an existing configuration."
        )
        ttk.Label(outer, textvariable=self.message, wraplength=1080).pack(
            side="bottom", fill="x"
        )
        tabs = ttk.Notebook(outer)
        tabs.pack(fill="both", expand=True, pady=12)
        settings = ttk.Frame(tabs, padding=12)
        global_tab = ttk.Frame(tabs, padding=16)
        tabs.add(settings, text="Profiles & layers")
        tabs.add(global_tab, text="Device & help")
        nav = ttk.Frame(settings)
        nav.pack(fill="x")
        self.profile = tk.StringVar(value="1")
        self.layer = tk.StringVar(value="0")
        for label, var, values in [
            ("Profile", self.profile, [str(i + 1) for i in range(8)]),
            ("Layer", self.layer, [str(i) for i in range(8)]),
        ]:
            ttk.Label(nav, text=label).pack(side="left", padx=(0, 6))
            box = ttk.Combobox(
                nav, textvariable=var, values=values, width=6, state="readonly"
            )
            box.pack(side="left", padx=(0, 18))
            box.bind("<<ComboboxSelected>>", self.select)
        self.fields = {}
        profile_box = ttk.LabelFrame(settings, text="Profile defaults", padding=10)
        profile_box.pack(fill="x", pady=10)
        layer_box = ttk.LabelFrame(
            settings, text="Selected layer — 0 is the base layer", padding=10
        )
        layer_box.pack(fill="x")

        def field(parent, label, key, values=None, width=16):
            f = ttk.Frame(parent)
            f.pack(side="left", padx=(0, 12))
            ttk.Label(f, text=label).pack(anchor="w")
            v = tk.StringVar()
            self.fields[key] = v
            if values:
                w = ttk.Combobox(
                    f, textvariable=v, values=values, width=width, state="readonly"
                )
            else:
                w = ttk.Entry(f, textvariable=v, width=width)
            w.pack(anchor="w")
            return f

        field(profile_box, "Name", "name", width=22)
        pc = field(profile_box, "LED color (RRGGBB)", "profile_color", width=12)
        ttk.Button(
            pc, text="Choose", command=lambda: self.choose("profile_color")
        ).pack(anchor="w")
        field(profile_box, "Report rate (Hz)", "hz", ["125", "250", "500"], 12)
        field(profile_box, "Selector tap action", "selector_action", width=19)
        field(layer_box, "DPI (0 = inherit)", "dpi", width=14)
        field(layer_box, "Trackball function", "motion", cfg.MODES, 14)
        field(layer_box, "Orientation", "orientation", cfg.ORIENTATIONS, 14)
        field(layer_box, "Counts / scroll detent", "counts", width=19)
        lc = field(layer_box, "LED color (RRGGBB)", "layer_color", width=12)
        ttk.Button(lc, text="Choose", command=lambda: self.choose("layer_color")).pack(
            anchor="w"
        )
        self.layer_led = tk.BooleanVar()
        ttk.Checkbutton(layer_box, text="Override LED", variable=self.layer_led).pack(
            side="left"
        )
        binding_box = ttk.LabelFrame(settings, text="Button actions", padding=10)
        binding_box.pack(fill="both", expand=True, pady=10)
        for col, title in enumerate(
            [
                "Button",
                "Behavior",
                "Target layer",
                "Output / unused-release action",
                "Value",
                "Scroll counts (0 = layer)",
            ]
        ):
            ttk.Label(binding_box, text=title, font=("Segoe UI", 9, "bold")).grid(
                row=0, column=col, sticky="w", padx=5, pady=(0, 8)
            )
        self.rows = []
        for i in range(6):
            ttk.Label(binding_box, text=cfg.BUTTONS[i]).grid(
                row=i + 1, column=0, sticky="w", padx=5
            )
            vars = [tk.StringVar() for _ in range(5)]
            self.rows.append(vars)
            for col, (var, values, width) in enumerate(
                zip(
                    vars,
                    [cfg.KINDS, [str(n) for n in range(8)], None, None, None],
                    [25, 12, 28, 14, 18],
                ),
                1,
            ):
                w = (
                    ttk.Combobox(
                        binding_box,
                        textvariable=var,
                        values=values,
                        width=width,
                        state="readonly",
                    )
                    if values
                    else ttk.Entry(binding_box, textvariable=var, width=width)
                )
                w.grid(row=i + 1, column=col, sticky="ew", padx=5, pady=5)
            vars[0].trace_add("write", lambda *_, i=i: self.binding_kind(i))
        ttk.Label(
            binding_box,
            text="Output: Mouse1…Mouse8, A, CTRL+C, CTRL+PLUS, ALT+LEFT, etc.\nValue: DPI number · motion 1=pointer / 2=scroll · LED hex color (e.g. FF6400).",
            wraplength=960,
        ).grid(row=8, column=0, columnspan=5, sticky="w", padx=5, pady=10)
        ttk.Label(
            settings,
            text="Transparent falls through to lower active layers. Higher layer numbers take priority.\nHold Bluetooth + turn the wheel to preview profiles; release to select.",
            wraplength=980,
        ).pack(anchor="w")
        self.global_vars = {}
        for row, (label, key, values) in enumerate(
            [
                (
                    "Profile at power-on",
                    "initial_profile",
                    ["Last used"] + [str(i + 1) for i in range(8)],
                ),
                (
                    "Mouse output transport",
                    "transport",
                    [
                        "Auto: switch selects radio / wired",
                        "Wired only",
                        "2.4 GHz only",
                    ],
                ),
                ("Button debounce (ms)", "debounce_ms", None),
            ]
        ):
            ttk.Label(global_tab, text=label).grid(
                row=row, column=0, sticky="w", pady=8
            )
            v = tk.StringVar()
            self.global_vars[key] = v
            w = (
                ttk.Combobox(
                    global_tab,
                    textvariable=v,
                    values=values,
                    state="readonly",
                    width=38,
                )
                if values
                else ttk.Entry(global_tab, textvariable=v, width=40)
            )
            w.grid(row=row, column=1, sticky="w", padx=14)
        ttk.Label(
            global_tab,
            text="Receiver pairing is imported from your verified stock .npb backup. No re-pairing or receiver firmware change.\n\nWired: mouse, keyboard shortcuts, and high-resolution scroll when enabled by the host.\nStock 2.4 GHz receiver: mouse buttons, X/Y, vertical/horizontal wheel. Keyboard actions are wired-only in this build.\nThe UI offers validated targets up to 500 Hz; 1000 Hz remains experimental.\nBluetooth, gestures, dial mode and custom HID modes are not implemented yet.\n\nSet DPI / motion / LED actions last until reset overrides, a profile change, or reboot. They do not write flash.\nUnused-release layer actions have no timeout. A subsequent action consumes the release action.\n\nRecovery: hold Bluetooth + M1 + M2 while powering on. Green pulses indicate USB recovery.\nUse nape.exe update --image <firmware.bin> to flash. Recovery does not start profiles, sensor or radio.\n\nUpload & save writes a verified alternate flash slot and applies the settings.\nThe previous slot remains available if the upload is interrupted. No companion process is required.",
            wraplength=950,
            justify="left",
        ).grid(row=6, column=0, columnspan=2, sticky="w", pady=20)
        self.load_global()
        self.load_selection()
        root.after(100, self.poll)

    def choose(self, key):
        chosen = colorchooser.askcolor("#" + self.fields[key].get(), parent=self.root)[
            1
        ]
        if chosen:
            self.fields[key].set(chosen[1:].upper())

    def binding_kind(self, i):
        if self.loading:
            return
        k, t, a, v = self.rows[i]
        kind = cfg.KINDS.index(k.get())
        if kind not in (3, 4, 9):
            t.set("0")
        elif t.get() == "0":
            t.set("1")
        if kind not in (2, 4):
            a.set("None")
        elif a.get() == "None":
            a.set("Mouse1")
        v.set(
            "1600"
            if kind == 5
            else "1" if kind == 6 else "FF6400" if kind == 7 else "0"
        )

    def store_selection(self):
        p, l = self.current
        pr = self.config["profiles"][p]
        ly = pr["layers"][l]
        f = self.fields
        pr.update(
            name=f["name"].get(),
            color=f["profile_color"].get(),
            report_hz=int(f["hz"].get()),
            selector_action=f["selector_action"].get(),
        )
        ly.update(
            dpi=int(f["dpi"].get()),
            motion=cfg.MODES.index(f["motion"].get()),
            orientation=cfg.ORIENTATIONS.index(f["orientation"].get()),
            scroll_counts=int(f["counts"].get()),
            color=f["layer_color"].get(),
            led_override=self.layer_led.get(),
        )
        for i, (k, t, a, v, counts) in enumerate(self.rows):
            kind = cfg.KINDS.index(k.get())
            value = int(v.get().removeprefix("#"), 16 if kind == 7 else 10)
            ly["buttons"][i] = dict(
                kind=kind, layer=int(t.get()), action=a.get(), value=value
            )
            if kind in (6, 12, 15) and value == 2 and int(counts.get()):
                ly["buttons"][i]["scroll_counts"] = int(counts.get())

    def load_selection(self):
        self.loading = True
        p, l = self.current
        pr = self.config["profiles"][p]
        ly = pr["layers"][l]
        for k, v in dict(
            name=pr["name"],
            profile_color=pr["color"],
            hz=pr["report_hz"],
            selector_action=pr["selector_action"],
            dpi=ly["dpi"],
            motion=cfg.MODES[ly["motion"]],
            orientation=cfg.ORIENTATIONS[ly.get("orientation", 0)],
            counts=ly["scroll_counts"],
            layer_color=ly["color"],
        ).items():
            self.fields[k].set(v)
        self.layer_led.set(ly["led_override"])
        for row, b in zip(self.rows, ly["buttons"]):
            for var, val in zip(
                row,
                [
                    cfg.KINDS[b["kind"]],
                    b["layer"],
                    b["action"],
                    f"{b['value']:06X}" if b["kind"] == 7 else b["value"],
                    b.get("scroll_counts", 0),
                ],
            ):
                var.set(val)
        self.loading = False

    def select(self, event=None):
        try:
            self.store_selection()
        except Exception as e:
            self.profile.set(str(self.current[0] + 1))
            self.layer.set(str(self.current[1]))
            messagebox.showerror("Invalid field", str(e))
            return
        self.current = (int(self.profile.get()) - 1, int(self.layer.get()))
        self.load_selection()

    def load_global(self):
        for key, var in self.global_vars.items():
            value = self.config[key]
            if key == "initial_profile":
                value = "Last used" if value == 255 else value + 1
            if key == "transport":
                value = [
                    "Auto: switch selects radio / wired",
                    "Wired only",
                    "2.4 GHz only",
                ][value]
            var.set(value)

    def snapshot(self):
        self.store_selection()
        for key, var in self.global_vars.items():
            value = var.get()
            if key == "transport":
                value = [
                    "Auto: switch selects radio / wired",
                    "Wired only",
                    "2.4 GHz only",
                ].index(value)
            else:
                value = (255 if value == "Last used" else int(value) - 1) if key == "initial_profile" else int(value)
            self.config[key] = value
        cfg.encode(self.config)
        return copy.deepcopy(self.config)

    def job(self, fn):
        if self.busy:
            return
        self.busy = True
        for b in self.operation_buttons:
            b.state(["disabled"])
        self.message.set("Working over USB…")

        def worker():
            try:
                dev = nape.open_device()
                try:
                    result = fn(nape.Maintenance(dev))
                finally:
                    dev.close()
                self.results.put((True, result))
            except Exception as e:
                self.results.put((False, str(e)))

        threading.Thread(target=worker, daemon=True).start()

    def poll(self):
        try:
            ok, result = self.results.get_nowait()
            self.busy = False
            for b in self.operation_buttons:
                b.state(["!disabled"])
            if not ok:
                self.message.set("Error: " + result)
            elif isinstance(result, dict) and "profiles" in result:
                self.config = result
                self.load_global()
                self.load_selection()
                self.message.set(
                    "Read device configuration. Changes are saved only by Upload & save."
                )
            else:
                self.message.set(str(result))
        except queue.Empty:
            pass
        self.root.after(100, self.poll)

    def read(self):
        self.job(cfg.read)

    def upload(self):
        try:
            c = self.snapshot()
        except Exception as e:
            messagebox.showerror("Invalid settings", str(e))
            return
        self.job(
            lambda client: (
                cfg.upload(client, c),
                "Saved, applied, and verified by readback.",
            )[1]
        )

    def status(self):
        self.job(lambda client: json.dumps(cfg.status(client)))

    def open(self):
        path = filedialog.askopenfilename(filetypes=[("Profile JSON", "*.json")])
        if not path:
            return
        try:
            c = json.loads(Path(path).read_text(encoding="utf-8"))
            cfg.encode(c)
            if c["selector"] != 6:
                raise ValueError(
                    "This editor reserves the Bluetooth button as selector"
                )
            self.config = c
            self.load_global()
            self.load_selection()
            self.message.set("Loaded JSON. Not uploaded yet.")
        except Exception as e:
            messagebox.showerror("Cannot open", str(e))

    def save(self):
        try:
            c = self.snapshot()
        except Exception as e:
            messagebox.showerror("Invalid settings", str(e))
            return
        path = filedialog.asksaveasfilename(
            defaultextension=".json", filetypes=[("Profile JSON", "*.json")]
        )
        if path:
            Path(path).write_text(json.dumps(c, indent=2), encoding="utf-8")
            self.message.set("Saved JSON. Not uploaded.")

    def bond(self):
        path = filedialog.askopenfilename(filetypes=[("Verified Nape backup", "*.npb")])
        if not path:
            return
        try:
            from nape_support import extract_bond

            self.config["bond"] = extract_bond(nape.load_backup(Path(path))).hex()
            self.message.set(
                "Imported receiver pairing. Upload & save to retain it on the trackball."
            )
        except Exception as e:
            messagebox.showerror("Cannot import pairing", str(e))


def main():
    root = tk.Tk()
    Editor(root)
    root.mainloop()


if __name__ == "__main__":
    main()
