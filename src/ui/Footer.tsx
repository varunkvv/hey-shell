import { Box, Text } from 'ink';
import { homedir } from 'node:os';

const cwd = process.cwd().replace(homedir(), '~');

export function Footer({ hint }: { hint: string }) {
  return (
    <Box justifyContent="space-between">
      <Text dimColor>{cwd}</Text>
      <Text dimColor>{hint}</Text>
    </Box>
  );
}
