import type { Style, Tone } from './layout.js';

// one palette per background. fg tokens are hex (ink downsamples to 256 / 16 colors when the terminal can't do truecolor),
// bg tints are only used when the terminal is truecolor and answered the background query, because a wash computed from a guess can clash
export type Palette = Record<Tone, string>;

const dark: Palette = {
  accent: '#7aa2f7',
  ok: '#9ece6a',
  err: '#f7768e',
  flag: '#bb9af7',
  str: '#e0af68',
  var: '#73daca',
  value: '#7dcfff',
  badgeText: '#16161e',
};
const light: Palette = {
  accent: '#3d59d6',
  ok: '#2e7d32',
  err: '#c4264a',
  flag: '#7041c4',
  str: '#946200',
  var: '#0e7466',
  value: '#0b6a99',
  badgeText: '#ffffff',
};

export type Theme = { light: boolean; bg?: [number, number, number] };

export const truecolor = /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? '');
export const noColor = !!process.env.NO_COLOR;

const hex = (c: number[]) => '#' + c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
const mix = (a: number[], b: number[], t: number) => a.map((x, i) => x + (b[i] - x) * t);
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

export type Props = { color?: string; backgroundColor?: string; bold?: boolean; dimColor?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean };

// a layout style as ink props for this theme. NO_COLOR keeps weight and underline, and turns filled pills into inverse
export function props(s: Style, t: Theme): Props {
  const p: Props = { bold: s.b, dimColor: s.d, italic: s.i, underline: s.u, inverse: s.inv };
  if (noColor) {
    if (s.bg === 'badge' || s.bg === 'accent' || s.bg === 'err') p.inverse = true;
    return p;
  }
  const pal = t.light ? light : dark;
  if (s.fg && !(s.fg === 'badgeText' && !s.bg)) p.color = pal[s.fg];
  if (s.bg === 'badge') p.backgroundColor = t.light ? '#946200' : '#e0af68';
  else if (s.bg === 'accent') p.backgroundColor = pal.accent;
  else if (s.bg === 'err') p.backgroundColor = pal.err;
  else if (s.bg === 'tint' && truecolor && t.bg) p.backgroundColor = hex(mix(t.bg, rgb(pal.accent), t.light ? 0.07 : 0.09));
  if (s.fg === 'badgeText' && s.bg === 'badge') p.color = t.light ? '#ffffff' : '#16161e';
  return p;
}
