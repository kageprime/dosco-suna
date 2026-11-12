'use client';

import { FreeGrantNotice } from '@/features/billing/free-grant-notice';
import { PlanChanger } from '@/features/billing/plan-card';
import { PricingPlanCard } from '@/features/billing/pricing-plan-card';
import type { PricingPlan } from '@/features/billing/pricing-plans';
import { TopupControls } from '@/features/billing/topup-controls';
import { useChangeCreditPlan } from '@/features/billing/use-change-credit-plan';
import { useTalkToSales } from '@/features/billing/use-enterprise-sales';
import { useUpgradePlans } from '@/features/billing/use-pricing-plans';
import { useUpgradeModalHost } from '@/features/billing/use-upgrade-modal-host';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { CreditLadder } from '@/features/marketing/pricing/credit-ladder';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import {
  type AccountState,
  type BillingState,
  canManageBilling,
  canOfferTopup,
  resolvedPlan,
} from '@kortix/sdk';
import { Button } from '@kortix/ui/button';
import Hint from '@kortix/ui/hint';
import { Copy } from '@kortix/ui/icons';
import { useAccountMembers } from '@kortix/ui/internal/account-hub/use-account-members';
import {
  DEFAULT_TIER_USD,
  formatWholeUsd,
  tierForMonthlyUsd,
} from '@kortix/ui/internal/billing/compute-pricing';
import {
  invalidateAccountState,
  useAccountState,
  useCreatePortalSession,
} from '@kortix/ui/internal/billing/index';
import {
  accountHasLiveSubscription,
  billingModalCopy,
  billingModalNeedsTopUp,
  resolveBillingState,
} from '@kortix/ui/internal/lib/billing/billing-gate-state';
import { accountPanelUrl, hubTarget } from '@kortix/ui/internal/stores/account-panel-store';
import {
  BillingAccountProvider,
  useBillingAccountId,
} from '@kortix/ui/internal/stores/billing-account-context';
import { useUpgradeDialogStore } from '@kortix/ui/internal/stores/upgrade-dialog-store';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@kortix/ui/item';
import Loading from '@kortix/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@kortix/ui/modal';
import { AskOwnerForCreditsButton } from '@kortix/ui/session/models/ask-owner-for-credits-button';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast } from '@kortix/ui/toast';
import { UserAvatar } from '@kortix/ui/user-avatar';
import {
  ArrowRightIcon as ArrowRight,
  CheckIcon,
  UserPlusIcon as UserPlus,
} from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

/** Whole-naira figure for pre-redirect display ("≈ ₦60,000 charged"). */
function formatNgn(amountNgn: number): string {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amountNgn);
}

export interface UpgradePlansModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountState?: AccountState;
  /** From the 402: distinguishes "wallet drained → top up" (credit view)
   *  from "no plan → pick a plan" (plans view). Fall back to accountState. */
  reason?: string;
  hasSubscription?: boolean;
  /** The resolved state from whichever surface opened the modal. Preferred over
   *  `reason` (the lossy 402 code) so the modal and the gate that opened it can
   *  never disagree about the same account. */
  billingState?: BillingState;
  /** True while account state is doing its first load — the credit view shows
   *  a skeleton instead of a misleading 0 until the real value lands. */
  accountLoading?: boolean;
}

/**
 * Which view the billing modal opens on:
 *
 * - `topup-first`: any account that is out of credits or whose payment failed.
 *   The compact modal: one slider, one action (Paper "Out of credits — v3");
 * - `plan-first`: a subscriber that is not blocked. The monthly plan leads;
 * - `plans`: Free against Credits, for a voluntary visit without a
 *   subscription.
 *
 * Inside the compact modal the slider sells the monthly plan. Only an account
 * that may buy one-off credits (`canOfferTopup`: Enterprise, or the per-account
 * grant) gets the one-off slider instead (Marko, 2026-11-09).
 */
export function billingModalLayout(opts: {
  needsTopUp: boolean;
  hasSubscription: boolean;
}): 'plans' | 'topup-first' | 'plan-first' {
  if (opts.needsTopUp) return 'topup-first';
  return opts.hasSubscription ? 'plan-first' : 'plans';
}

