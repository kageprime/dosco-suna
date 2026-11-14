import { Instrument_Serif, JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google';

/**
 * Dosco typography system:
 * - Sans (product UI, body, controls): Plus Jakarta Sans
 * - Serif (marketing headlines, editorial display): Instrument Serif
 * - Mono (code, commands, paths, IDs): JetBrains Mono
 */
export const doscoSans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-dosco-sans',
  display: 'swap',
});

export const doscoSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-dosco-serif',
  display: 'swap',
});

export const doscoMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-dosco-mono',
  display: 'swap',
});
