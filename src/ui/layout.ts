import { homedir } from 'node:os';
import { cells, clip, clipStart, firstGrapheme, wrap } from './text.js';
import type { Edit } from './text.js';
import { highlight, shimmer, sliceSpans, withStyle } from './style.js';

// the whole screen is computed here as plain rows, so scrolling, the sticky header, the scrollbar and click mapping are arithmetic.
// ink only prints the rows. see plans/2026-11-16-hey-ui-redesign.md for the look

// the frame spans the terminal. cli.tsx still min()s its width with this, so it stays exported and unbounded
export const MAX_WIDTH = Infinity;
// long prose is capped so lines stay readable on a wide screen. the frame itself is not
export const ANSWER_WIDTH = 120;
export const OUTPUT_CAP = 2000;
const FAILED_LINES = 2;
const SPINNER = '⣾⣽⣻⢿⡿⣟⣯⣷';

export type Step = {
  id: string;
  command: string;
  description?: string;
  asked: boolean;
  status: 'running' | 'pending' | 'ok' | 'failed' | 'declined' | 'stopped';
  code?: number;
  output: string[];
  total: number;
  startedAt: number;
  endedAt?: number;
  expanded: boolean;
};

export type Turn = {
  id: number;
  request: string;
  steps: Step[];
  answer: string;
  reuse?: string;
  folded: boolean;
  stopped: boolean;
  startedAt: number;
  endedAt?: number;
};

export type Sel = { kind: 'step'; id: string } | { kind: 'fold'; turn: number };
export type KeyName = 'enter' | 'esc' | 'tab';

export type Action =
  | { t: 'step'; id: string }
  | { t: 'fold'; turn: number }
  | { t: 'copy'; what: 'command' | 'output' | 'answer' | 'reuse'; step?: string; turn?: number }
  | { t: 'key'; key: KeyName }
  | { t: 'run' }
  | { t: 'edit' }
  | { t: 'skip' }
  | { t: 'back' }
  | { t: 'runEdited' }
  | { t: 'option'; i: number }
  | { t: 'chip'; kind: 'mode' | 'model' }
  | { t: 'prompt'; base: number }
  | { t: 'editAt'; start: number; end: number; x: number }
  | { t: 'page'; dir: 1 | -1 }
  | { t: 'bottom' }
  | { t: 'tab' };

// colors are tokens, resolved to a palette in theme.ts. tint is a faint wash of the terminal's own background
export type Tone = 'accent' | 'ok' | 'err' | 'flag' | 'str' | 'var' | 'value' | 'badgeText';
export type Style = { b?: boolean; d?: boolean; i?: boolean; u?: boolean; inv?: boolean; fg?: Tone; bg?: 'badge' | 'accent' | 'err' | 'tint' };
export type Span = { t: string; s: Style };
export type Hit = { x0: number; x1: number; action: Action };
type Meta = { step: string; part: 'head' | 'cmd' | 'action' | 'out'; idx?: number };
export type Row = { spans: Span[]; hits: Hit[]; row?: Action; meta?: Meta };

class Line {
  spans: Span[] = [];
  hits: Hit[] = [];
  col = 0;
  row?: Action;
  meta?: Meta;
  add(t: string, s: Style = {}, action?: Action) {
    if (!t) return this;
    const w = cells(t);
    this.spans.push({ t, s });
    if (action) this.hits.push({ x0: this.col, x1: this.col + w, action });
    this.col += w;
    return this;
  }
  to(col: number) {
    return this.add(' '.repeat(Math.max(0, col - this.col)));
  }
  done(): Row {
    return { spans: this.spans, hits: this.hits, row: this.row, meta: this.meta };
  }
}
const line = () => new Line();
const blank = (): Row => line().done();

export type Card =
  | { kind: 'approval'; description?: string; command: string; scroll: number }
  | { kind: 'edit'; description?: string; original: string; buffer: Edit }
  | { kind: 'question'; n: number; total: number; question: string; options: { label: string; description: string }[]; index: number; typing?: Edit }
  | { kind: 'menu'; title: string; options: { label: string; description: string; current: boolean; danger: boolean }[]; index: number };

export type Mode = 'prompt' | 'browse' | 'running' | 'approval' | 'edit' | 'question' | 'menu';

