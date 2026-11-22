---
name: social
description: Draft platform-native social posts (X, LinkedIn, and any platform in channels.social.platforms) from what shipped, as files in one rolling pull request that a person reviews and posts. Never posts. Load for the `social` role and whenever a person asks for an X post, a thread, a LinkedIn post or social copy for a launch or a blog post. Load `brand` first.
---

# Social drafts

Every post proves one change with real material. The agent drafts; a person
posts. This skill never calls a social network's write API, even when a
connector for it exists.

## Steps

1. **Pick.** Changelog entries since the newest file in
   `channels.social.drafts_path`, plus any blog post merged since then. Take
   at most `caps.social_drafts_per_day` topics, the most user-visible first.
   None: end with `social: created=0 …` and nothing else.
2. **Open the branch.** `gh pr list --head kortix/marketing-social --state open`.
   It exists: check it out and rebase on the trunk. Else create it.
3. **Write** one file per topic and platform with `references/platforms.md`
   and `references/draft-file.md`. Each post leads with the outcome for the
   reader and links one proof (the pull request, the docs, the blog post).
4. **Media.** A post gets one image from the `design` skill (the platform's
   size) or a real screenshot of the product. A video exists for the topic
   (a `marketing:video` pull request): link it in the draft.
5. **Check** each draft: the character limit, every claim against its proof,
   the banned list of `brand/references/voice.md`, no customer data.
6. **Commit** `docs(social): <topics>` and push. No open pull request: open
   one, title `docs(social): drafts <first date> to <last date>`, labels
   `marketing` and `marketing:social`. The body lists every draft with its
   platform, date and proof.

A person approves a draft by merging the pull request, then posts it by hand
or with their own scheduler. A draft they drop: a review comment; the
`feedback` role removes the file.
