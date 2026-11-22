# Decisions: continual learning

## Decided

- **2026-11-17 (owner):** built into My Kortix and the default harness, not a
  skill. `kortix-harness-refinement` is not the mechanism.
- **2026-11-17 (owner):** the loop covers analysis of multi-step runs,
  self-improvement, skill library maintenance and expansion of its own evals.

## Open (asked 2026-11-17)

1. **What merges without a person.** Recommended: memory and skills merge
   when eval-proven; prompts, tools and permissions open a change request.
2. **Cost.** On by default with a weekly cap from workspace credits, or only
   when a person turns it on.
3. **Rollout.** Recommended: flag `continual_learning` on dev first, then on
   for My Kortix in every workspace.
4. **What reaches Kortix.** Recommended: content-free signal counts by
   default; lesson text and eval tasks only from workspaces that opt in.
   Touches the Terms and the DPA (the `compliance` skill).
