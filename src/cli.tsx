#!/usr/bin/env node
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { render, useApp, useInput, useWindowSize, type Key } from 'ink';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createAgent, type AgentEvent } from './agent.js';
import { copy } from './ui/clipboard.js';
import {
  layout, MAX_WIDTH, OUTPUT_CAP, reuseOf, selectables,
  type Action, type Card, type KeyName, type Mode, type Sel, type Step, type Turn, type View,
} from './ui/layout.js';
import { settled, waiting } from './ui/notify.js';
import { Screen } from './ui/Screen.js';
import { term } from './ui/terminal.js';
import { clean, edit, editKey, offsetAt, type Edit } from './ui/text.js';
import { formatTranscript } from './ui/transcript.js';

type Question = { question: string; options: { label: string; description: string }[] };
type Asked =
  | { kind: 'approval'; id: string; input: Record<string, unknown>; resolve: (r: PermissionResult) => void }
  | { kind: 'question'; id: string; input: Record<string, unknown>; resolve: (r: PermissionResult) => void; questions: Question[] };
type Ask = { i: number; answers: Record<string, string>; index: number; typing?: Edit };
type CardState = { key: string; edit?: Edit; scroll: number; ask: Ask };
const freshCard = (key: string): CardState => ({ key, scroll: 0, ask: { i: 0, answers: {}, index: 0 } });

const GUARD_MS = 400;
const FLASH_MS = 2000;

const historyFile = join(homedir(), '.hey_history');
const history = existsSync(historyFile) ? readFileSync(historyFile, 'utf8').split('\n').filter(Boolean) : [];
const initial = process.argv.slice(2).join(' ').trim();

let allTurns: Turn[] = [];
let handoff = '';
let handoffCopied = false;

const noKey: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
  super: false, hyper: false, capsLock: false, numLock: false,
};
const keyFor = (k: KeyName): Key => ({ ...noKey, return: k === 'enter', escape: k === 'esc', tab: k === 'tab' });

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const firstLine = (s: string) => s.split('\n')[0];

function toStepOutput(text: string) {
  // the sdk's own placeholder for a command that printed nothing
  const lines = text === '(Bash completed with no output)' ? [] : clean(text).split('\n');
  const code = /^Exit code (\d+)$/.exec(lines[0])?.[1];
  if (code) lines.shift();
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return { code: code ? Number(code) : undefined, output: lines.slice(-OUTPUT_CAP), total: lines.length };
}

