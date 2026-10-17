// The demo EEPROM image for the mock: 16 setups laid out by the EC4's factory-default rules,
// generated here so no device data ships with the editor.
//   encoders: CC absolute, channel = setup, CC (16·group + i) & 127, 0…127, Acc3, display 127, name "----"
//   push buttons: Note on the same channel and number, key mode, display on, lower/upper 127
//   names "SE01"…"SE16" and "GR01"…"GR16"; unused bytes and the presets read 0xFF.
// On the unit, setups 15 and 16 hold factory templates; here they follow the same rules.

import * as M from './model.js';

export function demoImage() {
  const img = new Uint8Array(M.SIZE).fill(0xFF);
  img.set([0, 6, 2, 0x80, 0, 100, 0], 0); // last setup 1, routing MMMU, pop-up 2, contrast, -, screensaver off, note view
  img.fill(0, M.A.LAST_GROUP, M.A.LAST_GROUP + 16);
  for (let s = 0; s < 16; s++) {
    M.writeName(img, M.setupNameAddr(s), `SE${String(s + 1).padStart(2, '0')}`);
    for (let g = 0; g < 16; g++) {
      M.writeName(img, M.groupNameAddr(s, g), `GR${String(g + 1).padStart(2, '0')}`);
      const d = M.dataBase(s, g);
      for (let i = 0; i < 16; i++) {
        const n = (16 * g + i) & 0x7F;
        img[d + i] = (M.T.CCAB << 4) | s; // type, channel
        img[d + 16 + i] = n; // no link, CC number
        img[d + 32 + i] = 0; // NRPN MSB
        img[d + 48 + i] = 0; // lower
        img[d + 64 + i] = 0xFF; // upper: "max", read as 127 (or 16383 at 14 bits)
        img[d + 80 + i] = (6 << 4) | 1; // Acc3, display 0…127
        img[d + 96 + i] = 0xF0; // 14-bit MSB nibbles: upper max, lower 0
        img[d + 112 + i] = (M.PT.NOTE << 4) | s; // push: Note, same channel
        M.writeName(img, M.encNameAddr(s, g, i), '----');
        img[M.key1Base(s, g) + i] = n; // key mode, note
        img[M.key2Base(s, g) + i] = 0xFF; // display on, lower 127
        img[M.key2Base(s, g) + 16 + i] = 127; // no link, upper 127
      }
    }
  }
  return img;
}