export type View = {
  cols: number;
  rows: number;
  now: number;
  frame: number;
  turns: Turn[];
  mode: Mode;
  selected?: Sel;
  scroll: { stuck: boolean; top: number; seen: number };
  reveal: boolean;
  draft: Edit;
  card?: Card;
  armed: boolean;
  flash?: { text: string; step?: string; what?: string };
  mouseOff: boolean;
  permission: string;
  model: string;
  newBelow?: boolean;
  cwd?: string;
  canTab: boolean;
};

export type Layout = {
  rows: Row[];
  top: number;
  maxTop: number;
  total: number;
  viewH: number;
  newBelow: boolean;
  cmdMax: number;
};

const home = homedir();
export const shortCwd = (cwd: string) => (cwd === home || cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd);

export const reuseOf = (t: Turn) => t.reuse ?? [...t.steps].reverse().find((s) => s.status === 'ok')?.command;

// everything the keys can land on, in display order
export function selectables(turns: Turn[]): Sel[] {
  const out: Sel[] = [];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (!last && t.steps.length) out.push({ kind: 'fold', turn: t.id });
    if (last || !t.folded) for (const s of t.steps) if (s.status !== 'pending') out.push({ kind: 'step', id: s.id });
  });
  return out;
}

const modeLabel = (m: string) => (m === 'bypassPermissions' ? 'bypass' : m === 'acceptEdits' ? 'accept edits' : m);
const secs = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
const n = (x: number) => x.toLocaleString('en-US');
const plural = (x: number, w: string) => `${x} ${w}${x === 1 ? '' : 's'}`;

function result(s: Step, now: number): { text: string; style: Style } {
  if (s.status === 'running') return { text: secs(now - s.startedAt), style: { d: true, i: true } };
  if (s.status === 'declined') return { text: 'skipped', style: { d: true } };
  if (s.status === 'stopped') return { text: 'stopped', style: { d: true } };
  if (s.status === 'failed') return { text: s.code === undefined ? 'failed' : `exit ${s.code}`, style: { fg: 'err' } };
  if (s.total === 0) return { text: '', style: {} };
  if (s.total === 1) return { text: clip(s.output[0].trim(), 14), style: { fg: 'value' } };
  return { text: `${n(s.total)} lines`, style: { d: true } };
}

// a step that just finished fades its mark in (dim, then bold, then settled). frozen mid-way it is still a plain mark
function glyph(s: Step, v: Pick<View, 'frame' | 'now'>): { t: string; s: Style } {
  const age = s.endedAt === undefined ? Infinity : v.now - s.endedAt;
  const fade: Style = age < 120 ? { d: true } : age < 420 ? { b: true } : {};
  if (s.status === 'running') return { t: SPINNER[v.frame % SPINNER.length], s: { fg: 'accent' } };
  if (s.status === 'ok') return { t: '✓', s: { fg: 'ok', ...fade } };
  if (s.status === 'failed') return { t: '✗', s: { fg: 'err', ...fade } };
  return { t: '-', s: { d: true } };
}

