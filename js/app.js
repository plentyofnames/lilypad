// Lilypad UI.

import * as M from './model.js';
import { Store } from './store.js';
import { Device } from './device.js';
import { TouchFilter } from './touch.js';
import * as B from './bulk.js';
import { History } from './history.js';
import { MockDevice, imageFromSetupsOnly } from './mock.js';
import { demoImage } from './demo.js';
import { midiAccess, midiPermission, portPairs, midiTransport } from './midi.js';
import { parseContainer, containerFromImage, defaultHeader, TYPE_ALL_SETUPS, STOCK_PADDING } from './syx.js';
import { hexdump, PAGE } from './proto.js';
import { h, $, replace, download, modal } from './dom.js';

const MOCK_KEY = 'lilypad-mock-eeprom';
const PREFS_KEY = 'lilypad-prefs';
const READ_MS = 32; // one 64-byte READ round trip on the 31250-baud link

class Cancelled extends Error {}

const S = {
  store: new Store(),
  sel: { setup: 0, group: 0, kind: 'enc', index: 0, multi: null }, // multi: Set of indices when several are selected
  view: 'group', // 'group' | 'globals'
  conn: null, // {dev, kind, name, info}
  devState: null, // {setup, group} as last reported by the device
  mock: null,
  job: null,
  queued: 0,
  loading: new Set(),
  message: null,
  log: [],
  flash: null,
  prefs: {
    follow: true, moveDevice: false, autoWrite: false, mockSpeed: 'real', showLog: false, showMock: true,
    autoConnect: false, // reconnect to lastPort on load: set by connecting to a real unit, cleared by Disconnect
    lastPort: '',
    seenIntro: false, // the full About text shows on the start screen until Lilypad has been used once
  },
  waitingFor: null, // port name to reconnect to when it is plugged in
};

try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
  if (saved) {
    Object.assign(S.prefs, saved);
    if (!('seenIntro' in saved)) S.prefs.seenIntro = true; // saved prefs from before: used already
  }
} catch {}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(S.prefs));
  } catch {}
}

S.history = new History(S.store.img);
const CLIP_KEY = 'lilypad-clipboard';

const dialog = () => $('#dialog');
const img = () => S.store.img;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ------------------------------------------------------------------ messages and log

function say(text, kind = 'info') {
  S.message = { text, kind, t: Date.now() };
  renderStatus();
}
function showError(e) {
  if (e instanceof Cancelled || e.name === 'AbortError') return say('Cancelled.');
  if (e.message === 'device closed') return; // disconnected on purpose; the reason is already shown
  console.error(e);
  say(e.message || String(e), 'error');
}

function logLine(dir, bytes, note) {
  const t = (performance.now() / 1000).toFixed(3).padStart(9);
  const arrow = dir === 'tx' ? '→' : dir === 'rx' ? '←' : '·';
  S.log.push(`${t} ${arrow} ${(note || '').padEnd(44)}${bytes ? ' | ' + hexdump(bytes, 24) : ''}`);
  if (S.log.length > 4000) S.log.splice(0, S.log.length - 4000);
  if (S.prefs.showLog) scheduleLogRender();
}

// The log with a header, for pasting into a bug report.
async function copyLog() {
  const c = S.conn;
  const info = c?.info ? `${c.name}: fw ${c.info.fwMajor}.${c.info.fwMinor}, protocol ${c.info.proto}, ${c.info.eepromKb} KB, chunk ${c.info.maxChunk}` : c ? c.name + ' (no IDENTIFY reply)' : 'not connected';
  const text = [
    `Lilypad log, ${new Date().toISOString()}`,
    `target: ${$('#target').value} · ${info}`,
    `browser: ${navigator.userAgent}`,
    `device state: ${S.devState ? `setup ${S.devState.setup + 1} group ${S.devState.group + 1}` : '?'} · ${S.log.length} lines (times in s)`,
    '',
    ...S.log,
  ].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    say(`Copied ${S.log.length} log lines to the clipboard.`, 'ok');
  } catch {
    download(new TextEncoder().encode(text), `ec4_editor_log_${today()}.txt`);
    say('Clipboard not available: saved the log as a file.');
  }
}
let logTimer = 0;
function scheduleLogRender() {
  if (logTimer) return;
  logTimer = setTimeout(() => {
    logTimer = 0;
    renderLog();
  }, 100);
}

// ------------------------------------------------------------------ jobs (one at a time)