export function UpgradePlansModal({
  open,
  onOpenChange,
  accountState,
  reason,
  hasSubscription,
  billingState,
  accountLoading,
}: UpgradePlansModalProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const t = useTranslations('billing.credits.modal');
  const plans = useUpgradePlans();
  const sales = useTalkToSales(useBillingAccountId());

  // Which view? Resolved from the ONE billing-state resolver. The caller's
  // `billingState` (from the 402 or the gate that opened this) wins because
  // accountState can still be loading; otherwise derive it from live state.
  const hasSub = hasSubscription ?? accountHasLiveSubscription(accountState);
  const resolvedState = billingState ?? resolveBillingState(accountState);
  const layout = billingModalLayout({
    needsTopUp:
      billingModalNeedsTopUp(accountState, resolvedState) || reason === 'insufficient_credits',
    hasSubscription: hasSub,
  });

  if (layout !== 'plans') {
    return (
      <CreditTopUpModal
        open={open}
        onOpenChange={onOpenChange}
        accountState={accountState}
        billingState={resolvedState}
        accountLoading={accountLoading}
        leadWithTopUp={layout === 'topup-first'}
      />
    );
  }

  // `false` until the account state loads (KRTX-1720): Subscribe stays
  // disabled for that window, and the "owner required" button and the "ask an
  // owner" note wait for the answer.
  const mayManageBilling = canManageBilling(accountState);
  const ownerRequired = !!accountState && !mayManageBilling;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent variant="base" className="gap-0 space-y-0 p-0 lg:max-w-4xl">
        <ModalHeader className="space-y-2 px-6 pt-7 pb-6 md:px-8">
          <ModalTitle className="text-2xl font-medium tracking-tight text-balance">
            {t('title')}
          </ModalTitle>
          <ModalDescription className="max-w-xl text-sm text-pretty">
            {t('description')}
          </ModalDescription>
        </ModalHeader>

        {/* The /pricing plans band: hairlines top and bottom, one between the columns. */}
        <ModalBody className="p-0">
          <div className="divide-border grid grid-cols-1 divide-y border-y md:grid-cols-2 md:divide-x md:divide-y-0">
            {plans.map((plan) => (
              <UpgradePlanCard
                key={plan.id}
                plan={plan}
                onContinueFree={() => onOpenChange(false)}
                ownerRequired={ownerRequired}
                mayManageBilling={mayManageBilling}
                accountState={accountState}
              />
            ))}
          </div>
        </ModalBody>

        <div className="space-y-4 px-6 py-4 md:px-8">
          <p className="text-muted-foreground text-center text-xs">
            {tI18nHardcoded.raw('i18nComplete.textff2b8e88c520')}{' '}
            <button
              type="button"
              disabled={sales.isPending}
              onClick={sales.talk}
              className="text-foreground underline-offset-4 hover:underline"
            >
              {tI18nHardcoded.raw('i18nComplete.text604abea32b49')}
            </button>
          </p>

          {ownerRequired && (
            <Item variant="outline" size="sm" className="items-start bg-none">
              <Hint label={t('askOwnerHint')} side="top" className="max-w-xs text-xs">
                <ItemMedia variant="icon">
                  <UserPlus />
                </ItemMedia>
              </Hint>
              <ItemContent>
                <ItemTitle>{t('askOwnerTitle')}</ItemTitle>
                <ItemDescription className="text-xs leading-relaxed">
                  {t('askOwnerBody')}
                </ItemDescription>
              </ItemContent>
            </Item>
          )}
        </div>
      </ModalContent>
    </Modal>
  );
}

/**
 * One card of the plan view. Free closes the dialog. Credits carries the
 * credits ladder and starts the plan change; its own state, so the tier
 * survives re-renders of the modal.
 */