function stepRows(v: View, s: Step, cw: number): Row[] {
  const out: Row[] = [];
  const sel = v.selected?.kind === 'step' && v.selected.id === s.id;
  const re = cw - 1;
  const g = glyph(s, v);
  const r = result(s, v.now);
  const firstLine = s.command.split('\n')[0] + (s.command.includes('\n') ? ' …' : '');
  const showResult = cw + 1 >= 70 && r.text !== '';
  const avail = re - 4 - (showResult ? cells(r.text) + 2 : 0);
  const text = clip(firstLine, avail);
  const hl = highlight(text);
  const quiet = s.status === 'declined' || s.status === 'stopped';
  const body = s.status === 'running' ? shimmer(hl, v.frame, cells(text)) : quiet ? withStyle(hl, (st) => ({ ...st, d: true })) : hl;
  const head = line();
  head.meta = { step: s.id, part: 'head' };
  head.row = { t: 'step', id: s.id };
  head.add(sel || s.expanded ? (s.expanded ? '▾' : '▸') : ' ', sel ? { fg: 'accent' } : { d: true }).add(' ').add(g.t, g.s).add(' ');
  for (const sp of body) head.add(sp.t, sp.s);
  if (showResult) head.to(re - cells(r.text)).add(r.text, r.style);
  out.push(head.done());

  const tagged = (l: Line, part: Meta['part'], idx?: number) => {
    l.meta = { step: s.id, part, idx };
    return l.done();
  };
  if (s.expanded) {
    if (cells(firstLine) > avail || s.command.includes('\n')) {
      const ranges = wrap(s.command, cw - 8, cw - 8);
      const cmdSpans = highlight(s.command);
      for (const rg of ranges) {
        const l = line().to(6);
        for (const sp of sliceSpans(cmdSpans, rg.start, rg.end)) l.add(sp.t, { ...sp.s, d: true });
        out.push(tagged(l, 'cmd'));
      }
    }
    const a = line().to(4);
    const copied = (what: string) => v.flash?.step === s.id && v.flash.what === what;
    a.add(copied('command') ? 'copied ✓' : 'copy command', copied('command') ? { fg: 'ok' } : { u: true, fg: 'accent' }, { t: 'copy', what: 'command', step: s.id });
    a.add('  ·  ', { d: true });
    a.add(copied('output') ? 'copied ✓' : 'copy output', copied('output') ? { fg: 'ok' } : { u: true, fg: 'accent' }, { t: 'copy', what: 'output', step: s.id });
    a.add('  ·  ', { d: true });
    a.add('collapse', { u: true, fg: 'accent' }, { t: 'step', id: s.id });
    out.push(tagged(a, 'action'));
    if (s.total > s.output.length) out.push(tagged(line().to(6).add(`last ${n(s.output.length)} of ${n(s.total)}`, { d: true, i: true }), 'out'));
    if (!s.output.length) out.push(tagged(line().to(6).add('no output', { d: true, i: true }), 'out'));
    s.output.forEach((l, i) => out.push(tagged(line().to(6).add(clip(l, cw - 6)), 'out', i)));
  } else if (s.status === 'failed' && s.output.length) {
    for (const l of s.output.slice(-FAILED_LINES)) out.push(line().to(6).add(clip(l, cw - 6)).done());
    if (s.total > FAILED_LINES) {
      const more = line().to(6).add(`+${n(s.total - FAILED_LINES)} lines`, { u: true, fg: 'accent' });
      more.row = { t: 'step', id: s.id };
      out.push(more.done());
    }
  }
  return out;
}

// blank lines in an answer read as big gaps in a terminal. keep one between paragraphs, none around lists or after a lead-in ending in ":"
export function tidy(text: string): string {
  const lines = text.split('\n').map((l) => l.trimEnd());
  const item = (l?: string) => l !== undefined && /^\s*([-*•]|\d+[.)])\s/.test(l);
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (l === '') {
      const prev = out.at(-1);
      if (prev === undefined || prev === '') return;
      if (prev.endsWith(':') || item(lines.slice(i + 1).find((x) => x !== ''))) return;
    }
    out.push(l);
  });
  while (out.at(-1) === '') out.pop();
  return out.join('\n');
}

// a row with the answer-block wash behind it, from the bar to the right edge
function tinted(l: Line, end: number): Row {
  const row = l.done();
  const spans = row.spans.map((sp, i) => (i === 0 && sp.t === '  ' ? sp : { t: sp.t, s: { ...sp.s, bg: 'tint' as const } }));
  const used = spans.reduce((a, sp) => a + cells(sp.t), 0);
  if (used < end) spans.push({ t: ' '.repeat(end - used), s: { bg: 'tint' } });
  return { ...row, spans };
}