let chain = Promise.resolve();
function job(label, fn) {
  S.queued++;
  const run = async () => {
    S.queued--;
    const j = { label, done: 0, total: 0, t0: performance.now(), cancelled: false };
    S.job = j;
    renderAll();
    try {
      return await fn(j);
    } finally {
      S.job = null;
      renderAll();
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

let progressTimer = 0;
function progress() {
  if (progressTimer) return;
  progressTimer = setTimeout(() => {
    progressTimer = 0;
    renderStatus();
    renderSidebar();
    if (S.view === 'group' && !groupReady()) renderMain();
  }, 120);
}

function checkJob(j) {
  if (j.cancelled) throw new Cancelled();
  if (!S.conn) throw new Error('Device disconnected.');
}

async function readPages(j, pages, after, keepGoing = () => true) {
  j.total += pages.length;
  for (const p of pages) {
    checkJob(j);
    if (!keepGoing()) return false;
    const data = await S.conn.dev.read(p * PAGE, PAGE);
    S.store.fromDevice(p * PAGE, data);
    j.done++;
    after?.(p);
    progress();
  }
  return true;
}

// ------------------------------------------------------------------ navigation and lazy reads

const groupPages = (s, g) => M.pagesOf(M.groupRanges(s, g));
const setupPages = (s) => M.pagesOf(M.setupRanges(s));
const groupReady = (s = S.sel.setup, g = S.sel.group) => S.store.hasPages(groupPages(s, g));
const setupReady = (s) => S.store.hasPages(setupPages(s));

function go(setup, group, { kind, index, fromDevice = false } = {}) {
  const moved = setup !== S.sel.setup || group !== S.sel.group;
  S.sel.setup = setup;
  S.sel.group = group;
  if (kind) S.sel.kind = kind;
  if (index !== undefined) S.sel.index = index;
  if (moved || index !== undefined) S.sel.multi = null;
  S.view = 'group';
  ensureSetup(setup, group);
  if (moved && !fromDevice && S.prefs.moveDevice && S.conn && S.conn.info) {
    S.conn.dev.select(setup, group).catch(showError);
  }
  renderAll();
}

function ensureSetup(s, gFirst = 0) {
  if (!S.conn || !S.conn.info || S.loading.has(s)) return;
  const all = setupPages(s);
  if (S.store.hasPages(all)) return;
  S.loading.add(s);
  const first = groupPages(s, gFirst);
  const order = [...first, ...all.filter((p) => !first.includes(p))];
  job(`Reading setup ${s + 1}`, async (j) => {
    try {
      // Lazy reads stop when the user moves to another setup; what was read stays cached.
      const stillWanted = () => s === S.sel.setup;
      if (!stillWanted()) return;
      const done = await readPages(j, S.store.missingPages(order), () => {
        if (s === S.sel.setup && groupReady()) renderMain();
      }, stillWanted);
      if (done) say(`Read setup ${s + 1} (${M.setupName(img(), s).trim()}) in ${((performance.now() - j.t0) / 1000).toFixed(1)} s.`);
    } finally {
      S.loading.delete(s);
    }
  }).catch(showError);
}

// ------------------------------------------------------------------ dirty state

function isDirty(addr) {
  const st = S.store;
  const p = addr >> 6;
  if (!st.valid[p]) return false;
  if (S.conn || !st.fileInfo) return st.dev.valid[p] && M.writable(addr) && st.img[addr] !== st.dev.data[addr];
  return st.file.valid[p] && st.img[addr] !== st.file.data[addr];
}
function rangesDirty(ranges) {
  for (const [a, n] of ranges) for (let k = 0; k < n; k++) if (isDirty(a + k)) return true;
  return false;
}
const controlDirty = (s, g, i) => M.controlAddrs(s, g, i).some(isDirty);

function pendingSummary() {
  const st = S.store;
  if (S.conn) return { bytes: st.deviceDirtyBytes(), unknown: st.pagesWithoutDeviceBase().length, to: 'device' };
  if (st.fileInfo) return { bytes: st.fileDirtyBytes(), unknown: 0, to: 'file' };
  return { bytes: st.deviceDirtyBytes(), unknown: 0, to: 'stale' };
}

function edited() {
  S.store.changed();
  scheduleRender();
  if (S.prefs.autoWrite && S.conn) scheduleAutoWrite();
}

// Rendering runs just after the event that caused it: a change event fired by Tab has to let
// the focus reach the next field first, so the redraw can keep it there. (A timer, not
// requestAnimationFrame, which stops in background tabs.)
let renderPending = 0;
function scheduleRender() {
  if (!renderPending) renderPending = setTimeout(() => {
    renderPending = 0;
    renderAll();
  }, 0);
}

let autoTimer = 0;
function scheduleAutoWrite() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => writeChanges({ quiet: true }).catch(showError), 600);
}

// ------------------------------------------------------------------ connection

async function getMock() {
  if (S.mock) return S.mock;
  let image = null;
  try {
    const b64 = localStorage.getItem(MOCK_KEY);
    if (b64) image = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (image && image.length !== M.SIZE) image = null;
  } catch {}
  setMock(image ?? demoImage());
  return S.mock;
}

function imageFromContainer(c) {
  const out = new Uint8Array(M.SIZE).fill(0xFF);
  for (const p of c.pages) out.set(p.data, p.addr);
  return c.pages[0].addr === 0 ? out : imageFromSetupsOnly(out);
}

let mockSaveTimer = 0;
function setMock(image) {
  const old = S.mock;
  S.mock = new MockDevice(image, { speed: S.prefs.mockSpeed });
  if (old && S.conn?.kind === 'mock') disconnect(true);
  S.mock.onUpdate((what) => {
    if (what === 'eeprom') {
      clearTimeout(mockSaveTimer);
      mockSaveTimer = setTimeout(saveMock, 300);
    }
    renderMock();
  });
  saveMock();
  renderMock();
}
function saveMock() {
  try {
    let s = '';
    const e = S.mock.eeprom;
    for (let i = 0; i < e.length; i += 0x1000) s += String.fromCharCode(...e.subarray(i, i + 0x1000));
    localStorage.setItem(MOCK_KEY, btoa(s));
  } catch {}
}

async function refreshPorts() {
  const sel = $('#midiport');
  try {
    const acc = await midiAccess();
    const pairs = portPairs(acc);
    const prev = sel.value;
    replace(sel, pairs.length ? pairs.map((p) => h('option', { value: p.name }, p.name)) : h('option', { value: '' }, 'no MIDI ports'));
    if (pairs.some((p) => p.name === prev)) sel.value = prev;
    acc.onstatechange = () => refreshPorts().then(portsChanged).catch(() => {});
    return pairs;
  } catch (e) {
    replace(sel, h('option', { value: '' }, 'WebMIDI unavailable'));
    throw e;
  }
}

// auto: a reconnect Lilypad starts by itself (on load or replug). It gives up sooner when
// there's no reply and never takes the unit away from another Lilypad tab.
async function connect({ auto = false } = {}) {
  if (S.conn) return auto ? undefined : disconnect();
  const target = $('#target').value;
  S.waitingFor = null;
  let transport;
  try {
    if (target === 'mock') {
      transport = (await getMock()).transport();
    } else {
      if (auto && (await otherTabHasUnit())) {
        return say('Another Lilypad tab is connected to the EC4, so this one stays offline. Press Connect to take it over.');
      }
      if (!auto) await takeOverUnit();
      const pairs = await refreshPorts();
      const pair = pairs.find((p) => p.name === $('#midiport').value) || pairs[0];
      if (!pair) throw new Error('No MIDI port pair found. Is the EC4 plugged in?');
      transport = midiTransport(pair.in, pair.out);
    }
  } catch (e) {
    return showError(e);
  }

  // What to do with data already in the editor.
  const st = S.store;
  if (st.valid.some((v) => v)) {
    const pend = st.fileInfo || st.deviceDirtyBytes() > 0;
    let choice = null;
    if (pend) {
      const what = st.fileInfo ? `data from ${st.fileInfo.name}` : 'changes that were never written';
      choice = await modal(dialog(), {
        title: 'Editor already has data',
        body: h('p', {}, `The editor holds ${what}. Keep it as changes to write to ${transport.name}? The device is read first, so only bytes that differ get written.`),
        buttons: [
          { label: 'Cancel', value: null },
          { label: 'Discard, read from device', value: 'discard' },
          { label: 'Keep as changes', value: 'keep', primary: true },
        ],
      });
      if (!choice) return transport.close();
      if (choice === 'discard') st.clear();
      else st.dev.clear();
    } else st.clear();
    if (choice !== 'keep') S.history.clear();
  }

  const dev = new Device(transport, { log: logLine });
  S.conn = { dev, kind: target, name: transport.name, info: null, auto };
  dev.addEventListener('state', onDeviceState);
  dev.addEventListener('touch', onDeviceTouch);
  dev.addEventListener('deviceerror', (e) => say(`Device reported error ${e.detail.code} for command 0x${e.detail.cmd.toString(16)}`, 'error'));
  // No reply: during a DUMP_ALL the device ignores requests, so the client keeps retrying.
  dev.addEventListener('waiting', (e) => {
    if (e.detail.done) {
      if (S.message?.waiting) say('The device is answering again.');
      return;
    }
    const s = Math.round(e.detail.elapsedMs / 1000);
    const why = S.conn?.info ? 'the device may be busy with a dump' : 'the device may be busy with a dump, or controlfrog is not running on it';
    say(`No reply for ${s} s (${why}); retrying for up to ${S.conn?.auto && !S.conn.info ? 'a few seconds' : '75 s'}. Cancel or Disconnect to stop.`, 'error');
    S.message.waiting = true;
  });
  say(`Connecting to ${transport.name}…`);
  renderAll();
  try {
    const info = await dev.identify(auto ? { busyMs: 4000 } : {});
    if (info.proto !== 1) throw new Error(`${transport.name} speaks protocol ${info.proto}; this editor speaks 1.`);
    if (info.maxChunk < 64 || info.eepromKb < 64) throw new Error(`Unexpected device limits (EEPROM ${info.eepromKb} KB, chunk ${info.maxChunk}).`);
    S.conn.info = info;
    S.devState = await dev.getState();
    await dev.touchEvents(true);
    await job('Reading names and globals', (j) => readPages(j, S.store.missingPages([M.GLOBALS_PAGE, M.SETUP_NAMES_PAGE])));
    say(`${auto ? 'Reconnected' : 'Connected'} to ${transport.name}: firmware ${info.fwMajor}.${info.fwMinor}, protocol ${info.proto}.`, 'ok');
    if (target === 'midi') Object.assign(S.prefs, { autoConnect: true, lastPort: transport.name });
    S.prefs.seenIntro = true;
    savePrefs();
    go(S.devState.setup, S.devState.group, { fromDevice: true });
  } catch (e) {
    const msg = e.name === 'TimeoutError' || /no reply/.test(e.message)
      ? `No reply from ${transport.name}. Is the controlfrog firmware running on it?${auto ? ' Press Connect to try again.' : ''}` : e.message;
    disconnect(true);
    say(msg, 'error');
  }
}

async function disconnect(force = false) {
  if (!S.conn) return;
  const conn = S.conn;
  if (!force && conn.info) {
    const n = S.store.deviceDirtyBytes();
    if (n) {
      const ok = await modal(dialog(), {
        title: 'Unwritten changes',
        body: h('p', {}, `${plural(n, 'changed byte')} ${n === 1 ? 'is' : 'are'} not on the device yet. They stay in the editor; you can save them as .syx or write them after reconnecting.`),
        buttons: [{ label: 'Stay connected', value: false }, { label: 'Disconnect', value: true, primary: true }],
      });
      if (!ok) return;
    }
    if (S.job) S.job.cancelled = true;
    try {
      await Promise.race([conn.dev.touchEvents(false), sleep(500)]);
    } catch {}
  }
  if (S.job) S.job.cancelled = true;
  conn.dev.close();
  S.conn = null;
  S.devState = null;
  if (!force) {
    S.waitingFor = null;
    if (conn.kind === 'midi' && S.prefs.autoConnect) {
      S.prefs.autoConnect = false; // the user disconnected: don't reconnect on the next load
      savePrefs();
    }
  }
  renderAll();
  if (!force) say('Disconnected.');
}

// ---- reconnecting, and one Lilypad tab per unit
//
// The unit answers every program that has its port open, so two connected tabs would see each
// other's replies (the protocol allows one host at a time). Tabs agree over a BroadcastChannel:
// a reconnect waits for no other tab to hold the unit, Connect takes it over.

const TAB = Math.random().toString(36).slice(2);
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('lilypad') : null;
const replies = [];
if (channel) {
  channel.onmessage = (e) => {
    const m = e.data || {};
    if (m.from === TAB) return;
    const holding = S.conn?.kind === 'midi';
    if (m.type === 'query' && holding) channel.postMessage({ type: 'holding', from: TAB, to: m.from });
    if (m.type === 'take' && holding) {
      S.waitingFor = null;
      disconnect(true); // no TOUCH_EVENTS off: the other tab is about to switch them on
      say('Another Lilypad tab took over the EC4. Press Connect to take it back.', 'error');
      channel.postMessage({ type: 'released', from: TAB, to: m.from });
    }
    if (m.to === TAB) replies.push(m);
  };
}

async function askTabs(type, ms = 250) {
  if (!channel) return [];
  replies.length = 0;
  channel.postMessage({ type, from: TAB });
  await sleep(ms);
  return replies.splice(0);
}
const otherTabHasUnit = async () => (await askTabs('query')).some((m) => m.type === 'holding');
const takeOverUnit = () => askTabs('take');

// On load: reconnect to the unit Lilypad was last connected to, if Chrome already allows MIDI.
async function reconnectOnLoad() {
  if (!S.prefs.autoConnect || !S.prefs.lastPort) return;
  $('#target').value = 'midi';
  renderAll();
  if ((await midiPermission()) !== 'granted') return say(`Press Connect to reconnect to ${S.prefs.lastPort}.`);
  const pairs = await refreshPorts().catch(() => []);
  if (!pairs.some((p) => p.name === S.prefs.lastPort)) {
    S.waitingFor = S.prefs.lastPort;
    renderAll();
    return say(`Waiting for ${S.prefs.lastPort}: Lilypad reconnects when it is plugged in.`);
  }
  $('#midiport').value = S.prefs.lastPort;
  connect({ auto: true });
}

// A MIDI port came or went: notice an unplugged unit, reconnect a returning one.
function portsChanged(pairs) {
  const c = S.conn;
  if (c?.kind === 'midi' && c.dev.transport.output?.state === 'disconnected') {
    S.waitingFor = c.name;
    disconnect(true);
    say(`${c.name} was unplugged. Lilypad reconnects when it is back.`, 'error');
  }
  if (S.waitingFor && !S.conn && S.prefs.autoConnect && pairs.some((p) => p.name === S.waitingFor)) {
    $('#target').value = 'midi';
    $('#midiport').value = S.waitingFor;
    connect({ auto: true });
  }
}

function onDeviceState(e) {
  const { setup, group, solicited } = e.detail;
  S.devState = { setup, group };
  if (!solicited && S.prefs.follow) go(setup, group, { fromDevice: true });
  else renderAll();
}

const touchFilter = new TouchFilter();

function onDeviceTouch(e) {
  const { kind, index, setup, group } = e.detail;
  if (index > 15 || setup > 15 || group > 15) return;
  S.devState = { setup, group };
  S.flash = { kind: kind ? 'push' : 'enc', index, t: performance.now() };
  const target = touchFilter.decide(S.sel, e.detail, performance.now()); // null: a twist while pushing
  if (S.prefs.follow && target) go(setup, group, { kind: target, index, fromDevice: true });
  else renderAll();
  setTimeout(() => {
    if (S.flash && performance.now() - S.flash.t >= 590) {
      S.flash = null;
      document.querySelectorAll('.cell.flash').forEach((c) => c.classList.remove('flash'));
    }
  }, 600);
}

// ------------------------------------------------------------------ device actions

async function writeChanges({ quiet = false } = {}) {
  if (!S.conn?.info) return;
  return job('Writing to device', async (j) => {
    const st = S.store;
    const unknown = st.pagesWithoutDeviceBase();
    if (unknown.length) {
      j.label = `Reading ${plural(unknown.length, 'page')} to compare`;
      await readPages(j, unknown);
    }
    const chunks = st.deviceChunks();
    if (!chunks.length) {
      if (!quiet) say('Nothing to write: the device already has these settings.', 'ok');
      return;
    }
    const bytes = chunks.reduce((n, c) => n + c.data.length, 0);
    j.label = `Writing ${plural(bytes, 'byte')}`;
    j.total += chunks.length;
    const t0 = performance.now();
    let done = 0;
    let err = null;
    for (const c of chunks) {
      try {
        checkJob(j);
        const was = Array.from(st.dev.data.subarray(c.addr, c.addr + c.data.length), (b) => b.toString(16).padStart(2, '0')).join(' ');
        logLine('note', null, `0x${c.addr.toString(16).toUpperCase().padStart(4, '0')} was: ${was}`);
        await S.conn.dev.write(c.addr, c.data);
        st.written(c.addr, c.data);
        done++;
        j.done++;
        progress();
      } catch (e) {
        err = e;
        break;
      }
    }
    if (done && S.conn) {
      j.label = 'Reloading';
      S.devState = await S.conn.dev.reload();
    }
    if (err) throw err;
    say(`Wrote ${plural(bytes, 'byte')} in ${plural(chunks.length, 'message')} (${((performance.now() - t0) / 1000).toFixed(1)} s); device reloaded.`, 'ok');
  });
}

async function rereadSetup() {
  if (!S.conn?.info) return;
  const s = S.sel.setup;
  const pages = [...setupPages(s), M.SETUP_NAMES_PAGE];
  if (rangesDirty(M.setupRanges(s))) {
    const ok = await modal(dialog(), {
      title: `Re-read setup ${s + 1}`,
      body: h('p', {}, 'This setup has changes that are not on the device. Re-reading discards them.'),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Discard and re-read', value: true, danger: true }],
    });
    if (!ok) return;
  }
  for (const p of pages) {
    S.store.valid[p] = 0;
    S.store.dev.valid[p] = 0;
  }
  S.history.clear();
  // The shared names page holds other setups' names too: keep their edits.
  const names = img().slice(M.A.SETUP_NAMES, M.A.SETUP_NAMES + 64);
  await job(`Re-reading setup ${s + 1}`, (j) => readPages(j, pages)).catch(showError);
  if (S.store.valid[M.SETUP_NAMES_PAGE]) {
    for (let k = 0; k < 64; k++) if (k >> 2 !== s) img()[M.A.SETUP_NAMES + k] = names[k];
  }
  renderAll();
}

async function readEverything(range = [0, M.NPAGES]) {
  if (!S.conn?.info) return false;
  const missing = [];
  for (let p = range[0]; p < range[1]; p++) if (!S.store.valid[p]) missing.push(p);
  if (!missing.length) return true;
  await job(`Reading ${missing.length} pages`, (j) => readPages(j, missing));
  say(`Read ${missing.length} pages.`, 'ok');
  return S.store.hasPages(missing);
}

async function dumpAllBackup() {
  if (!S.conn?.info) return;
  const ok = await modal(dialog(), {
    title: 'Full backup with DUMP_ALL',
    body: h('p', {}, 'The device sends its whole 64 KB EEPROM in the Faderfox container. This takes about 67 s on the real unit, and the device answers nothing else meanwhile. The file is saved as it arrives, without touching the editor.'),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Start', value: true, primary: true }],
  });
  if (!ok) return;
  await job('DUMP_ALL (≈67 s)', async (j) => {
    j.total = 67;
    const tick = setInterval(() => {
      j.done = Math.min(66, (performance.now() - j.t0) / 1000);
      renderStatus();
    }, 500);
    try {
      const raw = await S.conn.dev.dumpAll();
      const c = parseContainer(raw);
      if (c.badPages.length) throw new Error(`Dump arrived with ${c.badPages.length} bad page checksums.`);
      // The device sends no STATE events during a dump: catch up.
      if (S.conn) S.devState = await S.conn.dev.getState();
      await saveBytes(raw, `EC4_eeprom_full_${today()}.syx`);
      say(`Saved full dump (${c.pages.length} pages).`, 'ok');
    } finally {
      clearInterval(tick);
    }
  }).catch(showError);
}

// ------------------------------------------------------------------ files

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function saveBytes(bytes, name) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'SysEx', accept: { 'application/octet-stream': ['.syx'] } }] });
      const w = await handle.createWritable();
      await w.write(bytes);
      await w.close();
      return handle.name;
    } catch (e) {
      if (e.name === 'AbortError') throw new Cancelled();
      if (e.name !== 'SecurityError' && e.name !== 'NotAllowedError') throw e;
    }
  }
  download(bytes, name);
  return name;
}

