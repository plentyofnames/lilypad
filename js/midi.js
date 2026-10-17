// WebMIDI transport for the real EC4. Nothing is requested or sent until the user
// picks the MIDI target and presses Connect.

let access = null;

export async function midiAccess() {
  if (access) return access;
  if (!navigator.requestMIDIAccess) throw new Error('This browser has no WebMIDI (use Chrome or Edge).');
  access = await navigator.requestMIDIAccess({ sysex: true });
  return access;
}

export const EC4_NAME = /faderfox ec4/i;

export function listPorts(acc) {
  const ins = [...acc.inputs.values()];
  const outs = [...acc.outputs.values()];
  return { ins, outs };
}

// Pairs inputs and outputs by name; EC4 ports first.
export function portPairs(acc) {
  const { ins, outs } = listPorts(acc);
  const pairs = outs.map((o) => ({ name: o.name, out: o, in: ins.find((i) => i.name === o.name) || null }));
  pairs.sort((a, b) => Number(EC4_NAME.test(b.name)) - Number(EC4_NAME.test(a.name)));
  return pairs.filter((p) => p.in);
}

export function midiTransport(input, output) {
  const port = {
    name: output.name,
    onmessage: null,
    send(bytes) {
      output.send(bytes);
    },
    close() {
      input.onmidimessage = null;
    },
  };
  input.onmidimessage = (e) => port.onmessage?.(e.data);
  return port;
}