function answerRows(t: Turn, cw: number, latest: boolean): Row[] {
  const out: Row[] = [];
  const re = cw - 1;
  const wFull = cw - 5;
  const w = Math.min(wFull, ANSWER_WIDTH);
  const text = tidy(t.answer);
  const ranges = wrap(text, w, Math.min(w, wFull - 6));
  const bar = (l: Line) => l.to(2).add('▌', { fg: 'accent' }).add(' ');
  ranges.forEach((rg, i) => {
    const l = bar(line());
    const txt = text.slice(rg.start, rg.end);
    const m = /^(\s*)([-*•]|\d+[.)])(\s)/.exec(txt);
    if (i === 0) l.add(txt, { b: true });
    else if (m) l.add(m[1]).add(m[2], { fg: 'accent' }).add(txt.slice(m[1].length + m[2].length));
    else l.add(txt);
    if (i === 0) l.to(re - 4).add('copy', { u: true, fg: 'accent' }, { t: 'copy', what: 'answer', turn: t.id });
    out.push(tinted(l, cw));
  });
  const reuse = latest ? reuseOf(t) : undefined;
  if (reuse) {
    out.push(tinted(bar(line()), cw));
    const rr = wrap(reuse, wFull - 2, wFull - 2 - 11);
    const spans = highlight(reuse);
    rr.forEach((rg, i) => {
      const l = bar(line());
      l.add(i === 0 ? '$ ' : '  ', { d: true });
      for (const sp of sliceSpans(spans, rg.start, rg.end)) l.add(sp.t, sp.s);
      if (i === 0) {
        l.to(re - 9).add('copy', { u: true, fg: 'accent' }, { t: 'copy', what: 'reuse', turn: t.id }).add('  ').add('tab', { b: true, u: true, fg: 'accent' }, { t: 'tab' });
      }
      out.push(tinted(l, cw));
    });
  }
  return out;
}

function buildLog(v: View, cw: number): Row[] {
  const out: Row[] = [];
  v.turns.forEach((t, ti) => {
    const last = ti === v.turns.length - 1;
    if (ti > 0) out.push(blank());
    const rq = wrap(t.request, cw - 2);
    rq.forEach((rg, i) => out.push(line().add(i === 0 ? '›' : ' ', { fg: 'accent', b: true }).add(' ').add(t.request.slice(rg.start, rg.end), { b: true }).done()));
    const folded = t.folded && !last;
    if (!last && t.steps.length) {
      const sel = v.selected?.kind === 'fold' && v.selected.turn === t.id;
      const f = line();
      f.row = { t: 'fold', turn: t.id };
      f.add(sel ? '▸' : ' ', { fg: 'accent' }).add(' ').add(folded ? '▸' : '▾', { d: true }).add(' ');
      f.add(`${plural(t.steps.length, 'command')} · ${secs((t.endedAt ?? v.now) - t.startedAt)}`, { d: true, u: true });
      out.push(f.done());
    }
    let shown = 0;
    if (!folded) {
      for (const s of t.steps) {
        if (s.status === 'pending') continue;
        out.push(...stepRows(v, s, cw));
        shown++;
      }
    }
    if (t.stopped) out.push(line().to(2).add('stopped', { d: true }).done());
    if (t.answer) {
      if (shown) out.push(blank());
      out.push(...answerRows(t, cw, last));
    }
  });
  return out;
}

const rule = (w: number, badge?: string, tone: 'badge' | 'accent' = 'badge') => {
  const l = line().add('──', { d: true });
  if (badge) l.add(` ${badge} `, { b: true, fg: 'badgeText', bg: tone }).add('─'.repeat(Math.max(0, w - 4 - cells(badge))), { d: true });
  else l.add('─'.repeat(Math.max(0, w - 2)), { d: true });
  return l.done();
};

type Hint = { key: string; label: string; action?: Action };

function statusRow(v: View, w: number, hints: Hint[]): Row {
  const badges: { text: string; style: Style; action?: Action }[] = [];
  // the mode and model chips open their menu while nothing is running and no card is up
  const pickable = v.mode === 'prompt' || v.mode === 'browse' || v.mode === 'menu';
  const chip = (kind: 'mode' | 'model') => (pickable ? ({ t: 'chip', kind } as const) : undefined);
  const p = v.permission;
  if (p === 'default') badges.push({ text: p, style: { d: true, u: pickable }, action: chip('mode') });
  else badges.push({ text: ` ${modeLabel(p)} `, style: { b: true, fg: 'badgeText', bg: p === 'bypassPermissions' ? 'err' : 'badge' }, action: chip('mode') });
  badges.push({ text: v.model, style: { d: true, u: pickable }, action: chip('model') });
  if (v.flash) badges.push({ text: v.flash.text, style: { fg: 'ok' } });
  if (v.newBelow) badges.push({ text: 'new below ↓', style: { b: true, u: true, fg: 'accent' }, action: { t: 'bottom' } });
  if (v.mouseOff) badges.push({ text: ' mouse off  ctrl-t to turn on ', style: { inv: true } });
  const badgeW = badges.reduce((a, b) => a + cells(b.text) + 2, 0);
  const hintW = (hs: Hint[]) => hs.reduce((a, h, i) => a + cells(h.key) + 1 + cells(h.label) + (i ? 3 : 0), 0);
  const cwd = v.cwd ?? shortCwd(process.cwd());
  const shown = [...hints];
  while (shown.length && cells(cwd) > w - hintW(shown) - 2 - badgeW && w - hintW(shown) - 2 - badgeW < Math.min(cells(cwd), 12)) shown.pop();
  const l = line();
  const hw = hintW(shown) + (shown.length ? 1 : 0);
  l.add(clipStart(cwd, Math.max(1, w - hw - badgeW - 1)), { d: true, i: true });
  for (const b of badges) l.add('  ').add(b.text, b.style, b.action);
  l.to(w - hintW(shown) - 1);
  shown.forEach((h, i) => {
    if (i) l.add('   ');
    const x0 = l.col;
    l.add(h.key, { b: true }).add(' ').add(h.label, { d: true });
    if (h.action) l.hits.push({ x0, x1: l.col, action: h.action });
  });
  return l.done();
}

