import { Box, Text } from 'ink';
import { homedir } from 'node:os';

const cwd = process.cwd().replace(homedir(), '~');

export type Hint = [key: string, label: string];

// key in normal weight, label dim, so the key is what catches the eye
export function Keys({ hints }: { hints: Hint[] }) {
  return (
    <Text>
      {hints.map(([key, label], i) => (
        <Text key={key}>
          {i > 0 && '   '}
          {key} <Text dimColor>{label}</Text>
        </Text>
      ))}
    </Text>
  );
}

export function Footer({ hints }: { hints: Hint[] }) {
  return (
    <Box justifyContent="space-between" marginTop={1}>
      <Box flexShrink={1} marginRight={2}>
        <Text dimColor wrap="truncate-start">{cwd}</Text>
      </Box>
      <Box flexShrink={0}>
        <Keys hints={hints} />
      </Box>
    </Box>
  );
}
