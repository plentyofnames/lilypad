# Lilypad

A browser-based **Web MIDI editor for the Faderfox EC4** running **controlfrog**, a custom firmware that lets a computer read and write the EC4's setups over USB MIDI. Edit the encoders, push buttons and names of all 16 setups × 16 groups, plus the device settings, and write back only the bytes that changed.

▶︎ **Live editor:** https://plentyofnam.es/lilypad/

> **Unofficial.** Lilypad and controlfrog are not made, endorsed or supported by Faderfox. Faderfox and EC4 are trademarks of their owner.
>
> **Editing a real unit needs the controlfrog firmware, which is not released yet.** The stock EC4 firmware does not speak Lilypad's protocol. Until controlfrog is out, you can try everything against the built-in demo EC4, and edit stock "all setups" `.syx` dumps offline.

Plain HTML, CSS and JS modules: no build step, no dependencies.

## Try it

Open the [live editor](https://plentyofnam.es/lilypad/) and press **Try the demo EC4**. The demo is a simulated EC4 that runs in the page. It speaks the same protocol as controlfrog, at the real link speed (31250 baud each way, ~5 ms per EEPROM page write), and starts from the EC4's factory layout. Its memory is kept in your browser, so it behaves like a device across reloads; **Reset** in the demo panel starts over.

To run it locally, serve the folder over HTTP (modules don't load from `file://`):

```sh
python3 -m http.server 8000
```

and open <http://localhost:8000/>. After pulling a newer version, hard-reload (Cmd+Shift+R), since `http.server` sends no cache headers.

## Requirements

- **Chrome, Edge** or another browser with Web MIDI and SysEx. Safari has no Web MIDI. The browser asks for MIDI/SysEx permission only when you pick the MIDI target and press **Connect**.
- For a real unit: an EC4 running controlfrog, on USB. Connect sends IDENTIFY first and stops unless the unit answers with protocol 1.
- **Reconnecting:** after a successful connection to a real unit, Lilypad reconnects to it on the next load. It does this only if the browser already allows MIDI, so a page load never prompts. If the unit isn't plugged in yet, Lilypad waits and connects when it appears; it also reconnects after the unit is unplugged and plugged back in. Pressing **Disconnect** stops all of this until the next manual Connect.
- **One tab at a time:** the unit answers every program that has its port open. So a Lilypad tab doesn't reconnect by itself while another Lilypad tab holds the unit, and pressing **Connect** takes the unit over from the other tab.
- Nothing is needed for the demo or for working on files offline.

## Targets

- **Demo EC4 (simulated)** is the default. Like the firmware:
  - it handles one request at a time and drops a request that arrives before the previous reply is out;
  - during a full dump (DUMP_ALL) it ignores requests and sends no events;
  - it sends at most one TOUCH per control per 250 ms.

  The demo panel shows:
  - the live names, which change only on RELOAD, as on the unit;
  - 16 knobs: wheel or drag sends a turn TOUCH event, a click sends a push;
  - setup/group keys, which send STATE events;
  - fault switches (writes fail, bus error, dropped reply, corrupt READ);
  - read/write counters;
  - Load .syx / Save EEPROM / Reset.
- **EC4 over MIDI (controlfrog)** is a real unit through its "Faderfox EC4" USB MIDI ports.

## Use

- **Browse.** The sidebar lists setups and groups by name. ● means read, ○ means not read yet, and an orange dot marks changes. ◂ is where the device is. The grid shows the 4×4 controls of the group. **Turn / Push** above it switches all 16 boxes between encoders and push buttons; each box's bottom line shows the other one, and clicking it switches. Arrow keys move, Space switches Turn/Push, PgUp/PgDn change group.
- **Edit in the boxes.** Each box has fields for its name, type, channel, number (MSB and LSB for NRPN, with the note name for notes) and lower/upper. Tab moves through them. A field in a box changes only that control. Display, mode, link and the push button's Key/Toggle and display are in the side panel.
- **Select several.** Shift-click selects a range of boxes, ⌘/Ctrl-click adds or removes one, and ⌘A or **Select all** takes all 16; Esc goes back to one. With several selected, the side panel shows each field's shared value or "mixed", and a change applies to every selected control that uses the field (so a number doesn't go to a program change).
- **Copy and paste.** **Copy** copies the selected controls (encoder, push button and name), the whole group or the whole setup (group and setup names included). **Paste** puts it over the selection, the current group or the current setup. One copied control goes into every selected box; several go into consecutive boxes from the first selected one. ⌘C/⌘V do the same for controls, and the clipboard works between Lilypad tabs. A pasted link on control 16 is cleared.
- **Fill.** **Fill** counts channels or numbers up by one, starting from the first selected control's value: across the selection, or from the selected box to box 16. Channels wrap after 16 and numbers after 127. Controls that don't use the field are skipped.
- **Undo.** ⌘Z / ⇧⌘Z (or ↶ ↷ in the top bar) undo and redo every edit, bulk ones included, and show where the change was. Typing a name counts as one step. Undoing after a write makes those bytes pending again. Opening a file, discarding or re-reading a setup clears the history.
- **Edit.** The side panel applies the rules of the EC4's setup data format:
  - Fields that don't apply are greyed out.
  - CCAh numbers run 0–31, and NRPN takes an MSB and an LSB.
  - Lower/upper are 14-bit (0–4094, or 16383 for max) for CCAh/PBnd/NRPN with display off/1000/±500/9999, and 7-bit otherwise.
  - Push types Off, Acc/LSp/Min/Max and Grp/Set turn their fields off; Grp/Set relabel the channel as Group/Setup.
  - Link is off on control 16.
  - Invalid stored values show with the value the EC4 actually uses.
- **Device settings** (top of the sidebar): routing, brightness, screensaver, note view and value pop-up. With controlfrog 0.10 or later, also **Send values on group change** (byte `0x0007`): each group or setup change then sends the new group's current values.
- **Reading.** Data is read lazily, one setup at a time (~2 s, the selected group first). Moving to another setup stops a lazy read, and pages already read stay cached. **Read all** reads the rest (~30 s for 64 KB). **Re-read setup** discards the cache for the current setup.
- **Write** sends only the changed bytes, as runs of at most 64 bytes that never cross a 64-byte page, then RELOAD. Bytes without a known device value (for example after opening a file while connected) are read first, so the comparison is exact. **Auto-write** (status bar) writes 0.6 s after each edit. **Move device** sends SELECT when you browse, and **Follow device** follows TOUCH and STATE events.
- **No reply** counts as "busy": a full dump keeps the unit silent for ~67 s. Lilypad keeps retrying a request for up to 75 s and says so in the status bar. **Cancel** or **Disconnect** stops it.
- **Lilypad never writes** `0x0000` (last setup: a value ≥ 16 factory-resets the unit at boot), `0x0004`, `0x0008`–`0x001F` (`0x0010`–`0x001F` hold the last group per setup) or the presets at `0x0800`–`0x0AFF`. Below `0x0B00` it writes only the settings above: `0x0001`–`0x0003` and `0x0005`–`0x0007`.
- **Files.** Opening a file (or dropping it on the page) works offline or while connected. It accepts:
  - stock "all setups" dumps (`0x0B00`–`0xFFFF`), as sent by the EC4's Setup → Send;
  - full 64 KB dumps;
  - "one setup" files, whose pages are applied by address.

  **Save .syx** writes the stock "all setups" format (30 zero bytes after each page), which the stock firmware loads with Setup → Receive. **Save full dump** writes all 64 KB in controlfrog's dump format. Saving an unchanged file reproduces it byte for byte. **Backup…** asks the unit for a full dump (~67 s) and saves it as it arrives.

## Protocol

controlfrog speaks a small SysEx protocol on the EC4's USB port: `F0 7D 45 43 34 <cmd> … F7` (`7D` is the non-commercial manufacturer ID, `45 43 34` is "EC4"). Data is packed 8-to-7. Requests are IDENTIFY, READ and WRITE (up to 64 bytes, never across a 64-byte page), RELOAD, GET_STATE, SELECT, TOUCH_EVENTS and DUMP_ALL. The unit also sends STATE and TOUCH events on its own. The codec is [`js/proto.js`](js/proto.js), and [`js/mock.js`](js/mock.js) is a complete device-side implementation.

## Files

| file | what |
|---|---|
| `index.html`, `style.css` | page and styles |
| `js/app.js`, `js/dom.js` | UI |
| `js/proto.js` | protocol v1: framing, 8-to-7 packing, checksums, message codecs |
| `js/device.js` | host client: one request at a time, timeouts and retries, TOUCH/STATE events |
| `js/touch.js` | what a TOUCH event selects (a twist while pushing keeps the push button) |
| `js/midi.js` | Web MIDI transport |
| `js/mock.js` | the demo EC4 |
| `js/demo.js` | the demo's starting setups, generated from the factory-default rules |
| `js/syx.js` | the EC4's nibble SysEx file format |
| `js/model.js` | memory map, value tables, rules, field get/set |
| `js/store.js` | image, device and file baselines, diff chunking |
| `js/bulk.js` | copy/paste of controls, groups and setups; fill; one field on several controls |
| `js/history.js` | undo/redo steps that keep only the changed bytes |
| `test/` | core tests |

## Tests

```sh
deno run --allow-read test/run.js
```

or open `/test/` on the local server (or [online](https://plentyofnam.es/lilypad/test/)). The tests use files generated from the demo setups. To also check the file code against your own unit, put a stock "all setups" dump and a full dump of the same unit at `test/local/all_setups.syx` and `test/local/eeprom_full.syx` (git-ignored).

## Notes

- The value tables and rules were cross-checked against the MIT-licensed [privatepublic-de/faderfox-editor](https://github.com/privatepublic-de/faderfox-editor). No code was copied from it.
- A 7-bit lower/upper edit also clears that value's 14-bit MSB nibble, so both readings agree. Factory data stores "max" as `0xFF` with nibble `0xF`, which reads as 127 or 16383.
- Note view: 0 shows numbers and non-zero shows note names. The value pop-up style is shown as a raw 0/1/2.

Built by a human and a Claude.

## License

MIT, see [LICENSE](LICENSE). Not affiliated with Faderfox.
