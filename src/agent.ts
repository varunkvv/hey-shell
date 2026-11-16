import { query, type CanUseTool, type Query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';

const systemPrompt = readFileSync(new URL('../prompt.md', import.meta.url), 'utf8');

// read-only commands run without asking. everything else is left to the sdk's permission handling
const allowedTools = [
  'Bash(kubectl get:*)', 'Bash(kubectl --context * get:*)', 'Bash(kubectl config:*)',
  'Bash(ls:*)', 'Bash(find:*)', 'Bash(wc:*)', 'Bash(grep:*)', 'Bash(cat:*)', 'Bash(head:*)',
  'Bash(tail:*)', 'Bash(sort:*)', 'Bash(uniq:*)', 'Bash(echo:*)', 'Bash(pwd)',
  'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)',
];

export type AgentEvent =
  | { type: 'narration'; text: string }
  | { type: 'step'; id: string; command: string }
  | { type: 'stepDone'; id: string; text: string; isError: boolean }
  | { type: 'answer'; text: string };

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
      current = query({
        prompt,
        options: {
          systemPrompt,
          model: 'sonnet',
          tools: ['Bash'],
          allowedTools,
          disallowedTools: ['mcp__claude-in-chrome'],
          permissionMode: 'default',
          canUseTool,
          strictMcpConfig: true,
          settingSources: [],
          resume: sessionId,
        },
      });
      for await (const m of current) {
        if ('session_id' in m && m.session_id) sessionId = m.session_id;
        if (m.type === 'assistant') {
          for (const b of m.message.content) {
            if (b.type === 'text' && b.text.trim()) onEvent({ type: 'narration', text: b.text.trim() });
            if (b.type === 'tool_use' && b.name === 'Bash') {
              onEvent({ type: 'step', id: b.id, command: String((b.input as { command?: string }).command ?? '') });
            }
          }
        } else if (m.type === 'user' && Array.isArray(m.message.content)) {
          for (const b of m.message.content) {
            if (b.type === 'tool_result') {
              onEvent({ type: 'stepDone', id: b.tool_use_id, text: blockText(b.content), isError: !!b.is_error });
            }
          }
        } else if (m.type === 'result') {
          onEvent({ type: 'answer', text: m.subtype === 'success' ? m.result : 'stopped' });
        }
      }
      current = undefined;
    },
  };
}
