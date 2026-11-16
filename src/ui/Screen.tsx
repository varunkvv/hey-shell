import { Box, Text, useWindowSize } from 'ink';
import { Approval } from './Approval.js';
import { Footer, type Hint } from './Footer.js';
import { LineInput } from './Prompt.js';
import { Steps, type Step } from './Steps.js';

// keep lines readable on very wide terminals
const MAX_WIDTH = 100;

export type ScreenProps = {
  phase: 'input' | 'running' | 'approval';
  request: string;
  steps: Step[];
  selected: number;
  narration: string;
  answer: string;
  approval?: { description?: string; command: string; onRun: (command: string) => void; onSkip: () => void };
  inputKey: number;
  hasDraft: boolean;
  canReuse: boolean;
  history: string[];
  onSubmit: (value: string) => void;
  onDraft: (value: string) => void;
  columns?: number;
};

function hintsFor(p: ScreenProps): Hint[] {
  if (p.phase === 'approval') return [];
  if (p.phase === 'running') {
    return [['esc', 'stop'], ...(p.steps.length ? [['o', 'output'] as Hint] : []), ...(p.steps.length > 1 ? [['↑↓', 'select'] as Hint] : [])];
  }
  if (p.hasDraft) return [['enter', 'send']];
  return [['enter', 'quit'], ...(p.canReuse ? [['tab', 'to shell'] as Hint] : [])];
}

export function Screen(p: ScreenProps) {
  const { columns } = useWindowSize();
  const width = Math.min(p.columns ?? columns, MAX_WIDTH);
  return (
    <Box flexDirection="column" width={width}>
      {p.request && (
        <Text>
          <Text dimColor>› </Text>
          {p.request}
        </Text>
      )}
      <Steps steps={p.steps} selected={p.selected} narration={p.phase === 'running' ? p.narration : ''} />
      {p.phase === 'approval' && p.approval && <Approval {...p.approval} />}
      {p.phase === 'input' && p.answer && (
        <Box marginTop={1} marginLeft={2}>
          <Text bold>{p.answer}</Text>
        </Box>
      )}
      {p.phase === 'input' && (
        <Box marginTop={p.request ? 1 : 0}>
          <LineInput
            key={p.inputKey}
            label="›"
            placeholder={p.request ? undefined : 'ask for something in plain english'}
            onSubmit={p.onSubmit}
            onChange={p.onDraft}
            history={p.history}
          />
        </Box>
      )}
      <Footer hints={hintsFor(p)} />
    </Box>
  );
}
