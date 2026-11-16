import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

export function LineInput({ initial = '', label, onSubmit, onCancel, onChange, history = [], active = true }: {
  initial?: string;
  label: string;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
  onChange?: (value: string) => void;
  history?: string[];
  active?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [hist, setHist] = useState(history.length);
  const set = (v: string) => {
    setValue(v);
    onChange?.(v);
  };

  useInput((input, key) => {
    if (key.return) onSubmit(value);
    else if (key.escape) onCancel?.();
    else if (key.backspace || key.delete) set(value.slice(0, -1));
    else if (key.upArrow && history.length) {
      const i = Math.max(0, hist - 1);
      setHist(i);
      set(history[i]);
    } else if (key.downArrow && history.length) {
      const i = Math.min(history.length, hist + 1);
      setHist(i);
      set(history[i] ?? '');
    } else if (!key.ctrl && !key.meta && !key.tab && input) {
      // a paste or fast typing can deliver text and enter in one chunk
      const next = value + input.replace(/[\r\n]+$/, '');
      set(next);
      if (/[\r\n]$/.test(input)) onSubmit(next);
    }
  }, { isActive: active });

  return (
    <Box>
      <Text color="green">{label} </Text>
      <Text>{value}</Text>
      {active && <Text inverse> </Text>}
    </Box>
  );
}
