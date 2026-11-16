import type { Key } from 'ink';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';

const seg = new Intl.Segmenter();
const parts = (s: string) => [...seg.segment(s)];

export const cells = (s: string) => stringWidth(s);
export const firstGrapheme = (s: string) => parts(s)[0]?.segment ?? '';

// output, commands and model text all reach the screen. strip escapes so none of them can drive the terminal
export function clean(s: string): string {
  return stripVTControlCharacters(s)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      let col = 0;
      return line.replace(/\t|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (c) => {
        if (c !== '\t') return '';
        const n = 8 - (col % 8);
        col += n;
        return ' '.repeat(n);
      });
    })
    .join('\n');
}

// fit into w cells, ending in "…" when cut
export function clip(s: string, w: number): string {
  if (cells(s) <= w) return s;
  let out = '';
  let used = 0;
  for (const { segment } of parts(s)) {
    const n = cells(segment);
    if (used + n > w - 1) break;
    out += segment;
    used += n;
  }
  return w > 0 ? out + '…' : '';
}

// keep the end, for paths that read best from the right
export function clipStart(s: string, w: number): string {
  if (cells(s) <= w) return s;
  const gs = parts(s).map((g) => g.segment);
  let out = '';
  let used = 0;
  while (gs.length) {
    const g = gs.pop()!;
    if (used + cells(g) > w - 1) break;
    out = g + out;
    used += cells(g);
  }
  return w > 0 ? '…' + out : '';
}

export const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - cells(s)));

export type Range = { start: number; end: number };

// word wrap that returns ranges into the source string, so a row can be mapped back to a text offset.
// the line break (or the space it broke at) is not in any range. only the first row gets `first` cells
export function wrap(text: string, w: number, first = w): Range[] {
  const out: Range[] = [];
  let off = 0;
  for (const line of text.split('\n')) {
    const gs = parts(line);
    let gi = 0;
    for (;;) {
      const limit = Math.max(1, out.length === 0 ? first : w);
      let width = 0;
      let j = gi;
      let lastSpace = -1;
      while (j < gs.length) {
        const n = cells(gs[j].segment);
        if (width + n > limit) break;
        width += n;
        if (gs[j].segment === ' ') lastSpace = j;
        j++;
      }
      if (j >= gs.length) {
        out.push({ start: off + (gs[gi]?.index ?? line.length), end: off + line.length });
        break;
      }
      if (gs[j].segment === ' ') {
        out.push({ start: off + gs[gi].index, end: off + gs[j].index });
        gi = j + 1;
      } else if (lastSpace > gi) {
        out.push({ start: off + gs[gi].index, end: off + gs[lastSpace].index });
        gi = lastSpace + 1;
      } else {
        if (j === gi) j++;
        out.push({ start: off + gs[gi].index, end: off + gs[j].index });
        gi = j;
      }
    }
    off += line.length + 1;
  }
  return out;
}

// a text buffer with a cursor. offsets are utf-16 indexes, moves go by grapheme
export type Edit = { text: string; cur: number };

const prev = (t: string, cur: number) => parts(t.slice(0, cur)).at(-1)?.segment.length ?? 0;
const next = (t: string, cur: number) => parts(t.slice(cur))[0]?.segment.length ?? 0;
const lineStart = (t: string, cur: number) => t.lastIndexOf('\n', cur - 1) + 1;
const lineEnd = (t: string, cur: number) => {
  const i = t.indexOf('\n', cur);
  return i < 0 ? t.length : i;
};
const wordStart = (t: string, cur: number) => {
  let i = cur;
  while (i > 0 && /\s/.test(t[i - 1])) i--;
  while (i > 0 && !/\s/.test(t[i - 1])) i--;
  return i;
};
const wordEnd = (t: string, cur: number) => {
  let i = cur;
  while (i < t.length && /\s/.test(t[i])) i++;
  while (i < t.length && !/\s/.test(t[i])) i++;
  return i;
};

export const edit = {
  of: (text: string): Edit => ({ text, cur: text.length }),
  insert: (e: Edit, s: string): Edit => ({ text: e.text.slice(0, e.cur) + s + e.text.slice(e.cur), cur: e.cur + s.length }),
  backspace: (e: Edit): Edit => {
    const n = prev(e.text, e.cur);
    return { text: e.text.slice(0, e.cur - n) + e.text.slice(e.cur), cur: e.cur - n };
  },
  del: (e: Edit): Edit => ({ text: e.text.slice(0, e.cur) + e.text.slice(e.cur + next(e.text, e.cur)), cur: e.cur }),
  left: (e: Edit): Edit => ({ ...e, cur: e.cur - prev(e.text, e.cur) }),
  right: (e: Edit): Edit => ({ ...e, cur: e.cur + next(e.text, e.cur) }),
  home: (e: Edit): Edit => ({ ...e, cur: lineStart(e.text, e.cur) }),
  end: (e: Edit): Edit => ({ ...e, cur: lineEnd(e.text, e.cur) }),
  wordLeft: (e: Edit): Edit => ({ ...e, cur: wordStart(e.text, e.cur) }),
  wordRight: (e: Edit): Edit => ({ ...e, cur: wordEnd(e.text, e.cur) }),
  killWord: (e: Edit): Edit => {
    const i = wordStart(e.text, e.cur);
    return { text: e.text.slice(0, i) + e.text.slice(e.cur), cur: i };
  },
  killLine: (e: Edit): Edit => {
    const i = lineStart(e.text, e.cur);
    return { text: e.text.slice(0, i) + e.text.slice(e.cur), cur: i };
  },
};

// the text offset under a cell column, for mapping a click back into a string
export function offsetAt(text: string, col: number): number {
  let used = 0;
  for (const { segment, index } of parts(text)) {
    const w = cells(segment);
    if (col < used + Math.max(1, w)) return index;
    used += w;
  }
  return text.length;
}

// one keypress applied to a buffer, or undefined when the key is not an editing key. `\n` only goes in when multiline
export function editKey(e: Edit, input: string, key: Key, multiline = false): Edit | undefined {
  if (key.leftArrow) return key.meta || key.ctrl ? edit.wordLeft(e) : edit.left(e);
  if (key.rightArrow) return key.meta || key.ctrl ? edit.wordRight(e) : edit.right(e);
  if (key.home) return edit.home(e);
  if (key.end) return edit.end(e);
  if (key.backspace) return key.meta ? edit.killWord(e) : edit.backspace(e);
  if (key.delete) return edit.del(e);
  if (key.ctrl) {
    const f = { a: edit.home, e: edit.end, w: edit.killWord, u: edit.killLine, b: edit.left, f: edit.right, d: edit.del }[input];
    return f?.(e);
  }
  if (key.meta) return input === 'b' ? edit.wordLeft(e) : input === 'f' ? edit.wordRight(e) : undefined;
  if (key.tab || key.escape || key.return || !input) return undefined;
  // a paste can arrive with its line breaks
  const text = (multiline ? input.replace(/\r\n?/g, '\n') : input.replace(/[\r\n]+/g, ' ')).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  return text ? edit.insert(e, text) : undefined;
}
