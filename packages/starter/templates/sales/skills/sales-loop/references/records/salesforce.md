# Record: Salesforce

`record.kind: salesforce`, `record.target: <instance URL>`.
`record.objects`: `person` is `Lead` until it converts, then `Contact`;
`company` is `Account`; `deal` is `Opportunity`. Custom fields the loop
writes, created once at setup by a Salesforce admin: `Kortix_Lead_Key__c`
(text), `Kortix_Score__c` (number), `Kortix_Tier__c` (picklist: hot, warm,
cold, disqualified) on Lead, Contact and Account. The agent never creates a
field or changes the org's metadata.

## Access, first match wins

1. The `salesforce` connector: `kortix connectors show salesforce` once per
   session, then `kortix connectors call salesforce <tool> '<json>' --json`.
2. The secrets `SALESFORCE_INSTANCE_URL` and `SALESFORCE_ACCESS_TOKEN`: REST at
   `$SALESFORCE_INSTANCE_URL/services/data/<version>`, header
   `Authorization: Bearer $SALESFORCE_ACCESS_TOKEN`. Read `<version>` once per
   session from `GET /services/data/` (the newest entry). An expired token
   answers `401 INVALID_SESSION_ID`: end the run with `errors=credential`.

## Operations

| Operation | REST call |
|---|---|
| `record.context` | `GET /sobjects/Lead/describe`: the three `Kortix_*__c` fields exist |
| `company.find(domain)` | `GET /query?q=SELECT Id,Name,Website FROM Account WHERE Website LIKE '%<domain>%' LIMIT 5`, then keep the exact domain match |
| `company.upsert` | `POST /sobjects/Account` or `PATCH /sobjects/Account/<Id>` with the empty fields only |
| `person.find(email)` | `GET /query?q=SELECT Id,Email,Status FROM Lead WHERE Email = '<email>' AND IsConverted = false`, then the same on `Contact` |
| `person.upsert` | `POST /sobjects/Lead` (`LastName`, `Company`, `Email`, `LeadSource`) or `PATCH` the found Lead or Contact |
| `deal.list_open()` | `GET /query?q=SELECT Id,Name,StageName,Amount,CloseDate,OwnerId,LastActivityDate FROM Opportunity WHERE IsClosed = false`; follow `nextRecordsUrl` into a file |
| `deal.create` / `deal.set_stage` | `POST /sobjects/Opportunity` / `PATCH /sobjects/Opportunity/<Id>` with `StageName`; only under `record_writes: stages` |
| `note.add(record, body)` | `POST /sobjects/Task` with `WhoId` or `WhatId`, `Subject` (the marker line), `Description` (the body), `Status: Completed` |
| `note.list(record)` | `GET /query?q=SELECT Subject,Description,CreatedDate FROM Task WHERE WhoId = '<Id>' OR WhatId = '<Id>' ORDER BY CreatedDate DESC` |
| `task.create` | `POST /sobjects/Task` with `Status: Not Started`, `ActivityDate`, `OwnerId` |
| `field.set` | `PATCH /sobjects/<object>/<Id>` with the one field |

## Notes

- Escape single quotes in SOQL values (`\'`). Never build a query from a lead's text without escaping.
- Opt-out: `HasOptedOutOfEmail = true` or `DoNotCall = true` on the Lead or Contact.
- The loop never converts a Lead; a person does.
