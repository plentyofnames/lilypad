// Decides what a TOUCH event from the device selects. Pushing a knob usually twists it a
// little too, so a turn event doesn't take the selection away from that knob's push button
// unless the knob keeps turning. Other controls are selected right away.

export const PUSH_GRACE_MS = 500; // turns of the pushed knob this soon after the push belong to it
export const TURN_STREAK_MS = 700; // a second turn event this soon after the first is real turning

export class TouchFilter {
  constructor() {
    this.pushAt = new Map();
    this.turnAt = new Map();
  }

  // sel: the editor's {setup, group, kind, index}; ev: the TOUCH {kind, index, setup, group}.
  // Returns 'enc' or 'push' to select, or null to keep the current selection.
  decide(sel, ev, now) {
    const key = `${ev.setup}/${ev.group}/${ev.index}`;
    if (ev.kind === 1) {
      this.pushAt.set(key, now);
      this.turnAt.delete(key);
      return 'push';
    }
    const onItsPush = sel.kind === 'push' && sel.index === ev.index && sel.setup === ev.setup && sel.group === ev.group;
    if (!onItsPush) {
      this.turnAt.set(key, now);
      return 'enc';
    }
    if (now - (this.pushAt.get(key) ?? -Infinity) < PUSH_GRACE_MS) {
      this.turnAt.delete(key); // part of the push, doesn't start a streak
      return null;
    }
    const streak = now - (this.turnAt.get(key) ?? -Infinity) < TURN_STREAK_MS;
    this.turnAt.set(key, now);
    return streak ? 'enc' : null;
  }
}
