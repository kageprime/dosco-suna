import { describe, expect, test } from 'bun:test'
import { followThrough, followThroughNote, openWait, outwardActions, runMessages } from '@/harness/pi/extensions/follow-through'

const user = (text: string) => ({ role: 'user', content: text })
const reply = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })
const bash = (command: string) => ({ role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command } }] })
const schedules = (action: string) => ({ role: 'assistant', content: [{ type: 'toolCall', name: 'kortix_schedules', arguments: { action, text: 'check' } }] })

const noWakeUp = async () => false
const wakeUp = async () => true

// The shape of a real run: pay an invoice, email the vendor to confirm, end with an offer.
const invoiceRun = [
  user('pay this invoice and confirm via email'),
  bash(`kortix connectors call bank recipients_list '{}'`),
  bash(`kortix connectors call bank transfers_create '{"amount":100}'`),
  bash(`kortix connectors call mail reply_to_thread '{"thread_id":"t1"}'`),
  reply('✅ The payment is ready for you to approve.\n\nWant me to check the thread for her answer in a couple of hours and tell you when it arrives?'),
]

describe('openWait', () => {
  test('a very long reply on one line is checked in milliseconds, and its closing offer is still found', async () => {
    const wall = 'word '.repeat(8000)
    const started = performance.now()
    expect(await openWait([user('summarise'), reply(wall)], noWakeUp)).toBeNull()
    expect(await openWait([user('summarise'), reply(`${wall}I'll then check and I will check again and I'll check`)], wakeUp)).toBeNull()
    expect(await openWait([user('summarise'), reply(`${wall}\n\nWant me to check the thread again tomorrow?`)], wakeUp)).toMatchObject({ kind: 'offer' })
    expect(performance.now() - started).toBeLessThan(500)
  })

  test('a wake-up call that failed sets nothing: the promise stays an open wait', async () => {
    const failed = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'kortix_schedules', arguments: { action: 'follow_up', text: 'check' } }] },
      { role: 'toolResult', toolCallId: 'call-1', isError: true, content: [{ type: 'text', text: 'at must be in the future' }] },
    ]
    const run = [...invoiceRun.slice(0, -1), ...failed, reply("⏳ I'll check the thread tomorrow morning.")]
    expect(await openWait(run, noWakeUp)).toMatchObject({ kind: 'promise' })
    // The same call succeeding closes the wait.
    const worked = [failed[0]!, { role: 'toolResult', toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'set' }] }]
    expect(await openWait([...invoiceRun.slice(0, -1), ...worked, reply("⏳ I'll check the thread tomorrow morning.")], noWakeUp)).toBeNull()
  })

  test('an offer to check later is an open wait, even when a loop is set', async () => {
    const wait = await openWait(invoiceRun, wakeUp)
    expect(wait).toEqual({ kind: 'offer', offer: 'Want me to check the thread for her answer in a couple of hours and tell you when it arrives?' })
  })

  test('outward connector calls with no wake-up are an open wait', async () => {
    const run = [...invoiceRun.slice(0, -1), reply('✅ Sent the email and drafted the transfer.')]
    expect(await openWait(run, noWakeUp)).toEqual({ kind: 'acted', actions: ['bank.transfers_create', 'mail.reply_to_thread'] })
  })

  test('outward calls with an active wake-up on the session are fine', async () => {
    const run = [...invoiceRun.slice(0, -1), reply('✅ Sent.')]
    expect(await openWait(run, wakeUp)).toBeNull()
  })

  test('a wake-up set in the run closes it without asking the API', async () => {
    let asked = false
    const run = [...invoiceRun.slice(0, -1), schedules('wake_on'), reply('⏳ I\'ll check the thread at 21:30.')]
    expect(await openWait(run, async () => ((asked = true), false))).toBeNull()
    expect(asked).toBe(false)
  })

  test('a loop set through the CLI closes it', async () => {
    const run = [...invoiceRun.slice(0, -1), bash(`kortix loop "check the reply" --in=2h --json`), reply('⏳ Set.')]
    expect(await openWait(run, noWakeUp)).toBeNull()
  })

  test('listing loops sets none', async () => {
    const run = [...invoiceRun.slice(0, -1), bash('kortix loops ls --json'), reply('✅ Sent.')]
    expect((await openWait(run, noWakeUp))?.kind).toBe('acted')
  })

  test('read-only connector calls and a plain answer leave nothing open', async () => {
    const run = [user('what is my balance?'), bash(`kortix connectors call bank balances_list '{}'`), reply('You have 3 accounts. Want me to break it down by currency?')]
    expect(await openWait(run, noWakeUp)).toBeNull()
  })

  // Two of 8 real-model runs on 2026-11-11 ended like this with no loop set.
  test('a promised check with no wake-up is an open wait', async () => {
    const promised = [user('pay this'), reply("Draft is ready.\n\n⏳ I'll check in tomorrow morning on whether a verified confirmation came through.")]
    expect((await openWait(promised, noWakeUp))?.kind).toBe('promise')
    const conditional = [user('pay this'), reply("If she's still quiet after 2 business days, I'll draft a chase email for you to send.")]
    expect((await openWait(conditional, noWakeUp))?.kind).toBe('promise')
    expect((await openWait([user('zahl das'), reply('Ich melde mich morgen früh, ob sie geantwortet hat.')], noWakeUp))?.kind).toBe('promise')
  })

  test('a promise is fine when a wake-up is active or a colleague reports back', async () => {
    const promised = [user('pay this'), reply("⏳ I'll check the thread at 15:00 and tell you.")]
    expect(await openWait(promised, wakeUp)).toBeNull()
    const handOff = [user('write the post'), { role: 'assistant', content: [{ type: 'toolCall', name: 'agent', arguments: { name: 'post-writer' } }] }, reply("⏳ I've handed that to the post writer. I'll tell you when it's done.")]
    expect(await openWait(handOff, noWakeUp)).toBeNull()
  })

  test('a plain answer with no time is not a promise', async () => {
    expect(await openWait([user('hi'), reply("I'll keep it short: you have 3 sessions running.")], noWakeUp)).toBeNull()
  })

  test('a German offer counts', async () => {
    const run = [user('zahl das'), reply('Erledigt. Soll ich morgen nachschauen, ob sie geantwortet hat?')]
    expect((await openWait(run, noWakeUp))?.kind).toBe('offer')
  })

  test('only the current run counts', async () => {
    const earlier = [...invoiceRun.slice(0, -1), schedules('follow_up'), reply('⏳ Set.')]
    expect(runMessages([...earlier, user('thanks')])).toEqual([])
    expect(await openWait([...earlier, user('thanks'), reply('You are welcome.')], noWakeUp)).toBeNull()
  })

  test('a read is not an outward action, whatever noun it reads', () => {
    for (const action of ['GMAIL_FETCH_MESSAGE_BY_THREAD_ID', 'GMAIL_LIST_DRAFTS', 'STRIPE_LIST_PAYMENT_INTENTS', 'GITHUB_LIST_PULL_REQUESTS', 'SLACK_SEARCH_MESSAGES', 'get_invoice', 'find_transfer']) {
      expect(outwardActions([bash(`kortix connectors call app ${action} '{}'`)])).toEqual([])
    }
    // A read verb later in the name does not make an outward action a read.
    for (const action of ['GMAIL_SEND_EMAIL', 'GMAIL_REPLY_TO_THREAD', 'STRIPE_CREATE_PAYMENT_INTENT', 'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL', 'MAIL_SEND_MESSAGE_TO_LIST']) {
      expect(outwardActions([bash(`kortix connectors call app ${action} '{}'`)])).toEqual([`app.${action}`])
    }
  })

  test('outwardActions dedupes and keeps order', () => {
    expect(outwardActions([bash('kortix connectors call mail send_email {} && kortix connectors call mail send_email {}')])).toEqual(['mail.send_email'])
  })
})