function UpgradePlanCard({
  plan,
  onContinueFree,
  ownerRequired,
  mayManageBilling,
  accountState,
}: {
  plan: PricingPlan;
  onContinueFree: () => void;
  ownerRequired: boolean;
  mayManageBilling: boolean;
  accountState?: AccountState;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tAccess = useTranslations('billing.access');
  const tCard = useTranslations('billing.credits.planCard');
  const tPlan = useTranslations('billing.plan');
  const locale = useLocale();
  const [monthlyUsd, setMonthlyUsd] = useState<number>(DEFAULT_TIER_USD);
  const { change, isPending } = useChangeCreditPlan();

  if (plan.id !== 'credits') {
    return (
      <PricingPlanCard
        plan={plan}
        badgeOverride={tPlan('currentPlan')}
        action={
          <MarketingButton
            type="button"
            size="md"
            variant="secondary"
            className="hit-area-y-1 w-full"
            onClick={onContinueFree}
          >
            {tI18nHardcoded.raw('i18nComplete.text73a7da68c3bf')}
          </MarketingButton>
        }
      />
    );
  }

  const valid = !!tierForMonthlyUsd(monthlyUsd);
  return (
    <PricingPlanCard
      plan={plan}
      priceSlot={
        <div className="space-y-3">
          <CreditLadder
            value={monthlyUsd}
            onChange={setMonthlyUsd}
            disabled={isPending}
            stackBelowXl={false}
          />
            <p className="text-muted-foreground text-xs text-balance">{tCard('rate')}</p>
            {accountState?.billing_fx?.usd_ngn_rate ? (
              <p className="text-muted-foreground text-xs tabular-nums">
                ≈ {formatNgn(Math.round(monthlyUsd * accountState.billing_fx.usd_ngn_rate))} / mo charged via Paystack
              </p>
            ) : null}
          </div>
      }
      action={
        ownerRequired ? (
          <MarketingButton
            type="button"
            size="md"
            variant="secondary"
            className="hit-area-y-1 w-full"
            disabled
          >
            {tAccess('managerRequired')}
          </MarketingButton>
        ) : (
          <MarketingButton
            type="button"
            size="md"
            variant="primary"
            className="group hit-area-y-1 w-full"
            disabled={isPending || !mayManageBilling || !valid}
            onClick={() => valid && change(monthlyUsd)}
          >
            {isPending ? (
              <>
                <Loading />
                {tI18nHardcoded.raw(
                  'autoFeaturesBillingTeamPlanCheckoutJsxTextStartingCheckout282edf7f',
                )}
              </>
            ) : (
              <>
                {valid
                  ? tCard('subscribeAction', { amount: formatWholeUsd(monthlyUsd, locale) })
                  : tCard('chooseAction')}
                <ArrowRight className="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
              </>
            )}
          </MarketingButton>
        )
      }
    />
  );
}

interface CreditTopUpModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountState?: AccountState;
  billingState?: BillingState | null;
  accountLoading?: boolean;
  /** Out of credits or payment failed: the fix leads. */
  leadWithTopUp: boolean;
}

/**
 * The compact billing modal (Paper "Out of credits — v3"): a title, one line,
 * one slider, one action. Picked from who is looking and why:
 *
 * - a member, who may not change billing: who can fix it, and a link to send
 *   them. No purchase control renders for a member (KRTX-1720);
 * - payment failed: the card is the fix, so updating it leads;
 * - an account that may buy one-off credits (Enterprise, or the per-account
 *   grant): the /pricing slider over the one-off amounts, with the monthly plan
 *   one link away below Enterprise;
 * - everyone else: the /pricing slider over the monthly tiers. Subscribing, or
 *   raising the plan, is the way to more credits.
 */
