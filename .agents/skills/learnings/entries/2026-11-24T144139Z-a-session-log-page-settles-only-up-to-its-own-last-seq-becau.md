---
recorded: 2026-11-24T14:41:39Z
incident_date: 2026-11-24
---
# A session-log page settles only up to its own last seq, because the API page lags the box page

**Rule:** In `applySessionLogPage` (`packages/sdk/src/core/session-log/store.ts`), a page never removes a held message after its own last real `seq`. Two sources feed one store: the box's live page and the API's stored-log page, and the API page lags the box by pi's journal (5 s mid-turn; minutes when journal posts back off on 5xx or 429). Only a page of a newer generation than the thread's last newest page (a restarted box) settles the whole tail, and a queued prompt's provisional `seq` settles anywhere. Never add a code path that treats "the page lacks it" as "it was deleted" past the page's tail; a deletion there arrives as a tombstone.

**Trigger surface:** Changing how `useSessionLogSync` (`packages/sdk/src/react/use-session-log.ts`) chooses between the box page and the API page (reload, resync, reconnect, visible tab, turn-end follow-ups, the box-page skip); changing the settle rule, `pageGenerations` or revs in the store; adding a new page source (saved copy, a sub-agent thread page, an older page).

**Incident:** 2026-11-24, a team member reported on prod web that every assistant reply of the last several turns of a pi session disappeared and came back only after a hard refresh. Mechanism: after a failed or skipped box read, a re-read applied the lagging API page, and the old rule treated it as the truth from its first `seq` to the end of the thread. Every rev-less reply newer than the API's last message left the store. Rev-less means it came from a box page, the device's saved copy, or any page after the hook re-mounted. The user messages came back through the `sent` prompts overlay and the v1 optimistic rows, so the screen showed user messages only. The prod API answered `502` and `503 request_deadline` the same afternoon, which is the likely cause of the journal falling behind (not verified for that session).

**Enforcement:** `store.test.ts` (lagging page with and without `has_more`, deletion inside the span, empty page, queued prompt, streaming reply after the tail, streaming copy against a finished record, newer generation, `log.state` before the page, older page first) and `use-session-log.test.ts` ("a lagging API page read after a failed box read keeps the replies the box page delivered"). 8 of these fail on the unfixed reducer.