async function openFile(file) {
  let c;
  try {
    c = parseContainer(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    return say(`${file.name}: ${e.message}`, 'error');
  }
  if (c.badPages.length) return say(`${file.name}: ${c.badPages.length} pages have bad checksums; not loaded.`, 'error');
  const st = S.store;
  const full = c.pages[0].addr === 0 && c.pages.length === M.NPAGES;
  const kind = full ? 'full EEPROM dump' : c.header[2] === TYPE_ALL_SETUPS ? 'all setups' : 'one setup';
  if (S.conn) {
    const ok = await modal(dialog(), {
      title: `Open ${file.name}`,
      body: h('p', {}, `Load this ${kind} file into the editor? Its settings become changes to write to the device (only differing bytes are written, after reading the device to compare).`),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Load', value: true, primary: true }],
    });
    if (!ok) return;
  } else if (pendingSummary().bytes) {
    const ok = await modal(dialog(), {
      title: `Open ${file.name}`,
      body: h('p', {}, 'The editor has unsaved changes. Discard them?'),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Discard', value: true, danger: true }],
    });
    if (!ok) return;
    st.clear();
  } else st.clear();
  st.file.clear();
  S.history.clear();
  st.fromFile(c.pages);
  st.fileInfo = { name: file.name, header: { ...c.header }, padding: c.padding, full, kind };
  if (!S.prefs.seenIntro) {
    S.prefs.seenIntro = true;
    savePrefs();
  }
  st.changed();
  say(`Opened ${file.name}: ${kind}, ${c.pages.length} pages.`, 'ok');
  go(S.sel.setup, S.sel.group);
}

async function saveSyx(full) {
  const st = S.store;
  const [start, end] = full ? [0, M.SIZE] : [M.A.SETUPS_START, M.SIZE];
  const pages = [];
  for (let p = start >> 6; p < end >> 6; p++) pages.push(p);
  let missing = st.missingPages(pages);
  if (missing.length) {
    if (!S.conn?.info) return say(full ? 'A full dump needs all 64 KB, and the editor does not have it. Open a full dump or connect.' : 'Not all setups are loaded.', 'error');
    const ok = await modal(dialog(), {
      title: full ? 'Save full dump' : 'Save all setups',
      body: h('p', {}, `${missing.length} pages have not been read from the device yet. Read them now? About ${Math.ceil((missing.length * READ_MS) / 1000)} s.`),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Read and save', value: true, primary: true }],
    });
    if (!ok) return;
    try {
      if (!(await readEverything([start >> 6, end >> 6]))) return;
    } catch (e) {
      return showError(e);
    }
  }
  const info = st.fileInfo;
  const header = info ? { ...info.header, 2: TYPE_ALL_SETUPS } : defaultHeader();
  const padding = full ? (info?.full ? info.padding : 0) : STOCK_PADDING;
  const bytes = containerFromImage(st.img, start, end, { header, padding });
  const name = info && info.full === full && info.kind !== 'one setup' ? info.name : `EC4_${full ? 'eeprom_full' : 'all_setups'}_${today()}.syx`;
  try {
    const saved = await saveBytes(bytes, name);
    st.markSaved(start, end);
    if (!info) st.fileInfo = { name: saved, header, padding, full, kind: full ? 'full EEPROM dump' : 'all setups' };
    say(`Saved ${saved} (${bytes.length} bytes${full ? '' : ', loadable with the stock Receive menu'}).`, 'ok');
  } catch (e) {
    showError(e);
  }
  renderAll();
}

async function discardChanges() {
  const pend = pendingSummary();
  if (!pend.bytes && !pend.unknown) return;
  const ok = await modal(dialog(), {
    title: 'Discard changes',
    body: h('p', {}, S.conn ? 'Throw away all changes that are not on the device?' : 'Throw away all changes since the file was opened or saved?'),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Discard', value: true, danger: true }],
  });
  if (!ok) return;
  S.store.revert(!!S.conn || !S.store.fileInfo);
  S.history.clear();
  if (S.conn) S.store.fileInfo = null; // the editor now holds device data, not the file
  edited();
  ensureSetup(S.sel.setup, S.sel.group);
  say('Changes discarded.');
}

// ------------------------------------------------------------------ rendering

function renderAll() {
  renderToolbar();
  renderSidebar();
  renderMain();
  renderInspector();
  renderStatus();
  renderMock();
}

function renderToolbar() {
  const c = S.conn;
  const busy = !!S.job;
  const pend = pendingSummary();
  $('#connect').textContent = c ? 'Disconnect' : 'Connect';
  $('#target').disabled = !!c;
  $('#midiport').hidden = $('#target').value !== 'midi';
  $('#midiport').disabled = !!c;
  const info = c?.info;
  const chip = $('#devinfo');
  chip.className = 'chip ' + (info ? 'on' : c ? 'wait' : '');
  chip.textContent = info ? `${c.name} · fw ${info.fwMajor}.${info.fwMinor} · protocol ${info.proto}` : c ? 'connecting…' : S.store.fileInfo ? 'offline · ' + S.store.fileInfo.name : 'offline';
  chip.title = info ? `EEPROM ${info.eepromKb} KB, max chunk ${info.maxChunk} bytes` : '';
  const w = $('#write');
  w.disabled = !info || busy || (!pend.bytes && !pend.unknown);
  w.textContent = info && pend.unknown ? `Write (compare ${plural(pend.unknown, 'page')})` : info && pend.bytes ? `Write ${plural(pend.bytes, 'byte')}` : 'Write';
  $('#reread').disabled = !info || busy;
  $('#readall').disabled = !info || busy || S.store.valid.every((v) => v);
  $('#dumpall').disabled = !info || busy;
  $('#discard').disabled = busy || (!pend.bytes && !pend.unknown);
  $('#undo').disabled = !S.history.canUndo;
  $('#redo').disabled = !S.history.canRedo;
  const allSetups = S.store.hasPages(range(M.A.SETUPS_START >> 6, M.NPAGES));
  const all = S.store.valid.every((v) => v);
  $('#save').disabled = busy || (!allSetups && !info);
  $('#savefull').disabled = busy || (!all && !info);
  document.body.classList.toggle('connected', !!info);
}

function range(a, b) {
  return Array.from({ length: b - a }, (_, k) => a + k);
}

function renderSidebar() {
  const st = S.store;
  const namesOk = st.valid[M.SETUP_NAMES_PAGE];
  const items = [];
  items.push(h('button', { class: 'side-globals' + (S.view === 'globals' ? ' sel' : ''), onclick: () => ((S.view = 'globals'), renderAll()) },
    h('span', { class: 'ico' }, '⚙'), 'Device settings', rangesDirty([[0, 7]]) ? h('span', { class: 'dot' }) : null));
  for (let s = 0; s < 16; s++) {
    const ready = setupReady(s);
    const loading = S.loading.has(s);
    const selected = s === S.sel.setup;
    const dev = S.devState?.setup === s;
    const status = loading ? h('span', { class: 'spin', title: 'reading' }) : ready ? h('span', { class: 'st ok', title: 'loaded' }) : h('span', { class: 'st', title: S.conn ? 'not read yet' : 'no data' });
    const name = namesOk ? M.setupName(st.img, s) : '····';
    const row = h('div', { class: 'setup' + (selected ? ' open' : '') },
      h('button', { class: 'setup-row' + (selected && S.view === 'group' ? ' sel' : ''), onclick: () => go(s, selected ? S.sel.group : st.valid[M.GLOBALS_PAGE] ? img()[M.A.LAST_GROUP + s] & 15 : 0), title: `Setup ${s + 1}` },
        h('span', { class: 'num' }, s + 1), h('span', { class: 'nm' }, name), status,
        rangesDirty([[M.setupNameAddr(s), 4], ...M.setupRanges(s)]) ? h('span', { class: 'dot' }) : null,
        dev ? h('span', { class: 'devmark', title: 'the device is on this setup' }, '◂') : null));
    if (selected) {
      const groups = h('div', { class: 'groups' });
      const namesReady = st.valid[M.A.GROUP_NAMES + s * 64 >> 6];
      for (let g = 0; g < 16; g++) {
        const gsel = g === S.sel.group && S.view === 'group';
        groups.append(h('button', { class: 'group-row' + (gsel ? ' sel' : ''), onclick: () => go(s, g) },
          h('span', { class: 'num' }, g + 1), h('span', { class: 'nm' }, namesReady ? M.groupName(st.img, s, g) : '····'),
          rangesDirty(M.groupRanges(s, g)) ? h('span', { class: 'dot' }) : null,
          dev && S.devState.group === g ? h('span', { class: 'devmark', title: 'the device is on this group' }, '◂') : null));
      }
      row.append(groups);
    }
    items.push(row);
  }
  replace($('#setups'), items);
}

function renderMain() {
  const main = $('#main');
  if (S.view === 'globals') return replace(main, globalsView());
  const st = S.store;
  const { setup: s, group: g } = S.sel;
  if (!st.valid.some((v) => v) && !S.conn) return replace(main, welcome());
  const ready = groupReady();
  const head = h('div', { class: 'group-head' },
    h('div', { class: 'crumb' },
      h('label', {}, 'Setup ', h('b', {}, s + 1)),
      nameInput('setupname', st.valid[M.SETUP_NAMES_PAGE] ? M.readName(st.img, M.setupNameAddr(s)) : '', (v) => edit(() => M.writeName(img(), M.setupNameAddr(s), v), { key: 'setupname' + s, label: 'setup name' }), !st.valid[M.SETUP_NAMES_PAGE], `SE${String(s).padStart(2, '0')}`),
      h('label', {}, 'Group ', h('b', {}, g + 1)),
      nameInput('groupname', ready ? M.readName(st.img, M.groupNameAddr(s, g)) : '', (v) => edit(() => M.writeName(img(), M.groupNameAddr(s, g), v), { key: `groupname${s}/${g}`, label: 'group name' }), !ready, `GR${String(g).padStart(2, '0')}`)),
    h('div', { class: 'nav' },
      h('button', { class: 'small', title: 'previous group', onclick: () => go(s, (g + 15) % 16) }, '‹'),
      h('button', { class: 'small', title: 'next group', onclick: () => go(s, (g + 1) % 16) }, '›'),
      S.conn?.info ? h('button', { class: 'small', title: 'show this group on the device (SELECT)', onclick: () => S.conn.dev.select(s, g).catch(showError) }, 'Show on device') : null));
  if (!ready) {
    const reading = S.loading.has(s);
    const msg = reading ? `Reading setup ${s + 1} from the device…`
      : S.conn?.info ? `Setup ${s + 1} has not been read yet. `
      : S.conn ? 'Connecting…' : 'No data for this setup. Open a .syx file or connect to a device.';
    const retry = !reading && S.conn?.info ? h('button', { class: 'small', onclick: () => ensureSetup(s, g) }, 'Read it now') : null;
    return replace(main, head, h('div', { class: 'grid placeholder' }, range(0, 16).map(() => h('div', { class: 'cell ghost' }))), h('p', { class: 'hint center' }, msg, retry));
  }
  // The cells are built before they go into the page, so focus in a box survives the redraw.
  replace(main, head, h('div', { id: 'groupbar', class: 'groupbar' }, groupBarItems()), h('div', { class: 'grid', id: 'grid' }, gridCells()), legend());
}

function legend() {
  return h('p', { class: 'hint' }, 'Click a box to select it; Shift-click selects a range, ⌘/Ctrl-click adds or removes one. ',
    'The fields in a box edit that control; the side panel edits everything selected. Arrow keys move, Space switches Turn/Push, ⌘C/⌘V copy and paste, ⌘Z undoes. ',
    S.conn ? 'Turning or pushing a control on the device selects it here.' : '');
}

// ---- selection

const selected = () => (S.sel.multi && S.sel.multi.size > 1 ? [...S.sel.multi].sort((a, b) => a - b) : [S.sel.index]);

// Updates the selection without rebuilding the grid (an open dropdown in a box stays open).
function setSelection(index, multi = null, kind = S.sel.kind) {
  const kindChanged = kind !== S.sel.kind;
  Object.assign(S.sel, { index, multi: multi && multi.size > 1 ? multi : null, kind });
  if (kindChanged) return renderAll();
  paintSelection();
  renderGroupBar();
  renderInspector();
}

function paintSelection() {
  const sel = new Set(selected());
  for (const c of document.querySelectorAll('#grid .cell')) {
    const i = Number(c.dataset.i);
    c.classList.toggle('sel', sel.has(i));
    c.classList.toggle('focus', i === S.sel.index && sel.size > 1);
  }
}

function selectControl(kind, i) {
  setSelection(i, null, kind);
}

function selectAll() {
  setSelection(S.sel.index, new Set(range(0, 16)));
}

// Mouse down in a box: plain = this one, Shift = range from the last plain click, ⌘/Ctrl = toggle.
// A click into a field of the box selects that box alone.
function cellPointer(ev, i) {
  if (ev.button !== 0) return;
  const inField = ev.target.closest('input, select, button');
  if (inField) {
    if (S.sel.index !== i || selected().length > 1) setSelection(i);
    return;
  }
  if (ev.shiftKey || ev.metaKey || ev.ctrlKey) {
    ev.preventDefault(); // no text selection; and leave any field, so ⌘C copies controls
    document.activeElement?.blur?.();
  }
  if (ev.shiftKey) {
    const [a, b] = [Math.min(S.sel.index, i), Math.max(S.sel.index, i)];
    setSelection(S.sel.index, new Set(range(a, b + 1)));
  } else if (ev.metaKey || ev.ctrlKey) {
    const set = new Set(selected());
    if (set.has(i) && set.size > 1) set.delete(i);
    else set.add(i);
    setSelection(set.has(i) ? i : [...set][0], set);
  } else setSelection(i);
}

// ---- the 16 boxes

const ENC_SHORT = M.ENC_TYPES.map((t, v) => ({ value: v, label: t.short }));
const PUSH_SHORT = M.PUSH_TYPES.map((t, v) => ({ value: v, label: t.short }));

function cellNum(key, value, min, max, onCommit, disabled, title) {
  const el = numField(key, value, min, max, onCommit, disabled);
  el.className = 'cn';
  if (title) el.title = title;
  return el;
}
function cellSelect(key, options, value, onCommit, disabled, title) {
  const el = selectField(key, options, value, onCommit, disabled);
  el.className = 'cs';
  if (title) el.title = title;
  return el;
}

function encCell(s, g, i, e) {
  const r = M.encoderRules(e, i);
  const set = (field) => (v) => edit(() => M.setEncoder(img(), s, g, i, field, v), { label: `encoder ${i + 1} ${field}` });
  const k = (f) => `c${i}:${f}`;
  let number;
  if (r.numberHigh.enabled) {
    number = [cellNum(k('msb'), Math.min(e.numberHigh, 127), 0, 127, set('numberHigh'), false, 'NRPN MSB'), h('span', { class: 'sep' }, ':'),
      cellNum(k('num'), e.number, 0, 127, set('number'), false, 'NRPN LSB')];
  } else {
    number = [cellNum(k('num'), Math.min(e.number, r.number.max), 0, r.number.max, set('number'), !r.number.enabled, r.number.enabled ? `${r.number.label} 0–${r.number.max}` : `not used by ${M.ENC_TYPES[e.type].short}`),
      r.number.kind === 'note' ? h('span', { class: 'note' }, M.noteName(e.number)) : null];
  }
  const lu = r.lower;
  return [
    h('div', { class: 'frow' }, cellSelect(k('type'), ENC_SHORT, e.type, set('type'), false, M.ENC_TYPES[e.type].label), cellSelect(k('ch'), channelOptions('ch '), e.channel, set('channel'), false, 'MIDI channel')),
    h('div', { class: 'frow' + (r.number.enabled ? '' : ' off') }, h('span', { class: 'fl' }, r.numberHigh.enabled ? 'NRPN' : r.number.kind === 'note' ? 'Note' : '#'), number),
    h('div', { class: 'frow' + (lu.enabled ? '' : ' off') },
      cellNum(k('lo'), e.lower, 0, lu.max, set('lower'), !lu.enabled, lu.enabled ? `Lower ${lu.hires ? '0–4094, 16383' : '0–127'}` : `not used by ${M.ENC_TYPES[e.type].short}`),
      h('span', { class: 'sep' }, '–'),
      cellNum(k('hi'), e.upper, 0, lu.max, set('upper'), !lu.enabled, lu.enabled ? `Upper ${lu.hires ? '0–4094, 16383' : '0–127'}` : '')),
  ];
}

function pushCell(s, g, i, p) {
  const r = M.pushRules(p, i);
  const set = (field) => (v) => edit(() => M.setPush(img(), s, g, i, field, v), { label: `push ${i + 1} ${field}` });
  const k = (f) => `c${i}:p${f}`;
  const types = p.valid ? PUSH_SHORT : [...PUSH_SHORT, { value: p.type, label: `? ${p.type}` }];
  const chOpts = r.channel.kind === 'group' ? channelOptions('grp ') : r.channel.kind === 'setup' ? channelOptions('set ') : channelOptions('ch ');
  return [
    h('div', { class: 'frow' }, cellSelect(k('type'), types, p.type, set('type'), false, p.valid ? M.PUSH_TYPES[p.type].label : 'invalid type'),
      cellSelect(k('ch'), chOpts, p.channel, set('channel'), !r.channel.enabled, r.channel.label)),
    h('div', { class: 'frow' + (r.number.enabled ? '' : ' off') }, h('span', { class: 'fl' }, r.number.kind === 'note' ? 'Note' : '#'),
      cellNum(k('num'), p.number, 0, 127, set('number'), !r.number.enabled, r.number.label),
      r.number.kind === 'note' && r.number.enabled ? h('span', { class: 'note' }, M.noteName(p.number)) : null,
      r.mode.enabled ? h('span', { class: 'pmode' }, M.PUSH_MODES[p.mode].short) : null),
    h('div', { class: 'frow' + (r.lower.enabled ? '' : ' off') },
      cellNum(k('lo'), p.lower, 0, 127, set('lower'), !r.lower.enabled, 'Lower 0–127'), h('span', { class: 'sep' }, '–'),
      cellNum(k('hi'), p.upper, 0, 127, set('upper'), !r.upper.enabled, 'Upper 0–127')),
  ];
}

function gridCells() {
  const { setup: s, group: g, kind } = S.sel;
  const sel = new Set(selected());
  return range(0, 16).map((i) => {
    const e = M.readEncoder(img(), s, g, i);
    const p = M.readPush(img(), s, g, i);
    const flash = S.flash && S.flash.index === i ? ' flash flash-' + S.flash.kind : '';
    const enc = kind === 'enc';
    const linked = enc ? e.link && i < 15 : p.link && i < 15;
    const other = enc
      ? h('button', { class: 'other', title: 'Show the push buttons', onclick: () => setSelection(i, null, 'push') }, h('span', { class: 'pico' }, '●'), ' ', M.pushSummary(p))
      : h('button', { class: 'other', title: 'Show the encoders', onclick: () => setSelection(i, null, 'enc') }, h('span', { class: 'pico' }, '◎'), ' ', M.encoderSummary(e));
    return h('div', {
      class: `cell ${enc ? 'tc' + e.type : 'tp'}` + (sel.has(i) ? ' sel' : '') + (sel.size > 1 && i === S.sel.index ? ' focus' : '') + flash + (controlDirty(s, g, i) ? ' dirty' : ''),
      dataset: { i: String(i) },
      onmousedown: (ev) => cellPointer(ev, i),
    },
      h('div', { class: 'line1' }, h('span', { class: 'idx' }, i + 1),
        nameInput(`c${i}:name`, e.name, (v) => edit(() => M.setEncoder(img(), s, g, i, 'name', v), { key: `name${s}/${g}/${i}`, label: `name of control ${i + 1}` }), false, '----'),
        linked ? h('span', { class: 'link', title: `linked to the next ${enc ? 'encoder' : 'push button'}` }, '⟶') : null),
      enc ? encCell(s, g, i, e) : pushCell(s, g, i, p),
      other);
  });
}

function renderGrid() {
  const grid = $('#grid');
  if (grid && groupReady()) replace(grid, gridCells());
}

// ---- the bar above the grid: Turn/Push, copy, paste, fill

function renderGroupBar() {
  const bar = $('#groupbar');
  if (bar) replace(bar, groupBarItems());
}

function menu(label, items, title) {
  return h('details', { class: 'menu', title },
    h('summary', {}, label),
    h('div', { class: 'menu-pop' }, items.map(([text, onclick, disabled, hint]) =>
      h('button', { disabled, onclick: (ev) => {
        ev.target.closest('details').open = false;
        onclick();
      } }, text, hint ? h('span', { class: 'kbd' }, hint) : null))));
}

function groupBarItems() {
  const { setup: s, group: g, kind, index } = S.sel;
  const sel = selected();
  const what = kind === 'enc' ? 'encoder' : 'push button';
  const many = sel.length > 1;
  const clip = getClip();
  const pasteText = !clip ? ['Clipboard is empty', () => {}, true]
    : clip.kind === 'controls' ? [`Paste ${clip.items.length === 1 ? 'control' : clip.items.length + ' controls'} into ${clip.items.length === 1 && many ? sel.length + ' selected' : 'control ' + (sel[0] + 1)}`, () => doPaste(clip), false, '⌘V']
    : clip.kind === 'group' ? [`Paste group (from ${clip.from}) over group ${g + 1}`, () => doPaste(clip), false, '⌘V']
    : [`Paste setup (from ${clip.from}) over setup ${s + 1}`, () => doPaste(clip), !setupReady(s), '⌘V'];
  const fillWhere = many ? `across the ${sel.length} selected` : index === 0 ? 'across the group' : `from ${what} ${index + 1} on`;
  return [
    h('div', { class: 'seg', title: 'Edit encoders (turn) or push buttons (Space)' },
      h('button', { class: kind === 'enc' ? 'on' : '', onclick: () => setSelection(index, S.sel.multi, 'enc') }, 'Turn'),
      h('button', { class: kind === 'push' ? 'on' : '', onclick: () => setSelection(index, S.sel.multi, 'push') }, 'Push')),
    h('span', { class: 'selinfo' }, many ? `${sel.length} ${what}s selected` : `${what[0].toUpperCase() + what.slice(1)} ${index + 1}`),
    menu('Copy', [
      [many ? `Copy ${sel.length} controls` : `Copy control ${index + 1}`, () => doCopy('controls'), false, '⌘C'],
      [`Copy group ${g + 1}`, () => doCopy('group')],
      [`Copy setup ${s + 1}`, () => doCopy('setup'), !setupReady(s)],
    ], 'Copy controls (encoder, push button and name), the group or the setup'),
    menu('Paste', [pasteText], 'Paste what was copied, in this tab or another Lilypad tab'),
    menu('Fill', [
      [`Fill channels ascending ${fillWhere}`, () => doFill('channel')],
      [`Fill numbers ascending ${fillWhere}`, () => doFill('number')],
    ], `Count up from the first ${what}'s value, like the unit's Fill menu`),
    h('button', { class: 'small', onclick: () => (many ? setSelection(index) : selectAll()), title: '⌘A selects all, Esc selects one' }, many ? 'Select one' : 'Select all'),
  ];
}

// ---- copy, paste, fill

function getClip() {
  try {
    const c = B.decodeClip(localStorage.getItem(CLIP_KEY) || '');
    if (c) return c;
  } catch {}
  return S.clip || null;
}
function setClip(clip, text = B.encodeClip(clip)) {
  S.clip = clip;
  try {
    localStorage.setItem(CLIP_KEY, text);
  } catch {}
}

function makeClip(kind) {
  const { setup: s, group: g } = S.sel;
  if (kind === 'setup' && !setupReady(s)) return say(`Setup ${s + 1} isn't fully read yet; copy it when it is.`, 'error'), null;
  return kind === 'controls' ? B.copyControls(img(), s, g, selected()) : kind === 'group' ? B.copyGroup(img(), s, g) : B.copySetup(img(), s);
}
function describeClip(clip) {
  return clip.kind === 'controls' ? (clip.items.length === 1 ? 'a control' : `${clip.items.length} controls`) : clip.kind === 'group' ? `group (${clip.from})` : `setup (${clip.from})`;
}

function doCopy(kind) {
  const clip = makeClip(kind);
  if (!clip) return;
  const text = B.encodeClip(clip);
  setClip(clip, text);
  navigator.clipboard?.writeText(text).catch(() => {});
  say(`Copied ${describeClip(clip)}.`, 'ok');
  renderGroupBar();
}

function doPaste(clip) {
  const { setup: s, group: g } = S.sel;
  if (S.view !== 'group' || !groupReady()) return;
  if (clip.kind === 'setup' && !setupReady(s)) return say(`Setup ${s + 1} isn't fully read yet; paste when it is.`, 'error');
  let what;
  edit(() => {
    if (clip.kind === 'controls') {
      const done = B.pasteControls(img(), s, g, selected(), clip);
      what = done.length === 1 ? `control ${done[0] + 1}` : `controls ${done.map((i) => i + 1).join(', ')}`;
    } else if (clip.kind === 'group') {
      B.pasteGroup(img(), s, g, clip);
      what = `group ${g + 1}`;
    } else {
      B.pasteSetup(img(), s, clip);
      what = `setup ${s + 1}`;
    }
  }, { label: 'paste' });
  say(what ? `Pasted ${describeClip(clip)} into ${what}. ⌘Z undoes it.` : 'Nothing changed: the clipboard matches.', 'ok');
}

function doFill(field) {
  const { setup: s, group: g, kind, index } = S.sel;
  const sel = selected();
  const targets = sel.length > 1 ? sel : range(index, 16);
  let n = 0;
  edit(() => (n = B.fill(img(), s, g, targets, kind, field)), { label: `fill ${field}s` });
  const what = field === 'channel' ? 'channels' : 'numbers';
  say(n ? `Filled ${what} of ${plural(n, kind === 'enc' ? 'encoder' : 'push button')}. ⌘Z undoes it.` : `No selected ${kind === 'enc' ? 'encoder' : 'push button'} uses ${what}.`, n ? 'ok' : 'error');
}

// ---- undo / redo

function undoRedo(redo) {
  const step = redo ? S.history.redo() : S.history.undo();
  if (!step) return;
  S.store.changed();
  const where = B.locate(step.changes.keys().next().value);
  if (where.globals) S.view = 'globals';
  else if (where.setup !== undefined && where.group !== undefined && (where.setup !== S.sel.setup || where.group !== S.sel.group || S.view !== 'group')) {
    go(where.setup, where.group, where.index !== undefined ? { index: where.index } : {});
  }
  say(`${redo ? 'Redid' : 'Undid'} ${step.label || 'edit'}.`);
  scheduleRender();
  if (S.prefs.autoWrite && S.conn) scheduleAutoWrite();
}

// ---- inspector

// Names are stored padded to 4 characters; the box shows them without the padding and
// selects the whole name on focus, so typing replaces it.
function nameInput(key, value, onInput, disabled, placeholder) {
  return h('input', {
    type: 'text', class: 'name', maxlength: 4, spellcheck: false, value: value.replace(/ +$/, ''), placeholder, disabled, dataset: { key },
    title: 'Up to 4 characters: A–Z a–z 0–9 space . / -',
    onfocus: (ev) => {
      const el = ev.target;
      if (el.dataset.restoring) return;
      el.select();
      el.dataset.justFocused = '1';
    },
    onmouseup: (ev) => {
      if (ev.target.dataset.justFocused) ev.preventDefault(); // keep the selection from the focus
      delete ev.target.dataset.justFocused;
    },
    onkeydown: (ev) => delete ev.target.dataset.justFocused,
    onblur: (ev) => delete ev.target.dataset.justFocused,
    oninput: (ev) => {
      const el = ev.target;
      const clean = [...el.value].filter((c) => M.NAME_CHARS.test(c)).join('').slice(0, 4);
      if (clean !== el.value) el.value = clean;
      onInput(clean);
    },
  });
}

// Every change to the settings goes through here: one undo step each. Edits with the same
// key in quick succession (typing a name) are one step.
function edit(fn, { key = null, label = '' } = {}) {
  if (S.history.record(fn, { key, label })) edited();
}

function numField(key, value, min, max, onCommit, disabled) {
  return h('input', {
    type: 'number', class: 'num', min, max, step: 1, value: String(value), disabled, dataset: { key },
    onchange: (ev) => {
      let v = Math.round(Number(ev.target.value));
      if (!Number.isFinite(v)) v = value;
      onCommit(Math.max(min, Math.min(max, v)));
    },
  });
}

function selectField(key, options, value, onCommit, disabled) {
  return h('select', { dataset: { key }, disabled, onchange: (ev) => ev.target.value !== '' && onCommit(Number(ev.target.value)) },
    options.map((o) => h('option', { value: String(o.value), selected: o.value === value }, o.label)));
}

function row(label, control, { enabled = true, hint, note } = {}) {
  return h('div', { class: 'row' + (enabled ? '' : ' disabled') },
    h('label', {}, label),
    h('div', { class: 'ctl' }, control, hint ? h('span', { class: 'hint' }, hint) : null),
    note ? h('div', { class: 'note' }, note) : null);
}

const channelOptions = (prefix = '') => range(0, 16).map((c) => ({ value: c, label: `${prefix}${c + 1}` }));

function noteControl(key, value, onCommit, disabled) {
  return h('span', { class: 'pair' },
    numField(key, value, 0, 127, onCommit, disabled),
    selectField(key + '-n', range(0, 128).map((n) => ({ value: n, label: M.noteName(n) })), value, onCommit, disabled));
}

function renderInspector() {
  const el = $('#inspector');
  if (S.view !== 'group' || !groupReady()) return replace(el, h('div', { class: 'insp-empty' }, S.view === 'globals' ? 'Global settings apply to the whole unit.' : ''));
  const { setup: s, group: g, index: i, kind } = S.sel;
  const tabs = h('div', { class: 'tabs' },
    h('button', { class: kind === 'enc' ? 'on' : '', onclick: () => setSelection(i, S.sel.multi, 'enc') }, 'Encoder'),
    h('button', { class: kind === 'push' ? 'on' : '', onclick: () => setSelection(i, S.sel.multi, 'push') }, 'Push button'));
  const sel = selected();
  if (sel.length > 1) {
    return replace(el,
      h('div', { class: 'insp-title' }, h('span', { class: 'big' }, `${sel.length} ${kind === 'enc' ? 'encoders' : 'push buttons'}`), h('span', { class: 'where' }, `Setup ${s + 1} · Group ${g + 1}`)),
      tabs,
      h('p', { class: 'hint' }, `Controls ${sel.map((x) => x + 1).join(', ')}. A change here applies to every selected control that uses the field.`),
      h('div', { class: 'fields' }, multiFields(s, g, sel, kind)));
  }
  const e = M.readEncoder(img(), s, g, i);
  const title = h('div', { class: 'insp-title' },
    h('span', { class: 'big' }, `${kind === 'enc' ? 'Encoder' : 'Push'} ${i + 1}`),
    h('span', { class: 'where' }, `Setup ${s + 1} · Group ${g + 1}`));
  const nameRow = row('Name', nameInput('encname', e.name.trimEnd(), (v) => edit(() => M.setEncoder(img(), s, g, i, 'name', v), { key: `name${s}/${g}/${i}`, label: `name of control ${i + 1}` }), false, '----'),
    { hint: kind === 'push' ? 'shared with the encoder' : '' });
  const body = kind === 'enc' ? encoderFields(s, g, i, e) : pushFields(s, g, i);
  replace(el, title, tabs, h('div', { class: 'fields' }, nameRow, body), addrInfo(s, g, i));
}

// Side panel for several controls: a shared value, or "mixed".
function multiFields(s, g, targets, kind) {
  const im = img();
  const opts = (list, fmt) => list.map((t, v) => ({ value: v, label: fmt(t) }));
  const specs = kind === 'enc'
    ? [['name', 'Name', 'text'], ['type', 'Type', opts(M.ENC_TYPES, (t) => `${t.short} — ${t.label}`)], ['channel', 'Channel', channelOptions()],
      ['number', 'Number', 'num'], ['numberHigh', 'NRPN MSB', 'num'], ['lower', 'Lower', 'num'], ['upper', 'Upper', 'num'],
      ['scale', 'Display', opts(M.SCALES, (t) => t.label)], ['mode', 'Mode', opts(M.MODES, (t) => `${t.short} — ${t.label}`)], ['link', 'Link', 'check']]
    : [['name', 'Name', 'text'], ['type', 'Type', opts(M.PUSH_TYPES, (t) => `${t.short} — ${t.label}`)], ['channel', 'Channel', channelOptions()],
      ['number', 'Number', 'num'], ['mode', 'Mode', opts(M.PUSH_MODES, (t) => t.label)], ['display', 'Display', [{ value: 0, label: 'Off' }, { value: 1, label: 'On' }]],
      ['lower', 'Lower', 'num'], ['upper', 'Upper', 'num'], ['link', 'Link', 'check']];
  return specs.map(([field, label, ctl]) => {
    const apply = targets.filter((i) => B.fieldApplies(im, s, g, i, kind, field));
    if (field === 'numberHigh' && !apply.length) return null; // only when the selection has NRPN
    const values = apply.map((i) => B.readField(im, s, g, i, kind, field));
    const same = values.length > 0 && values.every((v) => v === values[0]);
    const enabled = apply.length > 0;
    const set = (v) => edit(() => B.applyField(img(), s, g, targets, kind, field, v),
      { key: field === 'name' ? `mname${s}/${g}/${targets.join()}` : null, label: `${label.toLowerCase()} of ${plural(apply.length, 'control')}` });
    const key = 'm:' + field;
    let control;
    if (ctl === 'text') control = nameInput(key, same ? values[0] : '', set, !enabled, 'mixed');
    else if (ctl === 'check') {
      control = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: same && !!values[0], indeterminate: !same && enabled, disabled: !enabled, dataset: { key }, onchange: (ev) => set(ev.target.checked ? 1 : 0) }), same ? '' : 'mixed');
    } else if (ctl === 'num') {
      const hires = kind === 'enc' && (field === 'lower' || field === 'upper') && apply.some((i) => M.readEncoder(im, s, g, i).hires);
      control = numField(key, same ? values[0] : '', 0, hires ? M.HIRES_MAX : 127, set, !enabled);
      if (!same) control.placeholder = 'mixed';
    } else control = selectField(key, same ? ctl : [{ value: '', label: '— mixed —' }, ...ctl], same ? values[0] : '', set, !enabled);
    const hint = !enabled ? 'not used by the selected controls' : apply.length < targets.length ? `used by ${apply.length} of ${targets.length}` : '';
    return row(label, control, { enabled, hint });
  });
}