function App() {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [mode, setMode] = useState<'prompt' | 'browse' | 'running'>(initial ? 'running' : 'prompt');
  const [draft, setDraft] = useState<Edit>(edit.of(''));
  const [selected, setSelected] = useState<Sel>();
  const [scroll, setScroll] = useState({ stuck: true, top: 0, seen: 0 });
  const [reveal, setReveal] = useState(false);
  const [queue, setQueue] = useState<Asked[]>([]);
  const [cardState, setCardState] = useState<CardState>(freshCard(''));
  const [flash, setFlash] = useState<{ text: string; until: number; step?: string; what?: string }>();
  const [mouse, setMouse] = useState(term.mouse);
  const [, tick] = useState(0);

  const latest = useRef({ turns, queue, selected });
  latest.current = { turns, queue, selected };
  // keys can arrive in a batch before the next render, so the buffers being typed into are also kept in refs
  const liveDraft = useRef(draft);
  liveDraft.current = draft;
  const liveEdit = useRef<Edit | undefined>(undefined);
  const shown = useRef({ key: '', at: 0 });
  const stopping = useRef(false);
  const ended = useRef(new Set<number>());
  const answered = useRef(new Map<number, string>());
  const quitGuard = useRef(0);
  const lastKey = useRef(0);
  const turnId = useRef(0);
  const histAt = useRef(history.length);
  const act = useRef<(a: Action, col: number, quiet: boolean) => void>(() => {});
  const handle = useRef<(input: string, key: Key, quiet?: boolean) => void>(() => {});
  const laid = useRef<ReturnType<typeof layout>>(undefined);

  const updateTurn = (id: number, f: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === id ? f(t) : t)));
  const updateStep = (id: string, f: (s: Step) => Step) =>
    setTurns((ts) => ts.map((t) => (t.steps.some((s) => s.id === id) ? { ...t, steps: t.steps.map((s) => (s.id === id ? f(s) : s)) } : t)));

  const canUseTool: CanUseTool = (tool, input, { toolUseID, signal }) =>
    new Promise((resolve) => {
      let asked: Asked;
      if (tool === 'Bash') asked = { kind: 'approval', id: toolUseID, input, resolve };
      else if (tool === 'AskUserQuestion') asked = { kind: 'question', id: toolUseID, input, resolve, questions: input.questions as Question[] };
      else return resolve({ behavior: 'deny', message: `${tool} is not available` });
      if (asked.kind === 'approval') {
        updateStep(toolUseID, (s) => ({ ...s, status: 'pending', asked: true, description: String(input.description ?? '') || s.description }));
      }
      signal.addEventListener('abort', () => {
        setQueue((q) => q.filter((a) => a !== asked));
        resolve({ behavior: 'deny', message: 'stopped' });
      });
      setQueue((q) => [...q, asked]);
    });
  const agent = useMemo(() => createAgent(canUseTool), []);

  const onEvent = (id: number, e: AgentEvent) => {
    // the stream can still throw after the result, and by then the turn is over
    if (e.type !== 'done' && ended.current.has(id)) return;
    if (e.type === 'step') {
      const pending = latest.current.queue.some((a) => a.id === e.id);
      const step: Step = {
        id: e.id, command: clean(e.command), description: e.description ? clean(e.description) : undefined, asked: pending,
        status: pending ? 'pending' : 'running', output: [], total: 0, startedAt: Date.now(), expanded: false,
      };
      updateTurn(id, (t) => ({ ...t, steps: [...t.steps, step] }));
    } else if (e.type === 'stepDone') {
      const out = toStepOutput(e.text);
      updateStep(e.id, (s) => ({
        ...s,
        ...out,
        // an error with no exit code is a denial when hey denied it, a stop when the user stopped the run, and a failure otherwise (a timeout, say)
        status: !e.isError ? 'ok' : out.code !== undefined ? 'failed' : s.status === 'declined' || s.status === 'pending' ? 'declined' : stopping.current ? 'stopped' : 'failed',
        endedAt: Date.now(),
      }));
    } else if (e.type === 'answer') {
      answered.current.set(id, firstLine(clean(e.text)));
      updateTurn(id, (t) => ({ ...t, answer: clean(e.text), reuse: e.reuse && clean(e.reuse) }));
    } else if (e.type === 'done') endRun(id);
    else if (!stopping.current) updateTurn(id, (t) => ({ ...t, answer: `error: ${e.text}` }));
  };

  const endRun = (id: number) => {
    if (ended.current.has(id)) return;
    ended.current.add(id);
    const stopped = stopping.current;
    updateTurn(id, (t) => ({
      ...t,
      stopped,
      endedAt: Date.now(),
      steps: t.steps.map((s) => (s.status === 'running' ? { ...s, status: 'stopped' as const } : s.status === 'pending' ? { ...s, status: 'declined' as const } : s)),
    }));
    setQueue([]);
    quitGuard.current = Date.now() + GUARD_MS;
    setMode(latest.current.selected ? 'browse' : 'prompt');
    const said = answered.current.get(id);
    if (said && !stopped) waiting(said);
  };

  const startRun = (text: string) => {
    const id = ++turnId.current;
    setTurns((ts) => [...ts.map((t) => ({ ...t, folded: true })), { id, request: text, steps: [], answer: '', folded: false, stopped: false, startedAt: Date.now() }]);
    setMode('running');
    typeDraft(() => edit.of(''));
    setSelected(undefined);
    setScroll({ stuck: true, top: 0, seen: 0 });
    stopping.current = false;
    // a double tap on enter must not read the empty prompt as quit
    quitGuard.current = Date.now() + GUARD_MS;
    agent
      .run(text, (e) => onEvent(id, e))
      .catch((err) => onEvent(id, { type: 'error', text: err instanceof Error ? err.message : String(err) }))
      .finally(() => endRun(id));
  };

  useEffect(() => {
    if (initial) startRun(initial);
  }, []);

  // the card at the head of the queue is what the dock shows. each new one is guarded for 400ms and, if the user is away, announced
  const head = queue[0];
  useEffect(() => {
    if (!head) return settled();
    const body = head.kind === 'question' ? (head.questions[0]?.question ?? 'a question') : String(head.input.description || head.input.command || 'approval');
    waiting(body);
  }, [head]);

  useEffect(() => term.subscribe.input(settled), []);

  const now = Date.now();
  // per-card state belongs to the card, and is decided in the same render that first shows it, so the guard and the edit buffer are never left over from the previous card
  const cardKey = head?.id ?? '';
  if (shown.current.key !== cardKey) shown.current = { key: cardKey, at: now };
  const cs = cardState.key === cardKey ? cardState : freshCard(cardKey);
  const { edit: editBuf, scroll: cmdScroll, ask } = cs;
  liveEdit.current = editBuf;
  const patchCard = (f: (c: CardState) => Partial<CardState>) =>
    setCardState((prev) => {
      const base = prev.key === cardKey ? prev : freshCard(cardKey);
      return { ...base, ...f(base) };
    });
  const setEditBuf = (b: Edit | undefined) => patchCard(() => ({ edit: b }));
  const setCmdScroll = (f: (s: number) => number) => patchCard((c) => ({ scroll: f(c.scroll) }));
  const setAsk = (a: Ask | ((a: Ask) => Ask)) => patchCard((c) => ({ ask: typeof a === 'function' ? a(c.ask) : a }));
  // a card's action keys and clicks only count after 400ms with no input at all, so typing ahead while it appears cannot hit them
  const armed = now >= shown.current.at + GUARD_MS && now >= lastKey.current + GUARD_MS;
  const running = mode === 'running';
  const live = running || !!flash || (!!head && !armed);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, [live]);

  const flashNow = flash && now < flash.until ? flash : undefined;
  const q = head?.kind === 'question' ? head.questions[ask.i] : undefined;
  const effective: Mode = head ? (head.kind === 'question' ? 'question' : editBuf ? 'edit' : 'approval') : mode;
  let card: Card | undefined;
  if (head?.kind === 'approval') {
    const description = String(head.input.description ?? '') || undefined;
    const command = String(head.input.command ?? '');
    card = editBuf ? { kind: 'edit', description, original: command, buffer: editBuf } : { kind: 'approval', description, command, scroll: cmdScroll };
  } else if (head?.kind === 'question' && q) {
    card = { kind: 'question', n: ask.i + 1, total: head.questions.length, question: q.question, options: q.options, index: ask.index, typing: ask.typing };
  }
  const lastTurn = turns.at(-1);
  const view: View = {
    cols: columns, rows, now, frame: Math.floor(now / 100), turns, mode: effective, selected, scroll, reveal, draft, card, armed,
    flash: flashNow && { text: flashNow.text, step: flashNow.step, what: flashNow.what }, mouseOff: !mouse,
    canTab: !!lastTurn && !running && !!reuseOf(lastTurn),
  };
  const lay = layout(view);
  laid.current = lay;

  const scrollTo = (top: number) => {
    const l = laid.current!;
    const t = clamp(top, 0, l.maxTop);
    setReveal(false);
    setScroll((s) => (t >= l.maxTop ? { stuck: true, top: t, seen: l.total } : { stuck: false, top: t, seen: s.stuck ? l.total : s.seen }));
  };
  // the reveal flag only has to survive the render it was set for, so selection changes show their row once and scrolling is free again
  useEffect(() => {
    if (reveal) {
      setScroll((s) => (lay.top >= lay.maxTop ? { stuck: true, top: lay.top, seen: lay.total } : { stuck: false, top: lay.top, seen: s.stuck ? lay.total : s.seen }));
      setReveal(false);
    }
  }, [reveal]);
  const scrollBy = (d: number) => {
    if (card && card.kind === 'approval' && laid.current!.cmdMax > 0) setCmdScroll((s) => clamp(s + d, 0, laid.current!.cmdMax));
    else scrollTo(laid.current!.top + d);
  };

  const finish = () => {
    allTurns = latest.current.turns;
    void term.quiet().then(() => exit());
  };
  const toShell = (command: string | undefined) => {
    if (!command) return;
    handoff = command;
    handoffCopied = copy(command);
    finish();
  };

  const flashed = (text: string, step?: string, what?: string) => {
    const until = Date.now() + FLASH_MS;
    setFlash({ text, until, step, what });
    setTimeout(() => setFlash((f) => (f?.until === until ? undefined : f)), FLASH_MS);
  };
  const doCopy = (what: 'command' | 'output' | 'answer' | 'reuse', stepId?: string, turnId?: number) => {
    const t = turnId !== undefined ? latest.current.turns.find((x) => x.id === turnId) : undefined;
    const s = stepId ? latest.current.turns.flatMap((x) => x.steps).find((x) => x.id === stepId) : undefined;
    const pendingCmd = head?.kind === 'approval' ? String(editBuf?.text ?? head.input.command ?? '') : undefined;
    const text = { command: s?.command ?? pendingCmd, output: s?.output.join('\n'), answer: t?.answer, reuse: t && reuseOf(t) }[what];
    if (text === undefined) return;
    flashed(copy(text) ? `copied ${what} ✓` : 'copy failed (pbcopy)', stepId, what);
  };

  const select = (items: Sel[], i: number) => {
    setSelected(items[i]);
    setReveal(true);
  };
  const move = (d: 1 | -1) => {
    const items = selectables(latest.current.turns);
    if (!items.length) return;
    const at = items.findIndex((x) => (selected?.kind === 'step' ? x.kind === 'step' && x.id === selected.id : selected?.kind === 'fold' && x.kind === 'fold' && x.turn === selected.turn));
    select(items, at < 0 ? items.length - 1 : clamp(at + d, 0, items.length - 1));
  };
  const toggle = (sel: Sel | undefined) => {
    if (sel?.kind === 'step') updateStep(sel.id, (s) => ({ ...s, expanded: !s.expanded }));
    else if (sel?.kind === 'fold') updateTurn(sel.turn, (t) => ({ ...t, folded: !t.folded }));
    else return;
    setReveal(true);
  };
  const pick = (sel: Sel) => {
    setSelected(sel);
    if (mode === 'prompt') setMode('browse');
    toggle(sel);
  };

  const resolveHead = (r: PermissionResult) => {
    head?.resolve(r);
    setQueue((qs) => qs.slice(1));
  };
  const runApproval = (command: string) => {
    if (head?.kind !== 'approval') return;
    updateStep(head.id, (s) => ({ ...s, command: clean(command), status: 'running', startedAt: Date.now() }));
    resolveHead({ behavior: 'allow', updatedInput: { ...head.input, command } });
  };
  const skipApproval = (interrupt = false) => {
    if (head?.kind !== 'approval') return;
    updateStep(head.id, (s) => ({ ...s, status: 'declined' }));
    resolveHead({ behavior: 'deny', message: 'the user declined to run this command', interrupt });
  };
  const stop = () => {
    stopping.current = true;
    agent.stop();
  };
  const answerQuestion = (answer: string) => {
    if (head?.kind !== 'question' || !q) return;
    const answers = { ...ask.answers, [q.question]: answer };
    if (ask.i + 1 < head.questions.length) setAsk({ i: ask.i + 1, answers, index: 0 });
    else resolveHead({ behavior: 'allow', updatedInput: { ...head.input, answers } });
  };
  const pickOption = (i: number) => {
    if (!q) return;
    if (i < q.options.length) answerQuestion(q.options[i].label);
    else setAsk({ ...ask, index: i, typing: edit.of('') });
  };
  const skipQuestion = (interrupt = false) => {
    resolveHead({ behavior: 'deny', message: 'the user skipped the question. do not guess, say what you still need to know and stop', interrupt });
  };
  const submit = (text: string) => {
    const value = text.trim();
    if (!value) return Date.now() >= quitGuard.current && finish();
    appendFileSync(historyFile, value + '\n');
    history.push(value);
    histAt.current = history.length;
    startRun(value);
  };
  const toggleMouse = () => {
    term.setMouse(!term.mouse);
    setMouse(term.mouse);
  };

  const typeDraft = (f: (d: Edit) => Edit) => setDraft((liveDraft.current = f(liveDraft.current)));
  const typeEdit = (f: (b: Edit) => Edit) => liveEdit.current && setEditBuf((liveEdit.current = f(liveEdit.current)));
  // true when the card has been up for 400ms and nothing was typed or clicked for 400ms. every input restarts the guard
  const touch = () => {
    const at = Date.now();
    const quiet = at >= shown.current.at + GUARD_MS && at >= lastKey.current + GUARD_MS;
    lastKey.current = at;
    if (head) tick((n) => n + 1);
    return quiet;
  };
  const hasSteps = turns.some((t) => t.steps.length);
  handle.current = (input, key, passed) => {
    const quiet = passed ?? touch();
    if (key.ctrl && input === 't') return toggleMouse();
    if (key.pageUp || key.pageDown) return scrollBy((key.pageUp ? -1 : 1) * Math.max(1, laid.current!.viewH - 1));
    const ctrlC = key.ctrl && input === 'c';

    if (effective === 'approval') {
      if (ctrlC) {
        skipApproval(true);
        stop();
      } else if (!quiet) return;
      else if (key.return && cmdScroll >= laid.current!.cmdMax) runApproval(String(head!.input.command ?? ''));
      else if (input === 'e' && !key.ctrl && !key.meta) setEditBuf(edit.of(String(head!.input.command ?? '')));
      else if (key.escape) skipApproval();
    } else if (effective === 'edit') {
      if (key.escape || ctrlC) setEditBuf(undefined);
      else if (key.return) liveEdit.current?.text.trim() && runApproval(liveEdit.current.text);
      else if (input === '\n' || (key.meta && key.return)) typeEdit((b) => edit.insert(b, '\n'));
      else typeEdit((b) => editKey(b, input, key, true) ?? b);
    } else if (effective === 'question') {
      if (ctrlC) {
        skipQuestion(true);
        stop();
      } else if (!ask.typing && !quiet) return;
      else if (ask.typing) {
        if (key.escape) setAsk({ ...ask, typing: undefined });
        else if (key.return) ask.typing.text.trim() && answerQuestion(ask.typing.text.trim());
        else setAsk((a) => (a.typing ? { ...a, typing: editKey(a.typing, input, key) ?? a.typing } : a));
      } else if (key.upArrow) setAsk({ ...ask, index: Math.max(0, ask.index - 1) });
      else if (key.downArrow) setAsk({ ...ask, index: Math.min(q!.options.length, ask.index + 1) });
      else if (key.return) pickOption(ask.index);
      else if (key.escape) skipQuestion();
    } else if (effective === 'running') {
      if (ctrlC) stopping.current ? finish() : stop();
      else if (key.escape) stop();
      else if (key.upArrow) move(-1);
      else if (key.downArrow) move(1);
      else if (key.return) toggle(selected);
    } else if (effective === 'browse') {
      if (ctrlC) finish();
      else if (key.upArrow) move(-1);
      else if (key.downArrow) move(1);
      else if (key.return) toggle(selected);
      else if (key.tab && selected?.kind === 'step') toShell(turns.flatMap((t) => t.steps).find((s) => s.id === selected.id)?.command);
      else if (key.escape) {
        setMode('prompt');
        setSelected(undefined);
        setScroll((s) => ({ ...s, stuck: true }));
      }
    } else {
      // prompt
      const text = liveDraft.current.text;
      if (ctrlC) text ? typeDraft(() => edit.of('')) : finish();
      else if (key.ctrl && input === 'd' && !text) finish();
      else if (key.return) submit(text);
      else if (key.tab) !text && lastTurn && toShell(reuseOf(lastTurn));
      else if (key.escape) {
        if (!hasSteps) finish();
        else {
          setMode('browse');
          setSelected(undefined);
        }
      } else if (key.upArrow || key.downArrow) {
        const i = clamp(histAt.current + (key.upArrow ? -1 : 1), 0, history.length);
        histAt.current = i;
        typeDraft(() => edit.of(history[i] ?? ''));
      } else if (!key.ctrl && !key.meta && input.length > 1 && /[\r\n]$/.test(input)) {
        // a paste or fast typing can deliver text and enter in one chunk
        submit(edit.insert(liveDraft.current, input.replace(/[\r\n]+$/, '').replace(/[\r\n]+/g, ' ')).text);
      } else typeDraft((d) => editKey(d, input, key) ?? d);
    }
  };
  useInput((input, key) => handle.current(input, key));

  act.current = (a, col, quiet) => {
    switch (a.t) {
      case 'step': return pick({ kind: 'step', id: a.id });
      case 'fold': return pick({ kind: 'fold', turn: a.turn });
      case 'copy': return doCopy(a.what, a.step, a.turn);
      case 'key': return handle.current('', keyFor(a.key), quiet);
      case 'run': return runApproval(String(head?.input.command ?? ''));
      case 'edit': return setEditBuf(edit.of(String(head?.input.command ?? '')));
      case 'skip': return skipApproval();
      case 'back': return setEditBuf(undefined);
      case 'runEdited': return editBuf?.text.trim() ? runApproval(editBuf.text) : undefined;
      case 'option': return pickOption(a.i);
      case 'prompt':
        if (mode === 'browse') {
          setMode('prompt');
          setSelected(undefined);
        }
        if (mode !== 'running') setDraft({ ...draft, cur: a.base + offsetAt(draft.text.slice(a.base), col - 2) });
        return;
      case 'editAt': return editBuf && setEditBuf({ ...editBuf, cur: a.start + offsetAt(editBuf.text.slice(a.start, a.end), col - a.x) });
      case 'page': return scrollBy(a.dir * Math.max(1, laid.current!.viewH - 1));
      case 'bottom': return scrollTo(laid.current!.maxTop);
      case 'tab': return lastTurn && toShell(reuseOf(lastTurn));
    }
  };

  useEffect(() => {
    const press = ({ col, row }: { col: number; row: number }) => {
      const l = laid.current!;
      const r = l.rows[row];
      if (!r) return;
      const quiet = touch();
      // buttons on an approval or question card are guarded, so a click aimed at the log cannot land on one
      const guarded = row >= l.viewH && head && (effective === 'approval' || (effective === 'question' && !ask.typing));
      if (guarded && !quiet) return;
      const hit = r.hits.find((h) => col >= h.x0 && col < h.x1)?.action ?? r.row;
      if (hit) act.current(hit, col, quiet);
    };
    const offPress = term.subscribe.press((p) => press(p));
    const offWheel = term.subscribe.wheel((dir) => scrollBy(dir * 3));
    return () => (offPress(), offWheel());
  });

  return <Screen rows={lay.rows} width={Math.min(columns, MAX_WIDTH)} />;
}

term.enter(process.env.HEY_MOUSE !== '0');
const app = render(<App />, { exitOnCtrlC: false });
term.onRestore(() => app.unmount());
await app.waitUntilExit();
term.restore();
const note = handoff ? (handoffCopied ? 'command copied to clipboard' : undefined) : undefined;
if (allTurns.length) console.log(formatTranscript(allTurns, { reuse: !handoff, note }) + '\n');
if (process.env.HEY_OUT && handoff) writeFileSync(process.env.HEY_OUT, handoff);
process.exit(0);
