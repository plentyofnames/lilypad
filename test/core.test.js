// Core tests: container round trips, packing, rules, and diff writes against the mock.
// Runs in Deno (test/run.js) and in the browser (test/index.html). The setups are the
// generated demo image; to also check your own dumps, put a stock "all setups" file and a
// full EEPROM dump of the same unit at test/local/all_setups.syx and test/local/eeprom_full.syx.

import { pack, unpack, checksum, packedLength, host, decodeCommand, CMD, ProtocolError } from '../js/proto.js';
import { parseContainer, serializeContainer, containerFromImage } from '../js/syx.js';
import * as M from '../js/model.js';
import { Store, diffChunks } from '../js/store.js';
import { Device } from '../js/device.js';
import { MockDevice } from '../js/mock.js';
import { TouchFilter } from '../js/touch.js';
import * as B from '../js/bulk.js';
import { History } from '../js/history.js';
import { demoImage } from '../js/demo.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const skip = (name, why) => tests.push({ name, skip: why });
function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new Error(msg);
}
function eqBytes(a, b, what = 'bytes') {
  if (a.length !== b.length) throw new Error(`${what}: length ${a.length} != ${b.length}`);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(`${what}: differ at ${i}: ${a[i]} != ${b[i]}`);
}

function imageOf(c) {
  const img = new Uint8Array(0x10000).fill(0xFF);
  for (const p of c.pages) img.set(p.data, p.addr);
  return img;
}

// Round trips on a stock-style "all setups" file and a full EEPROM dump of the same unit.
function fileTests(what, allRaw, fullRaw) {
  const all = parseContainer(allRaw);
  const full = parseContainer(fullRaw);
  test(`${what}: all-setups file parses`, () => {
    assert(all.pages.length === 980, 'pages ' + all.pages.length);
    assert(all.pages[0].addr === 0x0B00 && all.pages.at(-1).addr === 0xFFC0);
    assert(all.badPages.length === 0, 'bad checksums');
    assert(all.padding === 30, 'padding ' + all.padding);
  });
  test(`${what}: full dump parses`, () => {
    assert(full.pages.length === 1024 && full.pages[0].addr === 0);
    assert(full.badPages.length === 0 && full.padding === 0);
  });
  test(`${what}: both files re-serialize byte-identically`, () => {
    eqBytes(serializeContainer(all), allRaw, 'all setups');
    eqBytes(serializeContainer(full), fullRaw, 'full dump');
  });
  test(`${what}: image -> all-setups container == all-setups file`, () => {
    eqBytes(containerFromImage(imageOf(all), 0x0B00, 0x10000, { header: all.header, padding: 30 }), allRaw);
    eqBytes(containerFromImage(imageOf(full), 0x0B00, 0x10000, { header: full.header, padding: 30 }), allRaw, 'from full');
  });
  test(`${what}: image -> full container == full dump`, () => {
    eqBytes(containerFromImage(imageOf(full), 0, 0x10000, { header: full.header, padding: 0 }), fullRaw);
  });
  test(`${what}: the two files agree on 0x0B00-0xFFFF`, () => {
    eqBytes(imageOf(all).subarray(0x0B00), imageOf(full).subarray(0x0B00));
  });
  test(`${what}: model reads every control`, () => {
    const img = imageOf(full);
    for (let s = 0; s < 16; s++)
      for (let g = 0; g < 16; g++)
        for (let i = 0; i < 16; i++) {
          const e = M.readEncoder(img, s, g, i);
          const p = M.readPush(img, s, g, i);
          assert(M.ENC_TYPES[e.type] && M.MODES[e.mode] && M.SCALES[e.scale]);
          M.encoderRules(e, i);
          M.pushRules(p, i);
        }
  });
}

