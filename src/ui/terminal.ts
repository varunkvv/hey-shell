import { writeSync } from 'node:fs';

// every terminal mode hey turns on lives here, so every exit path can turn them off in one place
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';
const FOCUS_ON = '\x1b[?1004h';
const FOCUS_OFF = '\x1b[?1004l';
const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const CURSOR_ON = '\x1b[?25h';
// synchronized output is written by ink around each frame. if we die mid-frame the terminal would hold the screen, so restore() ends it
const SYNC_OFF = '\x1b[?2026l';
// ask the terminal for its background color. the answer is ESC ] 11 ; rgb:RRRR/GGGG/BBBB (BEL or ESC \)
const BG_QUERY = '\x1b]11;?\x07';
const BG_REPLY = /\x1b\]11;(?:rgba?:)?([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)(?:\/[0-9a-f]+)?(?:\x07|\x1b\\)/gi;
const BG_PARTIAL = /\x1b\](?:1(?:1(?:;[^\x07\x1b]*)?)?)?$|\x1b\]11;[^\x07\x1b]*\x1b$/;
const BG_WAIT_MS = 120;

// sgr mouse report (ESC [ < button ; col ; row M|m) and focus in / out (ESC [ I|O)
const REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[([IO])/g;
const PARTIAL = /\x1b\[<[\d;]*$/;
const PARTIAL_ANY = new RegExp(`${PARTIAL.source}|${BG_PARTIAL.source}`);

export type Focus = 'unknown' | 'focused' | 'blurred';
export type Press = { col: number; row: number };
export type Background = { ready: boolean; light: boolean; bg?: [number, number, number] };

const on = {
  press: new Set<(p: Press) => void>(),
  wheel: new Set<(dir: 1 | -1) => void>(),
  focus: new Set<() => void>(),
  input: new Set<() => void>(),
  theme: new Set<() => void>(),
};
const emit = <T>(set: Set<(a: T) => void>, a: T) => set.forEach((f) => f(a));

let active = false;
let mouse = false;
let focus: Focus = 'unknown';
let unmount: (() => void) | undefined;
let lastData = 0;
// dark until the terminal says otherwise. `ready` flips on the answer or after BG_WAIT_MS, whichever comes first
let background: Background = { ready: false, light: false };
const hexv = (h: string) => parseInt(h, 16) / (16 ** h.length - 1);

// sync on purpose. this also runs from 'exit' and from signal handlers
const write = (s: string) => {
  try {
    writeSync(1, s);
  } catch {}
};

export const term = {
  get focus() {
    return focus;
  },
  get background() {
    return background;
  },
  get mouse() {
    return mouse;
  },
  subscribe: {
    press: (f: (p: Press) => void) => (on.press.add(f), () => void on.press.delete(f)),
    wheel: (f: (dir: 1 | -1) => void) => (on.wheel.add(f), () => void on.wheel.delete(f)),
    focus: (f: () => void) => (on.focus.add(f), () => void on.focus.delete(f)),
    input: (f: () => void) => (on.input.add(f), () => void on.input.delete(f)),
    theme: (f: () => void) => (on.theme.add(f), () => void on.theme.delete(f)),
  },

  // call before render. ink reads stdin with stdin.read(), so filtering read keeps mouse and focus reports out of useInput
  enter(mouseOn: boolean) {
    const { stdin, stdout } = process;
    if (active || !stdin.isTTY || !stdout.isTTY) return;
    active = true;
    mouse = mouseOn;
    const read = stdin.read.bind(stdin);
    let held = '';
    stdin.read = (...args: [number?]) => {
      for (;;) {
        const chunk = read(...args);
        if (chunk === null) return null;
        lastData = Date.now();
        let text = held + String(chunk);
        held = PARTIAL_ANY.exec(text)?.[0] ?? '';
        text = text.slice(0, text.length - held.length).replace(BG_REPLY, (_, r, g, b) => {
          const c: [number, number, number] = [hexv(r), hexv(g), hexv(b)];
          background = { ready: true, light: 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] > 0.5, bg: c.map((x) => x * 255) as [number, number, number] };
          emit(on.theme, undefined);
          return '';
        }).replace(REPORT, (_, b, col, row, end, f) => {
          if (f) {
            focus = f === 'I' ? 'focused' : 'blurred';
            emit(on.focus, undefined);
          } else if (mouse && end === 'M' && !(Number(b) & 32)) {
            const button = Number(b);
            if (button & 64) emit(on.wheel, button & 1 ? 1 : -1);
            else if ((button & 3) === 0) {
              emit(on.input, undefined);
              emit(on.press, { col: Number(col) - 1, row: Number(row) - 1 });
            }
          }
          return '';
        });
        if (text) {
          emit(on.input, undefined);
          return text;
        }
      }
    };
    // frames are already wrapped in synchronized output (DEC 2026) by ink 8, so there is nothing to turn on here
    write(ALT_ON + FOCUS_ON + (mouseOn ? MOUSE_ON : ''));
    // raw mode now, so the answer is not echoed onto the screen. ink turns it on again for itself and restore() turns it off
    try {
      stdin.setRawMode?.(true);
    } catch {}
    write(BG_QUERY);
    setTimeout(() => {
      if (background.ready) return;
      background = { ...background, ready: true };
      emit(on.theme, undefined);
    }, BG_WAIT_MS).unref();
    // every way out. sigkill can't be caught
    process.on('exit', term.restore);
    // on these paths the process is going away. ink's own exit hook may still be mid-unmount, and what it would write
    // now (erasing its frame) belongs to the alt screen we just left, so stdout is muted
    const leave = () => {
      term.restore();
      process.stdout.write = (() => true) as typeof process.stdout.write;
    };
    for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
      process.on(sig, () => {
        leave();
        process.exit(code);
      });
    }
    // a stack trace written inside the alt screen would be lost
    const die = (err: unknown) => {
      leave();
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
      process.exit(1);
    };
    process.on('uncaughtException', die);
    process.on('unhandledRejection', die);
  },

  setMouse(next: boolean) {
    if (!active || next === mouse) return;
    mouse = next;
    write(next ? MOUSE_ON : MOUSE_OFF);
  },

  // stop reports before leaving, then keep ink filtering stdin until it has been quiet for 60ms (at most 400ms).
  // a report still in flight, like the release of the click that is closing hey, would otherwise land in the shell as typed text
  async quiet() {
    if (!active) return;
    mouse = false;
    write(MOUSE_OFF + FOCUS_OFF);
    const start = Date.now();
    lastData = start;
    while (Date.now() - lastData < 60 && Date.now() - start < 400) await new Promise((r) => setTimeout(r, 10));
  },

  // ink also unmounts on exit, and its last frame would land on the normal screen if it ran after restore
  onRestore(fn: () => void) {
    unmount = fn;
  },

  // safe to call any number of times
  restore() {
    if (!active) return;
    active = false;
    mouse = false;
    try {
      unmount?.();
    } catch {}
    write(SYNC_OFF + MOUSE_OFF + FOCUS_OFF + ALT_OFF + CURSOR_ON);
    try {
      process.stdin.setRawMode?.(false);
    } catch {}
  },
};
