import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { Row } from './layout.js';
import { term } from './terminal.js';
import { props } from './theme.js';

// rows are already cut to the screen, ink only prints them. the palette follows the terminal's own background (see terminal.ts)
export function Screen({ rows, width }: { rows: Row[]; width: number }) {
  const [, redraw] = useState(0);
  useEffect(() => term.subscribe.theme(() => redraw((n) => n + 1)), []);
  const t = term.background;
  // hold the first frame until the background answer is in (at most ~120ms), so a light terminal never flashes the dark palette
  if (!t.ready && process.stdout.isTTY) return <Box width={width} height={rows.length} />;
  return (
    <Box flexDirection="column" width={width} height={rows.length}>
      {rows.map((r, i) => (
        <Text key={i} wrap="truncate">
          {r.spans.length
            ? r.spans.map((s, j) => (
                <Text key={j} {...props(s.s, t)}>
                  {s.t}
                </Text>
              ))
            : ' '}
        </Text>
      ))}
    </Box>
  );
}
