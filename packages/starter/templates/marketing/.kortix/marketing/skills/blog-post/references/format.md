# Find the blog format

1. `site.blog_path` in marketing.json; `null`: look for the posts folder:
   `content/blog/`, `src/content/blog/`, `posts/`, `_posts/`, `blog/`,
   `src/app/**/blog/`, `pages/blog/`, `data/blog/`, a CMS export folder.
2. No posts folder in the repository (the blog lives in a hosted CMS): write
   the post as `marketing/blog/<date>-<slug>.md` with the CMS fields as front
   matter. Name the CMS under `Needs a person`: a person pastes it.
3. Read the newest 3 posts. Record:
   - file naming (`<date>-<slug>.mdx`, `<slug>/index.md`, …) and extension;
   - every front matter key, its type and order (title, description, date
     format, author, tags, cover image path, draft flag);
   - where images live (`site.media_path`, a folder per post) and how a post
     references them;
   - components the posts use (MDX callouts, code blocks, embeds) and their
     import lines;
   - the usual length in words and the heading levels.
4. A draft flag exists (`draft: true`, `published: false`): set it, so the
   post stays hidden until a person flips it. Say so in the pull request body.
5. Author: the field's value for posts the team writes as a company; never a
   real person's name unless the person asked for it in a review.
