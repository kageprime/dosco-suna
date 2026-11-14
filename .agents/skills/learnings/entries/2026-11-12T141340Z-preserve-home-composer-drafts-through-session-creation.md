---
recorded: 2026-11-12T14:13:40Z
incident_date: 2026-11-12
---
# Preserve home composer drafts through session creation

**Rule:** Keep the home composer editable during session creation. Clear submitted text and transfer the remaining draft before the session composer restores it. Refuse another create while the first create is pending.

**Trigger surface:** Typing or pressing Enter again immediately after the first workspace-home submission.

**Incident:** 2026-11-12, F-008: disabling the home composer moved focus to BODY. Follow-up keystrokes disappeared before navigation completed.

**Enforcement:** Manual browser contract: send from workspace home, type a distinct follow-up at 250 ms steps across 0–3 s, and assert retained or sent text and one session create. No automated CI enforcer yet; add this contract to the browser journey when that journey covers home creation.

**Review correction:** Route-gap keyboard edits must use the existing document and ProseMirror deletion commands. A separate text buffer cannot delete the existing document. The destination draft lifecycle explicitly ends focus ownership after restore; a subtree observer must not reacquire focus. A connector gate keeps its original submission pending through Retry and invokes failed-send recovery only on cancellation or terminal failure. This keeps the submitted prompt out of the follow-up draft.

**Focus ownership:** Draft restoration replaces content without scheduling TipTap focus. Mount autofocus accepts sidebar links and buttons. An editable field or an open dialog retains focus. The session draft restore signal places the caret once and removes the route-gap listeners.
