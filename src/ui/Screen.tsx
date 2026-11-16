import { Box, Text } from 'ink';
import type { Row } from './layout.js';

// rows are already cut to the screen, ink only prints them
export function Screen({ rows, width }: { rows: Row[]; width: number }) {
  return (
    <Box flexDirection="column" width={width} height={rows.length}>
      {rows.map((r, i) => (
        <Text key={i} wrap="truncate">
          {r.spans.length
            ? r.spans.map((s, j) => (
                <Text key={j} bold={s.s.b} dimColor={s.s.d} underline={s.s.u} inverse={s.s.inv} color={s.s.fg} backgroundColor={s.s.bg}>
                  {s.t}
                </Text>
              ))
            : ' '}
        </Text>
      ))}
    </Box>
  );
}
