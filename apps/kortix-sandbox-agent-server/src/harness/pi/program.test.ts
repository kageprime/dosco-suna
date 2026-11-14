import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import { PROGRAM_REPLY_MAX_BYTES, programPrompt, programStep, type ProgramRun } from './program'
import type { WorkspaceSetupStatus } from '../shared/workspace-setup'

const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 0 })
const dir = () => mkdtempSync(join(tmpdir(), 'program-'))

function run(command: string, extra: Partial<ProgramRun> = {}): ProgramRun {
  const cwd = dir()
  return { command, agent: 'janitor', sessionId: 'ses_test', enabled: true, cwd, setup: () => null, eventDir: join(cwd, 'events'), ...extra }
}

async function step(program: ProgramRun, messages: Message[] = [user('sweep')], signal?: AbortSignal): Promise<{ message: AssistantMessage; deltas: string[]; types: string[] }> {
  const stream = programStep(program, { messages }, { signal })
  const deltas: string[] = []
  const types: string[] = []
  for await (const event of stream) {
    types.push(event.type)
    if (event.type === 'text_delta') deltas.push(event.delta)
  }
  return { message: await stream.result(), deltas, types }
}

const text = (message: AssistantMessage) => message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')

describe('programStep', () => {
  test('stdout is the reply; the prompt arrives on stdin and in $KORTIX_EVENT_PATH', async () => {
    const program = run('read -r line; echo "got: $line"; cat "$KORTIX_EVENT_PATH"; echo "agent=$KORTIX_AGENT_NAME pwd=$PWD"')
    const { message, types } = await step(program)
    expect(message.stopReason).toBe('stop')
    expect(message.provider).toBe('program')
    expect(message.model).toBe('janitor')
    expect(types[0]).toBe('start')
    expect(types.at(-1)).toBe('done')
    const reply = text(message)
    expect(reply).toContain('got: sweep')
    expect(JSON.parse(reply.split('\n')[1]!)).toEqual({ version: 1, session_id: 'ses_test', agent: 'janitor', prompt: 'sweep' })
    expect(reply).toContain(`agent=janitor pwd=${program.cwd}`)
  })

  test('a non-zero exit fails the turn with the end of stderr; stdout so far stays', async () => {
    const { message } = await step(run('echo partial; echo "boom: no token" >&2; exit 3'))
    expect(message.stopReason).toBe('error')
    expect(text(message)).toBe('partial\n')
    expect(message.errorMessage).toContain('exited with code 3')
    expect(message.errorMessage).toContain('boom: no token')
  })

  test('with the flag off nothing runs and the turn says how to turn it on', async () => {
    const program = run('touch ran', { enabled: false })
    const { message } = await step(program)
    expect(message.stopReason).toBe('error')
    expect(message.errorMessage).toContain('Program agents are off')
    expect(() => readFileSync(join(program.cwd, 'ran'))).toThrow()
  })

  test('Stop ends the whole process group', async () => {
    const program = run('sleep 30 & echo started; wait')
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 300)
    const { message } = await step(program, [user('go')], controller.signal)
    expect(message.stopReason).toBe('aborted')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('it waits for the workspace setup, and a failed setup fails the turn without running', async () => {
    let state: WorkspaceSetupStatus['state'] = 'running'
    const status = (): WorkspaceSetupStatus => ({
      state,
      started_at: '',
      ended_at: null,
      log: '/tmp/kortix/workspace-setup.log',
      steps: [{ kind: 'run', label: 'pnpm install', state: state === 'failed' ? 'failed' : 'running', exit_code: state === 'failed' ? 1 : null, started_at: null, ended_at: null, ...(state === 'failed' ? { error: 'exit 1' } : {}) }],
    })
    setTimeout(() => (state = 'done'), 700)
    const waited = Date.now()
    expect(text((await step(run('echo ran', { setup: status }))).message)).toBe('ran\n')
    expect(Date.now() - waited).toBeGreaterThanOrEqual(500)

    state = 'failed'
    const failed = run('touch ran', { setup: status })
    const { message } = await step(failed)
    expect(message.errorMessage).toContain('workspace setup failed at `pnpm install`')
    expect(() => readFileSync(join(failed.cwd, 'ran'))).toThrow()
  })

  test('a run past its timeout is stopped and the turn fails, naming the limit', async () => {
    const started = Date.now()
    const { message } = await step(run('echo started; sleep 30', { timeoutMs: 400 }))
    expect(message.stopReason).toBe('error')
    expect(message.errorMessage).toContain('ran longer than its timeout')
    expect(text(message)).toBe('started\n')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('the reply stops at the cap and says so', async () => {
    const { message } = await step(run(`head -c ${PROGRAM_REPLY_MAX_BYTES + 5000} /dev/zero | tr '\\0' 'a'`))
    expect(message.stopReason).toBe('stop')
    expect(text(message).length).toBeLessThan(PROGRAM_REPLY_MAX_BYTES + 100)
    expect(text(message)).toContain('[Output truncated at 256 KiB.]')
  })
})

describe('programPrompt', () => {
  test('is every user message after the last assistant message', () => {
    const assistant: Message = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: 'program', provider: 'program', model: 'x', usage: {} as never, stopReason: 'stop', timestamp: 0 }
    expect(programPrompt([user('one'), assistant, user('two'), { role: 'user', content: [{ type: 'text', text: 'three' }], timestamp: 0 }])).toBe('two\n\nthree')
    expect(programPrompt([user('only')])).toBe('only')
  })
})
