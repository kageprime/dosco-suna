'use client';

/**
 * Body of the Interaction section: hover, press, focus, translate, the icon
 * swap and the info icon, each as one cell. The budget is `kortix-brand`
 * motion.md (the frequency ladder): hover is color only, press is one scale,
 * translate is a marketing-profile device, and a floating panel opens with no
 * animation except the hover card.
 */

import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { CopyButton } from '@kortix/ui/markdown/copy-button';
import { ArrowRightIcon, GearSixIcon, UsersIcon } from '@phosphor-icons/react';

import { InfoHint, Spec, SpecCell, SpecGrid } from './spec';

const HOVER_ROWS = [
  { icon: UsersIcon, label: 'Members' },
  { icon: GearSixIcon, label: 'Settings' },
] as const;

export function InteractionSection() {
  return (
    <>
      <Spec
        id="interaction-states"
        name="Hover, press, focus"
        about={
          <>
            Hover is color only, press is one scale step behind <code>motion-safe:</code>, focus is
            the ring. A dense list and anything an arrow key drives get <code>transition-none</code>
            .
          </>
        }
        source="motion.md · menu-recipe.ts"
      >
        <SpecGrid className="sm:grid-cols-3">
          <SpecCell
            label="Hover"
            about="A dense row: hover:bg-hover and no transition. Only a sparse target takes duration-fast."
          >
            <ul className="w-full max-w-56 space-y-0.5">
              {HOVER_ROWS.map(({ icon: Icon, label }) => (
                <li key={label}>
                  <button
                    type="button"
                    className="hover:bg-hover text-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-none"
                  >
                    <Icon className="text-muted-foreground size-4 shrink-0" />
                    {label}
                  </button>
                </li>
              ))}
            </ul>
          </SpecCell>
          <SpecCell
            label="Press"
            about="Add motion-safe:active:scale-[0.96] to the control. Button does not ship it. Nothing else."
          >
            <Button variant="secondary" size="sm" className="motion-safe:active:scale-[0.96]">
              Press and hold
            </Button>
          </SpecCell>
          <SpecCell
            label="Focus"
            about="Tab into the field: border-ring plus a 3px ring-ring/15 halo."
          >
            <Input size="sm" placeholder="Tab here" className="max-w-48" aria-label="Focus demo" />
          </SpecCell>
        </SpecGrid>
      </Spec>

      <Spec
        id="interaction-translate"
        name="Translate and swap"
        about={
          <>
            A glyph may nudge <code>translate-x-0.5</code> on one primary or marketing link, never
            on a row or a menu. A state swap cross-fades two glyphs in one box (blur, scale,
            opacity, <code>bounce: 0</code>). Every copy action uses <code>CopyButton</code>: the
            Kortix copy icon swaps to <code>SolidCheckIcon</code>. Reduced motion swaps immediately.
          </>
        }
        source="copy-button.tsx"
      >
        <SpecGrid className="sm:grid-cols-3">
          <SpecCell
            label="Translate"
            about="Hover the link. Only the arrow moves, one step, duration-fast."
          >
            <a
              href="#interaction-translate"
              className="group text-foreground inline-flex items-center gap-1.5 text-sm font-medium"
            >
              Read the brand kit
              <ArrowRightIcon className="duration-fast size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" />
            </a>
          </SpecCell>
          <SpecCell
            label="Icon swap"
            about="Copy once. The check morphs in place and the box keeps its size."
          >
            <div className="flex items-center gap-2">
              <code className="text-muted-foreground font-mono text-xs">pnpm dev</code>
              <CopyButton code="pnpm dev" size="md" />
            </div>
          </SpecCell>
          <SpecCell
            label="Explain"
            about="This is it. The info icon carries the explanation. The label stays one line."
          >
            <div className="flex items-center gap-1.5">
              <span className="text-foreground text-sm font-medium">Retention</span>
              <InfoHint label="About retention">
                Sessions older than the retention window are archived, not deleted. The window is
                set per project.
              </InfoHint>
            </div>
          </SpecCell>
        </SpecGrid>
      </Spec>
    </>
  );
}
