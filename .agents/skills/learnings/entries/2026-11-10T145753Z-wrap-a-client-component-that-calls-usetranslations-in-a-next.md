---
recorded: 2026-11-10T14:57:53Z
incident_date: 2026-11-10
---
# Wrap a client component that calls useTranslations in a NextIntlClientProvider on every page outside app/[locale]; next-intl throws an empty Error in production

**Rule:** Only the `[locale]` layout mounts `I18nProvider`. A page outside that tree (the root `app/not-found.tsx`, which renders every unmatched URL and every `dynamicParams = false` miss) must mount its own `NextIntlClientProvider` before it renders a client component that calls `useTranslations`. Pass only the keys it renders: `hardcodedUi` alone is ~1.2 MB. Without a provider, next-intl's production build throws `Error()` with no message: the render fails, Next serves its error document, and the log shows `Error:` with a numeric digest and no text.

**Trigger surface:** Adding or editing a page, `not-found`, `error` or `global-error` file outside `app/[locale]`, or making a component it renders call `useTranslations`.

**Incident:** 2026-10-14 to 2026-11-10 (PR #9798 to PR #12253): every 404 on kortix.com showed "This page couldn't load", 1,062 empty `Error:` logs a day, and a POST to an unknown path answered 500 (107 a day).

**Enforcement:** `apps/web/src/app/not-found-messages.test.tsx` renders `NotFoundState` inside the root page's provider and fails on a missing key. None yet for a new page outside `app/[locale]`: a build-time check that fetches `/_not-found` from `next start` and fails on `__next_error__` would cover it.
