import { execFile } from 'node:child_process';
import { clean } from './text.js';
import { term } from './terminal.js';

const FALLBACK_MS = 5000;

// the text goes in as an argv item and is never parsed as applescript, so quotes and backslashes in model text are inert.
// `--` keeps a message starting with "-" from being read as an osascript option
function ring(body: string) {
  process.stdout.write('\x07');
  const text = clean(body).replace(/\s+/g, ' ').trim().slice(0, 200) || 'waiting for you';
  execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "hey"', '-e', 'end run', '--', text], () => {});
}

let cancel = () => {};

// call when hey stops and waits for the user. rings once when they are not looking:
// the terminal reported focus-out, or it never reports focus and nothing was typed for 5s. never while focused
export function waiting(body: string) {
  cancel();
  let sent = false;
  const send = () => {
    if (sent) return;
    sent = true;
    ring(body);
  };
  const check = () => term.focus === 'blurred' && send();
  check();
  const off = term.subscribe.focus(check);
  const timer = setTimeout(() => term.focus === 'unknown' && send(), FALLBACK_MS);
  cancel = () => {
    sent = true;
    off();
    clearTimeout(timer);
  };
}

// the user acted, so whatever was waiting is over
export const settled = () => cancel();
