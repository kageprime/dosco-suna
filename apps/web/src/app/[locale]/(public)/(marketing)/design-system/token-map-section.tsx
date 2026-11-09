'use client';

/**
 * Body of the Token map section: job → utility class → token → the value the
 * browser resolved right now. The job column is what you decide; the rest is
 * what you write. Every value is measured from a probe element painted with
 * the real class, so the table cannot drift from `globals.css`.
 *
 * The same table, as prose, is
 * `.agents/skills/kortix-design-system/references/token-map.md`.
 */

import { cn, useIsDark } from '@kortix/ui';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@kortix/ui/table';
import { useEffect, useRef, useState } from 'react';

import { CopyValue, toHex } from './live-tokens';
import { Spec } from './spec';

type Probe =
  | 'background-color'
  | 'color'
  | 'border-color'
  | 'border-radius'
  | 'padding-left'
  | 'font-size'
  | 'box-shadow';

interface TokenRow {
  job: string;
  /** The literal utility, written in full so Tailwind compiles it. */
  cls: string;
  token: string;
  probe: Probe;
}

interface TokenFamily {
  id: string;
  name: string;
  about: string;
  rows: TokenRow[];
}

const FAMILIES: TokenFamily[] = [
  {
    id: 'tokens-surface',
    name: 'Surface',
    about:
      'Pick a neutral by depth: the lowest step that still separates the element from its ground. In-flow sections are bg-background plus a hairline; bg-popover is a field, an overlay or a panel inside a panel.',
    rows: [
      {
        job: 'Page canvas',
        cls: 'bg-background',
        token: '--background',
        probe: 'background-color',
      },
      {
        job: 'Content pane in the shell',
        cls: 'bg-pane',
        token: '--pane',
        probe: 'background-color',
      },
      { job: 'Lifted region, sidebar', cls: 'bg-card', token: '--card', probe: 'background-color' },
      {
        job: 'Inset control, chip, track',
        cls: 'bg-secondary',
        token: '--secondary',
        probe: 'background-color',
      },
      { job: 'Tile fill', cls: 'bg-muted', token: '--muted', probe: 'background-color' },
      {
        job: 'Field, overlay, panel in a panel',
        cls: 'bg-popover',
        token: '--popover',
        probe: 'background-color',
      },
      {
        job: 'Sidebar row fill',
        cls: 'bg-sidebar-row',
        token: '--sidebar-row',
        probe: 'background-color',
      },
    ],
  },
  {
    id: 'tokens-ink',
    name: 'Ink and line',
    about: 'Two inks and one hairline. Hierarchy is surface lift, never opacity on text.',
    rows: [
      { job: 'Primary text', cls: 'text-foreground', token: '--foreground', probe: 'color' },
      {
        job: 'Secondary text, meta',
        cls: 'text-muted-foreground',
        token: '--muted-foreground',
        probe: 'color',
      },
      { job: 'Every border', cls: 'border-border', token: '--border', probe: 'border-color' },
      {
        job: 'Primary action fill',
        cls: 'bg-primary',
        token: '--primary',
        probe: 'background-color',
      },
      {
        job: 'Text on the primary fill',
        cls: 'text-primary-foreground',
        token: '--primary-foreground',
        probe: 'color',
      },
    ],
  },
  {
    id: 'tokens-interaction',
    name: 'Interaction',
    about:
      'Hover and selected are translucent ink, so they compose over any substrate. kortix-base aliases ring; disabled is opacity, never a color swap.',
    rows: [
      { job: 'Hover fill', cls: 'bg-hover', token: '--hover', probe: 'background-color' },
      { job: 'Selected fill', cls: 'bg-active', token: '--active', probe: 'background-color' },
      {
        job: 'Focus ring, links, brand accent',
        cls: 'text-ring',
        token: '--ring',
        probe: 'color',
      },
      {
        job: 'Destructive action',
        cls: 'bg-destructive',
        token: '--destructive',
        probe: 'background-color',
      },
    ],
  },
  {
    id: 'tokens-status',
    name: 'Status',
    about: 'One hue per meaning, on a glyph, a dot or a /15 tint. The label beside it stays ink.',
    rows: [
      {
        job: 'Success, running, merged',
        cls: 'text-kortix-green',
        token: '--kortix-green',
        probe: 'color',
      },
      {
        job: 'Success tint',
        cls: 'bg-kortix-green/15',
        token: '--kortix-green',
        probe: 'background-color',
      },
      { job: 'Error, failed', cls: 'text-kortix-red', token: '--kortix-red', probe: 'color' },
      {
        job: 'Warning, needs attention',
        cls: 'text-kortix-orange',
        token: '--kortix-orange',
        probe: 'color',
      },
      { job: 'Pending', cls: 'text-kortix-yellow', token: '--kortix-yellow', probe: 'color' },
      {
        job: 'Info, open, in review',
        cls: 'text-kortix-blue',
        token: '--kortix-blue',
        probe: 'color',
      },
      {
        job: 'Owner role badge only',
        cls: 'text-kortix-purple',
        token: '--kortix-purple',
        probe: 'color',
      },
    ],
  },
  {
    id: 'tokens-geometry',
    name: 'Geometry',
    about:
      'Spacing is 8% tighter than stock Tailwind, so a 16px mockup padding is p-4. rounded-md and text-xs are the defaults.',
    rows: [
      { job: 'Panel padding', cls: 'pl-4', token: '--spacing × 4', probe: 'padding-left' },
      { job: 'Row padding', cls: 'pl-3', token: '--spacing × 3', probe: 'padding-left' },
      {
        job: 'Panel, row, button radius',
        cls: 'rounded-md',
        token: '--radius − 2px',
        probe: 'border-radius',
      },
      {
        job: 'Tile, chip, menu row radius',
        cls: 'rounded-sm',
        token: '--radius − 4px',
        probe: 'border-radius',
      },
      {
        job: 'Floating panel radius',
        cls: 'rounded-lg',
        token: '--radius',
        probe: 'border-radius',
      },
      { job: 'Meta, captions', cls: 'text-xs', token: '--text-xs', probe: 'font-size' },
      { job: 'Body, labels, buttons', cls: 'text-sm', token: '--text-sm', probe: 'font-size' },
      { job: 'Section page title', cls: 'text-xl', token: '--text-xl', probe: 'font-size' },
      {
        job: 'Detail title, app ceiling',
        cls: 'text-2xl',
        token: '--text-2xl',
        probe: 'font-size',
      },
    ],
  },
  {
    id: 'tokens-elevation',
    name: 'Elevation',
    about:
      'Shadow means floats above the page; in-flow panels stay flat. An overlay pairs its shadow with a hairline.',
    rows: [
      {
        job: 'Raised chip, slider thumb',
        cls: 'shadow-xs',
        token: '--shadow-xs',
        probe: 'box-shadow',
      },
      {
        job: 'Dropdown, select, popover',
        cls: 'shadow-md',
        token: '--shadow-md',
        probe: 'box-shadow',
      },
      { job: 'Modal, sheet, toast', cls: 'shadow-lg', token: '--shadow-lg', probe: 'box-shadow' },
    ],
  },
];