const key = (k: KeyName, label: string, kk: string = k): Hint => ({ key: kk, label, action: { t: 'key', key: k } });

type Tier = 'primary' | 'secondary' | 'off';

// primary is a filled pill, secondary a dim bracket with a plain label, off is the same bracket all dim (guard still closed)
function button(l: Line, label: string, hint: string, tier: Tier, action?: Action) {
  const x0 = l.col;
  if (tier === 'primary') {
    l.add(' ', { bg: 'accent' }).add(label, { b: true, fg: 'badgeText', bg: 'accent' });
    if (hint) l.add('  ', { bg: 'accent' }).add(hint, { fg: 'badgeText', bg: 'accent' });
    l.add(' ', { bg: 'accent' });
  } else {
    const dim = tier === 'off';
    l.add('[ ', { d: true }).add(label, dim ? { d: true, i: true } : {});
    if (hint) l.add('  ').add(hint, { d: true });
    l.add(' ]', { d: true });
  }
  if (action) l.hits.push({ x0, x1: l.col, action });
}

function promptRow(v: View, w: number, focused: boolean, empty: boolean): Row {
  const l = line();
  l.add('›', { fg: 'accent', b: true }).add(' ');
  l.row = { t: 'prompt', base: 0 };
  const room = w - 3;
  const { text, cur } = v.draft;
  if (!text) {
    const hint = empty ? 'ask for something in plain english' : 'follow up';
    if (focused) l.add(hint[0], { inv: true }).add(hint.slice(1), { d: true, i: true });
    else l.add(hint, { d: true, i: true });
    return l.done();
  }
  // scroll sideways so the cursor stays on screen
  let start = 0;
  while (cells(text.slice(start, cur)) > room - 1) start++;
  const shown = text.slice(start);
  l.row = { t: 'prompt', base: start };
  const at = cur - start;
  const pre = shown.slice(0, at);
  const ch = firstGrapheme(shown.slice(at));
  const post = shown.slice(at + ch.length);
  l.add(pre);
  if (focused) l.add(ch || ' ', { inv: true });
  else l.add(ch);
  l.add(clip(post, Math.max(0, room - cells(pre) - 1)));
  return l.done();
}

function dockPrompt(v: View, w: number): Row[] {
  const rows = [rule(w)];
  const focused = v.mode === 'prompt';
  rows.push(promptRow(v, w, focused, !v.turns.length));
  const hints: Hint[] = [];
  if (!v.turns.length) hints.push(key('esc', 'quit'));
  else if (v.mode === 'browse') {
    const sel = v.selected;
    const open = sel?.kind === 'step' && v.turns.some((t) => t.steps.some((s) => s.id === sel.id && s.expanded));
    hints.push({ key: '↑↓', label: 'select' });
    if (sel) hints.push(key('enter', open ? 'collapse' : 'open'));
    if (sel?.kind === 'step') hints.push(key('tab', 'to shell'));
    hints.push(key('esc', 'back'));
  } else {
    if (v.canTab && !v.draft.text) hints.push(key('tab', 'to shell'));
    hints.push(key('esc', 'browse'));
    hints.push(key('enter', v.draft.text ? 'send' : 'quit'));
  }
  rows.push(statusRow(v, w, hints));
  return rows;
}

