/**
 * A program agent: `agents.<name>.run` in kortix.yaml (flag `program_agents`).
 *
 * pi stays the harness. The agent's model step is replaced by one run of its command, so the
 * turn, the transcript, Stop, the session log and every client work as for any agent. The
 * step makes no tool call, so pi ends the turn after it.
 *
 * - Input: the turn's prompt on stdin, and as JSON in the file `$KORTIX_EVENT_PATH`.
 * - Environment: the agent shell's (`AGENT_SHELL_ENV`): the project secrets, `KORTIX_TOKEN`
 *   and `KORTIX_API_URL`, so `createKortix()` from `@kortix/sdk` needs no config.
 * - Folder: the agent's first `workspace.repos` path, else the workspace.
 * - Output: stdout streams as the reply. A non-zero exit fails the turn with the end of stderr.
 * - The run waits for the agent's `workspace.setup` to finish; a failed setup fails the turn.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Api, AssistantMessage, AssistantMessageEventStream, Message, Model, StreamOptions, TextContent } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { logger } from '@/lib/log/logger'
import { AGENT_SHELL_ENV } from '../shared/agent-env-file'
import { WORKSPACE_SETUP_LOG_PATH, workspaceSetupStatus, type WorkspaceSetupStatus } from '../shared/workspace-setup'

export const PROGRAM_PROVIDER_ID = 'program'
export const PROGRAM_AGENTS_FLAG = 'program_agents'
/** The most reply text one run keeps. The process keeps running; the rest of stdout is dropped. */
export const PROGRAM_REPLY_MAX_BYTES = 256 * 1024
const STDERR_TAIL_BYTES = 4 * 1024
const KILL_GRACE_MS = 5_000
const SETUP_POLL_MS = 500
const EVENT_DIR = process.env.KORTIX_PROGRAM_EVENT_DIR || '/tmp/kortix/program'

export interface ProgramRun {
  /** The agent's `run`. */
  command: string
  agent: string
  sessionId: string
  /** False when the project has the flag off: the turn fails and nothing runs. */
  enabled: boolean
  cwd: string
  env?: NodeJS.ProcessEnv
  /** The workspace setup's status; null when the agent declares none. */
  setup?: () => WorkspaceSetupStatus | null
  eventDir?: string
  /** The run limit in ms (`agents.<name>.timeout`, compiled to seconds). Default 30 min. */
  timeoutMs?: number
}

/** A program agent's run limit when its compiled config names none. */
export const PROGRAM_TIMEOUT_DEFAULT_MS = 30 * 60_000

/** The model a program agent's messages name: provider `program`, model the agent. */
export function programModel(agent: string): Model<Api> {
  return {
    id: agent,
    name: agent,
    api: PROGRAM_PROVIDER_ID as Api,
    provider: PROGRAM_PROVIDER_ID,
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  }
}

/** The text of every user message after the last assistant message: the turn's prompt (steered messages included). */
export function programPrompt(messages: readonly Message[]): string {
  let start = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === 'assistant') {
      start = index + 1
      break
    }
  }
  return messages
    .slice(start)
    .flatMap((message) => {
      if (message.role !== 'user') return []
      if (typeof message.content === 'string') return [message.content]
      return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
    })
    .join('\n\n')
}

class ProgramReply {
  readonly message: AssistantMessage
  private bytes = 0
  private truncated = false

  constructor(private readonly out: AssistantMessageEventStream, model: Model<Api>) {
    this.message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: 'stop', timestamp: Date.now() }
    out.push({ type: 'start', partial: this.message })
  }

  private text(): TextContent {
    const last = this.message.content.at(-1)
    if (last?.type === 'text') return last
    const part: TextContent = { type: 'text', text: '' }
    this.message.content.push(part)
    this.out.push({ type: 'text_start', contentIndex: this.message.content.length - 1, partial: this.message })
    return part
  }

  write(chunk: string): void {
    if (!chunk || this.truncated) return
    const room = PROGRAM_REPLY_MAX_BYTES - this.bytes
    let delta = chunk
    if (Buffer.byteLength(chunk) > room) {
      // A cut inside a multi-byte character decodes to U+FFFD; drop it.
      delta = `${Buffer.from(chunk).subarray(0, Math.max(room, 0)).toString('utf8').replace(/\uFFFD$/, '')}\n\n[Output truncated at ${PROGRAM_REPLY_MAX_BYTES / 1024} KiB.]`
      this.truncated = true
    }
    this.bytes += Buffer.byteLength(delta)
    const part = this.text()
    part.text += delta
    this.out.push({ type: 'text_delta', contentIndex: this.message.content.length - 1, delta, partial: this.message })
  }

  private closeText(): void {
    const index = this.message.content.length - 1
    const last = this.message.content[index]
    if (last?.type === 'text') this.out.push({ type: 'text_end', contentIndex: index, content: last.text, partial: this.message })
  }

  finish(): AssistantMessage {
    if (this.message.content.length === 0) this.text()
    this.closeText()
    this.out.push({ type: 'done', reason: 'stop', message: this.message })
    this.out.end(this.message)
    return this.message
  }

  fail(error: string, reason: 'error' | 'aborted' = 'error'): AssistantMessage {
    this.closeText()
    this.message.stopReason = reason
    this.message.errorMessage = error
    this.out.push({ type: 'error', reason, error: this.message })
    this.out.end(this.message)
    return this.message
  }
}

