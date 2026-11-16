import { reuseOf, type Turn } from './layout.js';

const MAX_COMMANDS = 12;

// what lands in scrollback after the alt screen closes. ansi only when stdout is a tty and NO_COLOR is unset.
// `reuse` prints the reuse command (not needed when tab already put it in the shell), `note` is a dim line at the end
export function formatTranscript(
  turns: Turn[],
  { reuse = true, note, color = !!process.stdout.isTTY && !process.env.NO_COLOR }: { reuse?: boolean; note?: string; color?: boolean } = {},
): string {
  const sgr = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const dim = (s: string) => sgr('2', s);
  const bold = (s: string) => sgr('1', s);
  const indent = (s: string, pad: string) => s.split('\n').join('\n' + pad);

  return turns
    .map((t, i) => {
      const ran = t.steps.filter((s) => s.status === 'ok' || s.status === 'failed' || s.status === 'declined');
      const shown = ran.slice(-MAX_COMMANDS);
      const out = [`${sgr('36', '›')} ${t.request}`];
      if (ran.length > shown.length) out.push(dim(`  +${ran.length - shown.length} earlier`));
      for (const s of shown) {
        if (s.asked && s.description) out.push(dim(`  ${s.description}`));
        out.push(`  $ ${indent(s.command, '    ')}`);
        if (s.status === 'failed') {
          const last = [...s.output].reverse().find((l) => l.trim());
          out.push(`    ${sgr('31', `✗ exit ${s.code ?? 1}`)}${last ? `  ${last.trim()}` : ''}`);
        } else if (s.status === 'declined') out.push(dim('    skipped'));
      }
      if (t.answer) {
        const [first, ...rest] = t.answer.split('\n');
        out.push(bold('  ' + first), ...rest.map((l) => (l ? '  ' + l : l)));
      }
      if (t.stopped) out.push(dim('  stopped'));
      const last = i === turns.length - 1;
      const cmd = last ? reuseOf(t) : undefined;
      if (last && reuse && cmd) out.push(dim('  reuse'), `  $ ${indent(cmd, '      ')}`);
      if (last && note) out.push(dim(`  ${note}`));
      return out.join('\n');
    })
    .join('\n\n');
}
