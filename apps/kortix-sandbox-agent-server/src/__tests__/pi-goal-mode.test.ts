import { describe, expect, test } from 'bun:test'
import { MAX_NUDGES, goalSection, goalSettle, ownGoal, personTurn, stopRefusal, type ChatGoal } from '@/harness/pi/extensions/goal-mode'

const goal = (patch: Partial<ChatGoal> = {}): ChatGoal => ({
  goal_id: 'g1',
  title: 'Invoice paid and confirmed',
  state: 'active',
  slug: 'invoice-paid',
  folder: '/Users/u1/Goals/invoice-paid',
  owner_session_id: 's1',
  paused_at: null,
  waiting_on: null,
  next_wake_at: null,
  criteria: [{ id: 'c1', text: 'The transfer shows as sent', reported_met: true }, { id: 'c2', text: 'The vendor confirmed the IBAN' }],
  ...patch,
})
const user = (text: string) => ({ role: 'user', content: text })
const reply = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })
const bash = (command: string) => ({ role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command } }] })

describe('ownGoal', () => {
  test("the chat's own open goal; another session's goal or a closed one is not", () => {
    expect(ownGoal([goal({ owner_session_id: 's2' }), goal({ goal_id: 'g0', state: 'done' }), goal()], 's1')?.goal_id).toBe('g1')
    expect(ownGoal([goal({ state: 'stopped' })], 's1')).toBeNull()
  })
})

describe('goalSettle', () => {
  const run = [user('pay this'), reply('I emailed the vendor.')]

  test('an active goal with nothing recorded goes back to the model', () => {
    expect(goalSettle(goal(), run, 0, [])).toMatchObject({ continue: true })
  })

  test('a run that recorded progress, verify or a wait settles', () => {
    for (const command of ['kortix goals progress --summary "emailed"', 'kortix goals verify', 'kortix goals transition waiting_on_user --reason "which IBAN?"']) {
      expect(goalSettle(goal(), [...run, bash(command)], 0, [])).toEqual({ continue: false })
    }
  })

  test('a recording command that failed recorded nothing', () => {
    const call = { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'kortix goals progress --summary "emailed"' } }] }
    const failed = { role: 'toolResult', toolCallId: 'call-1', isError: true, content: [{ type: 'text', text: 'goal_conflict' }] }
    expect(goalSettle(goal(), [...run, call, failed], 0, [])).toMatchObject({ continue: true })
    expect(goalSettle(goal(), [...run, call, { ...failed, isError: false }], 0, [])).toEqual({ continue: false })
  })

  test('creating the goal is not recording: the creating turn starts the work', () => {
    expect(goalSettle(goal(), [...run, bash('kortix goals new "Invoice paid" --criterion "sent" --here')], 0, [])).toMatchObject({ continue: true })
  })

  test('no goal, a waiting, verifying or paused goal settles', () => {
    expect(goalSettle(null, run, 0, [])).toEqual({ continue: false })
    for (const patch of [{ state: 'waiting_on_user' }, { state: 'verifying' }, { paused_at: '2026-11-11T00:00:00Z' }]) {
      expect(goalSettle(goal(patch), run, 0, [])).toEqual({ continue: false })
    }
  })

  test(`at most ${MAX_NUDGES} notes per run, and none after a nudged step that used no tool`, () => {
    const worked = [bash('ls')]
    expect(goalSettle(goal(), run, MAX_NUDGES - 1, worked)).toMatchObject({ continue: true })
    expect(goalSettle(goal(), run, MAX_NUDGES, worked)).toEqual({ continue: false })
    expect(goalSettle(goal(), run, 1, [reply('Still waiting.')])).toEqual({ continue: false })
  })
})

describe('goalSection', () => {
  test('names the goal, each criterion with its status, the evidence folder and the three ways to record', () => {
    const text = goalSection(goal())
    expect(text).toContain('"Invoice paid and confirmed" (active)')
    expect(text).toContain('- c1: The transfer shows as sent (reported met)')
    expect(text).toContain('- c2: The vendor confirmed the IBAN (open)')
    expect(text).toContain('/Users/u1/Goals/invoice-paid/evidence/')
    for (const command of ['kortix goals progress', 'kortix goals verify', 'kortix goals transition waiting_on_user']) expect(text).toContain(command)
  })

  test('says how the person stops it, and that the chat never stops it by itself', () => {
    expect(goalSection(goal())).toContain('kortix goals stop --reason')
  })

  test('says how a waiting goal goes back to active once the person answered in the chat', () => {
    expect(goalSection(goal({ state: 'waiting_on_user' }))).toContain('kortix goals transition active')
  })
})

describe('stopping the goal', () => {
  const stop = { command: 'kortix goals stop --reason "the person said drop it"' }

  test("a person's own message is a person turn; a loop fire, a goal wake and a peer message are not", () => {
    expect(personTurn('drop the invoice goal')).toBe(true)
    expect(personTurn('[REMINDER reminder.0123456789ab — recurring]\nGoal wake: /drives/me/Goals/invoice. Load the kortix-goals skill and run one wake (goal g1).')).toBe(false)
    expect(personTurn('Goal wake: /drives/me/Goals/invoice. Load the kortix-goals skill and run one wake (goal g1). A person resumed the goal.')).toBe(false)
    expect(personTurn('<trigger_event>{"type":"cron"}</trigger_event>')).toBe(false)
  })

  test('a stop runs only in a person turn; every other goal command runs in any turn', () => {
    expect(stopRefusal(stop, true)).toBeNull()
    expect(stopRefusal(stop, false)).toContain('Only the person stops this goal')
    expect(stopRefusal({ command: 'cd /tmp && kortix  goals stop --reason x' }, false)).not.toBeNull()
    expect(stopRefusal({ command: 'kortix goals progress --summary "stop the old plan"' }, false)).toBeNull()
    expect(stopRefusal({ command: 'kortix goals transition waiting_on_user --reason "stop or go on?"' }, false)).toBeNull()
  })
})
