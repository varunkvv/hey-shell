import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RunOptions } from './agent.js';

export type Choice = { value: string; hint: string };

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

// leading --auto-approve / --model flags only, so a request that mentions them is left alone.
// auto-approve is never saved: the flag, then HEY_AUTO_APPROVE=1, then off. the model is flag, HEY_MODEL, the last one picked in the ui, then sonnet
export function startup(argv: string[], env: NodeJS.ProcessEnv): { request: string; run: RunOptions; autoApprove: boolean } | { error: string } {
  const args = argv.slice();
  const flags: Record<string, string> = {};
  let autoApprove = env.HEY_AUTO_APPROVE === '1';
  while (args[0]?.startsWith('--')) {
    const [name, inline] = args.shift()!.slice(2).split(/=(.*)/s);
    if (name === 'auto-approve') {
      if (inline !== undefined) return { error: '--auto-approve takes no value' };
      autoApprove = true;
      continue;
    }
    if (name !== 'model') return { error: `unknown option --${name}` };
    const value = inline ?? args.shift();
    if (!value) return { error: `--${name} needs a value` };
    flags[name] = value;
  }
  return {
    request: args.join(' ').trim(),
    run: { model: flags.model || env.HEY_MODEL || savedModel() || 'sonnet' },
    autoApprove,
  };
}
