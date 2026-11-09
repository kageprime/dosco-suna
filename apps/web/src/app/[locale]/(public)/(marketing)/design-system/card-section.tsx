'use client';

import { useTranslations } from '@/i18n/use-translations';
import {
  ArrowsClockwiseIcon,
  BellIcon,
  BookOpenIcon,
  CloudArrowUpIcon,
  CodeIcon,
  CubeIcon,
  DatabaseIcon,
  FolderIcon,
  GitBranchIcon,
  KeyIcon,
  LightningIcon,
  PlugsConnectedIcon,
  RobotIcon,
  ShieldCheckIcon,
  SparkleIcon,
  TerminalWindowIcon,
  UsersIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useState, type ComponentProps } from 'react';

import { DESIGN_SYSTEM_TRANSLATION_KEYS } from '@/i18n/design-system-translation-keys.generated';
import {
  Card,
  CardButton,
  CardDescription,
  CardEyebrow,
  CardFooter,
  CardGroup,
  CardHeader,
  CardImage,
  CardMedia,
  CardTitle,
} from '@kortix/ui/card';
import { localizeUiCatalog } from '@kortix/ui/i18n';
import { DemoContainer, InfoHint, SpecRow } from './spec';

/**
 * Body of the Card section. The `#comp-card` anchor, the heading and the
 * description live on the design-system page; this renders the variants only.
 *
 * Card is one compositional API with two layout axes — `orientation`
 * ("card" | "inline") and `columns` — plus two framing switches (`border`,
 * `separated`). Every block below is one point in that matrix, so the page
 * documents the whole surface rather than a "default" and a "glass".
 *
 * The surface is transparent and borderless by default: a card inherits the
 * substrate under it and leans on hairline dividers plus the magnetic
 * proximity highlight instead of a drawn frame. Each demo therefore sits on a
 * `DemoContainer` frame, the same frame the rest of this page uses.
 */

// ── demo data ────────────────────────────────────────────

const RUNTIME: { icon: Icon; title: string; description: string }[] = [
  {
    icon: CubeIcon,
    title: 'Sandbox',
    description: 'Every session boots its own cloud sandbox — session_id == sandbox_id.',
  },
  {
    icon: TerminalWindowIcon,
    title: 'Agent server',
    description: 'The kortix-agent daemon is baked into the snapshot, reachable over /p/<id>.',
  },
  {
    icon: PlugsConnectedIcon,
    title: 'Runtime REST',
    description: 'One transport for every session, proxied through the compatibility layer.',
  },
];

const SURFACES: { icon: Icon; title: string; description: string }[] = [
  { icon: FolderIcon, title: 'Workspaces', description: 'Provision, share, and archive.' },
  { icon: LightningIcon, title: 'Triggers', description: 'Schedules, webhooks, and events.' },
  { icon: KeyIcon, title: 'Secrets', description: 'Encrypted at rest, injected at boot.' },
  { icon: UsersIcon, title: 'Members', description: 'Roles, invites, and IAM policies.' },
];

const WALLPAPERS = [
  { src: '/wallpapers/silk-dark.jpg', eyebrow: 'Wallpaper', title: 'Silk' },
  { src: '/wallpapers/nebula-dark.jpg', eyebrow: 'Wallpaper', title: 'Nebula' },
];

/** The fills a card action reaches for. CardButton accepts Button's whole
 *  union, so anything in button.tsx works — these are just the sensible ones. */
const BUTTON_VARIANTS: ComponentProps<typeof CardButton>['variant'][] = [
  'default',
  'secondary',
  'outline',
  'ghost',
  'link',
  'brand',
  'destructive',
  'muted',
];

/** Button's labelled sizes, shortest box first. `default` is what a CardButton
 *  renders at when the prop is omitted — Button's own default, not a card one.
 *  The square `icon-*` sizes are in the same union but are not shown here: an
 *  icon-only button needs an accessible name, which is a caller's job. */
const BUTTON_SIZES: ComponentProps<typeof CardButton>['size'][] = [
  'xs',
  'base',
  'toolbar',
  'sm',
  'magic-sm',
  'default',
  'lg',
  'xl',
];

// ── local chrome ─────────────────────────────────────────

