# Nape Studio — WebHID editor

## Run locally

Requires Node.js 22 or newer. From this directory:

```
npm start
```

Open http://127.0.0.1:8787 in desktop Chrome or Edge. On Windows, you can also run `start.cmd`. No npm install is needed. Keep the terminal running; Ctrl+C stops the server.

Connect the trackball's own USB cable. Previously authorized devices reconnect automatically on page load and after USB reconnect. The first connection requires **Connect** and selecting the stock updater or custom maintenance interface. Use a consistent address/port: permission belongs to that browser origin. Both localhost HTTP and hosted HTTPS support WebHID.

Connecting reads the saved configuration before enabling edits. Changes apply to RAM after a 200 ms pause, then save to flash after 1.5 seconds of inactivity and verify through readback. No preview/review mode or manual save step is needed. The top bar shows Saving / Saved. Edits made during a transfer are queued for the next transfer; disconnects retain unsaved edits in the current tab. Wait for Saved before closing. A flash error stops automatic writes and shows Reconnect, retaining edits for retry. Selecting a profile in the editor never switches the device's active profile. Export JSON for a private backup.

The fixed workspace fits the browser. Profiles and Device are separate side tabs. Connection, import/export, transfer progress, and save status stay at the top. The action library uses search, categories, and page buttons instead of scrolling. Very small windows scale the interface down; a desktop-sized window is more readable.

## Supported controls

- Up to eight profiles, each with eight layers and seven button positions. Add/delete profiles, drag to reorder, and use the profile menu for name, color and report rate. Reordering preserves the startup profile's identity.
- Compact 0/1–6/P layer tabs, with right-click copy/paste across profiles; orientation icon choices and fixed-size horizontal/vertical device maps.
- Graphical keyboard/mouse assignment, compact action buttons, and a hover capture area. Keyboard modifiers can be toggled on the graphical keyboard. Capture suppresses cancellable mouse defaults; browser/OS-reserved shortcuts may not reach the page. Mouse buttons 4/5 conventionally mean Back/Forward, but applications may remap them.
- Profile name, color, report rate and selector tap action.
- Layer DPI, pointer/scroll mode, scroll sensitivity, orientation, and LED inherit/solid/off.
- Mouse and wired keyboard outputs; hold/toggle layers; unused-release actions; DPI/motion/LED overrides and reset; transparent/disabled bindings.
- Device transport, startup profile, and debounce.
- Receiver bond import from a verified `.npb` archive. This imports the pairing record into the configuration; it does not restore the archive or initialize storage.
- Runtime status and resume saved input.

Macros, arbitrary-angle rotation, gestures, Bluetooth and fresh receiver pairing are not implemented in the current firmware. Keyboard shortcuts use USB HID usages (symbol names assume a US layout) and currently work only over wired USB. The stock receiver supports the existing experimental mouse path.

## Action behaviors and layer P

The behavior controls above the action library choose No action, Hold action, Press action, Hold layer + press action, Toggle layer, or Inherit. Quick alone shows the keyboard/mouse graphics; Mouse, Keyboard and Settings contain compact action choices. The selected device control pulses (or stays shaded when reduced motion is enabled). Profile dragging shows a ghost slot and shifts the other profiles to preview the resulting order.

Hold outputs stay pressed, or can repeat presses at a configurable 20–2,000 ms interval. Hold DPI/ball/LED settings apply only while held; the newest held setting for that property wins. Releasing in any order reveals the remaining held setting, then the persistent value. Press outputs tap once; Press settings remain until reset/profile change/configuration apply/reboot. Hold layer + press action executes its secondary output or setting only on unused release. Macros remain unavailable.

Round always holds P (layer 7). P's clockwise/counterclockwise wheel actions are reserved for next/previous profile; all its other buttons and layer settings remain editable. Round release commits a wheel-selected profile; otherwise an unused release runs the profile's configured release action without a timeout. Inherited pointer jitter does not consume this action. Explicit layer motion/DPI/orientation and other resolved actions do. If another binding activates P without Round, its wheel switches profiles immediately. 

Use **`np-custom-firmware-1.0.11.bin`** (firmware `1.0.11`) with this editor. It includes behaviors, P, profile slots, wheel mappings, orientation, wired media controls and RAM preview. The current configuration is JSON version 2 / NPCFG002, 4,896 bytes. Incompatible custom settings reset to defaults at boot; old JSON is rejected. No compatibility conversion is performed. The ownership header and protected stock-data backup/restore protocol are unchanged. A settings reset also clears the custom receiver pairing field: import it again from your verified stock `.npb` archive.

Update with `nape.exe update --image np-custom-firmware-1.0.11.bin`. Refresh the editor after updating; it reconnects and reads the device automatically. Current Python clients use the same v2 codec; packaged desktop executables must be rebuilt when the codec changes.

