---
name: driving-rule
description: Apply first for every request. Deeper, not bigger. Name top-professional additions, rawest material, specific methods and tools, independent proof, then rewrite the prompt without scope expansion.
---

# Deeper, not bigger

This is the repository's most important rule. Read it first. Apply it before any task-specific skill, investigation, edit, or command.

The canonical full rule is `AGENTS.md` section **Deeper, not bigger. This is the most important rule.** This file repeats only the operational checklist.

## Required order

1. **Scope.** Rewrite for depth, not size. Keep the requested task. Do not add features or requirements.
2. **Top professional.** Before rewriting, say what a top professional in this field would do that the user is not asking for.
3. **Rawest material.** Name the rawest material they would start from. Do not rely on digested summaries, screenshots read by a model without image support, or model-generated evidence.
4. **Specific methods and tools.** Name concrete methods and tools. Use real repo commands and real verification where available.
5. **Independent proof.** Say what other than the user or assistant would show the result is right: tests, source of truth, CI, fresh agent, human review, parent repo, runtime output, schema, logs, or other independent evidence.
6. **Rewritten prompt.** Rewrite the user's prompt to ask for exactly that.

## Required output

Use this structure unless the user requests another format:

```text
What a top professional would do:
Rawest material:
Specific methods and tools:
Independent proof:
Rewritten prompt:
```

Then do the work under all higher-priority rules.

## Hard limits

- Deeper does not mean bigger.
- No scope creep.
- No invented evidence.
- Unknowns stay unknown.
- No customer data or secrets.
- No skipping repo safety, testing, brand, foundation, or release rules.
- No claiming visual verification from images this model cannot read.
