import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

export type Step = {
  id: string;
  command: string;
  status: 'running' | 'ok' | 'failed' | 'declined';
  code?: number;
  output: string;
  expanded: boolean;
};

const lines = (s: string) => s.split('\n').filter((l) => l.trim());

function result(s: Step) {
  if (s.status === 'declined') return 'skipped';
  if (s.status === 'failed') return `exit ${s.code ?? 1}`;
  const l = lines(s.output);
  return l.length > 1 ? `${l.length} lines` : (l[0] ?? '').slice(0, 40);
}

export function Steps({ steps, selected, narration }: { steps: Step[]; selected: number; narration?: string }) {
  return (
    <Box flexDirection="column" marginY={1}>
      {steps.map((s, i) => {
        const shown = s.expanded ? lines(s.output).slice(-40) : s.status === 'failed' ? lines(s.output).slice(-2) : [];
        return (
          <Box key={s.id} flexDirection="column">
            <Box justifyContent="space-between">
              <Box>
                <Text>{i === selected ? '> ' : '  '}</Text>
                {s.status === 'running' && <Text color="cyan"><Spinner /></Text>}
                {s.status === 'ok' && <Text color="green">✓</Text>}
                {s.status === 'failed' && <Text color="red">✗</Text>}
                {s.status === 'declined' && <Text dimColor>-</Text>}
                <Text> </Text>
                <Text wrap="truncate-end">{s.command.split('\n')[0]}</Text>
              </Box>
              <Text color={s.status === 'failed' ? 'red' : undefined} dimColor={s.status !== 'failed'}> {result(s)}</Text>
            </Box>
            {shown.map((l, j) => (
              <Text key={j} dimColor wrap="truncate-end">{'      ' + l}</Text>
            ))}
          </Box>
        );
      })}
      {narration && <Text dimColor>{'  ' + narration}</Text>}
    </Box>
  );
}
