import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Keys } from './Footer.js';
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

  // a yellow rule down the left edge marks the one thing the agent is waiting on. the command is never truncated, it wraps
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      marginLeft={2}
      paddingLeft={1}
      borderStyle="single"
      borderColor="yellow"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
    >
      <Text color="yellow">needs approval</Text>
      <Text bold>{description ?? 'run this command'}</Text>
      <Box marginTop={1}>
        {editing ? (
          <LineInput label="$" initial={command} onSubmit={onRun} onCancel={() => setEditing(false)} />
        ) : (
          <Text><Text dimColor>$ </Text>{command}</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Keys hints={editing ? [['enter', 'run'], ['esc', 'back']] : [['enter', 'run'], ['e', 'edit'], ['esc', 'skip']]} />
      </Box>
    </Box>
  );
}
