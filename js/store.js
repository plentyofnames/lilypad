// The editor's 64 KB image, which 64-byte pages of it hold real data, and two baselines:
// what the device holds (for diff writes) and what the open file held (for "unsaved").

import { SIZE, PAGE, NPAGES, writable } from './model.js';

export class Baseline {
  constructor() {
    this.data = new Uint8Array(SIZE).fill(0xFF);
    this.valid = new Uint8Array(NPAGES);
  }
  clear() {
    this.data.fill(0xFF);
    this.valid.fill(0);
  }
  set(addr, bytes) {
    this.data.set(bytes, addr);
    // Only whole pages count as known.
    for (let p = addr >> 6; p <= (addr + bytes.length - 1) >> 6; p++) {
      if (p * PAGE >= addr && (p + 1) * PAGE <= addr + bytes.length) this.valid[p] = 1;
    }
  }
}

export class Store {
  constructor() {
    this.img = new Uint8Array(SIZE).fill(0xFF);
    this.valid = new Uint8Array(NPAGES); // pages of img holding real data
    this.dev = new Baseline();
    this.file = new Baseline();
    this.fileInfo = null; // {name, header, padding, full}
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  changed(what = {}) {
    for (const fn of this.listeners) fn(what);
  }

  hasPages(pages) {
    return pages.every((p) => this.valid[p]);
  }
  missingPages(pages) {
    return pages.filter((p) => !this.valid[p]);
  }

  clear() {
    this.img.fill(0xFF);
    this.valid.fill(0);
    this.dev.clear();
    this.file.clear();
    this.fileInfo = null;
  }

  // Data read from the device: always the new device baseline; it becomes editor
  // data only where the editor has none (so pending edits and file data survive).
  fromDevice(addr, bytes) {
    this.dev.set(addr, bytes);
    for (let p = addr >> 6; p <= (addr + bytes.length - 1) >> 6; p++) {
      if (!this.valid[p]) {
        this.img.set(bytes.subarray(p * PAGE - addr, (p + 1) * PAGE - addr), p * PAGE);
        this.valid[p] = 1;
      }
    }
  }

  // A confirmed device write: those bytes are now on the device.
  written(addr, bytes) {
    this.dev.data.set(bytes, addr);
  }

  // File pages replace editor data and become the file baseline.
  fromFile(pages) {
    for (const p of pages) {
      this.img.set(p.data, p.addr);
      this.file.set(p.addr, p.data);
      for (let q = p.addr >> 6; q <= (p.addr + p.data.length - 1) >> 6; q++) this.valid[q] = 1;
    }
  }

  markSaved(start, end) {
    this.file.set(start, this.img.subarray(start, end));
  }

  // Pages with editor data but no device baseline (must be read before diffing).
  pagesWithoutDeviceBase() {
    const out = [];
    for (let p = 0; p < NPAGES; p++) if (this.valid[p] && !this.dev.valid[p] && pageWritable(p)) out.push(p);
    return out;
  }

  // Diff against the device: runs of changed writable bytes, split at 64-byte page boundaries.
  deviceChunks() {
    return diffChunks(this.img, this.dev.data, (p) => this.valid[p] && this.dev.valid[p]);
  }
  deviceDirtyBytes() {
    let n = 0;
    for (const c of this.deviceChunks()) n += c.data.length;
    return n;
  }
  isDeviceDirty(addr) {
    const p = addr >> 6;
    return writable(addr) && this.valid[p] && (!this.dev.valid[p] || this.img[addr] !== this.dev.data[addr]);
  }
  isFileDirty(addr) {
    const p = addr >> 6;
    return this.valid[p] && this.file.valid[p] && this.img[addr] !== this.file.data[addr];
  }
  fileDirtyBytes() {
    let n = 0;
    for (let p = 0; p < NPAGES; p++) {
      if (!this.valid[p] || !this.file.valid[p]) continue;
      for (let a = p * PAGE; a < (p + 1) * PAGE; a++) if (this.img[a] !== this.file.data[a]) n++;
    }
    return n;
  }

  // Throws away edits: back to the device data (connected) or the file data.
  revert(toDevice) {
    const base = toDevice ? this.dev : this.file;
    for (let p = 0; p < NPAGES; p++) {
      if (!this.valid[p]) continue;
      if (base.valid[p]) this.img.set(base.data.subarray(p * PAGE, (p + 1) * PAGE), p * PAGE);
      else if (toDevice) {
        this.img.fill(0xFF, p * PAGE, (p + 1) * PAGE);
        this.valid[p] = 0;
      }
    }
  }
}

function pageWritable(p) {
  for (let a = p * PAGE; a < (p + 1) * PAGE; a++) if (writable(a)) return true;
  return false;
}

export function diffChunks(img, base, pageOk) {
  const out = [];
  for (let p = 0; p < NPAGES; p++) {
    if (!pageOk(p)) continue;
    const end = (p + 1) * PAGE;
    let a = p * PAGE;
    while (a < end) {
      if (img[a] === base[a] || !writable(a)) {
        a++;
        continue;
      }
      const start = a;
      while (a < end && img[a] !== base[a] && writable(a)) a++;
      out.push({ addr: start, data: img.slice(start, a) });
    }
  }
  return out;
}