function encoderFields(s, g, i, e) {
  const r = M.encoderRules(e, i);
  const set = (field) => (v) => edit(() => M.setEncoder(img(), s, g, i, field, v), { label: `encoder ${i + 1} ${field}` });
  const out = [];
  const warn = [];
  if (e.rawType !== e.type) warn.push(`stored type ${e.rawType} is invalid; the EC4 uses ${M.ENC_TYPES[e.type].short}`);
  if (e.rawMode !== e.mode) warn.push(`stored mode ${e.rawMode} is invalid; the EC4 uses ${M.MODES[e.mode].short}`);
  if (e.rawScale !== e.scale) warn.push(`stored display ${e.rawScale} is invalid; the EC4 uses ${M.SCALES[e.scale].short}`);
  out.push(row('Type', selectField('type', M.ENC_TYPES.map((t, v) => ({ value: v, label: `${t.short} — ${t.label}` })), e.type, set('type'))));
  out.push(row('Channel', selectField('channel', channelOptions(), e.channel, set('channel'))));
  if (r.numberHigh.enabled) {
    out.push(row('NRPN MSB', numField('numberHigh', Math.min(e.numberHigh, 127), 0, 127, set('numberHigh')), { hint: '0–127 (CC 99)' }));
    out.push(row('NRPN LSB', numField('number', e.number, 0, 127, set('number')),
      { hint: `0–127 (CC 98) · NRPN ${Math.min(e.numberHigh, 127) * 128 + e.number}` }));
  } else if (r.number.kind === 'note') {
    out.push(row('Note', noteControl('number', e.number, set('number'))));
  } else {
    out.push(row(r.number.enabled ? r.number.label : 'Number', numField('number', Math.min(e.number, r.number.max), 0, r.number.max, set('number'), !r.number.enabled),
      { enabled: r.number.enabled, hint: r.number.enabled ? `0–${r.number.max}` : `not used by ${M.ENC_TYPES[e.type].short}` }));
  }
  const lu = r.lower;
  const luHint = !lu.enabled ? `not used by ${M.ENC_TYPES[e.type].short}` : lu.hires ? '0–4094, 16383' : '0–127';
  out.push(row('Lower', numField('lower', e.lower, 0, lu.max, set('lower'), !lu.enabled), { enabled: lu.enabled, hint: luHint }));
  out.push(row('Upper', numField('upper', e.upper, 0, lu.max, set('upper'), !lu.enabled), { enabled: lu.enabled, hint: lu.enabled ? luHint : '',
    note: lu.enabled && lu.hires ? '14-bit range: 0–4094, or 16383 for the maximum.' : null }));
  const scaleNote = e.type === M.T.CCAH || e.type === M.T.PBND || e.type === M.T.NRPN
    ? `With ${M.ENC_TYPES[e.type].short}, display off / 1000 / ±500 / 9999 give 14-bit lower/upper; the others 7-bit.` : null;
  out.push(row('Display', selectField('scale', M.SCALES.map((t, v) => ({ value: v, label: t.label })), e.scale, set('scale')), { note: scaleNote }));
  out.push(row('Mode', selectField('mode', M.MODES.map((t, v) => ({ value: v, label: `${t.short} — ${t.label}` })), e.mode, set('mode'), !r.mode.enabled),
    { enabled: r.mode.enabled, hint: r.mode.enabled ? '' : 'not used by Note' }));
  out.push(row('Link', h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!e.link && r.link.enabled, disabled: !r.link.enabled, dataset: { key: 'link' }, onchange: (ev) => set('link')(ev.target.checked ? 1 : 0) }),
    r.link.enabled ? `send together with encoder ${i + 2}` : 'not available on encoder 16'), { enabled: r.link.enabled }));
  if (warn.length) out.push(h('div', { class: 'warn' }, warn.join('; ') + '.'));
  return out;
}

