import { StockHID } from "./maintenance.js";
import { mountDeviceTools } from "./device-tools.js";
import { installProfileDrag } from "./profile-drag.js";
let actionPage = 0;
import {
  defaults,
  encode,
  decode,
  action,
  blankBinding,
  BUTTONS,
  KINDS,
  MODES,
  MEDIA,
  importBond,
} from "./schema.js";
import {
  activeProfiles,
  moveProfile,
  deleteProfile,
  addProfile,
  pasteLayer,
  installInputPalette,
} from "./editor-controls.js";
import {
  behaviorOf,
  actionOf,
  composeBinding,
  LAYER_KINDS,
} from "./action-model.js";
import { NapeHID, currentFirmware, firmwareVersion } from "./hid.js";
import { liveSelection } from "./live-state.js";
import { AutoSave } from "./auto-save.js";
const $ = (id) => document.getElementById(id);
const copy = (x) => structuredClone(x);
let deviceProfiles = null,
  savedProfiles = null,
  statusPolling = false;
let autoConnectPaused = false,
  connecting = false,
  lastDevice = null;
let stockClient = null;
let loadedBond = null;
let config = defaults(),
  profile = 0,
  layer = 0,
  button = 4,
  dirty = false,
  busy = false,
  client = null,
  deviceInfo = null,
  live = null,
  category = "Quick",
  search = "";