function emptyUsage(): AssistantMessage['usage'] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

/** Waits while the workspace setup runs. Resolves the reason it failed, or null when it is done or absent. */
async function setupSettled(status: () => WorkspaceSetupStatus | null, signal?: AbortSignal): Promise<string | null> {
  for (;;) {
    const current = status()
    if (!current || current.state === 'done') return null
    if (current.state === 'failed') {
      const step = current.steps.find((entry) => entry.state === 'failed')
      return `The workspace setup failed${step ? ` at \`${step.label}\` (${step.error ?? `exit ${step.exit_code}`})` : ''}, so the program did not run. The setup log is ${current.log || WORKSPACE_SETUP_LOG_PATH}.`
    }
    if (signal?.aborted) return null
    await new Promise((done) => setTimeout(done, SETUP_POLL_MS))
  }
}

/** One model step of a program agent: one run of its command. */
export function programStep(run: ProgramRun, context: { messages: Message[] }, options: StreamOptions = {}): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream()
  const reply = new ProgramReply(out, programModel(run.agent))
  void (async () => {
    if (!run.enabled) {
      reply.fail(`Program agents are off for this workspace, so \`${run.agent}\` did not run. Turn on Program agents in the workspace's feature flags, or remove \`run\` from agents.${run.agent} in kortix.yaml.`)
      return
    }
    const setupFailed = await setupSettled(run.setup ?? workspaceSetupStatus, options.signal)
    if (options.signal?.aborted) return void reply.fail('Request was aborted', 'aborted')
    if (setupFailed) return void reply.fail(setupFailed)

    const prompt = programPrompt(context.messages)
    const dir = run.eventDir ?? EVENT_DIR
    let eventPath: string
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      eventPath = join(dir, `${Date.now()}-${process.pid}.json`)
      writeFileSync(eventPath, `${JSON.stringify({ version: 1, session_id: run.sessionId, agent: run.agent, prompt })}\n`, { mode: 0o600 })
    } catch (err) {
      return void reply.fail(`The program's input file could not be written: ${(err as Error).message}`)
    }

    const started = Date.now()
    const child = spawn('bash', ['-c', run.command], {
      cwd: run.cwd,
      env: { ...(run.env ?? process.env), ...AGENT_SHELL_ENV, KORTIX_EVENT_PATH: eventPath, KORTIX_AGENT_NAME: run.agent },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so Stop ends everything the command started.
      detached: true,
    })
    const stdout = new StringDecoder('utf8')
    let stderr = Buffer.alloc(0)
    child.stdout.on('data', (chunk: Buffer) => reply.write(stdout.write(chunk)))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk])
      if (stderr.length > STDERR_TAIL_BYTES) stderr = stderr.subarray(stderr.length - STDERR_TAIL_BYTES)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)

    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      if (killTimer) return
      signalGroup(child.pid, 'SIGTERM')
      killTimer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS)
      killTimer.unref?.()
    }
    options.signal?.addEventListener('abort', stop, { once: true })
    const limitMs = run.timeoutMs ?? PROGRAM_TIMEOUT_DEFAULT_MS
    let timedOut = false
    const limit = setTimeout(() => {
      timedOut = true
      stop()
    }, limitMs)
    limit.unref?.()

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((done) => {
      child.once('error', (error) => done({ code: null, signal: null, error }))
      child.once('close', (code, signal) => done({ code, signal }))
    })
    options.signal?.removeEventListener('abort', stop)
    clearTimeout(limit)
    if (killTimer) clearTimeout(killTimer)
    reply.write(stdout.end())
    logger.info('[program] run ended', { agent: run.agent, code: exit.code, signal: exit.signal, ms: Date.now() - started })

    if (options.signal?.aborted) return void reply.fail('Request was aborted', 'aborted')
    if (timedOut) return void reply.fail(`\`${run.command}\` ran longer than its timeout (${formatLimit(limitMs)}) and was stopped. Raise \`timeout\` on agents.${run.agent} (at most 6h), or make the run shorter.`)
    if (exit.error) return void reply.fail(`The program could not start: ${exit.error.message}`)
    if (exit.code === 0) return void reply.finish()
    const tail = stderr.toString('utf8').trim()
    const how = exit.code === null ? `was stopped by ${exit.signal}` : `exited with code ${exit.code}`
    reply.fail(`\`${run.command}\` ${how}.${tail ? `\n\n${tail}` : ''}`)
  })().catch((err) => reply.fail(err instanceof Error ? err.message : String(err)))
  return out
}

/** `30 min`, `2 h`, `45 s`: the limit as a person reads it. */
function formatLimit(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds % 3600 === 0) return `${seconds / 3600} h`
  if (seconds % 60 === 0) return `${seconds / 60} min`
  return `${seconds} s`
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    process.kill(-pid, signal)
  } catch {
    // The group already exited.
  }
}
