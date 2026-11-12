/**
 * One `kortix-*` accent per cost type, the same three everywhere the Usage
 * page names a cost type: the hero swatches, the chart bars and tooltip, and
 * the balance card on the credit ledger. Compute is blue and LLM orange, a
 * pair that stays apart under every colour-vision deficiency (worst ΔE 24 in
 * the dataviz validator); storage is purple. The accents are theme-invariant,
 * so one hue reads in light and dark.
 */
export const COST_TYPE_COLOR = {
  compute_cost: 'var(--kortix-blue)',
  llm_cost: 'var(--kortix-orange)',
  storage_cost: 'var(--kortix-purple)',
} as const;
