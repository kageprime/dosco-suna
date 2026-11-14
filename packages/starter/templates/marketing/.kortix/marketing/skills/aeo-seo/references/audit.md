# Visibility audit (`aeo-audit`)

1. Read `.kortix/marketing/queries.md` on the trunk and the competitors in
   marketing.json. Read the newest open or closed issue labeled
   `marketing:aeo-audit` (`gh issue list --label marketing:aeo-audit --state all --limit 1 --json number,body`):
   you compare against it in step 5.
2. For each question, run `web_search` with the question exactly as written.
   Record the top 10 results: position, domain, URL.
3. Open the top 3 results and the site's best matching page with
   `scrape_webpage`. Record whether each page answers the question in its
   first 100 words, and whether it has schema.org JSON-LD (`FAQPage`,
   `HowTo`, `Article`, `Product`, `SoftwareApplication`).
4. A tool that asks another AI assistant is available: ask it the question
   and record the sources it cites. None: write `not measured`.
5. Give each question one status:
   - `cited`: the site is in the top 10 or in an assistant's sources;
   - `gap`: the site is absent and a competitor or another page is cited;
   - `no-page`: the site has no page that answers the question.
   And the change against the previous audit: `new`, `kept`, `lost`, `won`.
6. Rank the gaps: a listed competitor cited and the site not, first.
7. Open one issue, title `[marketing] AEO audit <date>`, labels `marketing`
   and `marketing:aeo-audit`. Body:
   - `<cited>/<total> questions cite the site (previous: <n>/<total>)`;
   - a table: question, status, change, site position, cited instead
     (domains), assistant sources;
   - `## Gaps`: the ranked gaps, each with the 3 cited URLs and what they
     answer that the site does not;
   - `## Proposed questions`: questions you saw in the results ("People also
     ask"); a person adds them to `queries.md`;
   - `## Method`: the date, the tools, every limit you hit.
8. Close the previous audit issue with a link to the new one.
