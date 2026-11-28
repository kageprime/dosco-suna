/**
 * Prints the QualiLoop system knowledge of the Kortix agent as JSON, for
 * `npx qualiloop connect knowledge --file -`:
 *
 * - system_prompts: the system prompt a QualiLoop test session ran with, read
 *   from a file (see SKILL.md, "Send the system knowledge"). Its session and
 *   project ids become the placeholders `{session_id}` and `{project_id}`.
 * - tools: every tool kortixd registers in a My Kortix session, built by the
 *   same code kortixd runs (name, description, JSON schema). `codemode` is left
 *   out: pi generates it at run time from the other tools.
 * - documentation: the SKILL.md of every skill the prompt lists in
 *   `<available_skills>`, from packages/starter/templates.
 *
 * Usage: bun .agents/skills/qualiloop/scripts/knowledge.ts <system-prompt.txt>
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createQuestionTool, createWorkspaceTools } from '../src/harness/pi/tools'
import { KORTIX_TOOLS, PLATFORM_TOOLS } from '../src/services/tools/host'
import { messaging } from '../src/harness/pi/extensions/messaging'
import { subagents } from '../src/harness/pi/extensions/subagents'
import { workflow } from '../src/harness/pi/extensions/workflow'

const ROOT = resolve(import.meta.dir, '../../..')
const file = process.argv[2]
if (!file) {
  console.error('Usage: bun .agents/skills/qualiloop/scripts/knowledge.ts <system-prompt.txt>')
  process.exit(2)
}

const captured = readFileSync(file, 'utf8')
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const text = captured
  .replace(new RegExp(`(- session_id: )${UUID}`), '$1{session_id}')
  .replace(new RegExp(`(- project_id: )${UUID}`), '$1{project_id}')
if (!text.includes('{session_id}') || !text.includes('{project_id}')) {
  console.error('The file has no "## Session ids" section: save the system message of a QualiLoop test session.')
  process.exit(2)
}

type Tool = { name: string; description: string; parameters: unknown }
const tools: Tool[] = []
// QualiLoop takes a tool description of at most 5000 characters (`workflow`'s is longer): the rest is cut.
const add = (tool: { name: string; description: string; parameters: unknown }) =>
  tools.push({ name: tool.name, description: tool.description.slice(0, 5000), parameters: tool.parameters })

// Extension tools take a host for their handlers; a description never calls one, so any host prints them.
const host: any = new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => host) })
for (const tool of createWorkspaceTools('/workspace')) add(tool)
for (const [name, tool] of Object.entries({ ...KORTIX_TOOLS, ...PLATFORM_TOOLS })) add({ name, ...tool })
add(createQuestionTool(host, () => undefined))
for (const extension of [subagents(host), workflow(host), messaging(host)]) {
  const starts: Array<() => void> = []
  const pi: any = new Proxy({}, {
    get: (_t, key) =>
      key === 'registerTool' ? add
        : key === 'on' ? (event: string, fn: () => void) => { if (event === 'session_start') starts.push(fn) }
          : () => undefined,
  })
  extension.factory(pi)
  for (const start of starts) start()
}

const registered = text.match(/^Registered tools: (.+)\.$/m)?.[1].split(', ') ?? []
const sent = registered.filter((name) => name !== 'codemode')
const missing = sent.filter((name) => !tools.some((tool) => tool.name === name))
if (missing.length) {
  console.error(`The prompt registers tools this script does not build: ${missing.join(', ')}. Add them to knowledge.ts.`)
  process.exit(1)
}

const skillDirs = ['packages/starter/templates/managed/skills', 'packages/starter/templates/base/skills']
const documentation = [...text.matchAll(/<name>([^<]+)<\/name>/g)].flatMap(([, name]) => {
  const dir = skillDirs.find((d) => existsSync(join(ROOT, d, name!, 'SKILL.md')))
  if (!dir) return []
  const path = `${dir}/${name}/SKILL.md`
  return [{ name: path, text: readFileSync(join(ROOT, path), 'utf8') }]
})

console.log(JSON.stringify({
  system_prompts: [{
    name: 'apps/kortix-sandbox-agent-server/src/harness/pi/runtime.ts systemPrompt() (My Kortix)',
    text,
    placeholders: ['{session_id}', '{project_id}'],
    agent: 'mykortix',
  }],
  tools: tools.filter((tool) => sent.includes(tool.name)),
  documentation,
  general: {
    name: 'My Kortix',
    summary: 'The one agent a person talks to in a Kortix workspace: it does the work itself or hands it to the right agent, and comes back with the result.',
    description:
      'My Kortix is the default agent of every Kortix workspace. A person writes what they want in their own words; My Kortix does it on its own cloud computer (files, shell, web search, image generation, connected apps) or delegates it to other agents and subagents, and reports the verified result. It acts with exactly the rights of the person it works for, follows through on waits with scheduled wake-ups, and remembers what the person tells it. It is used by people who are not technical as well as by engineers, so what matters most is that it finishes the task, checks the result before it reports it, writes short and plain answers, and never claims what it did not check.',
  },
}, null, 2))