function pushFields(s, g, i) {
  const p = M.readPush(img(), s, g, i);
  const r = M.pushRules(p, i);
  const set = (field) => (v) => edit(() => M.setPush(img(), s, g, i, field, v), { label: `push ${i + 1} ${field}` });
  const out = [];
  const types = M.PUSH_TYPES.map((t, v) => ({ value: v, label: `${t.short} — ${t.label}` }));
  if (!p.valid) types.push({ value: p.type, label: `invalid (${p.type})` });
  out.push(row('Type', selectField('ptype', types, p.type, set('type'))));
  const why = (en) => (en ? '' : `not used by ${p.valid ? M.PUSH_TYPES[p.type].short : 'this type'}`);
  const chOpts = r.channel.kind === 'group' ? channelOptions('Group ') : r.channel.kind === 'setup' ? channelOptions('Setup ') : channelOptions();
  out.push(row(r.channel.label, selectField('pchannel', chOpts, p.channel, set('channel'), !r.channel.enabled), { enabled: r.channel.enabled, hint: why(r.channel.enabled) }));
  if (r.number.kind === 'note' && r.number.enabled) out.push(row('Note', noteControl('pnumber', p.number, set('number'))));
  else out.push(row(r.number.label, numField('pnumber', p.number, 0, 127, set('number'), !r.number.enabled), { enabled: r.number.enabled, hint: r.number.enabled ? '0–127' : why(false) }));
  out.push(row('Mode', selectField('pmode', M.PUSH_MODES.map((t, v) => ({ value: v, label: t.label })), p.mode, set('mode'), !r.mode.enabled), { enabled: r.mode.enabled, hint: why(r.mode.enabled) }));
  out.push(row('Display', selectField('pdisplay', [{ value: 0, label: 'Off' }, { value: 1, label: 'On' }], p.display, set('display'), !r.display.enabled), { enabled: r.display.enabled, hint: why(r.display.enabled) }));
  out.push(row('Lower', numField('plower', p.lower, 0, 127, set('lower'), !r.lower.enabled), { enabled: r.lower.enabled, hint: r.lower.enabled ? '0–127' : why(false) }));
  out.push(row('Upper', numField('pupper', p.upper, 0, 127, set('upper'), !r.upper.enabled), { enabled: r.upper.enabled, hint: r.upper.enabled ? '0–127' : '' }));
  out.push(row('Link', h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!p.link && r.link.enabled, disabled: !r.link.enabled, dataset: { key: 'plink' }, onchange: (ev) => set('link')(ev.target.checked ? 1 : 0) }),
    r.link.enabled ? `send together with push ${i + 2}` : 'not available on push button 16'), { enabled: r.link.enabled }));
  return out;
}

