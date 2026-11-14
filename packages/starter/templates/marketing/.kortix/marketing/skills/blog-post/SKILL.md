---
name: blog-post
description: Write one blog post from what shipped (the week's changelog entries, or one feature a person names), in the site's own blog format, with a cover from the `design` skill and screenshots of the real product, as one pull request. Load for the `blog` role and whenever a person asks for a blog post, an announcement post or a launch post. Load `brand` first.
---

# Blog post

One post, one reader, one change that matters to them. The post proves every
claim with the commit, the pull request or the real product.

## Steps

1. **Cap.** `caps.blog_posts_per_week`: count `marketing:blog` pull requests
   opened in the last 7 days. At the cap: end with `capped=1`.
2. **Pick the topic.** Read the changelog entries of the last 7 days on the
   trunk (merged, and the open changelog pull request). Pick the 1 to 3
   changes a user cares about most. Skip a topic that a `marketing:blog` pull
   request covered in the last 30 days, or one a person dropped. No entry:
   end with `blog: created=0 … errors=none` and nothing else.
3. **Read the proof.** Open each change's pull request and diff. Write down
   what the user does, step by step, and the exact names in the UI or CLI.
4. **Find the format** with `references/format.md`. Copy the newest post's
   structure exactly.
5. **Write** with `references/structure.md` and the brand voice.
6. **Visuals.** Cover: the `design` skill, the size earlier covers use.
   In-post images: screenshots of the real product in the dev environment
   (`agent-browser`, synthetic data, the viewport earlier screenshots use).
7. **Build and look.** Build the site, start it, open the post with
   `agent-browser`: it renders, images load, links resolve, the page title and
   meta description are set. Take one screenshot of the rendered post for the
   pull request body.
8. **Check** with `references/review.md`. Fix every item.
9. **Open** one pull request from `kortix/marketing-blog-<slug>`: title
   `docs(blog): <post title>`, labels `marketing` and `marketing:blog`, body
   as `agents/marketing.md` says, plus the rendered screenshot.
