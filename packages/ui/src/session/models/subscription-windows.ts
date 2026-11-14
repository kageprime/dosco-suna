/**
 * The pure reading of a subscription login's usage windows: tone, names,
 * blocking windows and the limit. The model picker (`subscription-switcher`)
 * and the provider sheet (`customize/sections/view/subscription-usage`) both
 * read these, so they live at the session layer, below customize.
 */
import type { SubscriptionAccount, SubscriptionUsage, SubscriptionUsageWindow } from '@kortix/sdk';
import type { useTranslations } from '../../i18n';

export type UsageTone = 'ok' | 'near' | 'critical' | 'limited';

/** The bar fill of each tone: the provider sheet's meters and the picker's subscription rows. */
export const USAGE_TONE_BAR: Record<UsageTone, string> = { ok: 'bg-primary', near: 'bg-kortix-orange', critical: 'bg-kortix-red', limited: 'bg-kortix-red' };

/** Warn at 80%, turn red at 95%, and distinguish a provider-enforced limit. */
export function usageTone(window: SubscriptionUsageWindow, limited: boolean): UsageTone {
  if (window.used_percent >= 100 || (limited && window.used_percent >= 90)) return 'limited';
  if (window.used_percent >= 95) return 'critical';
  return window.used_percent >= 80 ? 'near' : 'ok';
}

/**
 * Windows that never stop the login's model calls: code review, paid extra
 * usage, and one model's own limit (ChatGPT `model_*`, Claude `seven_day_opus`,
 * `7d_sonnet`). Claude's OAuth-apps window stays blocking. The server's twin
 * is `isBlockingWindow` in packages/llm-gateway/src/usage/subscription-usage.ts.
 */
export function isBlockingWindow(id: string): boolean {
  return !/^(?:code_review|extra_usage|model_|seven_day_(?!oauth_apps$)|7d_(?!oauth_apps$))/.test(id);
}

/** The model name of a model-specific weekly window (`seven_day_opus` → `Opus`), or null. */
export function weeklyModel(id: string): string | null {
  const model = /^(?:seven_day|7d)_([a-z]+)$/.exec(id)?.[1];
  return model ? model[0]!.toUpperCase() + model.slice(1) : null;
}

const title = (value: string) => value.replaceAll('_', ' ').replace(/^./, (first) => first.toUpperCase());

/** A model limit's id fragment read back as its name: `gpt_5_3_codex_spark` → `GPT-5.3 Codex Spark`. */
export function modelName(slug: string): string {
  const words: string[] = [];
  for (const token of slug.split('_').filter(Boolean)) {
    const last = words.at(-1);
    if (/^\d+$/.test(token) && last && /\d$/.test(last)) words[words.length - 1] = `${last}.${token}`;
    else words.push(token === 'gpt' ? 'GPT' : /^\d/.test(token) ? token : token[0]!.toUpperCase() + token.slice(1));
  }
  return words.join(' ').replace(/^GPT (\d)/, 'GPT-$1');
}

type Translate = ReturnType<typeof useTranslations>;

/** A window's name: `5-hour`, `Weekly`, `Weekly · Opus`, `Code review · Weekly`, `Extra usage`. */
export function windowLabel(id: string, t: Translate, options: { modelWeekly?: boolean } = {}): string {
  if (id === 'five_hour') return t('fiveHour');
  // Beside `Weekly · Opus`, the plain weekly window is the one every model shares.
  if (id === 'weekly') return options.modelWeekly ? t('weeklyAll') : t('weekly');
  if (id === 'extra_usage') return t('extraUsage');
  if (id === 'seven_day_oauth_apps' || id === '7d_oauth_apps') return t('weeklyModel', { model: t('apps') });
  const model = weeklyModel(id);
  if (model) return t('weeklyModel', { model });
  const scoped = /^(code_review|model_[a-z0-9_]+?)_(five_hour|weekly|primary|secondary)$/.exec(id);
  if (scoped) {
    const scope = scoped[1] === 'code_review' ? t('codeReview') : modelName(scoped[1]!.slice('model_'.length));
    const span = scoped[2] === 'five_hour' ? t('fiveHour') : scoped[2] === 'weekly' ? t('weekly') : null;
    return span ? `${scope} · ${span}` : scope;
  }
  return title(id);
}

/**
 * `person@example.test · Pro`: who the login signs in as. The email is left out
 * when the label already shows it; null when the provider says nothing.
 */
export function accountLine(account: SubscriptionAccount | null | undefined, label: string): string | null {
  if (!account) return null;
  const email = account.email && !label.toLowerCase().includes(account.email.toLowerCase()) ? account.email : null;
  const plan = account.plan ? account.plan[0]!.toUpperCase() + account.plan.slice(1) : null;
  return [email, plan].filter(Boolean).join(' · ') || null;
}

/** The windows still in force: a window whose reset passed no longer limits anything. */
export function currentWindows(usage: SubscriptionUsage, now: number): SubscriptionUsageWindow[] {
  return usage.windows.filter((window) => !window.resets_at || Date.parse(window.resets_at) > now);
}

/** A login that cannot take a model call now, and when that ends (null: unknown). */
export function loginLimit(usage: SubscriptionUsage | null, now: number): { limited: boolean; until: string | null } {
  if (!usage) return { limited: false, until: null };
  const blocking = currentWindows(usage, now).filter((window) => isBlockingWindow(window.id));
  const full = blocking.filter((window) => window.used_percent >= 100);
  // A rejection whose window already reset is history, not a limit.
  const rejected = usage.limited && blocking.length === usage.windows.filter((window) => isBlockingWindow(window.id)).length;
  if (!full.length && !rejected) return { limited: false, until: null };
  const resets = (full.length ? full : blocking).map((window) => window.resets_at).filter((at): at is string => Boolean(at));
  // Capacity is back only when the LAST full window resets.
  return { limited: true, until: resets.length ? resets.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b)) : null };
}
