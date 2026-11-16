import { query, type CanUseTool, type PermissionMode, type Query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';

// node prints warnings straight onto the screen hey draws on. the sdk raises one on every bypassPermissions run (canUseTool is
// shadowed), and questions still reach hey there, so none of them are worth showing
process.removeAllListeners('warning');

const systemPrompt = readFileSync(new URL('../prompt.md', import.meta.url), 'utf8');

// hey has no command rules of its own. what runs, asks or is blocked comes from the permission mode, the rules and hooks in
// claude code's managed policy and the user's ~/.claude settings, and claude code's own checks
export type RunOptions = { permissionMode: PermissionMode; model: string };

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
    async run(prompt: string, onEvent: (e: AgentEvent) => void, { permissionMode, model }: RunOptions) {
      const q = (current = query({
        prompt,
        options: {
          systemPrompt,
          model,
          tools: ['Bash', 'AskUserQuestion'],
          // `tools` only limits the built-in tools. servers claude code injects itself (claude in chrome, when
          // ~/.claude.json enables it) ignore strictMcpConfig, so this drops every mcp tool from the model
          disallowedTools: ['mcp__*'],
          permissionMode,
          allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
          canUseTool,
          strictMcpConfig: true,
          // managed policy is always read. 'user' adds the user's permission rules, hooks and plugins. project and
          // local are left out so a repo's own settings and CLAUDE.md do not change what hey does in the current dir
          settingSources: ['user'],
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