/** The page's demo frame (`spec.tsx`): the page surface plus a hairline. */
const Frame = DemoContainer;

function Variant({
  label,
  note,
  children,
  frameClassName,
}: {
  label: string;
  note: string;
  children: React.ReactNode;
  frameClassName?: string;
}) {
  // One row of the Card spec: the label column, the note behind the info icon,
  // the variant in the page's demo frame (patterns.md, sections 1 to 3).
  return (
    <SpecRow label={label} about={note}>
      <Frame className={frameClassName}>{children}</Frame>
    </SpecRow>
  );
}

// ── section ──────────────────────────────────────────────

export function CardSection() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const localized = localizeUiCatalog(
    { RUNTIME, SURFACES, WALLPAPERS },
    tI18nComplete,
    DESIGN_SYSTEM_TRANSLATION_KEYS,
  );
  const [selected, setSelected] = useState(1);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const notices = [
    {
      id: 'snapshot',
      icon: CloudArrowUpIcon,
      title: tI18nComplete.raw('texte1d31423e77f'),
      body: tI18nComplete.raw('text8c5430fac0d9'),
    },
    {
      id: 'migration',
      icon: DatabaseIcon,
      title: tI18nComplete.raw('text260b83818832'),
      body: tI18nComplete.raw('textca44d7470fff'),
    },
  ].filter((notice) => !dismissed.includes(notice.id));

  return (
    <div className="space-y-6">
      {/* 1 ── anatomy ------------------------------------------------ */}
      <Variant
        label={tI18nComplete.raw('text7d345569180b')}
        note={tI18nComplete.raw('text06da55ff64fa')}
      >
        <Card className="max-w-md space-y-6 p-6">
          <div className="flex items-center gap-3">
            <CardMedia icon={CubeIcon} />
            <div className="flex items-center gap-2">
              <h3 className="text-base font-medium">Sandbox session</h3>
              <InfoHint label="About the sandbox session">
                A live cloud sandbox for each session. Credentials are injected at boot. The API
                streams readiness when it starts.
              </InfoHint>
            </div>
          </div>
          <ul className="text-muted-foreground space-y-3 text-sm">
            <li className="flex items-center gap-2">
              <LightningIcon className="size-4 shrink-0" />
              Starts with your session
            </li>
            <li className="flex items-center gap-2">
              <ShieldCheckIcon className="size-4 shrink-0" />
              Session-scoped credentials
            </li>
          </ul>
          <CardFooter className="gap-3 px-0 pt-0">
            <CardButton variant="secondary" icon={TerminalWindowIcon}>
              Open session
            </CardButton>
            <CardButton variant="ghost">Logs</CardButton>
          </CardFooter>
        </Card>
      </Variant>

      {/* 2 ── stacked group ------------------------------------------ */}
      <Variant
        label={tI18nComplete.raw('text5c6c8c0157e2')}
        note={tI18nComplete.raw('text4cc45abce5a0')}
      >
        <CardGroup>
          {localized.RUNTIME.map((item) => (
            <Card key={item.title} label={item.title} onClick={() => {}}>
              <CardHeader>
                <CardMedia icon={item.icon} />
                <CardTitle>{item.title}</CardTitle>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </CardGroup>
      </Variant>

      {/* 3 ── outlined group ----------------------------------------- */}
      <Variant
        label={tI18nComplete.raw('text88dd780cd3a7')}
        note={tI18nComplete.raw('texte61c3c44ff74')}
      >
        <CardGroup border="outlined">
          {localized.SURFACES.slice(0, 3).map((item) => (
            <Card key={item.title} label={item.title} onClick={() => {}}>
              <CardHeader>
                <CardMedia icon={item.icon} />
                <CardTitle>{item.title}</CardTitle>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </CardGroup>
      </Variant>

      {/* 4 ── grid, 2-D proximity ------------------------------------ */}
      <Variant
        label={tI18nComplete.raw('text37e3f6c2697b')}
        note={tI18nComplete.raw('text96efbfd36ce5')}
      >
        <CardGroup columns={2} border="outlined">
          {localized.SURFACES.map((item) => (
            <Card key={item.title} label={item.title} onClick={() => {}}>
              <CardHeader>
                <CardMedia icon={item.icon} />
                <CardTitle>{item.title}</CardTitle>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
              <CardFooter>
                <CardButton>{tI18nComplete.raw('text61e8d44ad423')}</CardButton>
              </CardFooter>
            </Card>
          ))}
        </CardGroup>
      </Variant>

      {/* 5 ── separated tiles ---------------------------------------- */}
      <Variant
        label={tI18nComplete.raw('text02e0567ac3d4')}
        note={tI18nComplete.raw('text3658d6e18a94')}
      >
        <CardGroup columns={3} separated border="outlined">
          {localized.RUNTIME.map((item) => (
            <Card key={item.title} label={item.title} onClick={() => {}}>
              <CardHeader>
                <CardMedia icon={item.icon} />
                <CardTitle>{item.title}</CardTitle>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </CardGroup>
      </Variant>

      {/* 6 ── inline rows -------------------------------------------- */}
      <Variant
        label={tI18nComplete.raw('text99ed40acbd94')}
        note={tI18nComplete.raw('text548d65f76e61')}
      >
        <CardGroup orientation="inline" border="outlined">
          <Card label={tI18nComplete.raw('textd6f42f3b5411')}>
            <CardMedia icon={KeyIcon} />
            <CardHeader>
              <CardTitle>{tI18nComplete.raw('textd6f42f3b5411')}</CardTitle>
              <CardDescription>{tI18nComplete.raw('text92660bfeed73')}</CardDescription>
            </CardHeader>
            <CardFooter>
              <CardButton icon={ArrowsClockwiseIcon}>
                {tI18nComplete.raw('textc3613b1704f5')}
              </CardButton>
            </CardFooter>
          </Card>
          <Card label={tI18nComplete.raw('text13d6ff07b8a5')}>
            <CardMedia icon={GitBranchIcon} />
            <CardHeader>
              <CardTitle>{tI18nComplete.raw('textec5855a78ab3')}</CardTitle>
              <CardDescription>{tI18nComplete.raw('text43394cf8283e')}</CardDescription>
            </CardHeader>
            <CardFooter>
              <CardButton icon={CodeIcon}>{tI18nComplete.raw('texted077f3d8125')}</CardButton>
            </CardFooter>
          </Card>
          <Card label={tI18nComplete.raw('text788011833a5a')}>
            <CardMedia icon={BellIcon} />
            <CardHeader>
              <CardTitle>{tI18nComplete.raw('text788011833a5a')}</CardTitle>
              <CardDescription>{tI18nComplete.raw('text5be1c74aa0a7')}</CardDescription>
            </CardHeader>
            <CardFooter>
              <CardButton variant="secondary">{tI18nComplete.raw('text6defafa2caa6')}</CardButton>
            </CardFooter>
          </Card>
        </CardGroup>
      </Variant>

      {/* 7 ── inline + image ----------------------------------------- */}
      <Variant
        label={tI18nComplete.raw('text24cfd660e786')}
        note={tI18nComplete.raw('textef4588ffbd13')}
      >
        <CardGroup orientation="inline" border="outlined">
          {localized.WALLPAPERS.map((wallpaper) => (
            <Card key={wallpaper.title} label={wallpaper.title}>
              <CardImage src={wallpaper.src} alt="" />
              <CardHeader>
                <CardEyebrow>{wallpaper.eyebrow}</CardEyebrow>
                <CardTitle>{wallpaper.title}</CardTitle>
                <CardDescription>{tI18nComplete.raw('text211ec50d7a30')}</CardDescription>
              </CardHeader>
              <CardFooter>
                <CardButton variant="secondary">{tI18nComplete.raw('textd6eafe823591')}</CardButton>
                <CardButton>{tI18nComplete.raw('text324b134f57c7')}</CardButton>
              </CardFooter>
            </Card>
          ))}
        </CardGroup>
      </Variant>

      {/* 8 ── stacked + banner --------------------------------------- */}
      <Variant
        label={tI18nComplete.raw('text20a958bfd83a')}
        note={tI18nComplete.raw('text9bf1993bf5ac')}
      >
        <CardGroup columns={2} separated border="outlined">
          {localized.WALLPAPERS.map((wallpaper) => (
            <Card key={wallpaper.title} label={wallpaper.title}>
              <CardImage src={wallpaper.src} alt="" />
              <CardHeader>
                <CardEyebrow>{wallpaper.eyebrow}</CardEyebrow>
                <CardTitle>{wallpaper.title}</CardTitle>
                <CardDescription>{tI18nComplete.raw('text06d7d97ef55d')}</CardDescription>
              </CardHeader>
              <CardFooter>
                <CardButton variant="default">{tI18nComplete.raw('textd6eafe823591')}</CardButton>
              </CardFooter>
            </Card>
          ))}
        </CardGroup>
      </Variant>

      {/* 9 ── media -------------------------------------------------- */}
      <Variant
        label={tI18nComplete.raw('textd357175cfe89')}
        note={tI18nComplete.raw('text7396996a6c8f')}
      >
        <CardGroup columns={3} separated border="outlined">
          <Card label={tI18nComplete.raw('textb6eb7c48522c')}>
            <CardHeader>
              <CardMedia icon={RobotIcon} />
              <CardTitle>{tI18nComplete.raw('texta35abcd6dac9')}</CardTitle>
              <CardDescription>{tI18nComplete.raw('textc09bd5ffeba2')}</CardDescription>
            </CardHeader>
          </Card>
          <Card label={tI18nComplete.raw('texte966f54a9a75')}>
            <CardHeader>
              <CardMedia logo="/usecases/logos/linear.png" logoAlt="Linear" />
              <CardTitle>{tI18nComplete.raw('textd707dc2f1936')}</CardTitle>
              <CardDescription>{tI18nComplete.raw('text3668377bfd48')}</CardDescription>
            </CardHeader>
          </Card>
          <Card label={tI18nComplete.raw('text3851cae17d93')}>
            <CardHeader>
              {/* Raster marks here because provider-icons/*.svg are monochrome
                  currentColor files: through an <img> they resolve to black and
                  vanish in dark mode (the app inlines them, or adds dark:invert). */}
              <CardMedia
                logo={['/usecases/logos/linear.png', '/usecases/logos/slack.webp']}
                logoAlt={tI18nComplete.raw('text59d3b31b8956')}
              />
              <CardTitle>{tI18nComplete.raw('text3851cae17d93')}</CardTitle>
              <CardDescription>{tI18nComplete.raw('textb88c90511203')}</CardDescription>
            </CardHeader>
          </Card>
        </CardGroup>
      </Variant>

      {/* 10 ── selection --------------------------------------------- */}
      <Variant
        label={tI18nComplete.raw('text57fd7a0cf33f')}
        note={tI18nComplete.raw('text717927e1dd40')}
      >
        <CardGroup border="outlined">
          {localized.SURFACES.slice(0, 3).map((item, index) => (
            <Card
              key={item.title}
              label={item.title}
              selected={selected === index}
              onClick={() => setSelected(index)}
            >
              <CardHeader>
                <CardMedia icon={item.icon} />
                <CardTitle>{item.title}</CardTitle>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </CardGroup>
      </Variant>

      {/* 11 ── disabled ---------------------------------------------- */}
      <Variant
        label={tI18nComplete.raw('text75081b593d15')}
        note={tI18nComplete.raw('text6aa179c11c63')}
      >
        <CardGroup columns={2} separated border="outlined">
          <Card label={tI18nComplete.raw('texte674447337e8')} onClick={() => {}}>
            <CardHeader>
              <CardMedia icon={SparkleIcon} />
              <CardTitle>{tI18nComplete.raw('texte674447337e8')}</CardTitle>
              <CardDescription>{tI18nComplete.raw('text3fa319e52954')}</CardDescription>
            </CardHeader>
          </Card>
          <Card label={tI18nComplete.raw('textca1844969742')} disabled onClick={() => {}}>
            <CardHeader>
              <CardMedia icon={DatabaseIcon} />
              <CardTitle>{tI18nComplete.raw('textca1844969742')}</CardTitle>
              <CardDescription>{tI18nComplete.raw('textce281df2e934')}</CardDescription>
            </CardHeader>
          </Card>
        </CardGroup>
      </Variant>

      {/* 12 ── dismissible ------------------------------------------- */}
      <Variant
        label={tI18nComplete.raw('textf27bcbb5e1e2')}
        note={tI18nComplete.raw('textb9539997cfbd')}
      >
        {notices.length > 0 ? (
          <CardGroup columns={2} separated border="outlined">
            {notices.map((notice) => (
              <Card
                key={notice.id}
                label={notice.title}
                dismissible
                onDismiss={() => setDismissed((ids) => [...ids, notice.id])}
              >
                <CardHeader>
                  <CardMedia icon={notice.icon} />
                  <CardTitle>{notice.title}</CardTitle>
                  <CardDescription>{notice.body}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </CardGroup>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-muted-foreground text-sm">{tI18nComplete.raw('textb9e9f26c6ab1')}</p>
            <CardButton
              variant="secondary"
              icon={ArrowsClockwiseIcon}
              onClick={() => setDismissed([])}
            >
              {tI18nComplete.raw('textdaee7606b339')}
            </CardButton>
          </div>
        )}
      </Variant>

      {/* 13 ── clickable --------------------------------------------- */}
      <Variant
        label={tI18nComplete.raw('texta4119d094636')}
        note={tI18nComplete.raw('text12e59d221a29')}
      >
        <CardGroup columns={2} separated border="outlined">
          <Card
            label={tI18nComplete.raw('text559b1cc46027')}
            href="https://docs.kortix.com"
            external
          >
            <CardHeader>
              <CardMedia icon={BookOpenIcon} />
              <CardTitle>{tI18nComplete.raw('textc205924de0fe')}</CardTitle>
              <CardDescription>{tI18nComplete.raw('texta8e98b14ad73')}</CardDescription>
            </CardHeader>
            <CardFooter>
              <CardButton href="https://docs.kortix.com" external>
                {tI18nComplete.raw('textd942e3dc737b')}
              </CardButton>
            </CardFooter>
          </Card>
          <Card label={tI18nComplete.raw('text4a866105af15')} href="/design-system#comp-card">
            <CardHeader>
              <CardMedia icon={SparkleIcon} />
              <CardTitle>{tI18nComplete.raw('text4a866105af15')}</CardTitle>
              <CardDescription>{tI18nComplete.raw('textbe35cc8c61f6')}</CardDescription>
            </CardHeader>
            <CardFooter>
              <CardButton variant="link">{tI18nComplete.raw('text27ef201b76a2')}</CardButton>
            </CardFooter>
          </Card>
        </CardGroup>
      </Variant>

      {/* 14 ── card buttons ------------------------------------------ */}
      <Variant
        label={tI18nComplete.raw('textc229fa075816')}
        note={tI18nComplete.raw('texte22df9359943')}
      >
        {/* CardButton stands alone — it needs no Card around it. */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-1">
            {BUTTON_VARIANTS.map((variant) => (
              <CardButton key={variant} variant={variant}>
                {variant}
              </CardButton>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {BUTTON_SIZES.map((size) => (
              <CardButton key={size} size={size} variant="outline">
                {size}
              </CardButton>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <CardButton icon={CloudArrowUpIcon}>{tI18nComplete.raw('textde9c395367bb')}</CardButton>
            <CardButton icon={ArrowsClockwiseIcon} iconPosition="end">
              {tI18nComplete.raw('textfc62c144fc7a')}
            </CardButton>
            <CardButton href="https://dosco.live" external>
              {tI18nComplete.raw('text68c114ea9c8c')}
            </CardButton>
            <CardButton disabled>{tI18nComplete.raw('text75081b593d15')}</CardButton>
          </div>
        </div>
      </Variant>

      {/* 15 ── proximity off ----------------------------------------- */}
      <Variant
        label={tI18nComplete.raw('text4658997f85b5')}
        note={tI18nComplete.raw('text91e222e24b7f')}
      >
        <CardGroup border="outlined" proximityHover={false}>
          {localized.RUNTIME.slice(0, 2).map((item) => (
            <Card key={item.title}>
              <CardHeader>
                <CardMedia icon={item.icon} />
                <CardTitle>{item.title}</CardTitle>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </CardGroup>
      </Variant>
    </div>
  );
}