function CreditTopUpModal({
  open,
  onOpenChange,
  accountState,
  billingState,
  accountLoading,
  leadWithTopUp,
}: CreditTopUpModalProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('billing.credits.modal');
  const createPortal = useCreatePortalSession();
  const [showPlan, setShowPlan] = useState(false);
  const [topUpInstead, setTopUpInstead] = useState(false);
  // Out-of-credits copy is DERIVED from the billing state, never written here:
  // a hardcoded "Out of credits" title once announced an emergency to every
  // account that opened this modal.
  // A Free workspace that leads with the top-up is out of credits, whatever
  // `no_subscription` says: it has a plan (Free), its wallet is empty.
  const copy = leadWithTopUp
    ? billingModalCopy(
        billingState === 'no_subscription' ? 'out_of_credits' : (billingState ?? null),
        tI18nComplete,
      )
    : { title: t('planTitle'), description: t('planDescription') };
  // The Stripe customer portal does not exist for Paystack-billed accounts
  // (the portal route 400s for them) — hide its CTA instead of erroring.
  const isPaystackBilled = accountState?.subscription?.provider === 'paystack';

  // A fresh open starts on the view its reason asks for. Reset during render,
  // not in an effect, so the first painted frame is already the right view.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setShowPlan(false);
      setTopUpInstead(false);
    }
  }

  const isMember = !!accountState && !canManageBilling(accountState);
  // One-off top-ups exist only for Enterprise and accounts granted them.
  const canTopUp = canOfferTopup(accountState);
  const isEnterprise = resolvedPlan(accountState).family === 'enterprise';
  // The one-off slider answers "out of credits" only. A voluntary visit opens
  // on the plan, as before.
  const showTopUp = canTopUp && leadWithTopUp && !showPlan;
  const paymentFailed = leadWithTopUp && billingState === 'payment_failed' && !topUpInstead;
  const openPortal = () => createPortal.mutate({ return_url: window.location.href });
  // One line under the title, naming the one way forward.
  const line = isMember
    ? t('memberBody')
    : paymentFailed || !leadWithTopUp
      ? copy.description
      : showTopUp
        ? t('addLine')
        : accountHasLiveSubscription(accountState)
          ? t('raiseLine')
          : t('subscribeLine');
  // An auto top-up saved before one-off top-ups left this plan never charges
  // again (auto-topup.ts). Say so once, where the user would expect it to run.
  const autoTopupRetired = !canTopUp && !!accountState?.auto_topup?.enabled;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="gap-0 space-y-0 p-0 sm:max-w-md">
        <ModalHeader className="gap-1.5 px-6 pt-6 pb-6">
          <ModalTitle className="pr-8 text-lg font-medium tracking-tight">{copy.title}</ModalTitle>
          <ModalDescription className="text-sm text-pretty">{line}</ModalDescription>
        </ModalHeader>

        {!accountState && accountLoading ? (
          // Who is looking decides the view (member, payment failed, slider).
          // Hold one neutral block at the slider's height until the state says.
          <div className="space-y-6 px-6 pb-6" aria-hidden>
            <Skeleton className="h-28 w-full rounded-md" />
            <Skeleton className="h-10 w-full rounded-md" />
          </div>
        ) : isMember ? (
          <MemberBlockedView />
        ) : paymentFailed ? (
          <PaymentFailedView
            portalPending={createPortal.isPending}
            onUpdateCard={openPortal}
            onTopUpInstead={canTopUp ? () => setTopUpInstead(true) : undefined}
          />
        ) : showTopUp ? (
          <div className="pb-2">
            <TopupControls state={accountState} variant="hero" />
            {!isEnterprise ? (
              <div className="flex justify-center border-t px-6 py-3">
                <button
                  type="button"
                  onClick={() => setShowPlan(true)}
                  className="text-foreground text-xs underline-offset-4 hover:underline"
                >
                  {t('switchToMonthly')}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3 px-6 pb-6">
            {accountState ? (
              <PlanChanger
                state={accountState}
                variant={leadWithTopUp ? 'ladder' : 'card'}
                className={leadWithTopUp ? undefined : 'bg-popover rounded-md border'}
              />
            ) : (
              <Skeleton className="h-40 w-full rounded-md" />
            )}
            {autoTopupRetired ? (
              <p className="text-muted-foreground text-center text-xs text-balance">
                {t('autoTopupRetired')}
              </p>
            ) : null}
            <FreeGrantNotice state={accountState} className="text-center" />
          </div>
        )}

        {/* A voluntary visit keeps the way to invoices, the card and
            cancelling. The out-of-credits view stays one action, and a
            Paystack account has no Stripe portal to open. */}
        {!isPaystackBilled && !leadWithTopUp && !isMember ? (
          <div className="flex items-center border-t px-3 py-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground gap-1.5"
              disabled={createPortal.isPending}
              onClick={openPortal}
            >
              {createPortal.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {tI18nComplete.raw('text7ea27c63aff1')}
            </Button>
          </div>
        ) : null}
      </ModalContent>
    </Modal>
  );
}

/**
 * The last charge failed. The card is the fix: updating it in the Stripe
 * portal retries the charge. A one-time top-up with another card is the
 * other way out. Red marks the state once, on the dot.
 */
function PaymentFailedView({
  portalPending,
  onUpdateCard,
  onTopUpInstead,
}: {
  portalPending: boolean;
  onUpdateCard: () => void;
  /** Absent when the account may not buy one-off credits. */
  onTopUpInstead?: () => void;
}) {
  const t = useTranslations('billing.credits.modal');
  return (
    <div className="space-y-4 px-6 pb-6" data-testid="billing-payment-failed">
      <div className="bg-popover flex items-start gap-3 rounded-md border px-4 py-3">
        <span aria-hidden className="bg-kortix-red mt-2 size-1.5 shrink-0 rounded-full" />
        <p className="text-foreground text-sm">{t('paymentFailedHint')}</p>
      </div>
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          size="lg"
          className="w-full gap-1.5 motion-safe:active:scale-[0.96]"
          disabled={portalPending}
          aria-busy={portalPending}
          onClick={onUpdateCard}
        >
          {portalPending ? <Loading className="size-4 shrink-0" /> : null}
          {t('updatePaymentMethod')}
        </Button>
        {onTopUpInstead ? (
          <Button
            type="button"
            size="lg"
            variant="secondary"
            className="w-full motion-safe:active:scale-[0.96]"
            onClick={onTopUpInstead}
          >
            {t('topUpInstead')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A member may not buy credits: the purchase routes answer 403 (KRTX-1720).
 * Name who can, and hand over a link that opens this workspace's billing for
 * them. The directory read answers only the caller for a member without
 * `member.read`; then the list hides and the sentence stands alone.
 */
function MemberBlockedView() {
  const t = useTranslations('billing.credits.modal');
  const accountId = useBillingAccountId();
  const members = useAccountMembers(accountId ?? undefined);
  const owners = (members.data ?? []).filter((member) => {
    const role = member.role ?? member.account_role;
    return (role === 'owner' || role === 'admin') && !!member.email;
  });
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copyLink = async () => {
    if (!accountId) return;
    // Open billing over the workspace home, not over the member's own page
    // (often a session): keep the locale and `/workspaces/<id>`, drop the rest.
    const base =
      window.location.pathname.match(/^(?:\/[a-z]{2})?\/workspaces\/[^/]+/)?.[0] ?? '/workspaces';
    const path = accountPanelUrl(base, hubTarget(accountId, { tab: 'billing' }));
    try {
      await navigator.clipboard.writeText(new URL(path, window.location.origin).toString());
      // The label says "Link copied", so no toast repeats it. Back to idle in 2 s.
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      errorToast(t('memberLinkCopyFailed'));
    }
  };

  return (
    <div className="space-y-4 px-6 pb-6" data-testid="topup-ask-owner">
      {members.isPending && accountId ? (
        <div className="space-y-1.5" aria-hidden>
          <Skeleton className="h-10 w-full rounded-md" />
        </div>
      ) : owners.length > 0 ? (
        <ul className="bg-popover divide-y rounded-md border">
          {owners.slice(0, 3).map((owner) => (
            <li key={owner.user_id} className="flex items-center gap-2.5 px-3 py-2">
              <UserAvatar email={owner.email!} size="sm" colorKey={owner.user_id} />
              <span className="text-foreground min-w-0 flex-1 truncate text-sm">{owner.email}</span>
              <span className="text-muted-foreground text-xs">
                {(owner.role ?? owner.account_role) === 'owner' ? t('roleOwner') : t('roleAdmin')}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-col gap-2">
        {/* Emails every owner (TOPUP-1, POST /accounts/:id/top-up-requests),
            once per member a day; the button carries its own 429 state. */}
        {accountId ? (
          <AskOwnerForCreditsButton
            accountId={accountId}
            variant="default"
            size="lg"
            className="w-full gap-1.5"
          />
        ) : null}
        <Button
          type="button"
          size="lg"
          variant="secondary"
          className="w-full gap-1.5 motion-safe:active:scale-[0.96]"
          disabled={!accountId}
          onClick={() => void copyLink()}
        >
          {copied ? <CheckIcon aria-hidden className="size-4" /> : <Copy className="size-4" />}
          {copied ? t('memberLinkCopied') : t('memberCopyLink')}
        </Button>
      </div>
    </div>
  );
}

export function GlobalUpgradeModal() {
  const selected = useUpgradeModalHost();
  return selected ? <GlobalUpgradeModalContent /> : null;
}

function GlobalUpgradeModalContent() {
  const { isOpen, closeUpgradeDialog, accountId, reason, hasSubscription, billingState } =
    useUpgradeDialogStore();
  const { data: accountState, isLoading: accountLoading } = useAccountState({ accountId });
  const queryClient = useQueryClient();

  // Pull the freshest account state every time the modal opens (skip the
  // server cache) so it always matches the Plan page — never a stale/zero value
  // left over from an earlier read, and it reflects a top-up the moment it lands.
  useEffect(() => {
    if (isOpen) invalidateAccountState(queryClient, true, true, accountId);
  }, [isOpen, queryClient, accountId]);

  return (
    <BillingAccountProvider accountId={accountId ?? null}>
      <UpgradePlansModal
        open={isOpen}
        onOpenChange={(open) => !open && closeUpgradeDialog()}
        accountState={accountState}
        reason={reason}
        hasSubscription={hasSubscription}
        billingState={billingState}
        accountLoading={accountLoading}
      />
    </BillingAccountProvider>
  );
}