const ACTIONS = [
  {
    id: "mouse1",
    name: "Primary click",
    desc: "Left mouse button",
    icon: "↖",
    category: "Mouse",
    binding: { ...blankBinding(2), action: "Mouse1" },
  },
  {
    id: "mouse2",
    name: "Secondary click",
    desc: "Right mouse button",
    icon: "↗",
    category: "Mouse",
    binding: { ...blankBinding(2), action: "Mouse2" },
  },
  {
    id: "mouse3",
    name: "Middle click",
    desc: "Mouse button 3",
    icon: "⊙",
    category: "Mouse",
    binding: { ...blankBinding(2), action: "Mouse3" },
  },
  {
    id: "mouse4",
    name: "Mouse button",
    desc: "Back, forward or buttons 1–8",
    icon: "◫",
    category: "Mouse",
    binding: { ...blankBinding(2), action: "Mouse4" },
  },
  {
    id: "key",
    name: "Keyboard shortcut",
    desc: "A key with optional modifiers",
    icon: "⌘",
    category: "Keyboard",
    binding: { ...blankBinding(2), action: "CTRL+C" },
  },
  {
    id: "hold",
    name: "Hold a layer",
    desc: "Active while this button is down",
    icon: "▱",
    category: "Layers",
    binding: { ...blankBinding(3), layer: 1 },
  },
  {
    id: "unused",
    name: "Hold + unused release",
    desc: "A second action if the layer is unused",
    icon: "▱+",
    category: "Layers",
    binding: { kind: 4, layer: 1, action: "Mouse5", value: 0 },
  },
  {
    id: "toggle",
    name: "Toggle a layer",
    desc: "Tap once on, tap again off",
    icon: "◩",
    category: "Layers",
    binding: { ...blankBinding(9), layer: 1 },
  },
  {
    id: "dpi",
    name: "Set DPI",
    desc: "Change pointer sensitivity",
    icon: "◎",
    category: "Motion",
    binding: { ...blankBinding(5), value: 400 },
  },
  {
    id: "mode",
    name: "Set ball function",
    desc: "Pointer or trackball scrolling",
    icon: "↕",
    category: "Motion",
    binding: { ...blankBinding(6), value: 2, scroll_counts: 16 },
  },
  {
    id: "led",
    name: "Set LED color",
    desc: "Apply a runtime color override",
    icon: "◉",
    category: "Utility",
    binding: { ...blankBinding(7), value: 0xff6400 },
  },
  {
    id: "reset",
    name: "Reset overrides",
    desc: "Return to the layer’s settings",
    icon: "↺",
    category: "Utility",
    binding: blankBinding(8),
  },
  {
    id: "transparent",
    name: "Transparent",
    desc: "Use the next active layer below",
    icon: "▧",
    category: "Layers",
    binding: blankBinding(),
  },
  {
    id: "disabled",
    name: "No action",
    desc: "Block this button on this layer",
    icon: "∅",
    category: "Utility",
    binding: blankBinding(1),
  },
];
const BALL_ACTIONS = [
  {
    name: "None",
    desc: "Disable ball movement",
    icon: "∅",
    category: "Motion",
    apply: () => (selectedLayer().motion = 3),
  },
  {
    name: "Pointer",
    desc: "Move the cursor",
    icon: "↖",
    category: "Motion",
    apply: () => (selectedLayer().motion = 1),
  },
  {
    name: "Scroll",
    desc: "Scroll using the ball",
    icon: "↕",
    category: "Motion",
    apply: () => (selectedLayer().motion = 2),
  },
  {
    name: "Inherit",
    desc: "Use lower active layer",
    icon: "▧",
    category: "Motion",
    apply: () => {
      if (layer) selectedLayer().motion = 0;
    },
  },
];
const LED_ACTIONS = [
  {
    name: "Inherit LED",
    desc: "Use lower layer or profile",
    icon: "◉",
    category: "Utility",
    apply: () => (selectedLayer().led_override = false),
  },
  {
    name: "Solid color",
    desc: "Use this layer’s color",
    icon: "◉",
    category: "Utility",
    apply: () => {
      selectedLayer().led_override = true;
      if (selectedLayer().color === "000000")
        selectedLayer().color = config.profiles[profile].color;
    },
  },
  {
    name: "LED off",
    desc: "Turn off the indicator",
    icon: "○",
    category: "Utility",
    apply: () => {
      selectedLayer().led_override = true;
      selectedLayer().color = "000000";
    },
  },
];
ACTIONS.push(
  ...["ScrollUp", "ScrollDown", "ScrollLeft", "ScrollRight"].map((name) => ({
    id: name,
    name: name.replace("Scroll", "Scroll "),
    desc: "One scroll step",
    icon: "↕",
    category: "Mouse",
    binding: { ...blankBinding(2), action: name },
  })),
);
ACTIONS.push(
  ...[5, 6, 7, 8].map((i) => ({
    id: `mouse${i}`,
    name: i === 5 ? "Forward · Mouse5" : `Mouse${i}`,
    desc: `Mouse button ${i}`,
    icon: "◫",
    category: "Mouse",
    binding: { ...blankBinding(2), action: `Mouse${i}` },
  })),
  ...[
    ["PLAYPAUSE", "Play / pause"],
    ["NEXTTRACK", "Next track"],
    ["PREVTRACK", "Previous track"],
    ["MEDIASTOP", "Stop media"],
    ["MUTE", "Mute"],
    ["VOLUMEUP", "Volume up"],
    ["VOLUMEDOWN", "Volume down"],
    ["EJECT", "Eject"],
  ].map(([action, name]) => ({
    id: action,
    name,
    desc: "USB consumer control · wired only",
    icon: "♫",
    category: "Keyboard",
    binding: { ...blankBinding(2), action },
  })),
  ...[
    ["USAGE46", "Print screen"],
    ["USAGE47", "Scroll lock"],
    ["USAGE48", "Pause"],
    ["USAGE49", "Insert"],
    ["USAGE4A", "Home"],
    ["USAGE4B", "Page up"],
    ["DELETE", "Delete"],
    ["USAGE4D", "End"],
    ["USAGE4E", "Page down"],
    ...Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `F${i + 1}`]),
  ].map(([action, name]) => ({
    id: action,
    name,
    desc: "Keyboard key · wired only",
    icon: "⌨",
    category: "Keyboard",
    binding: { ...blankBinding(2), action },
  })),
  {
    id: "clear-action",
    name: "None",
    desc: "No secondary action",
    icon: "∅",
    category: "Utility",
    binding: blankBinding(1),
  },
);
const CONTROL_NAMES = [
  ...BUTTONS,
  "Clockwise",
  "Counterclockwise",
  "Trackball",
  "LED",
];
const isWheel = () => button === 7 || button === 8;
const fixedWheel = () => isWheel() && layer === 7;
const binding = () => {
  if (button < 7) return selectedLayer().buttons[button];
  if (isWheel()) {
    const value = (selectedLayer().wheel ?? ["Inherit", "Inherit"])[button - 7];
    return {
      kind: value === "Inherit" ? 0 : value === "Disabled" ? 1 : 2,
      layer: 0,
      action: value === "Inherit" || value === "Disabled" ? "None" : value,
      value: 0,
    };
  }
  return blankBinding();
};
function setBinding(value) {
  if (isWheel()) {
    selectedLayer().wheel ??= ["Inherit", "Inherit"];
    selectedLayer().wheel[button - 7] =
      value.kind === 0
        ? "Inherit"
        : value.kind === 1
          ? "Disabled"
          : value.action;
  } else selectedLayer().buttons[button] = value;
}
function controlFunction(index) {
  if (index === 9) return MODES[selectedLayer().motion];
  if (index === 10)
    return !selectedLayer().led_override
      ? "Inherit"
      : selectedLayer().color === "000000"
        ? "Off"
        : "#" + selectedLayer().color;
  if ((index === 7 || index === 8) && layer === 7)
    return index === 7 ? "Next profile" : "Previous profile";
  if (index === 7 || index === 8) {
    const value = (selectedLayer().wheel ?? ["Inherit", "Inherit"])[index - 7];
    return value === "Inherit" && layer === 0
      ? index === 7
        ? "Scroll up"
        : "Scroll down"
      : value;
  }
  if (index === config.selector) return "Hold layer P";
  const b = selectedLayer().buttons[index];
  if (b.kind >= 10) return describe(b);
  return [
    "Inherit",
    "Disabled",
    b.action,
    `Hold layer ${b.layer === 7 ? "P" : b.layer}`,
    `L${b.layer} + release`,
    `${b.value} DPI`,
    MODES[b.value],
    "LED color",
    "Reset",
    "Toggle L" + b.layer,
  ][b.kind];
}
const mapTemplate = document.querySelector(".trackball").cloneNode(true);
let mapOrientation = -1;
function renderMapOrientation() {
  const chosen =
    selectedLayer().orientation ||
    config.profiles[profile].layers[0].orientation ||
    1;
  const degrees = (chosen * 90) % 360;
  if (mapOrientation === degrees) return;
  mapOrientation = degrees;
  const svg = document.querySelector(".trackball");
  svg.innerHTML = mapTemplate.innerHTML;
  const vertical = degrees === 90 || degrees === 270;
  svg.classList.toggle("vertical", vertical);
  svg.setAttribute("viewBox", vertical ? "0 0 430 500" : "0 0 500 244");
  const angle = (degrees * Math.PI) / 180;
  const project = (x, y) => [
    Math.round(
      (vertical ? 215 : 250) +
        (x - 250) * Math.cos(angle) -
        (y - 120) * Math.sin(angle),
    ),
    Math.round(
      (vertical ? 250 : 120) +
        (x - 250) * Math.sin(angle) +
        (y - 120) * Math.cos(angle),
    ),
  ];
  const transform = `translate(${vertical ? 215 : 250} ${vertical ? 250 : 120}) rotate(${degrees}) translate(-250 -120)`;
  const wrap = (node) => {
    const g = document.createElementNS(svg.namespaceURI, "g");
    node.replaceWith(g);
    g.append(node);
    g.setAttribute("transform", transform);
  };
  wrap(svg.querySelector(".map-outline"));
  svg.querySelectorAll(".map-control:not(.control-card)").forEach((g) => {
    [...g.children]
      .filter((n) => !["text", "title"].includes(n.tagName))
      .forEach(wrap);
    const id = Number(g.dataset.control);
    if (vertical && id !== 9)
      g.querySelectorAll("text").forEach((n) => n.remove());
    else if (id === 9)
      g.querySelectorAll("text").forEach((n, i) => {
        n.setAttribute("x", vertical ? 215 : 250);
        n.setAttribute("y", (vertical ? 245 : 115) + i * 17);
      });
    else if (degrees === 180 && id < 4)
      g.querySelectorAll("text").forEach((n, i) => {
        n.setAttribute("x", id < 2 ? 107 : 345);
        n.setAttribute("y", (id % 2 === 0 ? 78 : 140) + i * 17);
      });
  });
  if (vertical) {
    const sample = svg.querySelector(".control-card").cloneNode(true);
    svg.querySelectorAll(".control-card").forEach((n) => n.remove());
    const points = [
      [6, "Round", 81, 77],
      [3, "04", 143, 89],
      [2, "03", 143, 151],
      [1, "02", 357, 89],
      [0, "01", 357, 151],
      [5, "M2", 443, 91],
      [4, "M1", 443, 149],
      [7, "↻ Clockwise", 250, 28],
      [8, "↺ Counterclockwise", 250, 212],
    ];
    for (const [id, name, px, py] of points) {
      const [cx, cy] = project(px, py),
        x = cx < 215 ? 0 : 290,
        y = cy - 24;
      const g = sample.cloneNode(true);
      g.dataset.control = id;
      g.setAttribute("aria-label", "Configure " + name);
      const r = g.querySelector("rect");
      for (const [k, v] of Object.entries({ x, y, width: 140, height: 48 }))
        r.setAttribute(k, v);
      g.querySelectorAll("text").forEach((n, i) => {
        n.setAttribute("x", x + 8);
        n.setAttribute("y", y + 17 + i * 20);
      });
      g.querySelector(".control-name").textContent = name;
      g.querySelector(".control-function").dataset.controlFunction = id;
      svg.append(g);
    }
  } else if (degrees === 180) {
    svg.querySelectorAll(".control-card").forEach((g) => {
      const r = g.querySelector("rect"),
        x = 500 - Number(r.getAttribute("x")) - 112,
        y = Number(r.getAttribute("y")) < 100 ? 190 : 6;
      r.setAttribute("x", x);
      r.setAttribute("y", y);
      g.querySelectorAll("text").forEach((n, i) => {
        n.setAttribute("x", x + 7);
        n.setAttribute("y", y + 16 + i * 17);
      });
    });
  }
}
function renderControlLabels() {
  renderMapOrientation();
  document.querySelectorAll("[data-control-function]").forEach((n) => {
    const label = controlFunction(Number(n.dataset.controlFunction));
    n.textContent = label.length > 16 ? label.slice(0, 15) + "…" : label;
    n.parentElement.setAttribute(
      "aria-label",
      `Configure ${CONTROL_NAMES[Number(n.dataset.controlFunction)]}: ${label}`,
    );
  });
  // Only physical layer-switch buttons advertise the destination's LED color.
  document.querySelectorAll(".map-control:not(.control-card)").forEach((n) => {
    const index = Number(n.dataset.control);
    const b =
      index < 7 && index !== config.selector
        ? selectedLayer().buttons[index]
        : null;
    const target =
      index === config.selector
        ? config.profiles[profile].layers[7]
        : b && LAYER_KINDS.includes(b.kind)
          ? config.profiles[profile].layers[b.layer]
          : null;
    const color =
      target?.led_override && target.color !== "000000"
        ? "#" + target.color
        : null;
    n.classList.toggle("layer-target", !!color);
    n.style.setProperty("--target-color", color || "transparent");
  });
  document
    .querySelectorAll("[data-control]")
    .forEach((n) =>
      n.classList.toggle("selected", Number(n.dataset.control) === button),
    );
}
const selectedLayer = () => config.profiles[profile].layers[layer];
const isSelector = () => button === config.selector;
const canonical = (c) => decode(encode(c));
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function notice(text, type = "") {
  $("notice").textContent = text;
  $("notice").className = `notice ${type}`;
}
function showError(e) {
  notice(e.message || String(e), "error");
}
function checkReady() {
  return (
    !!client &&
    !client.failed &&
    deviceInfo?.state === "owned" &&
    !live?.recovery &&
    currentFirmware(live)
  );
}
function setDirty() {
  dirty = true;
  autoSave.edit();
  renderFooter();
}
function describe(b) {
  if (b.kind >= 10) {
    const a = actionOf(b),
      value =
        a.kind === 2
          ? b.action
          : a.kind === 5
            ? `${b.value} DPI`
            : a.kind === 6
              ? MODES[b.value]
              : a.kind === 7
                ? "LED color"
                : "Reset";
    return behaviorOf(b) === "layer"
      ? `L${b.layer} + ${value}`
      : b.kind === 18
        ? `Repeat ${value}`
        : `${behaviorOf(b) === "hold" ? "Hold" : "Press"} ${value}`;
  }
  switch (b.kind) {
    case 0:
      return "Falls through to the next active lower layer";
    case 1:
      return "No output, even if a lower layer has a binding";
    case 2:
      return b.action;
    case 3:
      return `Hold layer ${b.layer === 7 ? "P" : b.layer}`;
    case 4:
      return `Hold layer ${b.layer === 7 ? "P" : b.layer} · release unused for ${b.action}`;
    case 5:
      return `${b.value} DPI until overrides reset`;
    case 6:
      return `${MODES[b.value]} until overrides reset`;
    case 7:
      return `#${b.value.toString(16).padStart(6, "0").toUpperCase()} until overrides reset`;
    case 8:
      return "Clear DPI, motion and LED overrides";
    case 9:
      return `Toggle layer ${b.layer}`;
  }
}
function layerColor(l) {
  return l.led_override ? "#" + l.color : "#" + config.profiles[profile].color;
}
function renderFooter() {
  $("sync-label").textContent = autoSave.busy
    ? "Saving…"
    : dirty
      ? "Waiting to save"
      : client && checkReady()
        ? "Saved"
        : stockClient
          ? "Stock firmware"
          : client
            ? live?.recovery
              ? "USB recovery"
              : "Protected / maintenance"
            : "Not connected";
  $("sync-detail").textContent =
    client && checkReady()
      ? "Edits save automatically"
      : stockClient
        ? "Ready to install custom firmware"
        : client
          ? "Manage firmware and stock data in Device"
          : "Connect your trackball";
  $("connect").disabled = busy || autoSave.busy;
  $("connect").textContent = client || stockClient ? "Reconnect" : "Connect";
  $("connect").hidden = false;
  $("import").disabled = !checkReady() || busy;
  $("editor-view").inert = !checkReady() || busy;
  for (const id of [
    "transport",
    "initial-profile",
    "debounce",
    "import-bond",
    "led-gamma",
    "led-red",
    "led-green",
    "led-blue",
    "led-brightness",
  ])
    $(id).disabled = !checkReady() || busy;
  $("disconnect").disabled = busy || autoSave.busy || !(client || stockClient);
  $("resume").disabled = busy || autoSave.busy || !checkReady();
  $("refresh-status").disabled = busy || autoSave.busy || !client;
}
let layerClipboard = null,
  menuLayer = 0;