function addrInfo(s, g, i) {
  const d = M.dataBase(s, g);
  const changed = controlDirty(s, g, i);
  return h('details', { class: 'addr' },
    h('summary', {}, 'EEPROM bytes', changed ? h('span', { class: 'dot' }) : null),
    h('table', {}, [
      ['type/channel', d + i], ['link/number', d + 16 + i], ['NRPN MSB', d + 32 + i], ['lower', d + 48 + i], ['upper', d + 64 + i],
      ['mode/display', d + 80 + i], ['upper/lower MSB', d + 96 + i], ['push type/ch', d + 112 + i], ['name', d + 128 + i * 4],
      ['push mode/number', M.key1Base(s, g) + i], ['push display/lower', M.key2Base(s, g) + i], ['push link/upper', M.key2Base(s, g) + 16 + i],
    ].map(([n, a]) => h('tr', { class: isDirty(a) ? 'chg' : '' }, h('td', {}, n), h('td', {}, '0x' + a.toString(16).toUpperCase().padStart(4, '0')),
      h('td', {}, n === 'name' ? Array.from(img().subarray(a, a + 4), (b) => b.toString(16).padStart(2, '0')).join(' ') : img()[a].toString(16).padStart(2, '0'))))));
}

// ---- globals

function globalsView() {
  const st = S.store;
  const ok = st.valid[M.GLOBALS_PAGE];
  const g = M.readGlobals(st.img);
  const set = (f) => (v) => edit(() => M.setGlobal(img(), f, v), { label: 'device setting' });
  const rows = [];
  rows.push(h('h2', {}, 'Device settings'));
  if (!ok) {
    rows.push(h('p', { class: 'hint' }, S.conn ? 'Reading…' : 'Stock "all setups" files start at 0x0B00 and hold no global settings. Connect to the device or open a full EEPROM dump to edit them.'));
    return h('div', { class: 'globals' }, rows);
  }
  const routing = M.ROUTING.map((r) => ({ value: r.value, label: `${r.short} — ${r.label}` }));
  if (!M.ROUTING.some((r) => r.value === g.routing)) routing.push({ value: g.routing, label: `stored ${g.routing} (the EC4 loads ≥ 7 as 5)` });
  rows.push(row('MIDI routing', selectField('routing', routing, g.routing, set('routing')), { hint: 'what the EC4 forwards between its ports' }));
  rows.push(row('Brightness', h('span', { class: 'pair' },
    h('input', { type: 'range', min: 0, max: 255, value: String(g.brightness), dataset: { key: 'brightness' }, onchange: (ev) => set('brightness')(ev.target.value), oninput: (ev) => (ev.target.nextSibling.textContent = `${Math.round((ev.target.value * 100) / 255)} % (${ev.target.value})`) }),
    h('span', { class: 'hint' }, `${Math.round((g.brightness * 100) / 255)} % (${g.brightness})`))));
  const ss = [{ value: 100, label: 'Off (S00)' }, ...range(1, 100).map((m) => ({ value: m, label: `${m} min` }))];
  const ssVal = g.screensaver >= 1 && g.screensaver <= 100 ? g.screensaver : 100;
  rows.push(row('Screensaver', selectField('screensaver', ss, ssVal, set('screensaver')), { hint: g.screensaver !== ssVal ? `stored ${g.screensaver} loads as off` : '' }));
  rows.push(row('Note numbers', selectField('noteView', [{ value: 0, label: 'as numbers' }, { value: 1, label: 'as note names' }], g.noteView ? 1 : 0, set('noteView')), { hint: 'how Note controls show their number' }));
  // Firmware 0.10 added this byte; older controlfrog versions and the stock firmware ignore it.
  const fw = S.conn?.info;
  if (fw && (fw.fwMajor > 0 || fw.fwMinor >= 10)) {
    rows.push(row('Group change', h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: g.sendValues, dataset: { key: 'sendValues' }, onchange: (ev) => set('sendValues')(ev.target.checked ? 1 : 0) }),
      'Send values on group change'),
    { note: 'When the group or setup changes (on the unit, by a Grp/Set push button, or from Lilypad with Move device), the unit sends the new group\'s current values, like Num + push 16.' }));
  }
  rows.push(row('Value pop-up', selectField('popup', [0, 1, 2].map((v) => ({ value: v, label: `style ${v}` })), Math.min(g.popup, 2), set('popup')),
    { hint: 'pop-up in Name mode; set on the unit with Shift + Name / Bar / Num (factory: 2)' }));
  rows.push(h('h3', {}, 'Device state (read only)'));
  rows.push(h('p', { class: 'hint' }, `Last setup ${g.lastSetup < 16 ? g.lastSetup + 1 : '— (factory reset at boot!)'}; last group per setup: ${g.lastGroups.map((v) => (v & 15) + 1).join(' ')}. The editor never writes these bytes, nor the presets at 0x0800–0x0AFF.`));
  return h('div', { class: 'globals' }, rows);
}

