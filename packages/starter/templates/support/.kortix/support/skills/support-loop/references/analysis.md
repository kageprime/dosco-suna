# Analysis: what the team uses, then support.json

The setup agent runs this once, with the person. Read only until section 5.
Never `cat` an env file. Never read a customer conversation to "test" access:
`desk.context` is the test.

## 1. Evidence

| Check | Command | What it tells you |
|---|---|---|
| Connected apps | `kortix connectors ls --json` | `plain`, `intercom`, `zendesk`, `gmail`, `slack`: the desk and the sources that need no secret |
| Secret names | `kortix env push --from <file> --names --json` for each dotenv file | names only: `PLAIN_`, `INTERCOM_`, `ZENDESK_`, `FRONT_`, `HELPSCOUT_`, `CRISP_` prefixes point at the desk |
| The product | `README.md`, the landing page in the repository | `company.product_one_line` |
| Docs | folders `docs/`, `content/docs/`, `help/`, `apps/*/content`, a docs site in `package.json` scripts, `mkdocs.yml`, `docusaurus.config.*` | `knowledge.docs`, `knowledge.help_center_path` |
| A feedback widget | grep the code for `feedback`, `nps`, `rating` routes or components | where the product would call `support-feedback` |
| The Software Factory | `.kortix/software-factory/factory.json` exists | `support-bug-handoff` files into its store |
| Slack | the `slack` connector, then the channel list (names only) | `sources.slack.channels` candidates |

## 2. The desk

**Ask** which desk is the source of truth. Recommend the one the evidence
shows. Supported: `plain`, `intercom`, `zendesk`, `email`, `json-file`. A desk
not in that list (Front, Help Scout, Crisp): `json-file` for now, and tell the
person a desk reference is a short file under `references/desks/` that maps
the nine operations of contract §2.

## 3. Categories and approval

Show the categories (`how-to`, `bug`, `feature-request`, `billing`,
`account`, `security`, `other`) and the three modes of contract §6.
**Ask** whether any category may go further than `draft`. Recommend `draft`
for all at the start, and `approve_to_send` for `how-to` after two weeks of
good drafts. `billing`, `account` and `security` stay `draft` or
`approve_to_send`: never offer `auto_reply` for them.

## 4. Sources

Show only the sources with evidence, one line each with what it needs:

- `feedback`: the product calls the webhook. On by default.
- `queue`: the desk is connected or its secret is set.
- `inbox`: a mailbox, and connector events on for the workspace.
- `slack`: the Slack connector and the channel ids.

**Ask** which to turn on.

## 5. Write support.json

Fill `company`, `desk`, `knowledge`, `sources`, `approval`, `notify`. Keep
the default `caps`. Set each chosen source's trigger `enabled: true` and every
other source's trigger `enabled: false` in support.yaml, so the two files
agree. Run `kortix validate`.

## 6. Desk setup writes

Only after the person agrees:

- Plain: a label type per category, when the person wants labels.
- Intercom: `GET /me` for `desk.admin_id`; the API version for
  `desk.api_version`; one tag per category and `kortix-drafted`.
- Zendesk: a dedicated agent seat for the API user.
- Email: the labels `support/<category>`.
- `json-file`: the private repository and branch, with
  `{"version":1,"cursor":null,"conversations":[]}`.
