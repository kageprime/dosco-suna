# Analysis: what the team uses, then recruiting.json

The setup agent runs this once, with a person, before the first trigger
fires. Read only: never `cat` an env file, never open a candidate's data.

## 1. Evidence

Collect each line with its source:

| Check | How | Tells you |
|---|---|---|
| Connected apps | `kortix connectors ls --json` | an ATS connector (`ashby`, `greenhouse`, `lever`, `workable`), a mail connector (`gmail`, `outlook`), a calendar, Slack |
| Env names | `kortix env push --from <file> --names --json` for each dotenv file | names such as `ASHBY_*`, `GREENHOUSE_*`, `LEVER_*`, `WORKABLE_*` |
| Repository | the README, the careers page source, any form handler that posts applications | where applications come from today, the job ids, the careers URL |
| Careers page | fetch the public careers URL | the open roles and their public descriptions |

## 2. The system of record

**Ask** which ATS is the source of truth. Recommend the one the evidence
shows. None: the json-file record in a new private repository
(`references/records/json-file.md`). Write `record.kind`, `record.target`.

## 3. The roles and their rubrics

Draft the must-haves and signals of each open role from its public job post,
then **Ask** the person to correct the drafts, all roles in one question. Turn
them into `roles[]` (replace the `example-role` entry):

- `must_have`: at most 4 job-related requirements a CV can show. Never a
  degree, a school, an age, years since graduation or a nationality.
  "5+ years" becomes the ability it stands for, such as "has run a service in
  production".
- `signals`: 3 to 6 criteria with weights 1 to 3.
- `knockout_questions`: only job-related, lawful questions (work
  authorization for the location, the required schedule, a required licence).
  Each has `rule: "info-only"`: an answer never rejects by itself (contract
  §1 rule 6).
- `interview_plan`: the stages, their length and which criteria each covers.
- `ats_job_id`: from `job.list()`.

Read every rubric back against contract §1 rules 3 and 4 before you write it.
A criterion that could stand in for a protected attribute (a "culture fit",
a "native speaker", a "recent graduate", a photo): replace it with the
job-related ability behind it, and name the change in one line to the person.

## 4. Sources, approval, retention

1. **Ask** which sources to turn on. Show only the ones with evidence.
   Default: `application` and `referral` (the webhook).
2. **Ask** how drafts reach a person: `draft` with `draft_in: review` is the
   default and the recommendation. `approve_to_send` needs a root
   `kortix.yaml` policy (contract §7).
3. **Ask** the retention period. Default 180 days. Name that the law of the
   candidates' location may require a shorter or a longer period; the person
   decides.
4. **Ask** where a strong candidate and the digest go (`notify`).

## 5. Write recruiting.json

Write every answer into `.kortix/recruiting/recruiting.json`. Turn each chosen
source's trigger on and every other source's trigger off in
`recruiting.yaml` (`enabled: true` or `false`), so the two files agree.
