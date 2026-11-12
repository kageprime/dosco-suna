import type { PricingPlan } from '@/features/billing/pricing-plans';
import { cn } from '@kortix/ui';
import {
  CREDITS_PLAN_MAX_USD,
  CREDITS_PLAN_MIN_USD,
  FREE_MONTHLY_CREDITS,
  monthlyCreditsForUsd,
} from '@kortix/ui/internal/billing/compute-pricing';
import { SolidCheckIcon } from '@kortix/ui/internal/icons/solid-check-icon';
import { MinusIcon } from '@phosphor-icons/react';
import { Fragment } from 'react';

/** A cell in the compare table: included, not included, or a value. */
type Mark = boolean | string;

/**
 * The compare table (Accrue "Compare Plans"). Every row restates a plan
 * feature or an FAQ answer in `billing.pricing`, so the table makes no claim
 * the cards and the FAQ do not. Labels are English only, like the landing
 * sections; the table renders for `en` alone until it has catalog keys.
 */
function compareGroups(
  locale: string,
): { title: string; rows: { label: string; marks: [Mark, Mark, Mark] }[] }[] {
  const credits = (usd: number) => new Intl.NumberFormat(locale).format(monthlyCreditsForUsd(usd));
  return [
    {
      title: 'Usage',
      rows: [
        {
          label: 'Credits each month',
          marks: [
            new Intl.NumberFormat(locale).format(FREE_MONTHLY_CREDITS),
            `${credits(CREDITS_PLAN_MIN_USD)} to ${credits(CREDITS_PLAN_MAX_USD)}`,
            'Volume pricing',
          ],
        },
        { label: 'Members', marks: ['Unlimited', 'Unlimited', 'Unlimited'] },
        { label: 'Unused credits roll over', marks: [false, 'One month', 'One month'] },
        { label: 'Top-ups that never expire', marks: [false, true, true] },
      ],
    },
    {
      title: 'Models',
      rows: [
        // Free never gets managed models (resolve-billing.ts `paysForManagedModels`),
        // so the Free mark is false. DeepSeek and GLM only — no retired lineup names.
        { label: 'Managed models: DeepSeek, GLM', marks: [false, true, true] },
        { label: 'Your own API keys', marks: [true, true, true] },
        { label: 'ChatGPT subscription', marks: [true, true, true] },
        { label: 'Higher model rate limits', marks: [false, true, true] },
        { label: 'Managed model controls', marks: [false, false, true] },
      ],
    },
    {
      title: 'Security and support',
      rows: [
        { label: 'SAML SSO and SCIM directory sync', marks: [false, false, true] },
        { label: 'Advanced RBAC and audit logs', marks: [false, false, true] },
        { label: 'Deployment', marks: ['Cloud', 'Cloud', 'Cloud, VPC or on-prem'] },
        { label: 'Support', marks: [false, 'Email', 'Dedicated'] },
        { label: 'SLA and DPA', marks: [false, false, true] },
      ],
    },
  ];
}

/** A compare-table cell: a check, a muted dash, or the value as text. */
function MarkCell({ mark }: { mark: Mark }) {
  if (mark === true) {
    return (
      <>
        <SolidCheckIcon className="text-ring mx-auto" />
        <span className="sr-only">Included</span>
      </>
    );
  }
  if (mark === false) {
    return (
      <>
        <MinusIcon aria-hidden className="text-muted-foreground mx-auto size-4" />
        <span className="sr-only">Not included</span>
      </>
    );
  }
  return <span className="text-foreground text-pretty">{mark}</span>;
}

/** The /pricing compare table's rows, one group per topic. Rendered inside the page's section band. */
export function CompareTable({ plans, locale }: { plans: PricingPlan[]; locale: string }) {
  const groups = compareGroups(locale);
  return (
    <table className="w-full table-fixed border-collapse text-sm">
      <caption className="sr-only">Compare plans</caption>
      <colgroup>
        <col className="w-2/5" />
        <col />
        <col />
        <col />
      </colgroup>
      <thead className="bg-background sticky top-16 z-20">
        <tr className="border-b">
          <th scope="col" className="px-4 py-4 text-left font-normal lg:px-11">
            <span className="sr-only">Feature</span>
          </th>
          {plans.map((plan) => (
            <th
              key={plan.id}
              scope="col"
              className={cn(
                'text-foreground px-2 py-4 text-center font-medium',
                plan.highlight && 'bg-card',
              )}
            >
              {plan.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <Fragment key={group.title}>
            <tr>
              <th
                scope="colgroup"
                colSpan={4}
                className="text-foreground px-4 pt-10 pb-3 text-left text-base font-medium lg:px-11"
              >
                {group.title}
              </th>
            </tr>
            {group.rows.map((row) => (
              <tr key={row.label} className="border-t">
                <th
                  scope="row"
                  className="text-muted-foreground px-4 py-4 text-left font-normal text-pretty lg:px-11"
                >
                  {row.label}
                </th>
                {row.marks.map((mark, i) => (
                  <td
                    key={plans[i]?.id ?? i}
                    className={cn(
                      'px-2 py-4 text-center tabular-nums',
                      plans[i]?.highlight && 'bg-card',
                    )}
                  >
                    <MarkCell mark={mark} />
                  </td>
                ))}
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