function dockRunning(v: View, w: number): Row[] {
  const t = v.turns.at(-1);
  const count = t ? t.steps.filter((s) => s.status !== 'pending').length : 0;
  const running = line().to(2).add(SPINNER[v.frame % SPINNER.length], { fg: 'accent' }).add(' ').add(`${count ? `running ${plural(count, 'step')}` : 'working'} · ${secs(v.now - (t?.startedAt ?? v.now))}`, { d: true, i: true }).done();
  const sel = v.selected?.kind === 'step' && t?.steps.find((s) => s.id === (v.selected as { id: string }).id);
  const hints: Hint[] = [key('esc', 'stop')];
  if (count) hints.push({ key: '↑↓', label: 'select' });
  if (sel) hints.push(key('enter', sel.expanded ? 'collapse' : 'open'));
  return [rule(w), running, statusRow(v, w, hints)];
}

type Dock = { rows: Row[]; cmdMax: number };

function dockApproval(v: View, w: number, card: Extract<Card, { kind: 'approval' | 'edit' }>): Dock {
  const editing = card.kind === 'edit';
  const dirty = editing && card.buffer.text !== card.original;
  const desc = card.description ?? 'run this command';
  const head: Row[] = [rule(w, editing ? 'edit' : 'approve', editing ? 'accent' : 'badge')];
  const descText = editing && dirty ? `was: ${desc}` : desc;
  for (const rg of wrap(descText, w - 4)) head.push(line().to(2).add(descText.slice(rg.start, rg.end), editing && dirty ? { d: true, i: true } : { b: true }).done());
  head.push(blank());
  const text = editing ? card.buffer.text : card.command;
  // the command is never truncated. it wraps with a 4 cell hanging indent, and the region scrolls when it is taller than the screen allows
  const reserve = editing ? 1 : 0;
  const ranges = wrap(text, w - 7 - reserve, w - 5 - reserve);
  const chrome = head.length + 3;
  const cmdMax = Math.max(1, v.rows - chrome - 1);
  let from = 0;
  const visible = Math.min(ranges.length, cmdMax);
  if (editing) {
    const own = ranges.findIndex((r, i) => card.buffer.cur < (ranges[i + 1]?.start ?? Infinity) || i === ranges.length - 1);
    from = Math.max(0, Math.min(own - visible + 1 + Math.floor(visible / 2), ranges.length - visible));
  } else from = Math.min(card.scroll, ranges.length - visible);
  const cmdSpans = editing ? [] : highlight(text);
  const body: Row[] = [];
  for (let i = from; i < from + visible; i++) {
    const rg = ranges[i];
    const l = line().to(2).add(i === 0 ? '$ ' : '    ', i === 0 ? { fg: 'accent', b: true } : { d: true });
    if (editing) {
      const c = card.buffer.cur;
      const owns = c >= rg.start && c < (ranges[i + 1]?.start ?? Infinity) || (i === ranges.length - 1 && c >= rg.start);
      const x = l.col;
      if (owns) {
        const at = Math.min(c, rg.end);
        const rest = text.slice(at, rg.end);
        const ch = firstGrapheme(rest);
        l.add(text.slice(rg.start, at)).add(ch || ' ', { inv: true }).add(rest.slice(ch.length));
      } else l.add(text.slice(rg.start, rg.end));
      l.row = { t: 'editAt', start: rg.start, end: rg.end, x };
    } else for (const sp of sliceSpans(cmdSpans, rg.start, rg.end)) l.add(sp.t, sp.s);
    body.push(editing ? l.done() : tinted(l, w));
  }
  const seenEnd = from + visible >= ranges.length;
  const buttons = line().to(2);
  if (editing) {
    button(buttons, 'run edited', 'enter', 'primary', { t: 'runEdited' });
    buttons.add('   ');
    button(buttons, 'back', 'esc', 'secondary', { t: 'back' });
    const hint = 'ctrl-j newline';
    buttons.to(w - cells(hint) - 2).add(hint, { d: true, i: true });
  } else {
    const live = v.armed && seenEnd;
    button(buttons, 'run', 'enter', live ? 'primary' : 'off', live ? { t: 'run' } : undefined);
    buttons.add('   ');
    button(buttons, 'edit', 'e', 'secondary', { t: 'edit' });
    buttons.add('   ');
    button(buttons, 'skip', 'esc', 'secondary', { t: 'skip' });
    buttons.to(w - 6).add('copy', { u: true, fg: 'accent' }, { t: 'copy', what: 'command' });
  }
  const hints: Hint[] = !editing && !seenEnd ? [{ key: 'pgdn', label: 'more', action: { t: 'page', dir: 1 } }] : [];
  return { rows: [...head, ...body, blank(), buttons.done(), statusRow(v, w, hints)], cmdMax: Math.max(0, ranges.length - visible) };
}

