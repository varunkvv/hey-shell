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

// fixed-width result column so rows don't shift as results arrive
const RESULT = 14;

const lines = (s: string) => s.split('\n').filter((l) => l.trim());
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function result(s: Step) {
  if (s.status === 'running') return '';
  if (s.status === 'declined') return 'skipped';
  if (s.status === 'failed') return `exit ${s.code ?? 1}`;
  const l = lines(s.output);
  return clip(l.length > 1 ? `${l.length} lines` : (l[0] ?? '').trim(), RESULT);
}

function Mark({ status }: { status: Step['status'] }) {
  if (status === 'running') return <Text color="cyan"><Spinner /></Text>;
  if (status === 'ok') return <Text color="green">✓</Text>;
  if (status === 'failed') return <Text color="red">✗</Text>;
  return <Text dimColor>-</Text>;
}

export function Steps({ steps, selected, narration }: { steps: Step[]; selected: number; narration?: string }) {
  if (!steps.length && !narration) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {steps.map((s, i) => {
        const out = lines(s.output).filter((l) => !/^Exit code \d+$/.test(l.trim()));
        const shown = s.expanded ? out.slice(-40) : s.status === 'failed' ? out.slice(-2) : [];
        const [first, ...rest] = s.command.split('\n');
        const failed = s.status === 'failed';
        return (
          <Box key={s.id} flexDirection="column">
            <Box>
              <Box width={2}>
                <Text>{steps.length > 1 && i === selected ? '▸' : ' '}</Text>
              </Box>
              <Box width={2}>
                <Mark status={s.status} />
              </Box>
              <Box flexGrow={1} flexShrink={1} width={0}>
                <Text wrap="truncate-end" dimColor={s.status === 'ok' || s.status === 'declined'}>
                  {first + (rest.length ? ' …' : '')}
                </Text>
              </Box>
              <Box width={RESULT + 2} flexShrink={0} justifyContent="flex-end">
                <Text color={failed ? 'red' : undefined} dimColor={!failed} wrap="truncate-end">{result(s)}</Text>
              </Box>
            </Box>
            {shown.map((l, j) => (
              <Box key={j} marginLeft={4}>
                <Text dimColor>│ </Text>
                <Box flexGrow={1} flexShrink={1} width={0}>
                  <Text dimColor={!s.expanded} wrap="truncate-end">{l}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        );
      })}
      {narration && (
        <Box marginLeft={4}>
          <Text dimColor wrap="truncate-end">{narration.split('\n')[0]}</Text>
        </Box>
      )}
    </Box>
  );
}
