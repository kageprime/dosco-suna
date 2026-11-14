/**
 * Interim text that renders a card the person must see: a generative-UI
 * (`openui`) fence, or a setup link (`/secret-intake/<token>`,
 * `/connect/<token>`) that renders a form the user must act on. Internal: the
 * settled-turn fold (`work-split.ts`) and the agent-run fold
 * (`session-log/turns/agent-runs.ts`) both keep such text in view.
 */

/**
 * A fence line that opens a generative-UI block (```openui, ~~~openui-v2, …) at
 * any container depth: top level, in a blockquote, or in a list item. The
 * renderer opens a block at all three (`genui/fence.ts`, `FENCE_START` and
 * `LIST_FENCE`).
 */
const GENUI_FENCE = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(?:`{3,}|~{3,})[ \t]*openui/im;
/**
 * A setup route the renderer turns into a card: as a link target, inline code,
 * or a bare URL (an autolink). A relative path is always ours. An absolute URL
 * counts only with the `ksl_` token prefix, the rule the web renderer applies
 * to a cross-origin link (`parseSetupLinkHref`).
 */
const SETUP_LINK =
  /(?:^|[\s(<`])(?:\/(?:secret-intake|connect)\/[^\s)>`]|https?:\/\/[^\s)>`/]+\/(?:secret-intake|connect)\/ksl_)/i;

export function textRendersCard(body: string): boolean {
  return GENUI_FENCE.test(body) || SETUP_LINK.test(body);
}