function dockQuestion(v: View, w: number, c: Extract<Card, { kind: 'question' }>): Row[] {
  const rows: Row[] = [rule(w, c.total > 1 ? `question ${c.n}/${c.total}` : 'question', 'accent')];
  for (const rg of wrap(c.question, w - 4)) rows.push(line().to(2).add(c.question.slice(rg.start, rg.end), { b: true }).done());
  rows.push(blank());
  const labels = [...c.options.map((o) => o.label), 'other'];
  const lw = Math.min(28, Math.max(...labels.map(cells)));
  const hints: Hint[] = [];
  labels.forEach((label, i) => {
    const l = line().to(2);
    const on = i === c.index;
    const isOther = i === c.options.length;
    if (isOther && c.typing) {
      l.add('❯ ', { fg: 'accent', b: true });
      const { text, cur } = c.typing;
      l.add(text.slice(0, cur)).add(text[cur] ?? ' ', { inv: true }).add(text.slice(cur + 1));
    } else {
      const x0 = l.col;
      const pad = clip(label, lw) + ' '.repeat(Math.max(0, lw - cells(clip(label, lw))));
      l.add(on ? '❯ ' : '  ', { fg: 'accent', b: true }).add(pad, on ? { b: true, fg: 'accent' } : {});
      l.hits.push({ x0, x1: l.col, action: { t: 'option', i } });
      const d = isOther ? 'type your own answer' : c.options[i].description;
      l.add('  ').add(clip(d, Math.max(0, w - l.col - 2)), on ? { i: true } : { d: true, i: true });
    }
    rows.push(l.done());
  });
  rows.push(blank());
  const b = line().to(2);
  if (c.typing) {
    button(b, 'send', 'enter', 'primary', { t: 'key', key: 'enter' });
    b.add('   ');
    button(b, 'back', 'esc', 'secondary', { t: 'key', key: 'esc' });
  } else {
    button(b, 'answer', 'enter', v.armed ? 'primary' : 'off', { t: 'key', key: 'enter' });
    b.add('   ');
    button(b, 'skip', 'esc', 'secondary', { t: 'key', key: 'esc' });
    const hint = '↑↓ choose';
    b.to(w - cells(hint) - 2).add(hint, { d: true, i: true });
  }
  rows.push(b.done());
  rows.push(statusRow(v, w, hints));
  return rows;
}

function dockMenu(v: View, w: number, c: Extract<Card, { kind: 'menu' }>): Row[] {
  const rows: Row[] = [rule(w, c.title, 'accent')];
  const lw = Math.min(28, Math.max(...c.options.map((o) => cells(o.label))));
  c.options.forEach((o, i) => {
    const on = i === c.index;
    const l = line().to(2);
    l.row = { t: 'option', i };
    const pad = clip(o.label, lw) + ' '.repeat(Math.max(0, lw - cells(clip(o.label, lw))));
    l.add(on ? '❯ ' : '  ', { fg: 'accent', b: true }).add(pad, o.danger ? { fg: 'err', b: on } : on ? { b: true, fg: 'accent' } : {});
    l.add(' ').add(o.current ? '✓' : ' ', { fg: 'ok' }).add(' ').add(clip(o.description, Math.max(0, w - l.col - 2)), on ? { i: true } : { d: true, i: true });
    rows.push(l.done());
  });
  rows.push(statusRow(v, w, [{ key: '↑↓', label: 'choose' }, key('enter', 'pick'), key('esc', 'close')]));
  return rows;
}