const REPO = 'https://github.com/plentyofnames/lilypad';

// What Lilypad is: the start screen and the About dialog.
function aboutText() {
  return [
    h('p', { class: 'lead' }, 'A browser editor for the Faderfox EC4 running ', h('b', {}, 'controlfrog'),
      ', a custom firmware that lets a computer read and write the setups over USB MIDI. Edit the encoders, push buttons and names of all 16 setups × 16 groups, and write back only the bytes that changed.'),
    h('div', { class: 'notice' },
      h('p', {}, h('b', {}, 'Unofficial. '), 'Lilypad and controlfrog are not made, endorsed or supported by Faderfox. Faderfox and EC4 are their owner’s trademarks.'),
      h('p', {}, 'To edit a real unit, the EC4 needs the controlfrog firmware, which is ', h('b', {}, 'not released yet'), '. Until then, try the demo EC4: it runs in this page, at the real link speed, starting from the factory layout.')),
    h('p', { class: 'hint' }, 'Also opens stock "all setups" dumps (0x0B00–0xFFFF) and full 64 KB EEPROM dumps, offline. Saved "all setups" files load on the stock firmware through Setup → Receive. Needs Chrome, Edge or another browser with Web MIDI; Safari has none. ',
      h('a', { href: REPO, target: '_blank', rel: 'noopener' }, 'Source and instructions on GitHub'), ' · MIT licence.'),
  ];
}

function welcome() {
  const demo = h('button', { class: S.prefs.lastPort ? '' : 'primary', onclick: () => (($('#target').value = 'mock'), renderToolbar(), connect()) }, 'Try the demo EC4');
  const open = h('button', { onclick: () => $('#fileinput').click() }, 'Open a .syx file…');
  if (!S.prefs.seenIntro) return h('div', { class: 'welcome' }, h('h2', {}, 'Lilypad'), aboutText(), h('div', { class: 'welcome-actions' }, demo, open));
  // Once Lilypad has been used, the start screen is just the way back in; About keeps the rest.
  const port = S.prefs.lastPort;
  const unit = port ? h('button', { class: 'primary', onclick: () => (($('#target').value = 'midi'), renderToolbar(), connect()) }, `Connect to ${port}`) : null;
  return h('div', { class: 'welcome' },
    h('h2', {}, 'Lilypad'),
    S.waitingFor ? h('p', { class: 'hint' }, `Waiting for ${S.waitingFor} to be plugged in…`) : null,
    h('div', { class: 'welcome-actions' }, unit, demo, open),
    h('p', { class: 'hint' }, h('a', { href: '#', onclick: (e) => (e.preventDefault(), showAbout()) }, 'About Lilypad')));
}

function showAbout() {
  modal(dialog(), { title: 'About Lilypad', body: h('div', { class: 'about' }, aboutText()), buttons: [{ label: 'Close', value: true, primary: true }] });
}

// ---- status bar and log

function renderStatus() {
  const j = S.job;
  const msg = S.message;
  const pend = pendingSummary();
  const bar = $('#status');
  let prog = null;
  if (j) {
    const frac = j.total ? j.done / j.total : 0;
    const el = (performance.now() - j.t0) / 1000;
    const left = j.total && j.done > 2 ? (el / j.done) * (j.total - j.done) : null;
    prog = h('div', { class: 'job' },
      h('span', {}, j.label + (j.total ? ` · ${Math.floor(j.done)}/${j.total}` : '') + (left !== null && left > 0.5 ? ` · ${left.toFixed(0)} s left` : '') + (S.queued ? ` · ${S.queued} queued` : '')),
      h('progress', { max: 1, value: frac }),
      h('button', { class: 'small', onclick: () => {
        j.cancelled = true;
        S.conn?.dev.abort(); // also stops a request that is waiting out a busy device
      } }, 'Cancel'));
  }
  const pendTxt = pend.to === 'device' ? (pend.bytes || pend.unknown ? `${plural(pend.bytes, 'byte')} to write${pend.unknown ? `, ${plural(pend.unknown, 'page')} to compare` : ''}` : 'device up to date')
    : pend.to === 'file' ? (pend.bytes ? `${plural(pend.bytes, 'unsaved byte')}` : 'saved') : pend.bytes ? `${plural(pend.bytes, 'byte')} changed since read` : '';
  replace(bar,
    h('div', { class: 'msg ' + (msg?.kind || '') }, msg?.text || ''),
    prog,
    h('div', { class: 'right' },
      h('span', { class: 'pend' + (pend.bytes || pend.unknown ? ' has' : '') }, pendTxt),
      S.devState ? h('span', { class: 'devstate', title: 'what the device shows' }, `device: setup ${S.devState.setup + 1} · group ${S.devState.group + 1}`) : null,
      toggle('follow', 'Follow device', 'Turning a control or changing setup/group on the device selects it here'),
      toggle('moveDevice', 'Move device', 'Selecting a group here selects it on the device (SELECT)'),
      toggle('autoWrite', 'Auto-write', 'Write and reload 0.6 s after each edit'),
      toggle('showLog', 'Log', 'Show the protocol log', () => renderLog()),
      S.prefs.showLog ? h('button', { class: 'small', onclick: () => copyLog(), title: 'Copy the protocol log (with a header) to the clipboard' }, 'Copy log') : null,
      $('#target').value === 'mock' ? toggle('showMock', 'Demo panel', 'Show the simulated unit', () => renderMock()) : null));
}

