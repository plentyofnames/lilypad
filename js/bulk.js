// Bulk edits on the image: copy/paste of controls, groups and setups, ascending fill, and one
// field applied to several controls. Everything works on raw EEPROM bytes, so a paste carries
// every field (names included) exactly.

import * as M from './model.js';

const flat = (ranges) => ranges.flatMap(([a, n]) => Array.from({ length: n }, (_, k) => a + k));

// Byte addresses, in a fixed order, of one control, a group and a setup (names included).
export const controlAddrs = (s, g, i) => M.controlAddrs(s, g, i);
export const groupAddrs = (s, g) => flat(M.groupRanges(s, g));
export const setupAddrs = (s) => [...flat([[M.setupNameAddr(s), 4]]), ...flat(M.setupRanges(s))];

const read = (img, addrs) => Uint8Array.from(addrs, (a) => img[a]);
function write(img, addrs, bytes) {
  addrs.forEach((a, k) => (img[a] = bytes[k]));
}
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s) => Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16));

// Link is not available on control 16: a pasted link bit there is cleared.
function fixLinks(img, s, g) {
  img[M.dataBase(s, g) + 16 + 15] &= 0x7F;
  img[M.key2Base(s, g) + 16 + 15] &= 0x7F;
}

// ---- clipboard: {kind: 'controls' | 'group' | 'setup', items: [Uint8Array], from: label}

export function copyControls(img, s, g, indices) {
  return { kind: 'controls', items: indices.map((i) => read(img, controlAddrs(s, g, i))), from: `setup ${s + 1} group ${g + 1}` };
}
export function copyGroup(img, s, g) {
  return { kind: 'group', items: [read(img, groupAddrs(s, g))], from: `setup ${s + 1} group ${g + 1}` };
}
export function copySetup(img, s) {
  return { kind: 'setup', items: [read(img, setupAddrs(s))], from: `setup ${s + 1}` };
}

// One copied control goes into every target; several go into consecutive controls from the
// first target on (as many as fit). Returns the indices written.
export function pasteControls(img, s, g, targets, clip) {
  const sorted = [...targets].sort((a, b) => a - b);
  const pairs = clip.items.length === 1
    ? sorted.map((i) => [i, clip.items[0]])
    : clip.items.map((item, k) => [sorted[0] + k, item]).filter(([i]) => i < 16);
  for (const [i, bytes] of pairs) write(img, controlAddrs(s, g, i), bytes);
  fixLinks(img, s, g);
  return pairs.map(([i]) => i);
}
export function pasteGroup(img, s, g, clip) {
  write(img, groupAddrs(s, g), clip.items[0]);
  fixLinks(img, s, g);
}
export function pasteSetup(img, s, clip) {
  write(img, setupAddrs(s), clip.items[0]);
  for (let g = 0; g < 16; g++) fixLinks(img, s, g);
}

const SIZES = { controls: 15, group: 244, setup: 3908 };

export function encodeClip(clip) {
  return JSON.stringify({ lilypad: 1, kind: clip.kind, from: clip.from, items: clip.items.map(toHex) });
}
// Returns a clip, or null if the text isn't a Lilypad clipboard.
export function decodeClip(text) {
  try {
    const o = JSON.parse(text);
    if (o?.lilypad !== 1 || !SIZES[o.kind] || !Array.isArray(o.items) || !o.items.length) return null;
    const items = o.items.map(fromHex);
    if (items.some((b) => b.length !== SIZES[o.kind]) || (o.kind !== 'controls' && items.length !== 1)) return null;
    return { kind: o.kind, from: String(o.from || ''), items };
  } catch {
    return null;
  }
}

// ---- which fields apply to a control (the RULES), for multi-select and fill

export function fieldApplies(img, s, g, i, kind, field) {
  if (field === 'name') return true;
  if (kind === 'enc') {
    const r = M.encoderRules(M.readEncoder(img, s, g, i), i);
    if (field === 'type' || field === 'channel' || field === 'scale') return true;
    if (field === 'lower' || field === 'upper') return r.lower.enabled;
    return !!r[field]?.enabled;
  }
  const r = M.pushRules(M.readPush(img, s, g, i), i);
  if (field === 'type') return true;
  return !!r[field]?.enabled;
}

export function readField(img, s, g, i, kind, field) {
  if (field === 'name') return M.readEncoder(img, s, g, i).name;
  const c = kind === 'enc' ? M.readEncoder(img, s, g, i) : M.readPush(img, s, g, i);
  if (field === 'numberHigh') return Math.min(c.numberHigh, 127);
  return c[field];
}

export function setField(img, s, g, i, kind, field, value) {
  if (kind === 'enc' || field === 'name') M.setEncoder(img, s, g, i, field, value);
  else M.setPush(img, s, g, i, field, value);
}

// Sets one field on every target it applies to. Returns how many controls it applied to.
export function applyField(img, s, g, targets, kind, field, value) {
  let n = 0;
  for (const i of targets) {
    if (!fieldApplies(img, s, g, i, kind, field)) continue;
    setField(img, s, g, i, kind, field, value);
    n++;
  }
  return n;
}

// Ascending values in control order, starting from the first target's value, wrapping
// (channels 1–16, numbers 0–127). Controls the field doesn't apply to are skipped.
// Returns how many controls were filled.
export function fill(img, s, g, targets, kind, field) {
  const order = [...targets].sort((a, b) => a - b).filter((i) => fieldApplies(img, s, g, i, kind, field));
  if (!order.length) return 0;
  const wrap = field === 'channel' ? 16 : 128;
  const start = readField(img, s, g, order[0], kind, field);
  order.forEach((i, k) => setField(img, s, g, i, kind, field, (start + k) % wrap));
  return order.length;
}

// Where an address lives, for showing what an undo touched.
export function locate(addr) {
  if (addr >= M.A.DATA && addr < M.A.KEY2) {
    const n = Math.floor((addr - M.A.DATA) / 192);
    const off = (addr - M.A.DATA) % 192;
    return { setup: n >> 4, group: n & 15, index: off < 128 ? off % 16 : Math.floor((off - 128) / 4) };
  }
  if (addr >= M.A.KEY2) {
    const n = Math.floor((addr - M.A.KEY2) / 32);
    return { setup: n >> 4, group: n & 15, index: (addr - M.A.KEY2) % 16 };
  }
  if (addr >= M.A.KEY1 && addr < M.A.KEY1 + 4096) {
    const n = Math.floor((addr - M.A.KEY1) / 16);
    return { setup: n >> 4, group: n & 15, index: (addr - M.A.KEY1) % 16 };
  }
  if (addr >= M.A.GROUP_NAMES && addr < M.A.DATA) {
    const n = Math.floor((addr - M.A.GROUP_NAMES) / 4);
    return { setup: n >> 4, group: n & 15 };
  }
  if (addr >= M.A.SETUP_NAMES && addr < M.A.GROUP_NAMES) return { setup: (addr - M.A.SETUP_NAMES) >> 2 };
  return { globals: true };
}
