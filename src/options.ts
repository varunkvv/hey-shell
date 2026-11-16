import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RunOptions } from './agent.js';

export type Choice = { value: string; hint: string };

export const MODES: (Choice & { value: PermissionMode })[] = [
  { value: 'default', hint: 'claude code decides, asks when it is not sure' },
  { value: 'acceptEdits', hint: 'file edits and simple file commands in the working dir run without asking' },
  { value: 'plan', hint: 'the model is told to plan and not change anything' },
  { value: 'auto', hint: 'a model classifier approves or denies, asks when it cannot decide' },
  { value: 'dontAsk', hint: 'never asks, denies whatever is not already allowed (questions too)' },
  { value: 'bypassPermissions', hint: 'runs everything without asking (deny rules and hooks still apply)' },
];
// shift-tab walks these. bypassPermissions and dontAsk are only reachable from the menu or a flag
export const CYCLE: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto'];
// the aliases the sdk reports from supportedModels(). a full model id from --model or HEY_MODEL works too
export const MODELS = ['sonnet', 'opus', 'haiku', 'fable'];
export const modelChoices = (current: string): Choice[] => (MODELS.includes(current) ? MODELS : [...MODELS, current]).map((value) => ({ value, hint: '' }));

const modelFile = join(homedir(), '.config', 'hey', 'model');
const savedModel = () => {
  try {
    return readFileSync(modelFile, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
};
export const saveModel = (model: string) => {
  try {
    mkdirSync(dirname(modelFile), { recursive: true });
    writeFileSync(modelFile, model + '\n');
  } catch {
    // not being able to remember the choice must not take the app down
  }
};

// leading --mode / --model flags only, so a request that mentions them is left alone.
// the mode is never saved: flag, then HEY_PERMISSION_MODE, then default. the model is flag, HEY_MODEL, the last one picked in the ui, then sonnet
export function startup(argv: string[], env: NodeJS.ProcessEnv): { request: string; run: RunOptions } | { error: string } {
  const args = argv.slice();
  const flags: Record<string, string> = {};
  while (args[0]?.startsWith('--')) {
    const [name, inline] = args.shift()!.slice(2).split(/=(.*)/s);
    const value = inline ?? args.shift();
    if (name !== 'mode' && name !== 'model') return { error: `unknown option --${name}` };
    if (!value) return { error: `--${name} needs a value` };
    flags[name] = value;
  }
  const mode = flags.mode || env.HEY_PERMISSION_MODE || 'default';
  if (!MODES.some((m) => m.value === mode)) return { error: `unknown permission mode ${mode} (${MODES.map((m) => m.value).join(', ')})` };
  return {
    request: args.join(' ').trim(),
    run: { permissionMode: mode as PermissionMode, model: flags.model || env.HEY_MODEL || savedModel() || 'sonnet' },
  };
}
