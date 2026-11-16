import { homedir } from 'node:os';
import { cells, clip, clipStart, firstGrapheme, wrap } from './text.js';
import type { Edit } from './text.js';

// the whole screen is computed here as plain rows, so scrolling, the sticky header, the scrollbar and click mapping are arithmetic.
// ink only prints the rows. see plans/2026-11-16-hey-ui-redesign.md for the look

export const MAX_WIDTH = 100;
export const OUTPUT_CAP = 2000;
const FAILED_LINES = 2;
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

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
  | { t: 'prompt'; base: number }
  | { t: 'editAt'; start: number; end: number; x: number }
  | { t: 'page'; dir: 1 | -1 }
  | { t: 'bottom' }
  | { t: 'tab' };

export type Style = { b?: boolean; d?: boolean; u?: boolean; inv?: boolean; fg?: 'green' | 'red' | 'cyan' | 'black'; bg?: 'yellow' };
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
  | { kind: 'question'; n: number; total: number; question: string; options: { label: string; description: string }[]; index: number; typing?: Edit };

export type Mode = 'prompt' | 'browse' | 'running' | 'approval' | 'edit' | 'question';

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

const secs = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
const n = (x: number) => x.toLocaleString('en-US');
const plural = (x: number, w: string) => `${x} ${w}${x === 1 ? '' : 's'}`;

function result(s: Step, now: number): { text: string; style: Style } {
  if (s.status === 'running') return { text: secs(now - s.startedAt), style: { d: true } };
  if (s.status === 'declined') return { text: 'skipped', style: { d: true } };
  if (s.status === 'stopped') return { text: 'stopped', style: { d: true } };
  if (s.status === 'failed') return { text: s.code === undefined ? 'failed' : `exit ${s.code}`, style: { fg: 'red' } };
  if (s.total === 0) return { text: '', style: {} };
  if (s.total === 1) return { text: clip(s.output[0].trim(), 14), style: {} };
  return { text: `${n(s.total)} lines`, style: { d: true } };
}

function glyph(s: Step, frame: number): { t: string; s: Style } {
  if (s.status === 'running') return { t: SPINNER[frame % SPINNER.length], s: { fg: 'cyan' } };
  if (s.status === 'ok') return { t: '✓', s: { fg: 'green' } };
  if (s.status === 'failed') return { t: '✗', s: { fg: 'red' } };
  return { t: '-', s: { d: true } };
}

function stepRows(v: View, s: Step, cw: number): Row[] {
  const out: Row[] = [];
  const sel = v.selected?.kind === 'step' && v.selected.id === s.id;
  const re = cw - 1;
  const g = glyph(s, v.frame);
  const r = result(s, v.now);
  const firstLine = s.command.split('\n')[0] + (s.command.includes('\n') ? ' …' : '');
  const showResult = cw + 1 >= 70 && r.text !== '';
  const avail = re - 4 - (showResult ? cells(r.text) + 2 : 0);
  const text = clip(firstLine, avail);
  const [prog, ...rest] = text.split(/(?<=\S)(?=\s)/);
  const head = line();
  head.meta = { step: s.id, part: 'head' };
  head.row = { t: 'step', id: s.id };
  head.add(sel || s.expanded ? (s.expanded ? '▾' : '▸') : ' ', sel ? { fg: 'cyan' } : { d: true }).add(' ').add(g.t, g.s).add(' ');
  head.add(prog ?? '', { b: true }).add(rest.join(''), s.expanded ? { b: true } : {});
  if (showResult) head.to(re - cells(r.text)).add(r.text, r.style);
  out.push(head.done());

  const tagged = (l: Line, part: Meta['part'], idx?: number) => {
    l.meta = { step: s.id, part, idx };
    return l.done();
  };
  if (s.expanded) {
    if (cells(firstLine) > avail || s.command.includes('\n')) {
      const ranges = wrap(s.command, cw - 8, cw - 8);
      for (const rg of ranges) out.push(tagged(line().to(6).add(s.command.slice(rg.start, rg.end), { d: true }), 'cmd'));
    }
    const a = line().to(4);
    const copied = (what: string) => v.flash?.step === s.id && v.flash.what === what;
    a.add(copied('command') ? 'copied ✓' : 'copy command', copied('command') ? { fg: 'green' } : { u: true }, { t: 'copy', what: 'command', step: s.id });
    a.add('  ·  ', { d: true });
    a.add(copied('output') ? 'copied ✓' : 'copy output', copied('output') ? { fg: 'green' } : { u: true }, { t: 'copy', what: 'output', step: s.id });
    a.add('  ·  ', { d: true });
    a.add('collapse', { u: true }, { t: 'step', id: s.id });
    out.push(tagged(a, 'action'));
    if (s.total > s.output.length) out.push(tagged(line().to(6).add(`last ${n(s.output.length)} of ${n(s.total)}`, { d: true }), 'out'));
    if (!s.output.length) out.push(tagged(line().to(6).add('no output', { d: true }), 'out'));
    s.output.forEach((l, i) => out.push(tagged(line().to(6).add(clip(l, cw - 6)), 'out', i)));
  } else if (s.status === 'failed' && s.output.length) {
    for (const l of s.output.slice(-FAILED_LINES)) out.push(line().to(6).add(clip(l, cw - 6)).done());
    if (s.total > FAILED_LINES) {
      const more = line().to(6).add(`+${n(s.total - FAILED_LINES)} lines`, { u: true });
      more.row = { t: 'step', id: s.id };
      out.push(more.done());
    }
  }
  return out;
}

