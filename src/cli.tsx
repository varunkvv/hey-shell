#!/usr/bin/env node
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { render, useApp, useInput } from 'ink';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createAgent, type AgentEvent } from './agent.js';
import { Screen } from './ui/Screen.js';
import type { Step } from './ui/Steps.js';
import { formatTranscript, type Turn } from './ui/transcript.js';

type Pending = { id: string; input: Record<string, unknown>; resolve: (r: PermissionResult) => void };

const historyFile = join(homedir(), '.hey_history');
const history = existsSync(historyFile) ? readFileSync(historyFile, 'utf8').split('\n').filter(Boolean) : [];
const initial = process.argv.slice(2).join(' ').trim();

const transcript: Turn[] = [];
let handoff = '';
let picked = false;

function App() {
  const { exit } = useApp();
  const [phase, setPhase] = useState<'input' | 'running' | 'approval'>(initial ? 'running' : 'input');
  const [turn, setTurn] = useState(0);
  const [request, setRequest] = useState(initial);
  const [steps, setSteps] = useState<Step[]>([]);
  const [selected, setSelected] = useState(0);
  const [narration, setNarration] = useState('');
  const [answer, setAnswer] = useState('');
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending>();
  const current = useRef<Turn>({ request: '', commands: [], answer: '' });

  const canUseTool: CanUseTool = (tool, input, { toolUseID }) =>
    tool !== 'Bash'
      ? Promise.resolve({ behavior: 'deny', message: 'only Bash is available' })
      : new Promise((resolve) => {
          setPending({ id: toolUseID, input, resolve });
          setPhase('approval');
        });
  const agent = useMemo(() => createAgent(canUseTool), []);

  const onEvent = (e: AgentEvent) => {
    if (e.type === 'narration') setNarration(e.text);
    else if (e.type === 'step') {
      setSteps((s) => {
        setSelected(s.length);
        return [...s, { id: e.id, command: e.command, status: 'running', output: '', expanded: false }];
      });
    } else if (e.type === 'stepDone') {
      const code = /^Exit code (\d+)/.exec(e.text)?.[1];
      setSteps((all) =>
        all.map((s) => {
          if (s.id !== e.id) return s;
          const status = !e.isError ? 'ok' : code ? 'failed' : 'declined';
          if (status !== 'declined') current.current.commands.push(s.command);
          if (status === 'ok') handoff = s.command;
          return { ...s, status, code: code ? Number(code) : undefined, output: e.text };
        }),
      );
    } else {
      current.current.answer = e.text;
      setAnswer(e.text);
      setNarration('');
    }
  };

  useEffect(() => {
    if (phase !== 'running' || !request) return;
    current.current = { request, commands: [], answer: '' };
    transcript.push(current.current);
    setSteps([]);
    setAnswer('');
    agent
      .run(request, onEvent)
      .catch((err) => onEvent({ type: 'answer', text: `error: ${err instanceof Error ? err.message : err}` }))
      .finally(() => setPhase('input'));
  }, [turn]);

  const toggle = () => setSteps((all) => all.map((s, i) => (i === selected ? { ...s, expanded: !s.expanded } : s)));

  useInput((input, key) => {
    if (key.escape) agent.stop();
    else if (input === 'o') toggle();
    else if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
    else if (key.downArrow) setSelected((i) => Math.min(steps.length - 1, i + 1));
  }, { isActive: phase === 'running' });

  useInput((input, key) => {
    if (input === 'o') toggle();
    else if (key.tab && handoff) {
      picked = true;
      exit();
    }
  }, { isActive: phase === 'input' && !draft });

  const submit = (value: string) => {
    const text = value.trim();
    if (!text) return exit();
    appendFileSync(historyFile, text + '\n');
    history.push(text);
    setDraft('');
    setRequest(text);
    setNarration('');
    setPhase('running');
    setTurn((t) => t + 1);
  };

  const resolve = (r: PermissionResult, command?: string) => {
    if (command) setSteps((all) => all.map((s) => (s.id === pending!.id ? { ...s, command } : s)));
    pending!.resolve(r);
    setPending(undefined);
    setPhase('running');
  };

  return (
    <Screen
      phase={phase}
      request={request}
      steps={steps}
      selected={selected}
      narration={narration}
      answer={answer}
      approval={
        pending && {
          description: pending.input.description as string | undefined,
          command: String(pending.input.command ?? ''),
          onRun: (command) => resolve({ behavior: 'allow', updatedInput: { ...pending.input, command } }, command),
          onSkip: () => resolve({ behavior: 'deny', message: 'the user declined to run this command' }),
        }
      }
      inputKey={turn}
      hasDraft={!!draft}
      canReuse={!!handoff}
      history={history}
      onSubmit={submit}
      onDraft={setDraft}
    />
  );
}

const app = render(<App />, { alternateScreen: true });
await app.waitUntilExit();
if (transcript.length) console.log(formatTranscript(transcript) + '\n');
if (process.env.HEY_OUT && picked) writeFileSync(process.env.HEY_OUT, handoff);
process.exit(0);
