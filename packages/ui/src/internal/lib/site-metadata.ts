/**
 * Site metadata configuration - SIMPLE AND WORKING
 */

/**
 * One public origin for canonical URLs, sitemaps, structured data, and
 * machine-readable representations. Runtime app URLs are deliberately not
 * used here: a preview/dev hostname must never become the canonical origin.
 */
export const CANONICAL_ORIGIN = 'https://dosco.live';

export const siteMetadata = {
 name: 'Dosco',
 title: 'Dosco – The agentic operating system',
 description:
 "Dosco is the agentic operating system — agents, skills, memory and connectors in one managed workspace, and the software foundation for AltMatter's intelligent hardware.",
 url: CANONICAL_ORIGIN,
 keywords:
 'Dosco, agentic operating system, AI OS, AI operating system for companies, alternative to Claude Cowork, ChatGPT Work alternative, agents skills and memory, shared AI agents, scoped access, AI agents, connect 3000 tools, agent orchestration, AI-native company, AI operations',
};