function answerRows(t: Turn, cw: number, latest: boolean): Row[] {
  const out: Row[] = [];
  const re = cw - 1;
  const w = cw - 5;
  const ranges = wrap(t.answer, w, w - 6);
  ranges.forEach((rg, i) => {
    const l = line().to(2).add('▌').add(' ');
    const txt = t.answer.slice(rg.start, rg.end);
    l.add(txt, i === 0 ? { b: true } : {});
    if (i === 0) l.to(re - 4).add('copy', { u: true }, { t: 'copy', what: 'answer', turn: t.id });
    out.push(l.done());
  });
  const reuse = latest ? reuseOf(t) : undefined;
  if (reuse) {
    out.push(line().to(2).add('▌').done());
    const rr = wrap(reuse, w - 2, w - 2 - 11);
    rr.forEach((rg, i) => {
      const l = line().to(2).add('▌').add(' ');
      l.add(i === 0 ? '$ ' : '  ', { d: true }).add(reuse.slice(rg.start, rg.end));
      if (i === 0) {
        l.to(re - 9).add('copy', { u: true }, { t: 'copy', what: 'reuse', turn: t.id }).add('  ').add('tab', { b: true, u: true }, { t: 'tab' });
      }
      out.push(l.done());
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
    rq.forEach((rg, i) => out.push(line().add(i === 0 ? '›' : ' ', { fg: 'cyan', b: true }).add(' ').add(t.request.slice(rg.start, rg.end), { b: true }).done()));
    const folded = t.folded && !last;
    if (!last && t.steps.length) {
      const sel = v.selected?.kind === 'fold' && v.selected.turn === t.id;
      const f = line();
      f.row = { t: 'fold', turn: t.id };
      f.add(sel ? '▸' : ' ', { fg: 'cyan' }).add(' ').add(folded ? '▸' : '▾', { d: true }).add(' ');
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

const rule = (w: number, badge?: string) => {
  const l = line().add('──', { d: true });
  if (badge) l.add(` ${badge} `, { b: true, fg: 'black', bg: 'yellow' }).add('─'.repeat(Math.max(0, w - 4 - cells(badge))), { d: true });
  else l.add('─'.repeat(Math.max(0, w - 2)), { d: true });
  return l.done();
};

type Hint = { key: string; label: string; action?: Action };

function statusRow(v: View, w: number, hints: Hint[]): Row {
  const badges: { text: string; style: Style; action?: Action }[] = [];
  if (v.flash) badges.push({ text: v.flash.text, style: { fg: 'green' } });
  if (v.newBelow) badges.push({ text: 'new below ↓', style: { b: true, u: true }, action: { t: 'bottom' } });
  if (v.mouseOff) badges.push({ text: ' mouse off  ctrl-t to turn on ', style: { inv: true } });
  const badgeW = badges.reduce((a, b) => a + cells(b.text) + 2, 0);
  const hintW = (hs: Hint[]) => hs.reduce((a, h, i) => a + cells(h.key) + 1 + cells(h.label) + (i ? 3 : 0), 0);
  const cwd = v.cwd ?? shortCwd(process.cwd());
  const shown = [...hints];
  while (shown.length && cells(cwd) > w - hintW(shown) - 2 - badgeW && w - hintW(shown) - 2 - badgeW < Math.min(cells(cwd), 12)) shown.pop();
  const l = line();
  const hw = hintW(shown) + (shown.length ? 1 : 0);
  l.add(clipStart(cwd, Math.max(1, w - hw - badgeW - 1)), { d: true });
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

function button(l: Line, label: string, hint: string, style: Style, action?: Action) {
  const x0 = l.col;
  l.add('[ ').add(label, style);
  if (hint) l.add('  ').add(hint, { d: true });
  l.add(' ]');
  if (action) l.hits.push({ x0, x1: l.col, action });
}

function promptRow(v: View, w: number, focused: boolean, empty: boolean): Row {
  const l = line();
  l.add('›', { fg: 'cyan', b: true }).add(' ');
  l.row = { t: 'prompt', base: 0 };
  const room = w - 3;
  const { text, cur } = v.draft;
  if (!text) {
    const hint = empty ? 'ask for something in plain english' : 'follow up';
    if (focused) l.add(hint[0], { inv: true }).add(hint.slice(1), { d: true });
    else l.add(hint, { d: true });
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
  const running = line().to(2).add(`${count ? `running ${plural(count, 'step')}` : 'working'} · ${secs(v.now - (t?.startedAt ?? v.now))}`, { d: true }).done();
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
  const head: Row[] = [rule(w, editing ? 'edit' : 'approve')];
  const descText = editing && dirty ? `was: ${desc}` : desc;
  for (const rg of wrap(descText, w - 4)) head.push(line().to(2).add(descText.slice(rg.start, rg.end), editing && dirty ? { d: true } : { b: true }).done());
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
  const body: Row[] = [];
  for (let i = from; i < from + visible; i++) {
    const rg = ranges[i];
    const l = line().to(2).add(i === 0 ? '$ ' : '    ', { d: true });
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
    } else l.add(text.slice(rg.start, rg.end));
    body.push(l.done());
  }
  const seenEnd = from + visible >= ranges.length;
  const buttons = line().to(2);
  if (editing) {
    button(buttons, 'run edited', 'enter', { b: true, inv: true }, { t: 'runEdited' });
    buttons.add('   ');
    button(buttons, 'back', 'esc', {}, { t: 'back' });
    const hint = 'ctrl-j newline';
    buttons.to(w - cells(hint) - 2).add(hint, { d: true });
  } else {
    const live = v.armed && seenEnd;
    button(buttons, 'run', 'enter', live ? { b: true, inv: true } : { d: true }, live ? { t: 'run' } : undefined);
    buttons.add('   ');
    button(buttons, 'edit', 'e', {}, { t: 'edit' });
    buttons.add('   ');
    button(buttons, 'skip', 'esc', {}, { t: 'skip' });
    buttons.to(w - 6).add('copy', { u: true }, { t: 'copy', what: 'command' });
  }
  const hints: Hint[] = !editing && !seenEnd ? [{ key: 'pgdn', label: 'more', action: { t: 'page', dir: 1 } }] : [];
  return { rows: [...head, ...body, blank(), buttons.done(), statusRow(v, w, hints)], cmdMax: Math.max(0, ranges.length - visible) };
}

function dockQuestion(v: View, w: number, c: Extract<Card, { kind: 'question' }>): Row[] {
  const rows: Row[] = [rule(w, c.total > 1 ? `question ${c.n}/${c.total}` : 'question')];
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
      l.add('› ', { fg: 'cyan', b: true });
      const { text, cur } = c.typing;
      l.add(text.slice(0, cur)).add(text[cur] ?? ' ', { inv: true }).add(text.slice(cur + 1));
    } else {
      button(l, clip(label, lw) + ' '.repeat(Math.max(0, lw - cells(clip(label, lw)))), '', on ? { b: true, inv: true } : {}, { t: 'option', i });
      const d = isOther ? 'type your own answer' : c.options[i].description;
      l.add('  ').add(clip(d, Math.max(0, w - l.col - 2)), { d: true });
    }
    rows.push(l.done());
  });
  rows.push(blank());
  const b = line().to(2);
  if (c.typing) {
    button(b, 'send', 'enter', { b: true, inv: true }, { t: 'key', key: 'enter' });
    b.add('   ');
    button(b, 'back', 'esc', {}, { t: 'key', key: 'esc' });
  } else {
    button(b, 'answer', 'enter', v.armed ? { b: true, inv: true } : { d: true }, { t: 'key', key: 'enter' });
    b.add('   ');
    button(b, 'skip', 'esc', {}, { t: 'key', key: 'esc' });
    const hint = '↑↓ choose';
    b.to(w - cells(hint) - 2).add(hint, { d: true });
  }
  rows.push(b.done());
  rows.push(statusRow(v, w, hints));
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
      const g = glyph(step, v.frame);
      const sel = v.selected?.kind === 'step' && v.selected.id === step.id;
      const label = idx.length ? `lines ${n(off + Math.min(...idx) + 1)}-${n(off + Math.max(...idx) + 1)} of ${n(step.total)}` : '';
      l.add('▾', sel ? { fg: 'cyan' } : { d: true }).add(' ').add(g.t, g.s).add(' ').add(clip(step.command.split('\n')[0], cw - 5 - cells(label) - 2), { b: true });
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
      l.add(thumb ? '┃' : '│', thumb ? {} : { d: true });
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
