import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { LineInput } from './Prompt.js';

export function Approval({ description, command, onRun, onSkip }: {
  description?: string;
  command: string;
  onRun: (command: string) => void;
  onSkip: () => void;
}) {
  const [editing, setEditing] = useState(false);

  useInput((input, key) => {
    if (key.return) onRun(command);
    else if (input === 'e') setEditing(true);
    else if (key.escape) onSkip();
  }, { isActive: !editing });

  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Text color="yellow">? {description ?? 'run this command'}</Text>
      {editing ? (
        <Box marginLeft={4} marginY={1}>
          <LineInput label="$" initial={command} onSubmit={onRun} onCancel={() => setEditing(false)} />
        </Box>
      ) : (
        <Box marginLeft={4} marginY={1}>
          <Text>{command}</Text>
        </Box>
      )}
      <Text dimColor>{editing ? 'enter run · esc back' : 'enter run · e edit · esc skip'}</Text>
    </Box>
  );
}
