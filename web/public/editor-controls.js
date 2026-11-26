import { defaults, blankBinding, action, actionName } from "./schema.js";
export function activeProfiles(c) {
  return c.profiles.map((p, i) => (p.disabled ? -1 : i)).filter((i) => i >= 0);
}
export function moveProfile(c, from, to) {
  if (from === to) return from;
  const selected = c.profiles[from],
    startup = c.profiles[c.initial_profile];
  c.profiles.splice(from, 1);
  c.profiles.splice(to, 0, selected);
  c.initial_profile =
    c.initial_profile === 255 ? 255 : c.profiles.indexOf(startup);
  return to;
}
export function deleteProfile(c, index) {
  if (activeProfiles(c).length < 2) throw Error("Keep at least one profile.");
  const visibleIndex = activeProfiles(c).indexOf(index),
    startup = c.profiles[c.initial_profile];
  c.profiles.splice(index, 1);
  const empty = defaults().profiles[7];
  empty.disabled = true;
  empty.name = "";
  c.profiles.push(empty);
  const initial = c.profiles.indexOf(startup);
  c.initial_profile =
    c.initial_profile === 255
      ? 255
      : initial < 0
        ? activeProfiles(c)[0]
        : initial;
  const visible = activeProfiles(c);
  return visible[Math.min(visibleIndex, visible.length - 1)];
}
export function addProfile(c) {
  const index = c.profiles.findIndex((p) => p.disabled);
  if (index < 0) throw Error("All eight profile slots are in use.");
  c.profiles[index] = defaults().profiles[index];
  // The reserved selector may differ from the factory default.
  c.profiles[index].layers.forEach(
    (l) => (l.buttons[c.selector] = blankBinding()),
  );
  return index;
}
export function pasteLayer(c, profile, index, source) {
  const layer = structuredClone(source);
  if (index === 0) {
    const base = c.profiles[profile].layers[0];
    layer.dpi ||= base.dpi;
    layer.motion ||= base.motion;
    layer.scroll_counts ||= base.scroll_counts;
    layer.orientation ||= base.orientation;
  }
  layer.buttons[c.selector] = blankBinding();
  c.profiles[profile].layers[index] = layer;
}
export const codeUsage = {
  Enter: 40,
  Escape: 41,
  Backspace: 42,
  Tab: 43,
  Space: 44,
  Minus: 45,
  Equal: 46,
  BracketLeft: 47,
  BracketRight: 48,
  Backslash: 49,
  Semicolon: 51,
  Quote: 52,
  Backquote: 53,
  Comma: 54,
  Period: 55,
  Slash: 56,
  CapsLock: 57,
  PrintScreen: 70,
  ScrollLock: 71,
  Pause: 72,
  Insert: 73,
  Home: 74,
  PageUp: 75,
  Delete: 76,
  End: 77,
  PageDown: 78,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82,
  NumLock: 83,
  NumpadDivide: 84,
  NumpadMultiply: 85,
  NumpadSubtract: 86,
  NumpadAdd: 87,
  NumpadEnter: 88,
  NumpadDecimal: 99,
};
for (let i = 0; i < 26; i++)
  codeUsage["Key" + String.fromCharCode(65 + i)] = 4 + i;