function openProfileSettings(index) {
  if (profile !== index) layer = 0;
  profile = index;
  render();
  $("profile-dialog").showModal();
}
function reorderProfile(from, to) {
  profile = moveProfile(config, from, to);
  setDirty();
  render();
}
installProfileDrag($("profiles"), reorderProfile);
function renderProfiles() {
  $("profiles").replaceChildren();
  config.profiles.forEach((p, i) => {
    if (p.disabled) return;
    const item = el("div", "profile-item");
    const n = el("button", "profile-tab");
    n.role = "tab";
    n.setAttribute("aria-selected", String(i === profile));
    n.setAttribute("aria-label", `Profile ${i + 1}: ${p.name}`);
    n.style.setProperty("--swatch", "#" + p.color);
    n.append(
      el("span", "swatch"),
      el("span", "profile-name", p.name || `Profile ${i + 1}`),
      el("small", "profile-rate", `${p.report_hz} Hz`),
    );
    n.onclick = () => {
      layer = 0;
      profile = i;
      render();
    };
    n.onkeydown = (e) => {
      if (e.altKey && ["ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        const list = activeProfiles(config),
          pos = list.indexOf(i),
          target = list[pos + (e.key === "ArrowLeft" ? -1 : 1)];
        if (target !== undefined) reorderProfile(i, target);
      }
    };
    const more = el("button", "profile-more", "⋯");
    more.setAttribute("aria-label", `Settings for ${p.name}`);
    more.onclick = () => openProfileSettings(i);
    item.oncontextmenu = (e) => {
      e.preventDefault();
      openProfileSettings(i);
    };
    item.dataset.profileIndex = i;
    item.append(n, more);
    $("profiles").append(item);
  });
  const add = el("button", "add-profile", "+");
  add.setAttribute("aria-label", "Add profile");
  add.title = "Add profile";
  add.disabled = activeProfiles(config).length === 8;
  add.onclick = () => {
    profile = addProfile(config);
    layer = 0;
    setDirty();
    render();
    openProfileSettings(profile);
  };
  $("profiles").append(add);
  const p = config.profiles[profile];
  $("profile-name").value = p.name;
  $("profile-color").value = "#" + p.color;
  $("report-rate").value = p.report_hz;
  const list = activeProfiles(config),
    pos = list.indexOf(profile);
  $("move-profile-left").disabled = pos === 0;
  $("move-profile-right").disabled = pos === list.length - 1;
  $("delete-profile").disabled = list.length === 1;
  renderLiveTabs();
}
function renderLayers() {
  $("layers").replaceChildren();
  config.profiles[profile].layers.forEach((l, i) => {
    const n = el("button", "layer-tab", i === 7 ? "P" : String(i));
    n.role = "tab";
    n.dataset.layerIndex = i;
    n.setAttribute("aria-selected", String(i === layer));
    n.setAttribute(
      "aria-label",
      i === 0
        ? "Layer 0 · Base"
        : i === 7
          ? "Layer P · Profile selection"
          : `Layer ${i}`,
    );
    if (l.led_override && l.color !== "000000") {
      n.style.setProperty("--layer-color", "#" + l.color);
      n.classList.add("colored");
    }
    n.onclick = () => {
      layer = i;
      renderLayers();
      renderLayerSettings();
      renderSelection();
    };
    n.oncontextmenu = (e) => {
      e.preventDefault();
      menuLayer = i;
      $("paste-layer").disabled = !layerClipboard;
      const menu = $("layer-menu");
      menu.style.left = Math.min(e.clientX, innerWidth - 170) + "px";
      menu.style.top = Math.min(e.clientY, innerHeight - 100) + "px";
      menu.showPopover();
    };
    n.onkeydown = (e) => {
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        e.preventDefault();
        const r = n.getBoundingClientRect();
        n.oncontextmenu({
          preventDefault() {},
          clientX: r.left,
          clientY: r.bottom,
        });
      }
    };
    $("layers").append(n);
  });
  $("layer-title").textContent = `Layer ${layer === 7 ? "P" : layer}`;
  renderLiveTabs();
}
function renderOrientation() {
  const host = $("orientation-choices");
  host.replaceChildren();
  const selected = Number($("orientation").value);
  for (const [value, label] of [
    [0, "Inherit"],
    [1, "Round at top"],
    [2, "Round at right"],
    [3, "Round at bottom"],
    [4, "Round at left"],
  ]) {
    if (value === 0 && layer === 0) continue;
    const n = el("button", "orientation-option");
    n.setAttribute("aria-label", `Orientation ${label}`);
    n.setAttribute("aria-pressed", String(value === selected));
    n.title = label;
    if (value)
      n.innerHTML = `<svg viewBox="0 0 40 40" aria-hidden="true"><g transform="rotate(${(value * 90) % 360} 20 20)"><rect x="4" y="15" width="32" height="10" rx="3"/><circle cx="20" cy="20" r="6"/><path d="M29 17v2m0 2v2M8 17v1"/></g></svg>`;
    else n.textContent = "Inherit";
    n.onclick = () => {
      updateLayer((l) => (l.orientation = value));
      renderSelection();
    };
    host.append(n);
  }
}
function renderLayerSettings() {
  const l = selectedLayer(),
    known = [0, 400, 800, 1200, 1600, 2400, 3200, 4000].includes(l.dpi);
  $("dpi").value = known ? l.dpi : "custom";
  $("custom-dpi-label").hidden = known;
  $("custom-dpi").value = l.dpi || 1600;
  $("dpi").querySelector('option[value="0"]').disabled = layer === 0;
  $("motion").querySelector('option[value="0"]').disabled = layer === 0;
  const inheritedOrientation =
    $("orientation").querySelector('option[value="0"]');
  inheritedOrientation.hidden = layer === 0;
  inheritedOrientation.textContent = "Inherit base layer";
  $("orientation").value = l.orientation;
  $("orientation").title =
    "Device orientation; Inherit uses this profile’s layer 0.";
  renderOrientation();
  $("motion").value = l.motion;
  renderControlLabels();
  $("scroll-counts").value = l.scroll_counts;
  $("led-mode").value = !l.led_override
    ? "inherit"
    : l.color === "000000"
      ? "off"
      : "solid";
  $("layer-color").value = "#" + l.color;
  $("layer-color").disabled = !l.led_override || l.color === "000000";
  $("led-hint").textContent = l.led_override
    ? l.color === "000000"
      ? "LED off"
      : "Solid color"
    : "Lower active layer / profile";
  const color = layerColor(l);
  $("led-dot").style.background = color;
  $("device-led").style.fill = color;
}
function matchingAction(a, b) {
  if (a.binding.kind !== b.kind) return false;
  if (b.kind === 2) {
    if (a.id === "key") return !!(action(b.action) & 0x8000);
    if (a.id === "mouse4") return /^Mouse[4-8]$/i.test(b.action);
    return a.binding.action === b.action;
  }
  return true;
}
function assignAction(a) {
  if (fixedWheel()) return;
  if (isSelector()) config.profiles[profile].selector_action = a.action;
  else if (isWheel()) setBinding(copy(a));
  else {
    const current = binding();
    let mode = behaviorOf(current);
    if (["none", "inherit", "toggle"].includes(mode))
      mode = a.kind === 2 ? "hold" : "press";
    const next = composeBinding(mode, a, current.layer || 1);
    if (current.kind === 18 && a.kind === 2) {
      next.kind = 18;
      next.value = current.value;
    }
    setBinding(next);
  }
  setDirty();
  renderSelection();
}
function renderBehavior() {
  const host = $("binding-behavior");
  host.replaceChildren();
  host.hidden = button >= 9;
  if (button >= 9) return;
  if (isWheel() || isSelector()) {
    host.append(
      el(
        "span",
        "behavior-note",
        isWheel()
          ? fixedWheel()
            ? "Layer P · fixed profile selection"
            : "Press action · once per wheel detent"
          : "Hold layer P · fixed · action on unused release",
      ),
    );
    return;
  }
  const b = binding(),
    mode = behaviorOf(b),
    row = el("div", "behavior-options");
  for (const [value, label] of [
    ["none", "No action"],
    ["hold", "Hold action"],
    ["press", "Press action"],
    ["layer", "Hold layer + press action"],
    ["toggle", "Toggle layer"],
    ["inherit", "Inherit"],
  ]) {
    const n = el("button", mode === value ? "selected" : "", label);
    n.setAttribute("aria-pressed", String(mode === value));
    n.onclick = () => {
      let a = actionOf(b);
      if (["hold", "press"].includes(value) && a.kind === 1)
        a = { ...blankBinding(2), action: "Mouse1" };
      if (value === "hold" && a.kind === 8)
        a = { ...blankBinding(2), action: "Mouse1" };
      setBinding(composeBinding(value, a, b.layer || 1));
      setDirty();
      renderSelection();
    };
    row.append(n);
  }
  host.append(row);
  if (["layer", "toggle"].includes(mode)) {
    const targets = el("div", "layer-target-options");
    for (let i = 1; i < 8; i++) {
      const n = el(
        "button",
        b.layer === i ? "selected" : "",
        i === 7 ? "P" : String(i),
      );
      n.setAttribute("aria-label", `Target layer ${i === 7 ? "P" : i}`);
      const l = config.profiles[profile].layers[i];
      if (l.led_override && l.color !== "000000")
        n.style.setProperty("--layer-color", "#" + l.color);
      n.onclick = () => {
        b.layer = i;
        setDirty();
        renderSelection();
      };
      targets.append(n);
    }
    host.append(targets);
    if (mode === "layer")
      host.append(
        el(
          "small",
          "behavior-note",
          "Action runs on release only if the held layer was unused.",
        ),
      );
  }
}
function renderActions() {
  renderBehavior();
  document
    .querySelector(".action-pane")
    .classList.toggle("fixed-wheel", fixedWheel());
  if (fixedWheel()) {
    $("actions").replaceChildren();
    $("input-palette").hidden = true;
    document.querySelector(".action-pagination").hidden = true;
    return;
  }
  $("categories").replaceChildren();
  for (const c of ["Quick", "Mouse", "Keyboard", "Settings", "Macros"]) {
    const n = el("button", category === c ? "selected" : "", c);
    n.setAttribute("aria-pressed", String(category === c));
    n.onclick = () => {
      category = c;
      actionPage = 0;
      renderActions();
    };
    $("categories").append(n);
  }
  $("actions").replaceChildren();
  const special = button >= 9;
  const mode =
    !special && !isSelector() && !isWheel() ? behaviorOf(binding()) : "press";
  const noAction =
    !special &&
    !isSelector() &&
    !isWheel() &&
    ["none", "inherit", "toggle"].includes(mode);
  const usePalette = button < 9 && !search && category === "Quick" && !noAction;
  $("input-palette").hidden = !usePalette;
  palette.setEnabled(!noAction && button < 9);
  let library =
    button === 9
      ? BALL_ACTIONS
      : button === 10
        ? LED_ACTIONS
        : ACTIONS.filter(
            (a) =>
              !["hold", "unused", "toggle", "transparent", "disabled"].includes(
                a.id,
              ),
          );
  if (isWheel() || isSelector())
    library = library.filter((a) => a.binding.kind === 2);
  if (mode === "hold") library = library.filter((a) => a.binding?.kind !== 8);
  const items = library.filter(
    (a) =>
      (special ||
        search ||
        category === "Quick" ||
        (category === "Settings"
          ? ["Motion", "Utility"].includes(a.category)
          : a.category === category)) &&
      (!usePalette || !["Mouse", "Keyboard"].includes(a.category)) &&
      `${a.name} ${a.desc} ${a.category}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const unavailable = category === "Macros" && !special && !search;
  const visibleItems = noAction || unavailable ? [] : items;
  const pages = Math.max(1, Math.ceil(visibleItems.length / 24));
  actionPage = Math.min(actionPage, pages - 1);
  $("action-count").textContent = `${visibleItems.length} actions`;
  $("action-page").textContent = `${actionPage + 1} / ${pages}`;
  $("actions-prev").disabled = actionPage === 0;
  $("actions-next").disabled = actionPage === pages - 1;
  document.querySelector(".action-pagination").hidden = pages === 1;
  for (const a of visibleItems.slice(actionPage * 24, actionPage * 24 + 24)) {
    const n = el("button", "action-card");
    n.title = a.desc;
    n.disabled = button === 9 && layer === 0 && a.name === "Inherit";
    n.setAttribute("aria-label", `Assign ${a.name}`);
    n.append(el("span", "action-icon", a.icon), el("strong", "", a.name));
    n.onclick = () => {
      try {
        if (a.apply) {
          a.apply();
          renderLayerSettings();
          setDirty();
          renderSelection();
        } else assignAction(copy(a.binding));
      } catch (e) {
        showError(e);
      }
    };
    $("actions").append(n);
  }
  if (unavailable)
    $("actions").append(
      el("p", "empty-search", "Macros are not implemented yet."),
    );
  else if (noAction)
    $("actions").append(
      el(
        "p",
        "empty-search",
        mode === "toggle"
          ? "Choose the layer above."
          : "Choose Hold action, Press action, or Hold layer + press action to assign an action.",
      ),
    );
  else if (!items.length && !usePalette)
    $("actions").append(el("p", "empty-search", "No matching actions."));
}
function field(
  label,
  type,
  value,
  onChange,
  { options, min, max, wide = false, note } = {},
) {
  const wrapper = el("label", wide ? "wide" : "", label),
    input = document.createElement(options ? "select" : "input");
  if (options)
    for (const [v, t] of options) {
      const opt = el("option", "", t);
      opt.value = v;
      input.append(opt);
    }
  else input.type = type;
  if (min !== undefined) input.min = min;
  if (max !== undefined) input.max = max;
  input.value = value;
  input.setAttribute("aria-label", label);
  input.onchange = () => {
    try {
      onChange(type === "number" ? Number(input.value) : input.value);
      input.setCustomValidity("");
      setDirty();
      renderSelection();
    } catch (e) {
      input.setCustomValidity(e.message);
      input.reportValidity();
      showError(e);
    }
  };
  wrapper.append(input);
  if (note) wrapper.append(el("small", "field-note", note));
  return wrapper;
}
function outputField(label, value, set, wide = true) {
  return field(
    label,
    "text",
    value,
    (text) => {
      action(text);
      set(text.trim());
    },
    {
      wide,
      note: "Mouse1–Mouse8, a key, or a shortcut such as CTRL+C, ALT+LEFT or CTRL+PLUS.",
    },
  );
}
function scrollSensitivityField(value, set) {
  return field(
    "Scroll sensitivity (counts/step)",
    "number",
    value,
    (x) => {
      if (!Number.isInteger(x) || x < 0 || x > 4000)
        throw Error("Expected 0–4000.");
      set(x);
    },
    {
      min: 0,
      max: 4000,
      wide: true,
      note: "Lower = faster. Default: 16. Zero inherits the active layer (or the default).",
    },
  );
}
function renderInspector() {
  const host = $("inspector");
  host.replaceChildren();
  $("inspector-context").textContent =
    `${CONTROL_NAMES[button]} / Layer ${layer}`;
  if (button === 9) {
    host.append(
      el("h3", "", "Trackball"),
      el("p", "", "Layer motion settings"),
    );
    const fields = el("div", "inspector-fields");
    fields.append(
      field(
        "Ball function",
        "number",
        selectedLayer().motion,
        (x) => {
          updateLayer((l) => (l.motion = x));
        },
        {
          options: layer
            ? [
                [0, "Inherit"],
                [1, "Pointer"],
                [2, "Scroll"],
                [3, "None"],
              ]
            : [
                [1, "Pointer"],
                [2, "Scroll"],
                [3, "None"],
              ],
        },
      ),
    );
    if (selectedLayer().motion === 2)
      fields.append(
        scrollSensitivityField(selectedLayer().scroll_counts, (x) =>
          updateLayer((l) => (l.scroll_counts = x)),
        ),
      );
    host.append(
      fields,
      el(
        "p",
        "action-help",
        "DPI and orientation are in Layer settings. Lower counts scroll faster; zero inherits.",
      ),
    );
    return;
  }
  if (button === 10) {
    host.append(el("h3", "", "Layer LED"));
    const fields = el("div", "inspector-fields");
    fields.append(
      field(
        "LED behavior",
        "text",
        !selectedLayer().led_override
          ? "inherit"
          : selectedLayer().color === "000000"
            ? "off"
            : "solid",
        (x) => {
          updateLayer((l) => {
            l.led_override = x !== "inherit";
            if (x === "off") l.color = "000000";
            if (x === "solid" && l.color === "000000")
              l.color = config.profiles[profile].color;
          });
        },
        {
          options: [
            ["inherit", "Inherit"],
            ["solid", "Solid color"],
            ["off", "Off"],
          ],
        },
      ),
    );
    if (selectedLayer().led_override && selectedLayer().color !== "000000")
      fields.append(
        field("LED color", "color", "#" + selectedLayer().color, (x) =>
          updateLayer((l) => (l.color = x.slice(1).toUpperCase())),
        ),
      );
    host.append(fields);
    return;
  }
  if (fixedWheel()) {
    host.append(
      el("h3", "", button === 7 ? "Next profile" : "Previous profile"),
      el(
        "p",
        "",
        "Fixed on P. Hold Round, turn the wheel to preview a profile, then release Round to select it.",
      ),
    );
    return;
  }
  if (isWheel()) {
    const b = binding(),
      actionKind = actionOf(b).kind;
    host.append(
      el("h3", "", CONTROL_NAMES[button]),
      el("p", "", "One tap per wheel detent."),
    );
    const fields = el("div", "inspector-fields");
    fields.append(
      field(
        "Wheel action",
        "text",
        (selectedLayer().wheel ?? ["Inherit", "Inherit"])[button - 7],
        (x) => {
          if (!["Inherit", "Disabled"].includes(x)) action(x);
          selectedLayer().wheel ??= ["Inherit", "Inherit"];
          selectedLayer().wheel[button - 7] = x;
        },
        {
          wide: true,
          note: "Inherit, Disabled, ScrollUp/Down/Left/Right, Mouse1–8 or CTRL+C.",
        },
      ),
    );
    host.append(
      fields,
      el(
        "p",
        "action-help",
        "Wheel directions resolve independently through active layers. Holding Round still selects profiles. Keyboard taps require wired USB. Remapping requires updated firmware.",
      ),
    );
    return;
  }
  if (isSelector()) {
    host.append(
      el("h3", "", "Profile selector"),
      el(
        "p",
        "",
        "Round always holds layer P. Its wheel directions select profiles; the other buttons and settings on P are editable.",
      ),
    );
    const fields = el("div", "inspector-fields");
    fields.append(
      outputField(
        "Unused-release action",
        config.profiles[profile].selector_action,
        (x) => (config.profiles[profile].selector_action = x),
      ),
    );
    host.append(
      fields,
      el(
        "p",
        "action-help",
        "This release action belongs to the profile. Using P or cycling profiles consumes it. There is no timeout. Layer P requires the accompanying firmware.",
      ),
    );
    return;
  }
  const b = binding(),
    actionKind = actionOf(b).kind;
  host.append(el("h3", "", KINDS[b.kind]), el("p", "", describe(b)));
  const fields = el("div", "inspector-fields");
  if (actionKind === 2) {
    if (/^Mouse[1-8]$/i.test(b.action))
      fields.append(
        field("Mouse output", "text", b.action, (x) => (b.action = x), {
          options: Array.from({ length: 8 }, (_, i) => [
            `Mouse${i + 1}`,
            [
              "Primary · Mouse1",
              "Secondary · Mouse2",
              "Middle · Mouse3",
              "Back · Mouse4",
              "Forward · Mouse5",
              "Mouse6",
              "Mouse7",
              "Mouse8",
            ][i],
          ]),
          wide: true,
        }),
      );
    else if (/^Scroll/i.test(b.action))
      fields.append(
        field("Scroll direction", "text", b.action, (x) => (b.action = x), {
          options: ["ScrollUp", "ScrollDown", "ScrollLeft", "ScrollRight"].map(
            (x) => [x, x.replace("Scroll", "Scroll ")],
          ),
        }),
      );
    else if (MEDIA.includes(b.action.toUpperCase())) {
      fields.append(
        field("Media control", "text", b.action, (x) => (b.action = x), {
          options: MEDIA.map((x) => [x, x]),
        }),
      );
    } else {
      fields.append(
        outputField("Keyboard shortcut", b.action, (x) => (b.action = x)),
      );
      const mods = el("div", "modifier-row wide");
      for (const mod of ["CTRL", "SHIFT", "ALT", "GUI"]) {
        const n = el("button", "", mod);
        n.onclick = () => {
          const parts = b.action.toUpperCase().split("+"),
            key = parts.pop(),
            set = new Set(parts);
          set.has(mod) ? set.delete(mod) : set.add(mod);
          b.action = [...set, key].join("+");
          setDirty();
          renderSelection();
        };
        mods.append(n);
      }
      fields.append(mods);
    }
  }
  if (actionKind === 5)
    fields.append(
      field(
        "DPI value",
        "number",
        b.value,
        (x) => {
          if (!Number.isInteger(x) || x < 400 || x > 4000)
            throw Error("DPI must be 400–4000.");
          b.value = x;
        },
        { min: 400, max: 4000 },
      ),
    );
  if (actionKind === 6)
    fields.append(
      field(
        "Ball function",
        "number",
        b.value,
        (x) => {
          b.value = x;
          delete b.scroll_counts;
          if (x === 2) b.scroll_counts = 16;
        },
        {
          options: [
            [1, "Pointer"],
            [2, "Scroll"],
            [3, "None"],
          ],
        },
      ),
    );
  if (actionKind === 6 && b.value === 2)
    fields.append(
      scrollSensitivityField(b.scroll_counts ?? 0, (x) => {
        if (x) b.scroll_counts = x;
        else delete b.scroll_counts;
      }),
    );
  if (actionKind === 7)
    fields.append(
      field(
        "LED color",
        "color",
        "#" + b.value.toString(16).padStart(6, "0"),
        (x) => (b.value = parseInt(x.slice(1), 16)),
      ),
    );
  if (behaviorOf(b) === "hold" && actionKind === 2) {
    fields.append(
      field(
        "While held",
        "text",
        b.kind === 18 ? "repeat" : "down",
        (x) => {
          b.kind = x === "repeat" ? 18 : 2;
          b.value = x === "repeat" ? 100 : 0;
        },
        {
          options: [
            ["down", "Keep pressed"],
            ["repeat", "Repeat presses"],
          ],
        },
      ),
    );
    if (b.kind === 18)
      fields.append(
        field(
          "Repeat interval (ms)",
          "number",
          b.value,
          (x) => {
            if (!Number.isInteger(x) || x < 20 || x > 2000)
              throw Error("Use 20–2000 ms.");
            b.value = x;
          },
          { min: 20, max: 2000 },
        ),
      );
  }
  host.append(fields);
  const tips = {
    0: "On the base layer, a transparent button has no lower action to use.",
    1: "Unlike transparent, this prevents a lower layer’s action from firing.",
    2: "The output is held until this physical button is released. Keyboard shortcuts work over wired USB only; named symbols use US keyboard usages.",
    3: "The layer remains active while held. Buttons already down keep their original actions.",
    4: "There is no tap timeout. Another resolved action, ring use, or layer-specific ball function consumes the release action. Inherited pointer jitter does not.",
    5: "Runtime overrides last until Reset overrides, profile change, transport reconnect or reboot. They do not write flash.",
    6: "Scroll sensitivity is part of this action. A held action restores the previous behavior on release; zero uses the active layer’s sensitivity.",
    7: "This overrides the layer color until overrides reset. #000000 turns the LED off.",
    8: "Returns DPI, ball function and LED color to the active layer settings.",
    9: "Higher active layers win. Toggling this layer off reveals the next active layer.",
  };
  host.append(
    el(
      "p",
      "action-help",
      tips[b.kind] ||
        (behaviorOf(b) === "hold"
          ? "Active only while held. Releasing restores the next active setting."
          : behaviorOf(b) === "layer"
            ? "Runs on unused release; using another action cancels it."
            : "Runs once on press. Setting changes last until reset or profile change."),
    ),
  );
}
function renderSelection() {
  renderControlLabels();
  document
    .querySelectorAll("[data-control]")
    .forEach((n) =>
      n.classList.toggle("selected", Number(n.dataset.control) === button),
    );
  $("button-chips").replaceChildren();
  BUTTONS.forEach((name, i) => {
    const n = el("button", i === button ? "selected" : "", name);
    n.setAttribute("aria-label", `Select ${name}`);
    n.onclick = () => {
      button = i;
      renderSelection();
    };
    $("button-chips").append(n);
  });
  $("selected-button-label").textContent = CONTROL_NAMES[button];
  $("binding-label").textContent =
    button >= 9
      ? CONTROL_NAMES[button]
      : isSelector()
        ? "Profile selector"
        : KINDS[binding().kind];
  $("binding-description").textContent =
    button >= 7
      ? controlFunction(button)
      : isSelector()
        ? `Hold + ring · tap: ${config.profiles[profile].selector_action}`
        : describe(binding());
  renderActions();
  renderInspector();
}
function render() {
  renderProfiles();
  renderLayers();
  renderLayerSettings();
  renderSelection();
  renderFooter();
}
function updateLayer(fn) {
  const prior = copy(selectedLayer());
  try {
    fn(selectedLayer());
    encode(config);
    setDirty();
    renderLayerSettings();
    renderLayers();
    if (button >= 9) renderSelection();
  } catch (e) {
    config.profiles[profile].layers[layer] = prior;
    renderLayerSettings();
    showError(e);
  }
}
async function operation(fn) {
  if (busy || autoSave.busy) return;
  busy = true;
  document.body.classList.add("loading");
  $("progress").hidden = false;
  $("progress").value = 0;
  renderFooter();
  try {
    await fn();
  } catch (e) {
    showError(e);
  } finally {
    busy = false;
    document.body.classList.remove("loading");
    $("progress").hidden = true;
    renderFooter();
  }
}
function transfer(p) {
  $("progress").value = p;
}
function connectionLabel(text, state = "") {
  $("connection-label").textContent = text;
  $("connection-dot").className = `dot ${state}`;
}
function renderStatus() {
  renderLiveTabs();
  if (!client) {
    $("device-status").textContent = stockClient
      ? "Stock firmware connected."
      : "Not connected.";
    return;
  }
  $("device-status").textContent =
    `Storage: ${deviceInfo?.state || "unknown"}\n${live ? `Firmware: ${firmwareVersion(live.firmware)}\nMode: ${live.recovery ? "USB recovery" : live.running ? "Running" : "Input paused"}\nProfile: ${live.profile + 1} · ${live.dpi} DPI\nSensor: 0x${live.sensor.toString(16)} · errors: ${live.errors}\nRadio: ${live.radio ? "connected" : "inactive"}` : "Input status unavailable."}`;
}
async function readDevice() {
  const read = await client.read(transfer);
  live = await client.status();
  const bond = read.bond;
  if (dirty && loadedBond !== bond)
    throw Error(
      "Unsaved changes belong to another trackball. Export them before switching devices.",
    );
  savedProfiles = read.profiles.slice();
  if (!dirty) config = read;
  loadedBond = bond;
  deviceProfiles = live.previewActive ? null : savedProfiles;
  if (config.profiles[profile].disabled) profile = activeProfiles(config)[0];
  render();
  renderSettings();
  notice("Connected. Changes apply and save automatically.", "success");
  autoSave.start();
}
async function connect(device) {
  autoSave.stop();
  await operation(async () => {
    deviceProfiles = savedProfiles = null;
    if (client) await client.close();
    if (stockClient) await stockClient.close();
    stockClient = null;
    lastDevice = device;
    const session = new NapeHID(device, {
      onDisconnect: () => {
        if (client !== session) return;
        autoSave.stop();
        client = null;
        deviceInfo = live = null;
        connectionLabel("Disconnected");
        renderFooter();
        renderStatus();
        notice(
          "Waiting for the trackball to reconnect. Unsaved changes are retained.",
        );
      },
    });
    client = session;
    try {
      await session.open();
      deviceInfo = await session.info();
      try {
        live = await session.status();
      } catch (e) {
        if (session.failed) throw e;
        live = null;
      }
      renderStatus();
      if (!live) {
        connectionLabel("Maintenance connected", "problem");
        notice("Open Device to update firmware or manage original user data.");
      } else if (live.recovery) {
        connectionLabel("USB recovery", "problem");
        notice(
          "The trackball is in recovery. Open Device to flash firmware or reboot.",
        );
      } else if (deviceInfo.state !== "owned") {
        connectionLabel("Awaiting initialization", "problem");
        notice(
          `Device storage is ${deviceInfo.state}. Open Device to back up and adopt before editing custom profiles.`,
        );
      } else if (!currentFirmware(live)) {
        connectionLabel("Firmware update required", "problem");
        notice("Update to the latest compatible custom firmware before editing settings.");
      } else {
        connectionLabel("Connected via USB", "connected");
        await readDevice();
      }
    } catch (e) {
      await session.close().catch(() => {});
      if (client === session) {
        client = null;
        deviceInfo = live = null;
        connectionLabel("Connection failed", "problem");
      }
      throw e;
    }
  });
}
async function connectStock(device) {
  await operation(async () => {
    if (dirty)
      throw Error(
        "Export or save pending profile edits before connecting stock firmware.",
      );
    autoSave.stop();
    if (client) await client.close();
    if (stockClient) await stockClient.close();
    client = null;
    deviceInfo = live = null;
    stockClient = new StockHID(device);
    try {
      await stockClient.open();
      const version = await stockClient.identify();
      connectionLabel(`Stock ${version}`, "connected");
      notice(
        "Stock firmware connected. Open Device to install custom firmware.",
      );
    } catch (e) {
      await stockClient.close().catch(() => {});
      stockClient = null;
      throw e;
    } finally {
      renderStatus();
    }
  });
}
async function autoConnect() {
  if (
    !NapeHID.supported() ||
    autoConnectPaused ||
    client ||
    stockClient ||
    busy ||
    autoSave.busy ||
    connecting
  )
    return;
  connecting = true;
  try {
    const devices = (await navigator.hid.getDevices()).filter(
      (d) => NapeHID.matches(d) || StockHID.matches(d),
    );
    const device =
      devices.find((d) => d === lastDevice) ||
      (devices.length === 1 ? devices[0] : null);
    if (device) {
      if (NapeHID.matches(device)) await connect(device);
      else await connectStock(device);
    }
  } catch (e) {
    showError(e);
  } finally {
    connecting = false;
  }
}
function download(name, text) {
  const url = URL.createObjectURL(
      new Blob([text], { type: "application/json" }),
    ),
    a = el("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function renderSettings() {
  const correction = config.led_correction || {
    gamma: 22,
    red: 100,
    green: 100,
    blue: 100,
    brightness: 100,
  };
  for (const key of ["gamma", "red", "green", "blue", "brightness"])
    $("led-" + key).value =
      key === "gamma" ? correction[key] / 10 : correction[key];
  $("transport").value = config.transport;
  $("debounce").value = config.debounce_ms;
  const lastUsed = el("option", "", "Last used");
  lastUsed.value = 255;
  $("initial-profile").replaceChildren(lastUsed);
  config.profiles.forEach((p, i) => {
    if (p.disabled) return;
    const o = el("option", "", `${i + 1} · ${p.name}`);
    o.value = i;
    $("initial-profile").append(o);
  });
  $("initial-profile").value = config.initial_profile;
  $("bond-status").textContent =
    config.bond === "00".repeat(12)
      ? "No receiver bond configured. Import your original stock backup to use its receiver."
      : "Receiver pairing is present. The pairing bytes are kept private in this editor.";
  renderStatus();
  renderFooter();
}
// Profile and layer edits update a settings only.
$("profile-name").onchange = () => {
  const name = $("profile-name").value;
  if (name.includes("\0") || new TextEncoder().encode(name).length > 23) {
    showError(Error("Profile name must fit in 23 UTF-8 bytes."));
    $("profile-name").value = config.profiles[profile].name;
    return;
  }
  config.profiles[profile].name = name;
  setDirty();
  renderProfiles();
};
$("profile-color").oninput = () => {
  config.profiles[profile].color = $("profile-color")
    .value.slice(1)
    .toUpperCase();
  setDirty();
  renderLayerSettings();
};
$("profile-color").onchange = () => renderProfiles();
$("report-rate").onchange = () => {
  config.profiles[profile].report_hz = Number($("report-rate").value);
  setDirty();
};
$("dpi").onchange = () => {
  if ($("dpi").value === "custom") {
    $("custom-dpi-label").hidden = false;
    $("custom-dpi").focus();
    return;
  }
  updateLayer((l) => (l.dpi = Number($("dpi").value)));
};
$("custom-dpi").onchange = () => {
  const value = Number($("custom-dpi").value);
  if (!Number.isInteger(value) || value < 400 || value > 4000) {
    showError(Error("DPI must be 400–4000."));
    return;
  }
  updateLayer((l) => (l.dpi = value));
};
$("orientation").onchange = () =>
  updateLayer((l) => (l.orientation = Number($("orientation").value)));
$("motion").onchange = () =>
  updateLayer((l) => (l.motion = Number($("motion").value)));
$("scroll-counts").onchange = () => {
  const n = Number($("scroll-counts").value);
  if (!Number.isInteger(n) || n < 0 || n > 4000) {
    showError(Error("Scroll counts must be 0–4000."));
    return;
  }
  updateLayer((l) => (l.scroll_counts = n));
};
$("led-mode").onchange = () =>
  updateLayer((l) => {
    const mode = $("led-mode").value;
    l.led_override = mode !== "inherit";
    if (mode === "off") l.color = "000000";
    if (mode === "solid" && l.color === "000000")
      l.color = config.profiles[profile].color;
  });
$("layer-color").oninput = () =>
  updateLayer((l) => (l.color = $("layer-color").value.slice(1).toUpperCase()));
$("layer-reset").onclick = () => {
  if (
    !confirm(
      `Reset Layer ${layer} in ${config.profiles[profile].name}? Other layers stay unchanged.`,
    )
  )
    return;
  config.profiles[profile].layers[layer] = copy(
    defaults().profiles[profile].layers[layer],
  );
  config.profiles[profile].layers[layer].buttons[config.selector] =
    blankBinding();
  setDirty();
  render();
};
const map = document.querySelector(".trackball");
map.onclick = (e) => {
  const target = e.target.closest("[data-control]");
  if (!target) return;
  button = Number(target.dataset.control);
  category = "Quick";
  search = "";
  $("search").value = "";
  actionPage = 0;
  renderSelection();
};
map.onkeydown = (e) => {
  if (
    (e.key === "Enter" || e.key === " ") &&
    e.target.closest("[data-control]")
  ) {
    e.preventDefault();
    e.target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
};
$("search").oninput = () => {
  search = $("search").value;
  actionPage = 0;
  renderActions();
};
$("connect").onclick = async () => {
  if (busy || autoSave.busy || connecting) return;
  connecting = true;
  try {
    autoConnectPaused = false;
    if (!NapeHID.supported())
      throw Error("Use desktop Chrome or Edge on HTTPS or localhost.");
    const devices = (await navigator.hid.getDevices()).filter(
      (d) => NapeHID.matches(d) || StockHID.matches(d),
    );
    const device =
      devices.length === 1
        ? devices[0]
        : (
            await navigator.hid.requestDevice({
              filters: [
                {
                  vendorId: 0x3434,
                  productId: 0x0440,
                  usagePage: 0xff5d,
                  usage: 1,
                },
                {
                  vendorId: 0x3434,
                  productId: 0x0440,
                  usagePage: 0x8c,
                  usage: 1,
                },
              ],
            })
          )[0];
    if (!device) return;
    if (NapeHID.matches(device)) await connect(device);
    else await connectStock(device);
  } catch (e) {
    showError(e);
  } finally {
    connecting = false;
  }
};
$("export").onclick = () => {
  try {
    const c = canonical(config);
    download("nape-profiles.json", JSON.stringify(c, null, 2) + "\n");
    notice(
      "Profile JSON exported. It includes your receiver pairing; keep personal exports private.",
    );
  } catch (e) {
    showError(e);
  }
};
$("import").onclick = () => $("import-dialog").showModal();
$("choose-json").onclick = () => $("json-file").click();
$("cancel-json").onclick = () => $("import-dialog").close();
function importConfiguration(text) {
  if (text.length > 1024 * 1024)
    throw Error("Profile file is unexpectedly large.");
  const imported = canonical(JSON.parse(text));
  config = imported;
  profile = activeProfiles(config)[0];
  layer = 0;
  dirty = true;
  setDirty();
  $("import-dialog").close();
  $("import-json-text").value = "";
  render();
  notice("Imported. Saving automatically.");
}
$("apply-json").onclick = () => {
  try {
    importConfiguration($("import-json-text").value);
  } catch (e) {
    showError(e);
  }
};
$("json-file").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    if (f.size > 1024 * 1024)
      throw Error("Profile file is unexpectedly large.");
    importConfiguration(await f.text());
  } catch (e) {
    showError(e);
  }
};
function showView(device) {
  $("editor-view").hidden = device;
  $("device-view").hidden = !device;
  for (const [id, on] of [
    ["nav-editor", !device],
    ["device-settings", device],
  ]) {
    $(id).classList.toggle("selected", on);
    if (on) $(id).setAttribute("aria-current", "page");
    else $(id).removeAttribute("aria-current");
  }
  if (device) renderSettings();
}
$("device-settings").onclick = () => showView(true);
$("nav-editor").onclick = () => showView(false);
$("actions-prev").onclick = () => {
  actionPage--;
  renderActions();
};
$("actions-next").onclick = () => {
  actionPage++;
  renderActions();
};
for (const [id, key, min, max] of [
  ["transport", "transport", 0, 2],
  ["initial-profile", "initial_profile", 0, 7],
  ["debounce", "debounce_ms", 1, 30],
])
  $(id).onchange = () => {
    const value = Number($(id).value);
    if (
      !(key === "initial_profile" && value === 255) &&
      (!Number.isInteger(value) || value < min || value > max)
    ) {
      showError(Error(`Expected ${min}–${max}.`));
      $(id).value = config[key];
      return;
    }
    config[key] = value;
    setDirty();
  };
$("import-bond").onclick = () => $("bond-file").click();
$("bond-file").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    if (f.size !== 45112) throw Error("Expected a 45,112-byte .npb archive.");
    config.bond = await importBond(new Uint8Array(await f.arrayBuffer()));
    setDirty();
    renderSettings();
    notice(
      "Verified receiver pairing imported. Saving automatically.",
      "success",
    );
  } catch (e) {
    showError(e);
    alert(e.message);
  }
};
$("refresh-status").onclick = () =>
  operation(async () => {
    deviceInfo = await client.info();
    live = await client.status();
    renderStatus();
  });
$("resume").onclick = () =>
  operation(async () => {
    autoSave.stop();
    await client.resume();
    autoSave.start();
    deviceProfiles = savedProfiles;
    live = await client.status();
    renderStatus();
    notice("Device input resumed.", "success");
  });
$("disconnect").onclick = () =>
  operation(async () => {
    autoSave.stop();
    if (client) await client.close();
    if (stockClient) await stockClient.close();
    stockClient = null;
    client = null;
    deviceInfo = null;
    live = null;
    autoConnectPaused = true;
    connectionLabel("Disconnected");
    renderStatus();
    notice("Disconnected. Select Connect to reconnect.");
  });
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.addEventListener("keydown", (e) => {
  if (
    e.key === "/" &&
    !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName) &&
    !$("editor-view").hidden
  ) {
    e.preventDefault();
    $("search").focus();
  }
});
const palette = installInputPalette($("input-palette"), (value) => {
  if (button >= 9) {
    notice("Select a button or wheel direction first.");
    return;
  }
  assignAction({ ...blankBinding(2), action: value });
});
$("close-profile").onclick = () => $("profile-dialog").close();
$("move-profile-left").onclick = () => {
  const list = activeProfiles(config),
    pos = list.indexOf(profile);
  if (pos > 0) reorderProfile(profile, list[pos - 1]);
};
$("move-profile-right").onclick = () => {
  const list = activeProfiles(config),
    pos = list.indexOf(profile);
  if (pos < list.length - 1) reorderProfile(profile, list[pos + 1]);
};
$("delete-profile").onclick = () => {
  if (
    !confirm(
      `Delete ${config.profiles[profile].name} and its layers from these settings?`,
    )
  )
    return;
  profile = deleteProfile(config, profile);
  layer = 0;
  $("profile-dialog").close();
  setDirty();
  render();
};
$("copy-layer").onclick = () => {
  layerClipboard = copy(config.profiles[profile].layers[menuLayer]);
  $("layer-menu").hidePopover();
  notice(`Copied layer ${menuLayer === 7 ? "P" : menuLayer}.`);
};
$("paste-layer").onclick = () => {
  if (!layerClipboard) return;
  pasteLayer(config, profile, menuLayer, layerClipboard);
  layer = menuLayer;
  $("layer-menu").hidePopover();
  setDirty();
  render();
  notice("Layer pasted into these settings.");
};
function renderLiveTabs() {
  const current = client ? liveSelection(config, deviceProfiles, live) : null;
  document.querySelectorAll(".profile-item").forEach((n) => {
    const active = current?.profile === Number(n.dataset.profileIndex);
    n.classList.toggle("device-active", active);
    n.title = active ? "Active on device" : "";
  });
  document.querySelectorAll(".layer-tab").forEach((n) => {
    const active =
      current?.profile === profile &&
      current.layer === Number(n.dataset.layerIndex);
    n.classList.toggle("device-active", active);
    n.title = active ? "Active on device" : "";
  });
  $("jump-current").disabled = !current;
  $("jump-current").title = current
    ? `Jump to ${config.profiles[current.profile].name}, layer ${current.layer === 7 ? "P" : current.layer}`
    : "Connect the device to locate its active profile and layer";
}
$("jump-current").onclick = () => {
  const current = liveSelection(config, deviceProfiles, live);
  if (!current) return;
  profile = current.profile;
  layer = current.layer;
  render();
};
async function syncConfiguration(persist) {
  if (busy || !checkReady())
    throw Error("Device is unavailable. Reconnect to finish saving.");
  const session = client,
    refs = config.profiles.slice();
  const snapshot = canonical(config);
  const current = liveSelection(config, deviceProfiles, live);
  await session.upload(
    snapshot,
    () => {},
    persist
      ? {}
      : {
          preview: true,
          profile: current?.profile ?? 255,
        },
  );
  if (client !== session)
    throw Error("Device disconnected before saving completed.");
  if (persist) {
    savedProfiles = refs;
    loadedBond = snapshot.bond;
  }
  deviceProfiles = refs;
  live = await session.status();
  renderLiveTabs();
}
const autoSave = new AutoSave({
  apply: () => syncConfiguration(false),
  save: () => syncConfiguration(true),
  changed: () => {
    dirty = autoSave.pending;
    renderFooter();
  },
  error: showError,
});
setInterval(async () => {
  if (
    !client ||
    !live ||
    client.failed ||
    busy ||
    autoSave.busy ||
    statusPolling ||
    document.hidden
  )
    return;
  const session = client;
  statusPolling = true;
  try {
    const next = await session.status();
    if (client === session) {
      live = next;
      renderLiveTabs();
    }
  } catch (e) {
    if (client === session) {
      live = null;
      autoSave.stop();
      await session.close().catch(() => {});
      client = null;
      deviceInfo = null;
      connectionLabel("Reconnecting…");
      renderLiveTabs();
      renderFooter();
    }
  } finally {
    statusPolling = false;
  }
}, 200);
render();
if (NapeHID.supported()) {
  navigator.hid.addEventListener("connect", autoConnect);
  setInterval(autoConnect, 2000);
  autoConnect();
}
if (!NapeHID.supported())
  notice(
    "Open this page in desktop Chrome or Edge at localhost or over HTTPS to connect your trackball.",
  );
// Preserve the full workspace at small window sizes without hiding controls.
function fitWorkspace() {
  document.documentElement.style.setProperty(
    "--ui-scale",
    Math.min(1, window.innerWidth / 1250, window.innerHeight / 900),
  );
}
window.addEventListener("resize", fitWorkspace);
fitWorkspace();

for (const key of ["gamma", "red", "green", "blue", "brightness"]) {
  $("led-" + key).onchange = () => {
    const before = config.led_correction;
    try {
      config.led_correction = {
        ...(before || {
          gamma: 22,
          red: 100,
          green: 100,
          blue: 100,
          brightness: 100,
        }),
        [key]:
          key === "gamma"
            ? Math.round(Number($("led-" + key).value) * 10)
            : Number($("led-" + key).value),
      };
      encode(config);
      setDirty();
    } catch (e) {
      config.led_correction = before;
      renderSettings();
      showError(e);
    }
  };
}
function maintenanceReady() {
  if (busy || autoSave.busy || dirty)
    throw Error(
      "Wait for settings to finish saving before starting device maintenance.",
    );
}
async function chooseMaintenance(stock) {
  if (busy || autoSave.busy || connecting) return;
  connecting = true;
  try {
    autoConnectPaused = false;
    if (stock) await connectStock(await StockHID.choose());
    else await connect(await NapeHID.choose());
  } catch (e) {
    showError(e);
  } finally {
    connecting = false;
  }
}
mountDeviceTools($("device-tools"), {
  client: () => client,
  stockClient: () => stockClient,
  connect: () => $("connect").click(),
  connectCustom: () => chooseMaintenance(false),
  connectStock: () => chooseMaintenance(true),
  state: () => ({
    connected: !!(client || stockClient),
    stock: !!stockClient,
    stockVerified: !!stockClient?.version,
    storage: deviceInfo?.state,
    live,
    ready: checkReady(),
    busy: busy || autoSave.busy,
  }),
  progress: transfer,
  error: showError,
  checkReady: maintenanceReady,
  run: async (fn) => {
    maintenanceReady();
    autoSave.stop();
    await operation(async () => {
      try {
        await fn();
      } finally {
        if (client && !client.failed) {
          try {
            deviceInfo = await client.info();
            live = await client.status();
          } catch {
            deviceInfo = live = null;
          }
          if (
            deviceInfo?.state === "owned" &&
            currentFirmware(live) &&
            !live?.recovery
          )
            autoSave.start();
        }
        renderFooter();
        renderStatus();
      }
    });
  },
  disconnect: async () => {
    autoSave.stop();
    if (client) await client.close().catch(() => {});
    if (stockClient) await stockClient.close().catch(() => {});
    stockClient = null;
    client = null;
    deviceInfo = live = null;
    connectionLabel("Waiting for USB…");
    renderFooter();
    renderStatus();
  },
  refresh: async () => {
    deviceInfo = await client.info();
    live = await client.status();
    if (deviceInfo.state === "owned" && currentFirmware(live) && !live.recovery)
      await readDevice();
    else {
      autoSave.stop();
      renderFooter();
      renderStatus();
    }
  },
});

if (navigator.hid)
  navigator.hid.addEventListener("disconnect", (event) => {
    if (stockClient?.device !== event.device) return;
    stockClient.close().catch(() => {});
    stockClient = null;
    connectionLabel("Disconnected");
    renderStatus();
  });
