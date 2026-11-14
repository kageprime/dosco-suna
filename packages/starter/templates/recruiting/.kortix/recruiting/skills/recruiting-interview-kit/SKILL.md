---
name: recruiting-interview-kit
description: Draft the interview kit for one candidate's next stage from the role's interview plan and rubric in recruiting.json — the same structured questions for every candidate of the role, plus the follow-ups this candidate's scorecard leaves open. Load it in the Recruiting Factory after a person decided to advance a candidate.
---

# Interview kit: one stage, one kit

The contract is `recruiting-loop`. Run only after a `decided · advance` note
(contract §6).

## Steps

1. Read the role's `interview_plan`. The next stage is the first stage after
   the newest stage the record shows. No next stage: end. A person makes the
   offer decision.
2. **The core questions.** For each criterion in the stage's `focus`, write
   2 questions. They are the same for every candidate of the role. Write
   them once per role and stage: the first time, submit them as a Review
   output (`kortix review submit --kind output --title "Interview questions: <role>, <stage>"`).
   Later kits reuse the text a person approved. Each question names what a
   strong answer shows, on the screening scale of 0 to 4.
3. **The follow-ups.** At most 3 questions for this candidate: the
   must-haves `not shown` and the `Ask next` line of the scorecard. Never a
   question about a protected attribute, a gap in dates, family, health,
   plans to have children, religion or origin.
4. **The scoring sheet.** One line per criterion: the score 0 to 4 and the
   evidence the interviewer heard. The interviewer scores alone, before any
   debrief.

## Output

```markdown
Interview kit · <role title> · <stage> · <minutes> min · candidate <key suffix>

Core questions (same for every candidate)
1. <question> — strong answer shows: <…>

Follow-ups for this candidate
1. <question> — why: <the gap in the scorecard>

Scoring sheet
- <criterion>: 0 1 2 3 4 · evidence: ____
```

Deliver it as a draft (contract §7 `draft_in`), with the marker
`[recruiting-loop] drafted · interview-kit`. It holds no CV text and no
contact details: the interviewer opens the record for those.