for (let i = 0; i < 10; i++) {
  codeUsage["Digit" + ((i + 1) % 10)] = 30 + i;
  codeUsage["Numpad" + i] = i ? 88 + i : 98;
}
for (let i = 1; i <= 12; i++) codeUsage["F" + i] = 57 + i;
export function capturedKey(e) {
  const fallback = /^[a-z]$/i.test(e.key || "")
    ? "Key" + e.key.toUpperCase()
    : /^\d$/.test(e.key || "")
      ? "Digit" + e.key
      : e.key;
  const code = codeUsage[e.code] || codeUsage[fallback];
  if (!code) return null;
  const mods =
    (e.ctrlKey ? 1 : 0) |
    (e.shiftKey ? 2 : 0) |
    (e.altKey ? 4 : 0) |
    (e.metaKey ? 8 : 0);
  return actionName(0x8000 | (mods << 7) | code);
}
const esc = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
export function keyboardSVG() {
  const rows = [
    [
      ["Esc", "Escape", 1.3],
      ...Array.from({ length: 12 }, (_, i) => [
        "F" + (i + 1),
        "F" + (i + 1),
        1,
      ]),
    ],
    [
      ["`", "Backquote"],
      ...Array.from({ length: 10 }, (_, i) => [
        String((i + 1) % 10),
        "Digit" + ((i + 1) % 10),
      ]),
      ["−", "Minus"],
      ["=", "Equal"],
      ["⌫", "Backspace", 1.5],
    ],
    [
      ["Tab", "Tab", 1.5],
      ..."QWERTYUIOP".split("").map((k) => [k, "Key" + k]),
      ["[", "BracketLeft"],
      ["]", "BracketRight"],
      ["\\", "Backslash"],
    ],
    [
      ["Caps", "CapsLock", 1.7],
      ..."ASDFGHJKL".split("").map((k) => [k, "Key" + k]),
      [";", "Semicolon"],
      ["'", "Quote"],
      ["Enter", "Enter", 1.8],
    ],
    [
      ["Shift", "mod:SHIFT", 2.2],
      ..."ZXCVBNM".split("").map((k) => [k, "Key" + k]),
      [",", "Comma"],
      [".", "Period"],
      ["/", "Slash"],
      ["↑", "ArrowUp"],
      ["Shift", "mod:SHIFT", 1.3],
    ],
    [
      ["Ctrl", "mod:CTRL", 1.4],
      ["Win", "mod:GUI", 1.3],
      ["Alt", "mod:ALT", 1.3],
      ["Space", "Space", 6.5],
      ["←", "ArrowLeft"],
      ["↓", "ArrowDown"],
      ["→", "ArrowRight"],
    ],
  ];
  let svg =
    '<svg viewBox="0 0 600 226" role="group" aria-label="Keyboard actions">';
  rows.forEach((row, r) => {
    let x = 0;
    for (const [label, code, w = 1] of row) {
      const width = w * 40 - 4;
      svg += `<g role="button" tabindex="0" data-key="${esc(code)}" aria-label="${esc(code.startsWith("mod:") ? "Toggle " + label : "Assign " + label)}"><rect x="${x}" y="${r * 38}" width="${width}" height="32" rx="4"/><text x="${x + width / 2}" y="${r * 38 + 21}">${esc(label)}</text></g>`;
      x += w * 40;
    }
  });
  return svg + "</svg>";
}
export function installInputPalette(host, assign, changed) {
  host.innerHTML = `<div class="keyboard-map">${keyboardSVG()}</div>
 <div class="mouse-palette"><svg viewBox="0 0 124 112" role="group" aria-label="Mouse buttons"><path class="mouse-body" d="M32 12 Q32 2 62 2 Q92 2 92 12 V74 Q92 108 62 108 Q32 108 32 74Z"/><g data-output="Mouse1" tabindex="0" role="button" aria-label="Assign primary mouse button"><path d="M34 34 V14 Q34 4 60 4 V34Z"/><text x="46" y="24">1</text></g><g data-output="Mouse2" tabindex="0" role="button" aria-label="Assign secondary mouse button"><path d="M64 4 Q90 4 90 14 V34 H64Z"/><text x="78" y="24">2</text></g><g data-output="Mouse3" tabindex="0" role="button" aria-label="Assign middle mouse button"><rect x="55" y="38" width="14" height="24" rx="5"/><text x="62" y="54">3</text></g><g data-output="Mouse4" tabindex="0" role="button" aria-label="Assign mouse button 4"><rect x="16" y="40" width="12" height="24" rx="3"/><text x="22" y="56">4</text></g><g data-output="Mouse5" tabindex="0" role="button" aria-label="Assign mouse button 5"><rect x="16" y="68" width="12" height="24" rx="3"/><text x="22" y="84">5</text></g></svg>
 <div class="mouse-actions">${[
   ["Mouse3", "Middle"],
   ["Mouse4", "4 · Back"],
   ["Mouse5", "5 · Forward"],
   ["ScrollUp", "↑ Scroll"],
   ["ScrollDown", "↓ Scroll"],
   ["ScrollLeft", "← Scroll"],
   ["ScrollRight", "→ Scroll"],
 ]
   .map(([v, l]) => `<button data-output="${v}">${l}</button>`)
   .join("")}</div></div>
 <div class="capture-row"><div id="capture-zone" tabindex="0" role="button" aria-label="Capture input"><span>Hover here to capture</span><strong id="captured-action">Key combination or mouse button</strong></div><button id="use-capture" disabled>Assign</button></div><small class="capture-note">Esc exits capture. Some OS/browser shortcuts cannot be captured.</small>`;
  const mods = new Set();
  let captured = null,
    active = false,
    previous = null,
    escaped = false;
  const zone = host.querySelector("#capture-zone"),
    use = host.querySelector("#use-capture"),
    display = host.querySelector("#captured-action");
  const record = (value) => {
    captured = value;
    display.textContent = value;
    use.disabled = !value;
  };
  function choose(e) {
    const out = e.target.closest("[data-output]"),
      key = e.target.closest("[data-key]");
    if (out) {
      assign(out.dataset.output);
      return;
    }
    if (!key) return;
    const code = key.dataset.key;
    if (code.startsWith("mod:")) {
      const name = code.slice(4);
      mods.has(name) ? mods.delete(name) : mods.add(name);
      host.querySelectorAll("[data-key]").forEach((n) => {
        const selected = mods.has(n.dataset.key.slice(4));
        n.classList.toggle("selected", selected);
        n.setAttribute("aria-pressed", String(selected));
      });
      return;
    }
    const bits = [...mods].reduce(
      (v, k) => v | { CTRL: 1, SHIFT: 2, ALT: 4, GUI: 8 }[k],
      0,
    );
    assign(actionName(0x8000 | (bits << 7) | codeUsage[code]));
  }
  host.addEventListener("click", (e) => {
    if (!zone.contains(e.target) && e.target !== use) choose(e);
  });
  host.addEventListener("keydown", (e) => {
    if (
      (e.key === "Enter" || e.key === " ") &&
      e.target.closest("[data-output],[data-key]")
    ) {
      e.preventDefault();
      choose(e);
    }
  });
  const suppress = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  zone.onpointerenter = () => {
    escaped = false;
    previous = document.activeElement;
    zone.focus({ preventScroll: true });
    active = true;
    zone.classList.add("listening");
  };
  zone.onfocus = () => {
    if (!escaped) {
      active = true;
      zone.classList.add("listening");
    }
  };
  const stop = () => {
    active = false;
    zone.classList.remove("listening");
  };
  zone.onpointerleave = () => {
    stop();
    if (document.activeElement === zone) {
      zone.blur();
      previous?.focus?.({ preventScroll: true });
    }
  };
  zone.onblur = stop;
  window.addEventListener("blur", stop);
  for (const type of [
    "pointerdown",
    "mousedown",
    "mouseup",
    "auxclick",
    "click",
    "contextmenu",
  ])
    zone.addEventListener(
      type,
      (e) => {
        suppress(e);
        if (type === "pointerdown") {
          const output = {
            0: "Mouse1",
            1: "Mouse3",
            2: "Mouse2",
            3: "Mouse4",
            4: "Mouse5",
          }[e.button];
          if (output) record(output);
        }
      },
      true,
    );
  zone.addEventListener(
    "wheel",
    (e) => {
      suppress(e);
      record(
        Math.abs(e.deltaX) > Math.abs(e.deltaY)
          ? e.deltaX > 0
            ? "ScrollRight"
            : "ScrollLeft"
          : e.deltaY > 0
            ? "ScrollDown"
            : "ScrollUp",
      );
    },
    { passive: false },
  );
  const onKey = (e) => {
    if ((!active && document.activeElement !== zone) || host.hidden) return;
    suppress(e);
    if (e.key === "Escape") {
      escaped = true;
      stop();
      zone.blur();
      return;
    }
    if (e.repeat) return;
    const value = capturedKey(e);
    if (value) record(value);
    else if (!["Control", "Shift", "Alt", "Meta"].includes(e.key))
      display.textContent = "Key not supported";
  };
  window.addEventListener("keydown", onKey, true);
  zone.addEventListener("keydown", onKey);
  window.addEventListener(
    "keyup",
    (e) => {
      if ((active || document.activeElement === zone) && !host.hidden)
        suppress(e);
    },
    true,
  );
  use.onclick = () => {
    if (captured) assign(captured);
  };
  return {
    setEnabled(enabled) {
      host.classList.toggle("unavailable", !enabled);
      host
        .querySelectorAll("button")
        .forEach((n) => (n.disabled = !enabled || (n === use && !captured)));
      host.setAttribute("aria-disabled", String(!enabled));
    },
  };
}
