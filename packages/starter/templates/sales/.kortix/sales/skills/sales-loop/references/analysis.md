# Analysis: what the team sells and where it keeps leads

The setup agent runs these checks once, before it writes sales.json. Read
only. Never `cat` an env file: `kortix env push --from <file> --names --json`
prints names only.

## 1. What the company sells

- The README, the website URL in `package.json` `homepage` or the repository
  description, the pricing page, the docs. Write `company.name`,
  `company.website`, `company.product_one_line` in the company's own words.
- **Ask** who signs the drafts (`company.sender`).

## 2. The system of record

Evidence, in this order:

| Evidence | Points to |
|---|---|
| `kortix connectors ls --json`: a connected `attio`, `hubspot`, `salesforce`, `pipedrive` or Google Sheets connector | that system |
| env names `ATTIO_`, `HUBSPOT_`, `SALESFORCE_`/`SF_`, `PIPEDRIVE_` | that system |
| code that calls the CRM (`grep -rIlE "api.attio.com|api.hubapi.com|salesforce.com/services|pipedrive.com/api"`) | that system, and the product already sends data to it |

**Ask** which system is the source of truth. Recommend the one the evidence
shows; none: `json-file` in a new private repository, or a Google Sheet.

## 3. Where signups come from

- The signup handler in the code (`grep -rInE "signup|sign_up|createUser"`
  in the backend). Note the file and the function: setup adds the webhook
  call there, or the person does.
- A form tool (Typeform, Tally, HubSpot forms, Webflow): it posts the
  `inbound` payload, through its own webhook feature or a relay.
- **Ask** which sources to turn on. Default: `signup` and `inbound`.

## 4. The ICP

Draft the ICP from the website and the README, then **Ask** the person to
correct the draft, as one question. The draft covers:

1. Who buys today: the segments, the company size, the roles.
2. What must be true for a good fit (`must_have`).
3. What makes a lead better (`nice_to_have`).
4. What rules a lead out (`disqualifiers`).
Never invent customers. Ask for two or three real examples only to read their
public websites, and never write their names into sales.json.

## 5. Approval

**Ask**: "Where should drafts go: the Review page, your mailbox as drafts, or
notes in the CRM?" Default `review`. **Ask** whether the agent may move deal
stages (`record_writes: stages`). Default `notes`.

## 6. Write sales.json

Every key of the contract §0 table. Turn each chosen source's trigger on and
every other source's trigger off in sales.yaml, so the two files agree.
