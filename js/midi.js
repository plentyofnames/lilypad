// WebMIDI transport for the real EC4. Nothing is requested or sent until the user presses
// Connect, or until Lilypad reconnects on load to the EC4 it was last connected to; it does
// that only when Chrome has already granted MIDI access, so a page load never prompts.

let access = null;

export async function midiAccess() {
  if (access) return access;
  if (!navigator.requestMIDIAccess) throw new Error('This browser has no WebMIDI (use Chrome or Edge).');
  access = await navigator.requestMIDIAccess({ sysex: true });
  return access;
}

// 'granted', 'prompt', 'denied' or 'unknown' (no Permissions API for MIDI).
export async function midiPermission() {
  try {
    return (await navigator.permissions.query({ name: 'midi', sysex: true })).state;
  } catch {
    return 'unknown';
  }
}

export const EC4_NAME = /faderfox ec4/i;

export function listPorts(acc) {
  const ins = [...acc.inputs.values()];
  const outs = [...acc.outputs.values()];
  return { ins, outs };
}

// Pairs plugged-in inputs and outputs by name; EC4 ports first.
export function portPairs(acc) {
  const { ins, outs } = listPorts(acc);
  const live = (p) => p.state !== 'disconnected';
  const pairs = outs.filter(live).map((o) => ({ name: o.name, out: o, in: ins.find((i) => i.name === o.name && live(i)) || null }));
  pairs.sort((a, b) => Number(EC4_NAME.test(b.name)) - Number(EC4_NAME.test(a.name)));
  return pairs.filter((p) => p.in);
}

export function midiTransport(input, output) {
  const port = {
    name: output.name,
    output, // its .state tells when the unit is unplugged
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