export function layout(v0: View): Layout {
  const W = Math.min(v0.cols, MAX_WIDTH);
  const cw = W - 1;
  const mk = (v: View): { dock: Row[]; cmdMax: number } => {
    let cmdMax = 0;
    let dock: Row[];
    if (v.card?.kind === 'approval' || v.card?.kind === 'edit') {
      const d = dockApproval(v, W, v.card);
      dock = d.rows;
      cmdMax = d.cmdMax;
    } else if (v.card?.kind === 'question') dock = dockQuestion(v, W, v.card);
    else if (v.card?.kind === 'menu') dock = dockMenu(v, W, v.card);
    else if (v.mode === 'running') dock = dockRunning(v, W);
    else dock = dockPrompt(v, W);
    return { dock: dock.length > v.rows ? dock.slice(dock.length - v.rows) : dock, cmdMax };
  };
  const v = v0;
  let { dock, cmdMax } = mk(v);
  const viewH = v.rows - dock.length;
  const log = buildLog(v, cw);
  const total = log.length;
  const maxTop = Math.max(0, total - viewH);
  let top = v.scroll.stuck ? maxTop : Math.max(0, Math.min(v.scroll.top, maxTop));
  if (v.reveal && v.selected) {
    const at = log.findIndex((r) =>
      v.selected!.kind === 'step' ? r.meta?.part === 'head' && r.meta.step === (v.selected as { id: string }).id : r.row?.t === 'fold' && r.row.turn === (v.selected as { turn: number }).turn,
    );
    if (at >= 0 && at < top) top = at;
    else if (at >= top + viewH) top = at - viewH + 1;
    top = Math.max(0, Math.min(top, maxTop));
  }
  const slice = log.slice(top, top + viewH);
  const pad = Math.max(0, viewH - slice.length);
  const rows: Row[] = [...Array.from({ length: pad }, blank), ...slice];

  // sticky header while the output of an expanded step is on screen but its header is not
  const first = rows[pad];
  if (total > viewH && first?.meta && first.meta.part !== 'head') {
    const step = v.turns.flatMap((t) => t.steps).find((s) => s.id === first.meta!.step);
    const headAt = log.findIndex((r) => r.meta?.part === 'head' && r.meta.step === first.meta!.step);
    if (step && step.expanded && headAt < top) {
      const idx = rows.slice(pad + 1).filter((r) => r.meta?.step === step.id && r.meta.part === 'out' && r.meta.idx !== undefined).map((r) => r.meta!.idx!);
      const off = step.total - step.output.length;
      const l = line();
      l.row = { t: 'step', id: step.id };
      const g = glyph(step, v);
      const sel = v.selected?.kind === 'step' && v.selected.id === step.id;
      const label = idx.length ? `lines ${n(off + Math.min(...idx) + 1)}-${n(off + Math.max(...idx) + 1)} of ${n(step.total)}` : '';
      l.add('▾', sel ? { fg: 'accent' } : { d: true }).add(' ').add(g.t, g.s).add(' ');
      for (const sp of highlight(clip(step.command.split('\n')[0], cw - 5 - cells(label) - 2))) l.add(sp.t, sp.s);
      l.to(cw - 1 - cells(label)).add(label, { d: true });
      rows[pad] = l.done();
    }
  }

  // scrollbar in the last column, only when the log overflows
  if (total > viewH && viewH > 0) {
    const thumbH = Math.max(1, Math.round((viewH * viewH) / total));
    const thumbTop = Math.round(((viewH - thumbH) * top) / Math.max(1, maxTop));
    rows.forEach((r, i) => {
      const l = line();
      l.spans = r.spans;
      l.hits = r.hits;
      l.col = r.spans.reduce((a, s) => a + cells(s.t), 0);
      l.to(cw);
      const thumb = i >= thumbTop && i < thumbTop + thumbH;
      l.hits.push({ x0: cw, x1: cw + 1, action: { t: 'page', dir: i < thumbTop ? -1 : 1 } });
      l.add(thumb ? '▐' : ' ', { d: true });
      rows[i] = { ...l.done(), row: r.row, meta: r.meta };
    });
  }
  const newBelow = !v.scroll.stuck && top < maxTop && total > v.scroll.seen;
  if (newBelow) dock = mk({ ...v, newBelow }).dock;
  return {
    rows: [...rows, ...dock],
    top,
    maxTop,
    total,
    viewH,
    newBelow,
    cmdMax,
  };
}
