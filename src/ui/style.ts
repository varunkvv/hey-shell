import { cells } from './text.js';
import type { Span, Style } from './layout.js';

// light shell highlighting and the running shimmer. colors are palette tokens (see theme.ts), never raw colors.
// program bold, flags flag, quoted strings str, $vars var, pipes and operators dim

const seg = new Intl.Segmenter();
const KEYWORDS = new Set(['for', 'in', 'do', 'done', 'if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'case', 'esac', 'time']);
const NEXT_IS_PROGRAM = new Set(['do', 'then', 'else', 'elif', 'time', 'while', 'until', 'if']);
const OPS = '|&;<>()`';

const same = (a: Style, b: Style) => a.b === b.b && a.d === b.d && a.i === b.i && a.u === b.u && a.inv === b.inv && a.fg === b.fg && a.bg === b.bg;

function pusher(out: Span[]) {
  return (t: string, s: Style) => {
    if (!t) return;
    const last = out.at(-1);
    if (last && same(last.s, s)) last.t += t;
    else out.push({ t, s });
  };
}

// the spans always join back to exactly `text`, so ranges into the text can be cut from them with sliceSpans
export function highlight(text: string): Span[] {
  const out: Span[] = [];
  const push = pusher(out);
  const n = text.length;
  let i = 0;
  let cmdPos = true;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      let j = i;
      while (j < n && /\s/.test(text[j])) j++;
      if (text.slice(i, j).includes('\n')) cmdPos = true;
      push(text.slice(i, j), {});
      i = j;
      continue;
    }
    if (OPS.includes(c)) {
      let j = i;
      while (j < n && OPS.includes(text[j])) j++;
      const run = text.slice(i, j);
      if (/[|&;(`]/.test(run)) cmdPos = true;
      push(run, { d: true });
      i = j;
      continue;
    }
    // one word, which can mix plain text and quoted pieces (--name="a b")
    const first = text[i];
    const flag = first === '-' && text[i + 1] !== undefined && !/\s/.test(text[i + 1]);
    let j = i;
    let plain = '';
    const word = { text: '', assign: false };
    const flush = (isFirstPiece: boolean) => {
      if (!plain) return;
      let s: Style = {};
      if (flag) s = { fg: 'flag' };
      else if (plain.includes('$')) s = { fg: 'var' };
      else if (isFirstPiece && KEYWORDS.has(plain)) s = { d: true, i: true };
      else if (isFirstPiece && cmdPos && !/^\w+=/.test(plain)) s = { b: true };
      push(plain, s);
      plain = '';
    };
    let pieces = 0;
    while (j < n && !/\s/.test(text[j]) && !OPS.includes(text[j])) {
      const ch = text[j];
      if (ch === '"' || ch === "'") {
        flush(pieces === 0);
        pieces++;
        let k = j + 1;
        while (k < n && text[k] !== ch) k += ch === '"' && text[k] === '\\' ? 2 : 1;
        k = Math.min(n, k + 1);
        push(text.slice(j, k), { fg: 'str' });
        j = k;
        continue;
      }
      if (ch === '\\' && j + 1 < n) {
        plain += text.slice(j, j + 2);
        j += 2;
        continue;
      }
      plain += ch;
      j++;
    }
    word.text = text.slice(i, j);
    flush(pieces === 0);
    if (NEXT_IS_PROGRAM.has(word.text)) cmdPos = true;
    else if (!/^\w+=/.test(word.text) || pieces === 0 && !/^\w+=/.test(word.text)) cmdPos = false;
    i = j;
  }
  return out;
}

// the spans covering utf-16 offsets [start, end) of the text they came from
export function sliceSpans(spans: Span[], start: number, end: number): Span[] {
  const out: Span[] = [];
  let at = 0;
  for (const sp of spans) {
    const a = Math.max(start, at);
    const b = Math.min(end, at + sp.t.length);
    if (b > a) out.push({ t: sp.t.slice(a - at, b - at), s: sp.s });
    at += sp.t.length;
    if (at >= end) break;
  }
  return out;
}

export const withStyle = (spans: Span[], f: (s: Style) => Style): Span[] => spans.map((sp) => ({ t: sp.t, s: f(sp.s) }));

// a bright band sweeps across dimmed text, like claude code's thinking line. `frame` moves it 2 cells per tick
export function shimmer(spans: Span[], frame: number, width: number, band = 4): Span[] {
  const period = width + 10;
  const p = ((frame * 2) % period) - band;
  const out: Span[] = [];
  const push = pusher(out);
  let col = 0;
  for (const sp of spans) {
    for (const { segment } of seg.segment(sp.t)) {
      const w = cells(segment);
      const lit = col + w > p && col < p + band;
      push(segment, lit ? { ...sp.s, d: undefined, b: true } : { ...sp.s, d: true });
      col += w;
    }
  }
  return out;
}