const COLOR_PROBES: ReadonlySet<Probe> = new Set(['background-color', 'color', 'border-color']);

/** Renders the class on a probe and reports the computed value, re-read on theme flip. */
function LiveValue({ cls, probe }: { cls: string; probe: Probe }) {
  const ref = useRef<HTMLSpanElement>(null);
  const pageDark = useIsDark();
  const [value, setValue] = useState('');
  useEffect(() => {
    if (!ref.current) return;
    const raw = getComputedStyle(ref.current).getPropertyValue(probe).trim();
    if (COLOR_PROBES.has(probe)) setValue(toHex(raw) ?? raw);
    else if (probe === 'box-shadow')
      setValue(raw === 'none' ? 'none' : `${raw.split(/,(?![^(]*\))/).length} layers`);
    else setValue(raw);
  }, [cls, probe, pageDark]);
  const isColor = COLOR_PROBES.has(probe);
  return (
    <span className="flex items-center gap-2">
      <span
        ref={ref}
        aria-hidden
        className={cn(
          'shrink-0',
          cls,
          isColor && 'size-4 rounded-sm',
          probe === 'color' && 'bg-current',
          probe === 'border-color' && 'border-2',
          probe === 'border-radius' && 'bg-foreground size-5',
          probe === 'padding-left' && 'bg-foreground inline-block h-3 rounded-sm',
          probe === 'font-size' && 'sr-only',
          probe === 'box-shadow' && 'bg-popover border-border size-5 rounded-sm border',
        )}
      />
      {/* Hex for colors, px for lengths, layer count for a shadow. Chrome serializes oklch as lab(), which reads as noise. */}
      {probe === 'box-shadow' ? (
        <span className="text-muted-foreground font-mono text-xs">{value || '…'}</span>
      ) : (
        <CopyValue value={value || '…'} />
      )}
    </span>
  );
}

export function TokenMapSection() {
  return (
    <>
      {FAMILIES.map((family) => (
        <Spec key={family.id} id={family.id} name={family.name} about={family.about}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[38%]">Job</TableHead>
                <TableHead>Class</TableHead>
                <TableHead className="hidden md:table-cell">Token</TableHead>
                <TableHead>Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {family.rows.map((row) => (
                <TableRow key={row.cls}>
                  <TableCell className="text-foreground text-sm">{row.job}</TableCell>
                  <TableCell>
                    <CopyValue value={row.cls} />
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden font-mono text-xs md:table-cell">
                    {row.token}
                  </TableCell>
                  <TableCell>
                    <LiveValue cls={row.cls} probe={row.probe} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Spec>
      ))}
    </>
  );
}