function toggle(pref, label, title, after) {
  return h('label', { class: 'tog', title },
    h('input', { type: 'checkbox', checked: !!S.prefs[pref], onchange: (e) => {
      S.prefs[pref] = e.target.checked;
      savePrefs();
      after?.();
      renderStatus();
    } }), label);
}

function renderLog() {
  const el = $('#log');
  el.hidden = !S.prefs.showLog;
  if (el.hidden) return;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  el.textContent = S.log.join('\n');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// ---- mock panel

const knobAngle = new Array(16).fill(0);
const lastTouch = new Array(32).fill(0);
let mockFlash = null;

function mockTouch(kind, i) {
  const now = performance.now();
  if (now - lastTouch[kind * 16 + i] < 120) return;
  lastTouch[kind * 16 + i] = now;
  mockFlash = { i, t: now };
  S.mock.touch(kind, i);
  renderMock();
  setTimeout(() => {
    if (mockFlash && performance.now() - mockFlash.t > 380) {
      mockFlash = null;
      renderMock();
    }
  }, 400);
}

function knob(i) {
  let drag = null;
  const el = h('div', { class: 'mknob', title: `Encoder ${i + 1}: wheel or drag = turn, click = push` },
    h('div', { class: 'cap', style: { transform: `rotate(${knobAngle[i]}deg)` } }));
  const turn = (d) => {
    knobAngle[i] += d;
    el.firstChild.style.transform = `rotate(${knobAngle[i]}deg)`;
    mockTouch(0, i);
  };
  el.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    turn(ev.deltaY < 0 ? 12 : -12);
  }, { passive: false });
  el.addEventListener('pointerdown', (ev) => {
    drag = { y: ev.clientY, moved: false };
    el.setPointerCapture(ev.pointerId);
  });
  el.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dy = drag.y - ev.clientY;
    if (Math.abs(dy) >= 4) {
      drag.moved = true;
      drag.y = ev.clientY;
      turn(dy > 0 ? 12 : -12);
    }
  });
  el.addEventListener('pointerup', () => {
    if (drag && !drag.moved) mockTouch(1, i);
    drag = null;
  });
  return el;
}

function renderMock() {
  const panel = $('#mockpanel');
  const show = $('#target').value === 'mock' && S.prefs.showMock && S.mock;
  panel.hidden = !show;
  document.body.classList.toggle('with-mock', !!show);
  if (!show) return;
  const m = S.mock;
  const live = m.live;
  const lines = [];
  for (let r = 0; r < 4; r++) {
    const cells = [];
    for (let c = 0; c < 4; c++) {
      const i = r * 4 + c;
      cells.push(h('span', { class: mockFlash?.i === i ? 'inv' : '' }, M.readName(live, M.encNameAddr(m.setup, m.group, i))));
    }
    lines.push(h('div', { class: 'oline' }, cells));
  }
  const knobs = h('div', { class: 'mknobs' }, range(0, 16).map(knob));
  const stepper = (label, value, onSet) => h('div', { class: 'stepper' },
    h('span', {}, label),
    h('button', { class: 'small', onclick: () => onSet((value + 15) % 16) }, '−'),
    h('b', {}, value + 1),
    h('button', { class: 'small', onclick: () => onSet((value + 1) % 16) }, '+'));
  const fault = (key, label, on, set) => h('label', { class: 'tog' }, h('input', { type: 'checkbox', checked: on, onchange: (e) => (set(e.target.checked), renderMock()) }), label);
  replace(panel,
    h('div', { class: 'mock-head' }, h('b', {}, 'Demo EC4'), h('span', { class: 'hint' }, ` fw ${m.fw.join('.')} · ${m.port ? 'connected' : 'not connected'} · touch events ${m.touchOn ? 'on' : 'off'}${m.dumping ? ' · DUMP_ALL running (silent)' : ''}`)),
    h('div', { class: 'mock-body' },
      h('div', { class: 'mock-unit' },
        h('div', { class: 'oled', title: 'live settings: change only on RELOAD' },
          h('div', { class: 'otop' }, `${M.setupName(live, m.setup)} ${M.groupName(live, m.setup, m.group)}`), lines),
        h('div', { class: 'mock-keys' },
          stepper('Setup', m.setup, (v) => m.setState(v, live[M.A.LAST_GROUP + v] & 15)),
          stepper('Group', m.group, (v) => m.setState(m.setup, v)))),
      knobs,
      h('div', { class: 'mock-opts' },
        h('label', { class: 'tog' }, h('input', { type: 'checkbox', checked: m.speed === 'real', onchange: (e) => {
          m.speed = S.prefs.mockSpeed = e.target.checked ? 'real' : 'fast';
          savePrefs();
        } }), 'Real link speed (31250 baud)'),
        h('div', { class: 'faults' }, h('span', { class: 'hint' }, 'Faults: '),
          fault('ws', 'writes fail', m.faults.writeStatus !== 0, (v) => (m.faults.writeStatus = v ? 1 : 0)),
          fault('be', 'EEPROM bus error', m.faults.busError, (v) => (m.faults.busError = v)),
          fault('dr', 'drop next reply', m.faults.dropReplies > 0, (v) => (m.faults.dropReplies = v ? 1 : 0)),
          fault('bc', 'corrupt next READ', m.faults.badChecksum, (v) => (m.faults.badChecksum = v))),
        h('div', { class: 'hint' }, `${m.stats.reads} reads · ${m.stats.writes} writes · ${m.stats.bytesWritten} bytes written · ${m.stats.dropped} requests dropped`),
        h('div', { class: 'mock-btns' },
          h('button', { class: 'small', onclick: () => $('#mockfile').click(), title: 'Replace the demo EEPROM with a .syx file' }, 'Load .syx'),
          h('button', { class: 'small', onclick: () => saveBytes(containerFromImage(m.eeprom, 0, M.SIZE, { padding: 0 }), `demo_eeprom_${today()}.syx`).catch(showError) }, 'Save EEPROM'),
          h('button', { class: 'small', onclick: resetMock, title: 'Back to the demo setups (factory layout)' }, 'Reset')))));
}

function resetMock() {
  setMock(demoImage());
  say('Demo EC4 reset to the factory layout.');
}

async function loadMockFile(file) {
  try {
    const c = parseContainer(new Uint8Array(await file.arrayBuffer()));
    if (c.badPages.length) throw new Error('bad page checksums');
    setMock(imageFromContainer(c));
    say(`Demo EC4 EEPROM loaded from ${file.name}.`);
  } catch (e) {
    say(`${file.name}: ${e.message}`, 'error');
  }
}

// ------------------------------------------------------------------ keyboard

function onKey(ev) {
  const mod = ev.metaKey || ev.ctrlKey;
  const key = ev.key.toLowerCase();
  // ⌘Z / ⇧⌘Z / Ctrl+Y: Lilypad's undo, also in a field (a field redrawn after a change has no undo of its own).
  if (mod && !ev.altKey && (key === 'z' || key === 'y') && !ev.target.closest('dialog')) {
    ev.preventDefault();
    return undoRedo(key === 'y' || ev.shiftKey);
  }
  if (ev.target.closest('input, select, textarea, dialog') || S.view !== 'group' || !groupReady()) return;
  const i = S.sel.index;
  const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 };
  if (mod && key === 'a') {
    ev.preventDefault();
    selectAll();
  } else if (ev.key === 'Escape') {
    setSelection(i);
  } else if (ev.key in moves) {
    ev.preventDefault();
    selectControl(S.sel.kind, (i + moves[ev.key] + 16) % 16);
  } else if (ev.key === ' ') {
    ev.preventDefault();
    setSelection(i, S.sel.multi, S.sel.kind === 'enc' ? 'push' : 'enc');
  } else if (ev.key === 'PageDown' || ev.key === 'PageUp') {
    ev.preventDefault();
    go(S.sel.setup, (S.sel.group + (ev.key === 'PageDown' ? 1 : 15)) % 16);
  }
}

// ------------------------------------------------------------------ wiring

function init() {
  $('#connect').onclick = () => connect();
  $('#target').onchange = () => {
    if ($('#target').value === 'midi') refreshPorts().catch(showError);
    renderAll();
  };
  $('#write').onclick = () => writeChanges().catch(showError);
  $('#reread').onclick = () => rereadSetup();
  $('#readall').onclick = () => readEverything().catch(showError);
  $('#dumpall').onclick = () => dumpAllBackup();
  $('#discard').onclick = () => discardChanges();
  $('#open').onclick = () => $('#fileinput').click();
  $('#fileinput').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) openFile(f);
  };
  $('#mockfile').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) loadMockFile(f);
  };
  $('#save').onclick = () => saveSyx(false);
  $('#about').onclick = () => showAbout();
  $('#savefull').onclick = () => saveSyx(true);
  document.addEventListener('keydown', onKey);
  $('#undo').onclick = () => undoRedo(false);
  $('#redo').onclick = () => undoRedo(true);
  // ⌘C / ⌘V outside text fields copy and paste the selected controls (via the system clipboard,
  // so it works between Lilypad tabs too). Selected page text (the log, a hint) copies as text.
  const inText = (t) => t?.closest?.('input, textarea');
  document.addEventListener('copy', (e) => {
    if (inText(e.target) || !document.getSelection().isCollapsed || S.view !== 'group' || !groupReady()) return;
    const clip = makeClip('controls');
    const text = B.encodeClip(clip);
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
    setClip(clip, text);
    say(`Copied ${describeClip(clip)}.`, 'ok');
    renderGroupBar();
  });
  document.addEventListener('paste', (e) => {
    if (inText(e.target) || S.view !== 'group' || !groupReady()) return;
    const clip = B.decodeClip(e.clipboardData.getData('text/plain')) || getClip();
    if (!clip) return;
    e.preventDefault();
    doPaste(clip);
  });
  document.addEventListener('click', (e) => {
    for (const d of document.querySelectorAll('details.menu[open]')) if (!d.contains(e.target)) d.open = false;
  });
  window.addEventListener('storage', (e) => e.key === CLIP_KEY && renderGroupBar());
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) openFile(f);
  });
  window.addEventListener('beforeunload', (e) => {
    const p = pendingSummary();
    if (p.bytes && (S.conn || S.store.fileInfo)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  renderAll();
  renderLog();
}

// For debugging from the console.
window.lilypad = { S, M, B, writeChanges, connect, disconnect, go, openFile, saveSyx, edit, undoRedo, setSelection, doCopy, doPaste, doFill, getClip };

init();
reconnectOnLoad().catch(showError);
