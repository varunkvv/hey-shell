export type Turn = { request: string; commands: string[]; answer: string };

// what lands in scrollback after the alt screen closes. ansi only when stdout is a tty
export function formatTranscript(turns: Turn[], color = !!process.stdout.isTTY && !process.env.NO_COLOR): string {
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[22m` : s);
  const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[22m` : s);
  const indent = (s: string, pad: string) => s.split('\n').join('\n' + pad);
  return turns
    .map((t) =>
      [
        `${dim('›')} ${t.request}`,
        ...t.commands.map((c) => dim(`  $ ${indent(c, '    ')}`)),
        ...(t.answer ? [bold('  ' + indent(t.answer, '  '))] : []),
      ].join('\n'),
    )
    .join('\n\n');
}