Consumer usage definitions follow the [USB-IF HID Usage Tables](https://www.usb.org/sites/default/files/hut1_3_0.pdf). The stock wireless receiver still carries mouse reports only.

The **Device** panel provides custom USB firmware updates (including recovery), first install through stock 1.3.3-r, verified stock-user-data backup/adoption, restoration of original data or data plus official stock 1.3.3, reboot, file inspection, full-dump `.npb` extraction/comparison and offline MPTool `prepare-bin`. Files stay local. Profile editing remains disabled in protected/recovery mode, while maintenance remains available.

The Device tab separates **Install** and **Restore to stock** into numbered cards. Connect works with stock or custom firmware. Each step is enabled only for the appropriate device state. Choose custom and stock firmware on their respective cards; the GitHub release link opens the download page, after which you select the downloaded application file. Flash buttons show transfer progress and wait for USB boot verification before claiming completion.

The final cards are **Custom firmware installed** and **Stock firmware installed**. A verified connection can complete either card without running that workflow in this session. Custom firmware must also have initialized storage and be outside recovery mode; paused input is identified separately. These checks verify the responding firmware, not every hardware function. Authorized stock and custom interfaces reconnect automatically. Install step 3 and Restore step 4 always offer explicit Connect buttons for a returning interface that needs browser permission; Restore step 4 turns green only while stock firmware is connected and identified; this is USB access permission, not Bluetooth or receiver pairing.

Restoring an archive that differs from the last adoption backup requires an explicit confirmation and firmware **1.0.11 or newer**. Older firmware requires an update first. This override changes the expected stock snapshot; it does not bypass the archive checksum, transfer hash, or restored-data readback. The firmware records the replacement restore transaction before changing user data, so an interrupted transfer can be retried with the same archive. The native utility continues to use the strict matching-backup restore command.

**Backup and adopt** is the primary installation action. It always reads a fresh backup; an existing file is accepted only when it matches the fresh bytes exactly. **Restore data and flash stock** is the primary restoration action; both files are validated before any write, and restored data is fully read back before firmware staging.

Backup and adopt uses Chrome/Edge's save-file picker, closes the file, reads it back and verifies every byte before adoption. An existing differing file is never overwritten. If adoption is interrupted, restore the original archive through Restore data only before taking a fresh backup and adopting again. Restore operations replace custom settings; they ask for confirmation. Firmware files are checked for model, ROM/layout and SHA-256 before staging. After activation the browser requires a USB disconnect/reconnect and a live application response; missing permissions or reconnect timeout reports **boot unverified**, not success. UART recovery and experimental Windows receiver-attributed input capture still require local tools. The desktop utility remains supported.

## Privacy and hosting

The page has no backend API, analytics, account, external fonts, or network uploads. WebHID communication is directly between the browser and USB device. Pairing data remains in memory unless you explicitly export it. Exported JSON contains receiver pairing bytes; keep personal exports private.

The hosted editor is at https://nape-pro.jerrymk.com/. `public/` contains the complete static website. `wrangler.jsonc` configures a Cloudflare Worker with static assets and that custom domain; the workers.dev endpoint is disabled. From this directory, run `npx wrangler login` to authorize Cloudflare, then `npx wrangler deploy` to publish changes. Nothing is deployed automatically. HTTPS is required for WebHID on a hosted domain; localhost also works. The hosted origin needs its own initial Connect permission, independent of localhost. Serve the app as a top-level page. Preserve the CSP and Permissions-Policy in `public/_headers`.

Do not publish firmware dumps, `.npb` archives or user JSON as web assets. The local server only serves `public/`, binds to 127.0.0.1, and has no device-management backend.

## Development

`public/schema.js` implements the NPCFG002 codec. `public/hid.js` owns the serialized HID protocol and verified upload. `public/app.js` handles the editor; `public/auto-save.js` serializes live application and idle saves.

Hardware writes must be tested using a freshly read configuration and a backup.

`public/editor-controls.js` contains profile/layer editing helpers and the graphical input palette. Barlow is bundled locally under the SIL Open Font License (see `public/fonts/OFL.txt`), from https://github.com/jpt/barlow.

## Orientation and live state

Layer 0 has an explicit orientation. Upper layers may inherit directly from their own profile’s layer 0, including when an intermediate active layer has a different orientation. The icons show the physical position of Round: top (native), right, bottom, left. Wire values 1–4 apply 0°, 90°, 180°, 270° clockwise to the native sensor movement before pointer/ball-scroll processing. The ring itself is independent of ball orientation.

The active device profile and highest active layer are shaded/bold. Editing another profile does not shade that profile’s same-numbered layer or switch the device. Jump to current navigates explicitly; choosing an editor profile starts at layer 0. Status polling and live preview require the current firmware; a single configuration-version check replaces per-feature compatibility paths.

Startup profile is under Device: **Last used** (default) or a fixed enabled profile. Last used remembers a completed selection after 750 ms; disconnecting power sooner can retain the preceding profile. RAM previews do not change this history.

Ball scroll defaults to 16 sensor counts per wheel step (lower is faster). Set/Hold ball-scroll actions can override sensitivity; zero inherits the layer setting. Stock-style ball scrolling emits one whole step when a threshold is crossed. Vertical wins if both axes cross together; both accumulators are then cleared. Reports are paced at up to 250 Hz (4 ms per axis), independently of pointer/button reporting, and each HID report carries only one nonzero scroll axis. This intentionally does not attempt diagonal scrolling. **None** disables ball motion independently of Inherit, including in Set/Hold/unused-release ball-function actions.

## LED calibration and metadata

Device offers gamma (1.0–4.0 in 0.1 increments), per-channel gains (0–100%) and brightness (0–100%). Gamma defaults to 2.2; the gains default to 100% and need visual calibration for the physical LED. Firmware uses 16-bit gamma tables and 4 kHz PWM from a 40 MHz timer (10,000 timer steps per period). Stored colors remain 8-bit RGB. Recovery/protected indicators bypass user gains/brightness so a zero brightness setting cannot hide recovery. Gamma tables are generated by `tools/generate_led_gamma.py`.

The static HTML includes a descriptive title, description, Open Graph tags, WebApplication structured data and visible project description. Its canonical and Open Graph URL is https://nape-pro.jerrymk.com/. Search indexing requires a publicly reachable deployment; localhost is not indexed.

The owner has confirmed the restore-to-stock process works. The revised workflow UI is checked separately; a completed upload alone is never treated as proof that the application booted.

Holding Round flashes the current profile color at 4 Hz / 50% duty until the first wheel movement. The previewed profile color then stays steady until release, which restores the active layer color.
