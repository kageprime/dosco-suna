'use client';

import { useTranslations } from '@/i18n/use-translations';
import {
  CubeIcon as Cube,
  KeyIcon as Key,
  RowsIcon as Rows,
} from '@phosphor-icons/react';

import { KortixLogo } from '@/components/ui/kortix-logo';

/**
 * Brand half of the split auth screen. Replaces the old all-dark centered
 * form with a two-up: credentials left, Dosco summary right. Positioning is
 * deliberate — Dosco is an agentic OS, not an AI command center — so the
 * panel says so in one headline plus three proof points, over the ember
 * gradient with the Dosco mark. No photo assets: the panel is pure CSS +
 * the stamped brand PNGs, so there is nothing new to localize or ship.
 */
export function AuthBrandPanel() {
  const t = useTranslations('auth.unified');
  const points = [
    { icon: Cube, text: t.raw('brandPoint1') },
    { icon: Rows, text: t.raw('brandPoint2') },
    { icon: Key, text: t.raw('brandPoint3') },
  ];
  return (
    <div className="relative flex h-full min-h-svh flex-col justify-between overflow-hidden bg-[#0c0a09] p-10 text-stone-100 xl:p-14">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(110% 70% at 85% 10%, rgba(249,115,22,0.28) 0%, rgba(249,115,22,0) 55%), radial-gradient(90% 60% at 10% 100%, rgba(234,88,12,0.18) 0%, rgba(234,88,12,0) 60%)',
        }}
      />
      <KortixLogo variant="default" size={30} className="relative" />
      <div className="relative space-y-8">
        <div className="space-y-3">
          <h2 className="max-w-md text-4xl font-medium tracking-tight text-balance xl:text-5xl">
            {t.raw('brandHeadline')}
          </h2>
          <p className="max-w-md text-base leading-relaxed text-stone-400 text-pretty">
            {t.raw('brandSub')}
          </p>
        </div>
        <ul className="space-y-4">
          {points.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5">
                <Icon className="size-4 text-orange-400" />
              </span>
              <span className="text-sm text-stone-300">{text}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
