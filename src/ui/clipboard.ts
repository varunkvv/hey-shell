import { execFileSync } from 'node:child_process';

// sync so a copy right before exit is not lost. macos only, like the rest of hey
export function copy(text: string): boolean {
  try {
    execFileSync('pbcopy', { input: text });
    return true;
  } catch {
    return false;
  }
}
