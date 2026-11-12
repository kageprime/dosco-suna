import {
  BrainIcon,
  CheckIcon,
  CodeIcon,
  CpuIcon,
  FolderSimpleIcon,
  HardDrivesIcon,
  IdentificationBadgeIcon,
  KeyIcon,
  ListChecksIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { ComponentType } from 'react';

import { Band, Heading } from '../kit/page-frame';

type Glyph = ComponentType<{ className?: string }>;

/** Every pillar id the sovereign and security pages render, mapped to its icon. */
const PILLAR_ICONS: Record<string, Glyph> = {
  computer: CpuIcon,
  identity: IdentificationBadgeIcon,
  credentials: KeyIcon,
  record: ListChecksIcon,
  code: CodeIcon,
  infra: HardDrivesIcon,
  models: BrainIcon,
  files: FolderSimpleIcon,
};

/** The four-pillar band /security and /sovereign render: one localized pillar
 *  set, one cell per pillar, hairlines between the cells. */
export function PillarsBand({
  pillars,
}: {
  pillars: {
    title: string;
    titleMuted?: string;
    items: readonly { id: string; name: string; line: string; facts: readonly string[] }[];
  };
}) {
  return (
    <section id="pillars" className="scroll-mt-16 py-14 lg:py-20">
      <Heading title={pillars.title} titleMuted={pillars.titleMuted} />
      <Band className="mt-12">
        <ul className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2 xl:grid-cols-4">
          {pillars.items.map(({ id, name, line, facts }) => {
            const Icon = PILLAR_ICONS[id];
            return (
              <li key={id} className="bg-background flex flex-col gap-5 p-6 lg:p-10">
                <Icon className="text-foreground size-6" aria-hidden />
                <h3 className="text-foreground text-2xl font-medium tracking-tight text-balance">
                  {name}
                  <span className="text-muted-foreground mt-1 block text-lg leading-snug">
                    {line}
                  </span>
                </h3>
                <ul className="mt-auto flex flex-col gap-2 text-sm">
                  {facts.map((fact) => (
                    <li key={fact} className="text-foreground flex items-start gap-2">
                      <CheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                      {fact}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      </Band>
    </section>
  );
}
