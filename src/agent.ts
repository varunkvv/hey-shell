import { query, type CanUseTool, type Query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';

const systemPrompt = readFileSync(new URL('../prompt.md', import.meta.url), 'utf8');

// claude code already runs plain read-only commands (ls, cat, grep, wc, find without -delete, git log...)
// and asks for anything that writes. it does not know kubectl get, so that is all we add.
// keep the verb first: `Bash(kubectl --context * get:*)` never matches, and `... get *` lets
// `kubectl --context x label pod y get z` through
const allowedTools = ['Bash(kubectl get:*)', 'Bash(kubectl config get-contexts:*)'];

export type AgentEvent =
  | { type: 'step'; id: string; command: string; description?: string }
  | { type: 'stepDone'; id: string; text: string; isError: boolean }
  | { type: 'answer'; text: string; reuse?: string }
  | { type: 'error'; text: string }
  | { type: 'done' };

// the model ends with "reuse:" and a fenced block holding one command that does the whole job
const REUSE = /(?:^|\n)reuse:?[ \t]*\n```\w*\n([\s\S]*?)\n```\s*$/i;

export function splitAnswer(full: string): { text: string; reuse?: string } {
  const m = REUSE.exec(full.trim());
  const reuse = m?.[1].trim();
  return m && reuse ? { text: full.trim().slice(0, m.index).trim(), reuse } : { text: full.trim() };
}

const blockText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (c?.type === 'text' ? c.text : '')).join('')
      : '';

export function createAgent(canUseTool: CanUseTool) {
  let sessionId: string | undefined;
  let current: Query | undefined;

  return {
    stop: () => void current?.interrupt(),
    async run(prompt: string, onEvent: (e: AgentEvent) => void) {
      const q = (current = query({
        prompt,
        options: {
          systemPrompt,
          model: 'sonnet',
          tools: ['Bash', 'AskUserQuestion'],
          allowedTools,
          disallowedTools: ['mcp__claude-in-chrome'],
          permissionMode: 'default',
          canUseTool,
          strictMcpConfig: true,
          settingSources: [],
          resume: sessionId,
        },
      }));
      for await (const m of q) {
        if ('session_id' in m && m.session_id) sessionId = m.session_id;
        if (m.type === 'assistant') {
          for (const b of m.message.content) {
            if (b.type === 'tool_use' && b.name === 'Bash') {
              const input = b.input as { command?: string; description?: string };
              onEvent({ type: 'step', id: b.id, command: String(input.command ?? ''), description: input.description });
            }
          }
        } else if (m.type === 'user' && Array.isArray(m.message.content)) {
          for (const b of m.message.content) {
            if (b.type === 'tool_result') {
              onEvent({ type: 'stepDone', id: b.tool_use_id, text: blockText(b.content), isError: !!b.is_error });
            }
          }
        } else if (m.type === 'result') {
          if (m.subtype === 'success') onEvent({ type: 'answer', ...splitAnswer(m.result) });
          else onEvent({ type: 'error', text: m.subtype.replace(/^error_/, '').replace(/_/g, ' ') });
          // the result is the last thing that matters. the stream can take a while longer to close
          onEvent({ type: 'done' });
        }
      }
      if (current === q) current = undefined;
    },
  };
}