// load(path) returns the file's bytes, or null if it is missing.
export async function runTests(load, report = console.log) {
  // The demo setups, on a unit last left on setup 2, group 2.
  const demo = demoImage();
  demo[M.A.LAST_SETUP] = 1;
  demo[M.A.LAST_GROUP + 1] = 1;
  const allRaw = containerFromImage(demo, 0x0B00, 0x10000, { padding: 30 });
  const fullRaw = containerFromImage(demo, 0, 0x10000, { padding: 0 });
  const full = parseContainer(fullRaw);

  test('container wire format', () => {
    const raw = Uint8Array.from([
      0xF0, 0x00, 0x00, 0x00,
      0x41, 0x20, 0x1B, 0x42, 0x20, 0x13, 0x43, 0x20, 0x12, 0x44, 0x20, 0x10, // EC4, all setups, V2.00
      0x49, 0x20, 0x1B, 0x4A, 0x20, 0x10, // page 0x0B00
      0x4D, 0x2A, 0x15, 0x4D, 0x23, 0x1C, // data A5 3C
      0x4B, 0x20, 0x10, 0x4C, 0x2E, 0x11, // checksum 0x00E1
      0x00, 0x00, // padding
      0x4F, 0x20, 0x1B, 0xF7,
    ]);
    const c = parseContainer(raw);
    assert(c.header[1] === 0x0B && c.header[2] === 3 && c.header[3] === 2 && c.header[4] === 0, JSON.stringify(c.header));
    assert(c.pages.length === 1 && c.pages[0].addr === 0x0B00 && c.pages[0].check === 0xE1 && c.badPages.length === 0);
    eqBytes(c.pages[0].data, [0xA5, 0x3C], 'data');
    assert(c.padding === 2 && c.stop === 0x0B);
    eqBytes(serializeContainer(c), raw, 'serialized');
  });
  fileTests('demo', allRaw, fullRaw);
  const localAll = await load('test/local/all_setups.syx');
  const localFull = await load('test/local/eeprom_full.syx');
  if (localAll && localFull) fileTests('local', localAll, localFull);
  else skip('local dumps', 'no test/local/all_setups.syx and test/local/eeprom_full.syx');

  test('8-to-7 pack/unpack round trip, lengths 1-64', () => {
    for (let n = 1; n <= 64; n++) {
      const d = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n * 11) & 0xFF);
      const p = pack(d);
      assert(p.length === packedLength(n), 'packed length');
      assert(p.every((b) => b < 0x80), '7-bit');
      eqBytes(unpack(p, 0, n), d, 'n=' + n);
    }
    assert(checksum([0x80, 0x7F, 0x01]) === 0x00);
  });
  test('WRITE command encodes and decodes', () => {
    const d = Uint8Array.from([0xFF, 0x00, 0x80, 0x7F, 1, 2, 3, 4, 0xF0]);
    const c = decodeCommand(host.write(0x1C04, d));
    assert(c.cmd === CMD.WRITE && c.addr === 0x1C04 && c.len === 9 && !c.error);
    eqBytes(c.data, d);
    const msg = host.read(0xFFC0, 64);
    assert(msg.length === 5 + 1 + 5 + 1 && msg.every((b, i) => i === 0 || i === msg.length - 1 || b < 0x80));
  });

  test('demo image follows the factory layout', () => {
    const img = demoImage();
    assert(M.setupName(img, 14) === 'SE15' && M.groupName(img, 14, 0) === 'GR01');
    const e = M.readEncoder(img, 3, 9, 5);
    assert(e.type === M.T.CCAB && e.channel === 3 && e.number === (16 * 9 + 5) % 128, JSON.stringify(e));
    assert(e.lower === 0 && e.upper === 127 && e.mode === 6 && e.scale === 1 && e.name === '----', JSON.stringify(e));
    const p = M.readPush(img, 3, 9, 5);
    assert(p.type === M.PT.NOTE && p.channel === 3 && p.number === e.number && p.mode === 0 && p.display === 1, JSON.stringify(p));
    const g = M.readGlobals(img);
    assert(g.lastSetup === 0 && g.routing === 6 && g.brightness === 0x80 && g.screensaver === 100);
    assert(img.subarray(0x0800, 0x0B00).every((b) => b === 0xFF), 'presets empty');
  });

  test('rules: CCAh numbers are clamped to 31, NRPN gets MSB/LSB', () => {
    const img = imageOf(full);
    M.setEncoder(img, 0, 0, 3, 'number', 100);
    M.setEncoder(img, 0, 0, 3, 'type', M.T.CCAH);
    assert(M.readEncoder(img, 0, 0, 3).number === 31);
    M.setEncoder(img, 0, 0, 3, 'number', 90);
    assert(M.readEncoder(img, 0, 0, 3).number === 31, 'set clamps too');
    M.setEncoder(img, 0, 0, 3, 'type', M.T.NRPN);
    const r = M.encoderRules(M.readEncoder(img, 0, 0, 3), 3);
    assert(r.numberHigh.enabled && r.number.label === 'NRPN LSB');
    assert(!M.encoderRules({ ...M.readEncoder(img, 0, 0, 3), type: M.T.PRGC }, 3).number.enabled);
    assert(!M.encoderRules(M.readEncoder(img, 0, 0, 15), 15).link.enabled, 'no link on encoder 16');
  });
  test('rules: 14-bit lower/upper only for CCAh/PBnd/NRPN with display off/1000/±500/9999', () => {
    const img = imageOf(full);
    const d = M.dataBase(1, 2);
    M.setEncoder(img, 1, 2, 5, 'type', M.T.PBND);
    M.setEncoder(img, 1, 2, 5, 'scale', 1);
    assert(!M.readEncoder(img, 1, 2, 5).hires);
    M.setEncoder(img, 1, 2, 5, 'scale', 3);
    let e = M.readEncoder(img, 1, 2, 5);
    assert(e.hires && e.upper === 16383, 'factory upper reads as max: ' + e.upper);
    M.setEncoder(img, 1, 2, 5, 'upper', 4094);
    assert(img[d + 64 + 5] === 0xFE && img[d + 96 + 5] >> 4 === 0xF);
    M.setEncoder(img, 1, 2, 5, 'upper', 5000);
    assert(M.readEncoder(img, 1, 2, 5).upper === 16383);
    M.setEncoder(img, 1, 2, 5, 'lower', 300);
    assert(img[d + 48 + 5] === 300 - 256 && (img[d + 96 + 5] & 15) === 1);
    M.setEncoder(img, 1, 2, 5, 'scale', 1);
    M.setEncoder(img, 1, 2, 5, 'lower', 200);
    assert(M.readEncoder(img, 1, 2, 5).lower === 127, '7-bit clamp');
    assert((img[d + 96 + 5] & 15) === 0, '7-bit edit clears the lower MSB nibble');
  });
  test('rules: push buttons', () => {
    const off = M.pushRules({ type: M.PT.OFF }, 0);
    assert(!off.display.enabled && !off.channel.enabled && !off.upper.enabled);
    const grp = M.pushRules({ type: M.PT.GRP }, 0);
    assert(grp.channel.enabled && grp.channel.label === 'Group' && !grp.number.enabled && grp.display.enabled);
    const acc = M.pushRules({ type: M.PT.LSP6 }, 15);
    assert(!acc.channel.enabled && acc.display.enabled && !acc.link.enabled);
    const img = imageOf(full);
    M.setPush(img, 2, 3, 4, 'mode', 1);
    M.setPush(img, 2, 3, 4, 'number', 64);
    M.setPush(img, 2, 3, 4, 'upper', 99);
    M.setPush(img, 2, 3, 4, 'link', 1);
    const p = M.readPush(img, 2, 3, 4);
    assert(p.mode === 1 && p.number === 64 && p.upper === 99 && p.link === 1);
  });
  test('names', () => {
    const img = imageOf(full);
    M.writeName(img, M.encNameAddr(0, 0, 0), 'Ab!c');
    assert(M.readEncoder(img, 0, 0, 0).name === 'Abc ');
  });

  test('diff chunks: only changed bytes, <= 64, never across a page', () => {
    const base = imageOf(full);
    const img = Uint8Array.from(base);
    const changed = new Set();
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF);
    for (let k = 0; k < 3000; k++) {
      const a = 0x0B00 + (rnd() % (0x10000 - 0x0B00));
      img[a] = (base[a] + 1 + (rnd() % 255)) & 0xFF;
      changed.add(a);
    }
    for (let a = 0x2000; a < 0x2100; a++) {
      img[a] ^= 0x55; // a long run across four pages
      changed.add(a);
    }
    const chunks = diffChunks(img, base, () => true);
    let n = 0;
    for (const c of chunks) {
      assert(c.data.length >= 1 && c.data.length <= 64);
      assert((c.addr >> 6) === ((c.addr + c.data.length - 1) >> 6), 'crosses a page at ' + c.addr);
      for (let k = 0; k < c.data.length; k++) assert(changed.has(c.addr + k) && img[c.addr + k] !== base[c.addr + k]);
      n += c.data.length;
    }
    assert(n === changed.size, `${n} bytes in chunks, ${changed.size} changed`);
  });
  test('diff chunks skip device-owned bytes', () => {
    const base = imageOf(full);
    const img = Uint8Array.from(base);
    img[0] = 20; // last setup: never written (>= 16 would factory-reset)
    img[0x11] = 5; // last group
    img[0x0800] = 1; // presets
    img[3] = 200; // brightness: written
    const chunks = diffChunks(img, base, () => true);
    assert(chunks.length === 1 && chunks[0].addr === 3 && chunks[0].data.length === 1, JSON.stringify(chunks));
  });

  test('device client against the mock: identify, read, diff write, reload', async () => {
    const mock = new MockDevice(imageOf(full), { speed: 'fast' });
    const dev = new Device(mock.transport());
    const id = await dev.identify();
    assert(id.proto === 1 && id.eepromKb === 64 && id.maxChunk === 64);
    const st = await dev.getState();
    assert(st.setup === 1 && st.group === 1, JSON.stringify(st));
    await dev.touchEvents(true);
    assert(mock.touchOn);

    const store = new Store();
    for (const p of M.pagesOf(M.setupRanges(3))) store.fromDevice(p * 64, await dev.read(p * 64, 64));
    assert(store.hasPages(M.pagesOf(M.groupRanges(3, 7))));
    assert(store.deviceChunks().length === 0);

    M.setEncoder(store.img, 3, 7, 2, 'type', M.T.NRPN);
    M.setEncoder(store.img, 3, 7, 2, 'numberHigh', 5);
    M.setEncoder(store.img, 3, 7, 2, 'name', 'Cut ');
    M.setPush(store.img, 3, 7, 15, 'type', M.PT.SET);
    M.writeName(store.img, M.groupNameAddr(3, 7), 'Flt');
    const chunks = store.deviceChunks();
    const expectBytes = store.deviceDirtyBytes();
    const before = Uint8Array.from(mock.eeprom);
    for (const c of chunks) {
      await dev.write(c.addr, c.data);
      store.written(c.addr, c.data);
    }
    assert(mock.stats.bytesWritten === expectBytes, `wrote ${mock.stats.bytesWritten}, expected ${expectBytes}`);
    assert(store.deviceChunks().length === 0, 'clean after write');
    let diff = 0;
    for (let a = 0; a < 0x10000; a++) if (mock.eeprom[a] !== before[a]) diff++;
    assert(diff === expectBytes, `${diff} bytes differ on the mock`);
    for (const p of M.pagesOf(M.setupRanges(3))) eqBytes(mock.eeprom.subarray(p * 64, p * 64 + 64), store.img.subarray(p * 64, p * 64 + 64), 'page ' + p);
    assert(M.readEncoder(mock.live, 3, 7, 2).type !== M.T.NRPN, 'live state unchanged before RELOAD');
    const r = await dev.reload();
    assert(r.setup === 1 && M.readEncoder(mock.live, 3, 7, 2).type === M.T.NRPN);
  });

  test('mock enforces the protocol limits', async () => {
    const mock = new MockDevice(imageOf(full), { speed: 'fast' });
    const t = mock.transport();
    let last = null;
    t.onmessage = (b) => (last = Array.from(b));
    const ask = async (msg) => {
      last = null;
      t.send(msg);
      await new Promise((r) => setTimeout(r, 50)); // one request at a time
      return last && [last[5], last[6], last[7]];
    };
    const bad = host.write(0x2000, Uint8Array.from([1, 2, 3]));
    bad[bad.length - 2] ^= 1;
    const errs = [
      await ask(host.write(0x2030, new Uint8Array(32))), // crosses 0x2040
      await ask(host.read(0x2000, 65)),
      await ask(bad),
      await ask(Uint8Array.from([0xF0, 0x7D, 0x45, 0x43, 0x34, 0x55, 0xF7])),
    ];
    assert(JSON.stringify(errs) === JSON.stringify([[0x7F, 0x12, 1], [0x7F, 0x10, 1], [0x7F, 0x12, 2], [0x7F, 0x55, 5]]), JSON.stringify(errs));
    const dev = new Device(mock.transport());
    try {
      await dev.write(0x2000, new Uint8Array(65));
      assert(false, 'should throw');
    } catch (e) {
      assert(e instanceof RangeError);
    }
    mock.faults.busError = true;
    try {
      await dev.read(0, 64);
      assert(false, 'should throw');
    } catch (e) {
      assert(e instanceof ProtocolError && e.code === 3);
    }
  });

  test('mock drops a request sent before the previous reply', async () => {
    const mock = new MockDevice(imageOf(full), { speed: 'fast' });
    const t = mock.transport();
    const replies = [];
    t.onmessage = (b) => replies.push(b[5]);
    t.send(host.read(0x1BC0, 64));
    t.send(host.identify()); // too early: dropped
    await new Promise((r) => setTimeout(r, 50));
    t.send(host.getState());
    await new Promise((r) => setTimeout(r, 50));
    assert(JSON.stringify(replies) === JSON.stringify([0x11, 0x21]) && mock.stats.dropped === 1, JSON.stringify(replies));
  });

  test('during DUMP_ALL the mock ignores requests and sends no events', async () => {
    const mock = new MockDevice(imageOf(full), { speed: 'real', timeScale: 0.005 }); // dump ~0.33 s
    const t = mock.transport();
    const got = [];
    t.onmessage = (b) => got.push(b[1] === 0 ? 'dump' : b[5].toString(16));
    t.send(host.touchEvents(true));
    await new Promise((r) => setTimeout(r, 30));
    t.send(host.dumpAll());
    await new Promise((r) => setTimeout(r, 60));
    assert(mock.dumping, 'dump running');
    t.send(host.identify());
    mock.touch(0, 2);
    mock.setState(5, 5);
    await new Promise((r) => setTimeout(r, 500));
    assert(!mock.dumping && mock.stats.dropped === 1, 'dropped ' + mock.stats.dropped);
    assert(JSON.stringify(got) === JSON.stringify(['21', 'dump']), JSON.stringify(got));
    assert(mock.setup === 5, 'the state still changed on the unit');
  });

  test('client waits out a running dump and retries', async () => {
    const mock = new MockDevice(imageOf(full), { speed: 'real', timeScale: 0.005 });
    const dev = new Device(mock.transport());
    const waits = [];
    dev.addEventListener('waiting', (e) => waits.push(e.detail.done ? 'done' : 'wait'));
    mock.port.send(host.dumpAll()); // started by someone else
    await new Promise((r) => setTimeout(r, 40));
    const t0 = performance.now();
    const id = await dev.identify(); // first attempt is ignored, the retry after the dump answers
    assert(id.proto === 1 && performance.now() - t0 >= 700, 'took ' + (performance.now() - t0));
    assert(JSON.stringify(waits) === JSON.stringify(['wait', 'done']), JSON.stringify(waits));
    assert(mock.stats.dropped === 1);
  });

  test('a request waiting on a busy device can be aborted', async () => {
    const mock = new MockDevice(imageOf(full), { speed: 'fast' });
    const dev = new Device(mock.transport());
    mock.faults.dropReplies = 100;
    const p = dev.read(0, 64);
    setTimeout(() => dev.abort(), 1500);
    try {
      await p;
      assert(false, 'should throw');
    } catch (e) {
      assert(e.name === 'AbortError', e.message);
    }
    mock.faults.dropReplies = 0;
    eqBytes(await dev.read(0, 64), imageOf(full).subarray(0, 64), 'works again');
  });

  test('copy/paste of controls, groups and setups', () => {
    const img = demoImage();
    M.setEncoder(img, 0, 0, 2, 'type', M.T.NRPN);
    M.setEncoder(img, 0, 0, 2, 'numberHigh', 9);
    M.setEncoder(img, 0, 0, 2, 'name', 'Cut');
    M.setEncoder(img, 0, 0, 2, 'link', 1);
    M.setPush(img, 0, 0, 2, 'type', M.PT.GRP);
    const clip = B.decodeClip(B.encodeClip(B.copyControls(img, 0, 0, [2])));
    assert(clip && clip.kind === 'controls' && clip.items.length === 1, 'clipboard text round trip');
    const wrote = B.pasteControls(img, 3, 4, [5, 15], clip);
    assert(JSON.stringify(wrote) === '[5,15]');
    for (const i of [5, 15]) {
      const e = M.readEncoder(img, 3, 4, i);
      assert(e.type === M.T.NRPN && e.numberHigh === 9 && e.name === 'Cut ' && M.readPush(img, 3, 4, i).type === M.PT.GRP);
    }
    assert(M.readEncoder(img, 3, 4, 5).link === 1 && M.readEncoder(img, 3, 4, 15).link === 0, 'no link on control 16');
    // several controls go into consecutive slots from the first target
    const many = B.copyControls(img, 0, 0, [0, 1, 2]);
    assert(JSON.stringify(B.pasteControls(img, 1, 1, [14], many)) === '[14,15]', 'clipped at 16');
    // group and setup
    M.writeName(img, M.groupNameAddr(0, 0), 'Src');
    B.pasteGroup(img, 7, 9, B.decodeClip(B.encodeClip(B.copyGroup(img, 0, 0))));
    eqBytes(Uint8Array.from(B.groupAddrs(7, 9), (a) => img[a]), Uint8Array.from(B.groupAddrs(0, 0), (a) => img[a]), 'group bytes');
    assert(M.groupName(img, 7, 9) === 'Src ');
    M.writeName(img, M.setupNameAddr(0), 'Live');
    const before = img.slice();
    B.pasteSetup(img, 12, B.copySetup(img, 0));
    eqBytes(Uint8Array.from(B.setupAddrs(12), (a) => img[a]), Uint8Array.from(B.setupAddrs(0), (a) => before[a]), 'setup bytes');
    for (let a = 0; a < img.length; a++) if (img[a] !== before[a]) assert(B.setupAddrs(12).includes(a), 'paste touched only setup 13, not 0x' + a.toString(16));
    assert(B.decodeClip('{"lilypad":1,"kind":"group","items":["00"]}') === null && B.decodeClip('hello') === null, 'rejects bad clipboards');
  });

  test('fill ascending and one field for several controls', () => {
    const img = demoImage();
    M.setEncoder(img, 2, 0, 0, 'number', 120);
    assert(B.fill(img, 2, 0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'enc', 'number') === 10);
    assert(JSON.stringify([0, 1, 7, 8, 9].map((i) => M.readEncoder(img, 2, 0, i).number)) === '[120,121,127,0,1]', 'numbers wrap at 128');
    M.setEncoder(img, 2, 0, 4, 'type', M.T.PRGC); // number doesn't apply: skipped, not counted
    M.setEncoder(img, 2, 0, 3, 'number', 50);
    B.fill(img, 2, 0, [3, 4, 5], 'enc', 'number');
    assert(M.readEncoder(img, 2, 0, 5).number === 51, 'skips the program change');
    M.setPush(img, 2, 0, 0, 'channel', 14);
    B.fill(img, 2, 0, [0, 1, 2, 3], 'push', 'channel');
    assert(JSON.stringify([0, 1, 2, 3].map((i) => M.readPush(img, 2, 0, i).channel)) === '[14,15,0,1]', 'channels wrap at 16');
    M.setEncoder(img, 2, 0, 9, 'type', M.T.CCAH);
    const n = B.applyField(img, 2, 0, [4, 8, 9], 'enc', 'number', 100);
    assert(n === 2 && M.readEncoder(img, 2, 0, 8).number === 100 && M.readEncoder(img, 2, 0, 9).number === 31, 'rules per control');
    assert(B.applyField(img, 2, 0, [14, 15], 'enc', 'link', 1) === 1 && M.readEncoder(img, 2, 0, 15).link === 0);
    assert(JSON.stringify(B.locate(M.dataBase(5, 6) + 128 + 3 * 4 + 2)) === JSON.stringify({ setup: 5, group: 6, index: 3 }));
    assert(JSON.stringify(B.locate(M.key2Base(1, 2) + 16 + 7)) === JSON.stringify({ setup: 1, group: 2, index: 7 }));
  });

  test('undo and redo, with typing merged into one step', () => {
    const img = demoImage();
    const orig = img.slice();
    const h = new History(img);
    h.record(() => M.setEncoder(img, 0, 0, 0, 'channel', 5), { now: 1000 });
    for (const [k, name] of ['A', 'AB', 'ABC'].entries()) h.record(() => M.setEncoder(img, 0, 0, 1, 'name', name), { key: 'n', now: 2000 + k * 100 });
    assert(h.done.length === 2, 'typing is one step: ' + h.done.length);
    assert(h.record(() => {}) === null, 'no-op is not a step');
    h.undo();
    assert(M.readEncoder(img, 0, 0, 1).name === M.readEncoder(orig, 0, 0, 1).name, 'name back');
    h.undo();
    eqBytes(img, orig, 'all undone');
    assert(!h.canUndo && h.canRedo);
    h.redo();
    h.redo();
    assert(M.readEncoder(img, 0, 0, 0).channel === 5 && M.readEncoder(img, 0, 0, 1).name === 'ABC ');
    h.undo();
    h.record(() => M.setEncoder(img, 0, 0, 2, 'mode', 0));
    assert(!h.canRedo, 'a new edit clears redo');
  });

  test('a twist while pushing does not leave the push button', () => {
    const f = new TouchFilter();
    const sel = { setup: 0, group: 2, kind: 'enc', index: 0 };
    const ev = (kind, index, t) => {
      const r = f.decide(sel, { kind, index, setup: 0, group: 2 }, t);
      if (r) Object.assign(sel, { kind: r, index });
      return r;
    };
    assert(ev(1, 4, 1000) === 'push' && sel.kind === 'push' && sel.index === 4);
    assert(ev(0, 4, 1200) === null, 'twist during the push is ignored');
    assert(ev(0, 4, 1600) === null, 'a stray turn after it does not count with the one during the push');
    assert(ev(0, 4, 2600) === null, 'a single slow twist does not switch');
    assert(ev(0, 4, 2850) === 'enc' && sel.kind === 'enc', 'continued turning switches');
    assert(ev(0, 4, 3100) === 'enc');
    assert(ev(1, 4, 4000) === 'push');
    assert(ev(0, 7, 4100) === 'enc' && sel.index === 7, 'another knob is selected right away');
    assert(ev(0, 7, 4150) === 'enc');
  });

  test('mock sends at most one TOUCH per control per 250 ms', async () => {
    const mock = new MockDevice(imageOf(full), { speed: 'fast' });
    const dev = new Device(mock.transport());
    const got = [];
    dev.addEventListener('touch', (e) => got.push(`${e.detail.kind}:${e.detail.index}`));
    await dev.touchEvents(true);
    mock.touch(0, 3);
    mock.touch(0, 3);
    mock.touch(1, 3);
    mock.touch(0, 4);
    await new Promise((r) => setTimeout(r, 270));
    mock.touch(0, 3);
    await new Promise((r) => setTimeout(r, 50));
    assert(JSON.stringify(got) === JSON.stringify(['0:3', '1:3', '0:4', '0:3']), JSON.stringify(got));
  });

  test('client retries a corrupted READ reply', async () => {
    const mock = new MockDevice(imageOf(full), { speed: 'fast' });
    const dev = new Device(mock.transport());
    mock.faults.badChecksum = true;
    const d = await dev.read(0x1BC0, 64);
    eqBytes(d, imageOf(full).subarray(0x1BC0, 0x1C00));
    assert(mock.stats.reads === 2);
  });

  test('touch and state events reach the client', async () => {
    const mock = new MockDevice(imageOf(full), { speed: 'fast' });
    const dev = new Device(mock.transport());
    const got = [];
    dev.addEventListener('touch', (e) => got.push(['touch', e.detail.kind, e.detail.index]));
    dev.addEventListener('state', (e) => got.push(['state', e.detail.setup, e.detail.group, e.detail.solicited]));
    mock.touch(0, 3); // touch events off: nothing
    await dev.touchEvents(true);
    mock.touch(1, 9);
    mock.setState(4, 5);
    await new Promise((r) => setTimeout(r, 100));
    assert(JSON.stringify(got) === JSON.stringify([['state', 1, 1, true], ['touch', 1, 9], ['state', 4, 5, false]]), JSON.stringify(got));
  });

  test('DUMP_ALL returns the full image in the Faderfox container', async () => {
    const mock = new MockDevice(imageOf(full), { speed: 'fast' });
    const dev = new Device(mock.transport());
    const raw = await dev.dumpAll();
    eqBytes(raw, fullRaw, 'dump');
  });

  let failed = 0;
  let skipped = 0;
  for (const t of tests) {
    if (t.skip) {
      skipped++;
      report(`skip ${t.name}: ${t.skip}`);
      continue;
    }
    try {
      await t.fn();
      report(`ok   ${t.name}`);
    } catch (e) {
      failed++;
      report(`FAIL ${t.name}: ${e.message}`);
    }
  }
  const run = tests.length - skipped;
  report(`${run - failed}/${run} passed${skipped ? `, ${skipped} skipped` : ''}`);
  return failed;
}