describe('followThroughNote', () => {
  test('quotes the offer and tells the model to set the wake-up itself', () => {
    const note = followThroughNote({ kind: 'offer', offer: 'Want me to check later?' })
    expect(note).toContain('"Want me to check later?"')
    expect(note).toContain('kortix_schedules')
  })
})

describe('followThrough extension', () => {
  type Handler = (event: unknown) => unknown
  function load(applies = true) {
    const handlers = new Map<string, Handler>()
    const nudges: unknown[] = []
    const extension = followThrough({ applies: () => applies, hasWakeUp: noWakeUp, onNudge: (wait) => nudges.push(wait) })
    const factory = typeof extension === 'function' ? extension : extension.factory
    void factory({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as never)
    const settle = (messages: unknown[]) =>
      handlers.get('agent_before_settle')!({ type: 'agent_before_settle', outcome: 'completed', continue: false, entries: [], context: { contextMessages: messages, canContinue: false } })
    return { handlers, nudges, settle }
  }

  test('continues once with a hidden note, then lets the run settle', async () => {
    const { handlers, nudges, settle } = load()
    const first = (await settle(invoiceRun)) as { continue: boolean; entries: { display: boolean; customType: string }[] }
    expect(first.continue).toBe(true)
    expect(first.entries[0]).toMatchObject({ type: 'custom_message', customType: 'kortix-follow-through', display: false })
    expect(await settle(invoiceRun)).toBeUndefined()
    expect(nudges).toHaveLength(1)
    handlers.get('agent_settled')!({ type: 'agent_settled', aborted: false })
    expect(((await settle(invoiceRun)) as { continue: boolean }).continue).toBe(true)
  })

  test('leaves a turn it does not apply to alone', async () => {
    expect(await load(false).settle(invoiceRun)).toBeUndefined()
  })

  test("keeps the entries an earlier settle hook added (pi replaces the list with each hook's result)", async () => {
    const { handlers } = load()
    const earlier = { type: 'custom_message', customType: 'kortix-goal', content: '[goal] …', display: false }
    const result = (await handlers.get('agent_before_settle')!({ type: 'agent_before_settle', outcome: 'completed', continue: true, entries: [earlier], context: { contextMessages: invoiceRun, canContinue: false } })) as { entries: { customType: string }[] }
    expect(result.entries.map((entry) => entry.customType)).toEqual(['kortix-goal', 'kortix-follow-through'])
  })
})
