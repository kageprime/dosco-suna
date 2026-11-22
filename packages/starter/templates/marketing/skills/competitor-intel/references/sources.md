# Sources, in order of trust

1. **The competitor's own pages**: changelog, release notes, blog, docs,
   pricing page, status page, GitHub releases (`gh release list -R <owner>/<repo>`).
   Open each with `scrape_webpage`; record the date on the page.
2. **Their official accounts**: posts on X, LinkedIn or YouTube that the
   company's own account published, found through `web_search`.
3. **Reputable news** that names its source: funding, acquisitions,
   partnerships.
4. **Launch and community sites**: Product Hunt, Hacker News, GitHub
   trending. A signal to check against 1 to 3, never a source alone.

## Rules

- A date outside the window, or no date: drop the item.
- A secondary source alone: write "reported by <outlet>", never as fact.
- A pricing change: link the pricing page; never restate the price in the
  digest.
- Never log in, never sign up for a trial, never scrape behind a login.
- Search for naming variants of each competitor (old names, product names)
  and confirm the domain before you attribute an item.
