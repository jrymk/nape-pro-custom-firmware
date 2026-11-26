import { prepareBin } from "./prepare-bin.js";
import * as maintenance from "./maintenance.js";
import { NapeHID, firmwareVersion } from "./hid.js";
import { hex } from "./schema.js";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const bytes = async (f) => new Uint8Array(await f.arrayBuffer());
const download = (name, data) => {
  const url = URL.createObjectURL(new Blob([data])),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
};
export function mountDeviceTools(root, api) {
  root.innerHTML = `
  <section class="maintenance-flow" aria-label="Install custom firmware">
    <h2>Install</h2>
    <div class="flow-step" id="maintenance-install-connect"><span class="step-number">1</span><div>
      <h3>Connect your trackball</h3><p>Use its own USB data cable. Stock and custom firmware are supported.</p>
      <button id="maintenance-connect">Connect</button><small id="maintenance-connection">Not connected.</small>
    </div></div>
    <div class="flow-step" id="maintenance-install-flash"><span class="step-number">2</span><div>
      <h3>Flash custom firmware</h3><p id="maintenance-firmware-status">Connect a device to flash.</p>
      <label>Custom application .bin <input id="maintenance-image" type="file" accept=".bin"></label>
      <button id="maintenance-latest-custom">Use latest release</button>
      <a href="https://github.com/jrymk/nape-pro-custom-firmware/releases" target="_blank" rel="noopener noreferrer">GitHub firmware releases ↗</a>
      <small>Load the latest release or choose a local application .bin. A full UART dump cannot be flashed here.</small>
      <pre id="maintenance-image-info">No firmware selected.</pre>
      <button id="maintenance-update" class="primary">Flash custom firmware</button>
      <small>Firmware is checked before activation. Existing user data is retained.</small>
    </div></div>
    <div class="flow-step" id="maintenance-install-adopt"><span class="step-number">3</span><div>
      <h3>Back up stock data and initialize</h3><p>Available in protected mode (amber flashing). Save the original settings and pairing data before initializing custom storage.</p>
      <button id="maintenance-connect-custom">Connect custom firmware</button>
      <div class="maintenance-actions"><button id="maintenance-backup">Backup to file</button><button id="maintenance-adopt" class="primary">Backup and adopt</button></div>
      <small>A fresh backup is saved, reopened and verified before adoption. An existing file is accepted only if it matches exactly.</small>
      <small class="backup-warning">Keep your .npb backup file. Returning to stock firmware without a valid stock user-data backup is untested and is not supported by this restore tool.</small>
    </div></div>
    <div class="flow-step" id="maintenance-install-done"><span class="step-number">4</span><div>
      <h3>Custom firmware installed</h3><p id="maintenance-install-status">Connect custom firmware to verify installation.</p>
      <p id="maintenance-install-error" class="workflow-error" role="alert" hidden></p>
    </div></div>
  </section>
  <section class="maintenance-flow" aria-label="Restore stock firmware">
    <h2>Restore to stock</h2>
    <div class="flow-step" id="maintenance-restore-connect"><span class="step-number">1</span><div>
      <h3>Connect custom firmware</h3><p>Normal and USB recovery modes support restoration.</p><button id="maintenance-stock-connect">Connect</button>
    </div></div>
    <div class="flow-step" id="maintenance-restore-files"><span class="step-number">2</span><div>
      <h3>Choose your stock backup</h3>
      <label>Original stock user data .npb <input id="maintenance-archive" type="file" accept=".npb"></label>
      <pre id="maintenance-archive-info">Use this trackball’s original archive. This is separate from custom profile JSON and full UART backups.</pre>
      <small>Restoration replaces custom settings. Export custom profiles first if you want to keep them.</small>
    </div></div>
    <div class="flow-step" id="maintenance-restore-flash"><span class="step-number">3</span><div>
      <h3>Restore data and flash stock firmware</h3>
      <label>Stock application .bin <input id="maintenance-stock-image" type="file" accept=".bin"></label>
      <button id="maintenance-latest-stock">Use stock from latest release</button>
      <a href="https://github.com/jrymk/nape-pro-custom-firmware/releases" target="_blank" rel="noopener noreferrer">GitHub firmware releases ↗</a>
      <pre id="maintenance-stock-image-info">No stock firmware selected.</pre>
      <button id="maintenance-stock" class="primary">Restore data and flash stock</button>
      <small>Both files are validated first. User data is restored, read back and protected before firmware flashing starts.</small>
      <details><summary>Restore data only</summary><p>Leaves custom firmware installed in protected mode.</p><button id="maintenance-restore">Restore stock data only</button></details>
    </div></div>
    <div class="flow-step" id="maintenance-restore-done"><span class="step-number">4</span><div>
      <h3>Stock firmware installed</h3><p id="maintenance-restore-status">Connect stock firmware to verify installation.</p>
      <button id="maintenance-connect-stock">Connect stock firmware</button>
      <p id="maintenance-restore-error" class="workflow-error" role="alert" hidden></p>
    </div></div>
  </section>
  <details class="setting-card"><summary>Offline files and diagnostics</summary>
    <label>Full UART readback <input id="maintenance-dump" type="file" accept=".bin"></label>
    <div class="maintenance-actions"><button id="maintenance-extract">Extract .npb</button><button id="maintenance-compare">Compare archive with dump</button><button id="maintenance-radio">Read radio status</button><button id="maintenance-reboot">Reboot</button></div>
    <label>Prepare MPTool file <input id="maintenance-prepare-file" type="file" accept=".bin,.npb"></label>
    <div class="maintenance-actions"><select id="maintenance-prepare-type" aria-label="MPTool input type"><option value="app">Application</option><option value="backup">Stock .npb</option><option value="dump">Raw UART dump</option></select><input id="maintenance-address" aria-label="Original dump address" placeholder="Dump address: 0x04000000"><button id="maintenance-prepare">Prepare-bin</button></div>
    <small>UART flashing and receiver-attributed Windows input capture still use the local tools. Files stay on this computer.</small>
  </details>
  <output id="maintenance-result" role="status" aria-live="polite"></output>`;
  const $ = (id) => root.querySelector("#maintenance-" + id);
  let image = null,
    imageInfo = null,
    backup = null,
    stockImage = null;
  let selecting = false,
    activeButton = null,
    working = false;
  let installOutcome = "",
    restoreOutcome = "",
    installError = "",
    restoreError = "";
  const restoreAction = () =>
    ["stock", "restore"].some((id) => activeButton === $(id));
  function updateState() {
    const state = api.state(),
      locked = working || state.busy;
    const stockReady = !!(
      state.connected &&
      state.stock &&
      state.stockVerified
    );
    if (restoreOutcome === "unverified" && stockReady)
      restoreOutcome = "success";
    const custom = state.connected && !state.stock;
    const protectedData =
      custom && ["protected", "restored"].includes(state.storage);
    const step = (id, enabled, status = "") => {
      const card = $(id);
      card.classList.toggle("unavailable", !enabled);
      card.classList.toggle("complete", status === "success");
      card.classList.toggle("failed", status === "error");
      for (const control of card.querySelectorAll("button,input"))
        control.disabled = locked || !enabled;
    };
    step("install-connect", true, state.connected ? "success" : "");
    step("install-flash", state.connected, custom ? "success" : "");
    $("firmware-status").textContent = custom
      ? "Custom firmware detected. Skip to step 3, or choose a newer image to update."
      : state.stock
        ? "Stock firmware detected. Choose custom firmware to install."
        : "Connect a device to flash.";
    step("install-adopt", protectedData);
    $("adopt").disabled = $("backup").disabled = locked || !protectedData;
    $("update").disabled = locked || !state.connected || !image;
    $("connection").textContent = state.stock
      ? "Stock firmware connected."
      : custom
        ? `Custom firmware connected · ${state.storage || "checking storage"}.`
        : "Not connected.";
    const ready = state.ready;
    if (custom && restoreOutcome === "success") restoreOutcome = "";
    step(
      "install-done",
      !!ready,
      ready ? "success" : installOutcome === "error" ? "error" : "",
    );
    $("install-status").textContent = ready
      ? state.live?.running
        ? "Custom firmware detected and storage initialized. Ready to configure profiles."
        : "Custom firmware detected and storage initialized. Input is paused; use Resume saved input below."
      : installOutcome === "error"
        ? "Installation stopped."
        : custom && state.live?.recovery
          ? "USB recovery is connected. Flash firmware, then reboot into normal mode."
          : protectedData
            ? "Firmware connected. Complete step 3 to initialize custom storage."
            : installOutcome === "unverified"
              ? "Upload completed; USB boot is not verified. Click Connect custom firmware and select the new interface if prompted. This is USB permission, not wireless pairing."
              : "Connect running custom firmware to verify installation.";
    step("restore-connect", true, custom ? "success" : "");
    step("restore-files", custom);
    step("restore-flash", custom && !!backup);
    $("stock").disabled = locked || !custom || !backup || !stockImage;
    step(
      "restore-done",
      true,
      stockReady ? "success" : restoreOutcome === "error" ? "error" : "",
    );
    $("restore-status").textContent = stockReady
      ? restoreOutcome === "success"
        ? "Stock firmware reconnected and responded. User-data restoration and readback were verified."
        : "Stock firmware detected and responding. No restoration is needed."
      : restoreOutcome === "error"
        ? "Restoration stopped."
        : restoreOutcome === "unverified"
          ? "Data restored and firmware uploaded; USB boot is not verified. Click Connect stock firmware and select the stock interface if prompted."
          : "Connect stock firmware to verify installation.";
    for (const [kind, error] of [
      ["install", installError],
      ["restore", restoreError],
    ]) {
      $(kind + "-error").textContent = error ? `Error: ${error}` : "";
      $(kind + "-error").hidden = !error;
    }
    $("connect-custom").disabled = locked;
    $("connect-stock").disabled = locked;
    for (const id of ["reboot", "radio"]) $(id).disabled = locked || !custom;
  }
  const run = (fn) =>
    api.run(async () => {
      try {
        await fn();
      } catch (e) {
        if (restoreAction()) {
          restoreOutcome = "error";
          restoreError = e.message;
        } else if (["update", "adopt"].some((id) => activeButton === $(id))) {
          installOutcome = "error";
          installError = e.message;
        }
        result(e.message, "error");
        throw e;
      }
    });
  $("connect").onclick = $("stock-connect").onclick = api.connect;
  $("connect-custom").onclick = api.connectCustom;
  $("connect-stock").onclick = api.connectStock;
  setInterval(updateState, 250);
  updateState();
  const result = (msg, type = "") => {
    $("result").textContent = type === "error" ? `Error: ${msg}` : msg;
    $("result").classList.toggle("workflow-error", type === "error");
  };
  const progress = (p, label) => {
    api.progress(p);
    const percent = Math.round(p * 100);
    result(`${label} · ${percent}%`);
    if (activeButton) {
      activeButton.textContent = `${label} · ${percent}%`;
      activeButton.style.setProperty("--transfer", `${percent}%`);
    }
  };
  const selected = async (id) => {
    const f = $(id).files[0];
    if (!f) throw Error("Select a file first.");
    return bytes(f);
  };
  const wrap = (fn) => async (event) => {
    if (working) return;
    activeButton =
      event?.currentTarget?.tagName === "BUTTON" ? event.currentTarget : null;
    const label = activeButton?.textContent;
    working = true;
    activeButton?.classList.add("transferring");
    if (restoreAction()) {
      restoreOutcome = "";
      restoreError = "";
    } else if (["update", "adopt"].some((id) => activeButton === $(id))) {
      installOutcome = "";
      installError = "";
    }
    updateState();
    try {
      await fn();
    } catch (e) {
      result(e.message, "error");
      api.error(e);
    } finally {
      if (activeButton) {
        activeButton.textContent = label;
        activeButton.classList.remove("transferring");
      }
      activeButton = null;
      working = false;
      updateState();
    }
  };
  const client = () => {
    const c = api.client();
    if (!c) throw Error("Connect the custom firmware over USB first.");
    return c;
  };
  async function refresh() {
    await api.refresh();
  }
  function watchDisconnect(device) {
    let seen = false;
    const listener = (e) => {
      if (e.device === device) seen = true;
    };
    navigator.hid.addEventListener("disconnect", listener);
    return {
      seen: () => seen,
      stop: () => navigator.hid.removeEventListener("disconnect", listener),
    };
  }
  async function waitBoot(stock, watcher) {
    result("Activation sent. Waiting for USB to reconnect…");
    if (activeButton) activeButton.textContent = "Waiting for USB…";
    await api.disconnect();
    // A successful send is not a successful boot. Require an observed detach.

    for (let i = 0; i < 32; i++) {
      await pause(250);
      const devices = await navigator.hid.getDevices();

      const matching = devices.filter(
        stock ? maintenance.StockHID.matches : NapeHID.matches,
      );
      if (!watcher.seen() || matching.length !== 1) continue;
      const d = matching[0],
        s = stock
          ? new maintenance.StockHID(d)
          : new NapeHID(d, { timeout: 1500 });
      try {
        await s.open();
        const info = stock ? await s.identify() : await s.info();
        if (stock && info !== "1.3.3-r")
          throw Error("Unexpected stock firmware version.");
        const status = stock ? null : await s.status();
        result(
          stock
            ? `Stock firmware reconnected: ${info}.`
            : `Custom firmware reconnected: ${firmwareVersion(status.firmware)} · ${info.state}.`,
        );
        await s.close();
        return true;
      } catch {
        await s.close().catch(() => {});
      }
    }
    result(
      `Activation sent; boot is not verified. Reconnect the USB cable and click Connect ${stock ? "stock firmware in Restore step 4" : "custom firmware in Install step 3"} to authorize and verify the returning interface.`,
    );
    return false;
  }
  async function flash(c, stock = false) {
    const firmware = stock ? stockImage : image;
    if (!firmware) throw Error("Choose an application image first.");
    await maintenance.validateImage(firmware, { stock });
    const watcher = watchDisconnect(c.device);
    let activated = false,
      transferError = null;
    try {
      await maintenance.updateFirmware(c, firmware, progress, {
        stock,
        onActivation: () => {
          activated = true;
        },
      });
    } catch (e) {
      if (!activated) {
        watcher.stop();
        throw e;
      }
      transferError = e;
    }
    const booted = await waitBoot(stock, watcher);
    watcher.stop();
    if (stock) restoreOutcome = booted ? "success" : "unverified";
    else installOutcome = booted ? "" : "unverified";
    if (!booted && transferError)
      result(
        `Activation response interrupted: ${transferError.message}. Boot is unverified; reconnect and check the device.`,
      );
  }
  $("image").onchange = wrap(async () => {
    image = null;
    imageInfo = null;
    $("image-info").textContent = "Checking custom firmware…";
    const b = await selected("image");
    imageInfo = await maintenance.validateImage(b);
    image = b;
    $("image-info").textContent =
      `${imageInfo.kind} · ${imageInfo.bytes.toLocaleString()} bytes\nSHA-256 ${imageInfo.sha256}`;
  });
  $("stock-image").onchange = wrap(async () => {
    stockImage = null;
    $("stock-image-info").textContent = "Checking stock firmware…";
    const b = await selected("stock-image");
    const info = await maintenance.validateImage(b, { stock: true });
    stockImage = b;
    $("stock-image-info").textContent =
      `${info.kind} · ${info.bytes.toLocaleString()} bytes · SHA-256 verified`;
  });
  for (const stock of [false, true]) {
    const id = stock ? "stock-image" : "image";
    $(stock ? "latest-stock" : "latest-custom").onclick = wrap(async () => {
      if (stock) stockImage = null;
      else {
        image = null;
        imageInfo = null;
      }
      $(id).value = "";
      $(id + "-info").textContent = "Fetching latest release…";
      try {
        const downloaded = await maintenance.downloadFirmware(stock, progress);
        if (stock) stockImage = downloaded.data;
        else {
          image = downloaded.data;
          imageInfo = downloaded.info;
        }
        $(id + "-info").textContent =
          `${downloaded.name} · ${downloaded.release}\n${downloaded.info.bytes.toLocaleString()} bytes · SHA-256 ${downloaded.info.sha256}`;
        result(
          "Firmware downloaded and verified. Ready to flash when you choose.",
        );
      } catch (error) {
        $(id + "-info").textContent =
          "No firmware selected. Choose a local file or retry the download.";
        throw error;
      }
    });
  }
  $("archive").onchange = wrap(async () => {
    backup = null;
    $("archive-info").textContent = "Checking archive…";
    const b = await selected("archive");
    const data = await maintenance.loadArchive(b);
    backup = b;
    $("archive-info").textContent =
      `Archive checksum verified · ${data.length.toLocaleString()} user-data bytes. Includes stock pairing and settings; not firmware.`;
  });
  for (const [id, doAdopt] of [
    ["backup", false],
    ["adopt", true],
  ]) {
    $(id).onclick = wrap(async () => {
      if (selecting) return;
      client();
      api.checkReady();
      if (!window.showSaveFilePicker)
        throw Error("Saving a verified backup requires desktop Chrome/Edge.");
      selecting = true;
      try {
        const handle = await showSaveFilePicker({
          suggestedName: `nape-stock-${new Date().toISOString().slice(0, 10)}.npb`,
          types: [
            {
              description: "Nape stock user-data backup",
              accept: { "application/octet-stream": [".npb"] },
            },
          ],
        });
        await run(async () => {
          await maintenance.backupAndAdopt(client(), handle, progress, doAdopt);
          result(
            doAdopt
              ? "Backup saved and readback verified. Custom storage adopted."
              : "Backup saved and readback verified. Stock data unchanged.",
          );
          await refresh();
        });
      } finally {
        selecting = false;
      }
    });
  }
  $("restore").onclick = wrap(() =>
    run(async () => {
      if (!backup) throw Error("Select the original verified .npb first.");
      if (
        !confirm(
          "Replace custom settings with this original stock backup? The device will enter protected mode.",
        )
      )
        return;
      if (
        !(await maintenance.restoreData(client(), backup, progress, {
          confirmDifferent: (message) => confirm(message),
        }))
      ) {
        result("Restoration canceled. No user data was changed.");
        return;
      }
      result("Stock data restored, readback verified and protected.");
      await refresh();
    }),
  );
  $("stock").onclick = wrap(() =>
    run(async () => {
      if (!backup || !stockImage)
        throw Error("Select an original .npb and the stock application image.");
      await maintenance.loadArchive(backup);
      await maintenance.validateImage(stockImage, { stock: true });
      if (
        !confirm(
          "Replace custom settings and firmware with the selected stock backup and stock application image?",
        )
      )
        return;
      const c = client();
      if (
        !(await maintenance.restoreData(c, backup, progress, {
          confirmDifferent: (message) => confirm(message),
        }))
      ) {
        result("Restoration canceled. No user data was changed.");
        return;
      }
      await flash(c, true);
    }),
  );
  $("update").onclick = wrap(() =>
    run(async () => {
      if (!api.stockClient()) {
        await flash(client());
        return;
      }
      if (!image) throw Error("Choose custom firmware first.");
      const c = api.stockClient(),
        watcher = watchDisconnect(c.device);
      let activated = false;
      try {
        try {
          await c.install(image, progress, () => {
            activated = true;
          });
        } catch (e) {
          if (!activated) throw e;
        }
        if (activated)
          installOutcome = (await waitBoot(false, watcher)) ? "" : "unverified";
      } finally {
        watcher.stop();
      }
    }),
  );
  $("reboot").onclick = wrap(() =>
    run(async () => {
      const c = client(),
        watcher = watchDisconnect(c.device);
      try {
        await c.request(0x26);
        await waitBoot(false, watcher);
      } finally {
        watcher.stop();
      }
    }),
  );
  $("extract").onclick = wrap(async () => {
    const b = await maintenance.extractBackup(await selected("dump"));
    download("nape-stock-extracted.npb", b);
    result("Extracted stock user data. UART dump unchanged.");
  });
  $("compare").onclick = wrap(async () => {
    if (!backup) throw Error("Select an archive first.");
    await maintenance.verifyBackup(backup, await selected("dump"));
    result("Every archived byte matches the supplied full UART dump.");
  });
  $("prepare").onclick = wrap(async () => {
    const raw = await selected("prepare-file"),
      kind = $("prepare-type").value;
    const entered = $("address").value.trim();
    const prepared = await prepareBin(
      raw,
      kind,
      entered ? Number(entered) : null,
    );
    download(prepared.filename, prepared.data);
    result(
      `Prepared ${prepared.filename}\nAddress ${prepared.manifest.address} · ${prepared.manifest.programmed_bytes.toLocaleString()} bytes\n${prepared.manifest.mptool_route}\n${prepared.manifest.notes}`,
    );
  });
  $("radio").onclick = wrap(() =>
    run(async () => {
      const b = await client().request(0x20);
      result(
        `Radio diagnostic status (${b.length} bytes): ${hex(b)}\nRead-only; no radio test started.`,
      );
    }),
  );
}
