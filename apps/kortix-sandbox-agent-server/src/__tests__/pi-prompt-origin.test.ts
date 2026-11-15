/**
 * `promptOrigin` (harness/pi/prompt-origin.ts): where a turn's prompt came from,
 * read from the envelope apps/api writes, and the workflow refusal per origin.
 * Synthetic values only.
 */
import { describe, expect, test } from 'bun:test'
import { peerMessagePromptText } from '@kortix/shared/peer-message-prompt'
import { promptOrigin, ultracodeRequested, workflowOriginRefusal } from '@/harness/pi/prompt-origin'

/** The head and block apps/api `subagentNoticeText` writes (`system:subagent-finished`). */
const NOTICE = [
  'A background subagent you started has finished. This message is from the platform, not from the user.',
  'task_id: child-1',
  'status: completed',
  '',
  '<kortix_system type="session-report" source="subagent">',
  '<session-report><session-id>child-1</session-id><status>COMPLETE</status></session-report>',
  '</kortix_system>',
].join('\n')

describe('promptOrigin', () => {
  test('a background subagent\'s report and a teammate\'s are a platform notice; the workflow refuses to start or resume there', () => {
    expect(promptOrigin(NOTICE)).toBe('notice')
    expect(promptOrigin('Your teammate reviewer finished its turn and is idle. This message is from the platform, not from the user.\ntask_id: child-2\nstatus: completed\n')).toBe('notice')
    expect(workflowOriginRefusal('notice')).toStartWith("A workflow starts or resumes only from a person's own message, and this turn came from a platform notice")
  })

  test('a batch of notices whose report is not first is a notice only when the API marked it synthetic', () => {
    const batch = `Calendar: your 10:00 starts in 5 minutes.\n\n---\n\n${NOTICE.split('\n').slice(4).join('\n')}`
    expect(promptOrigin(batch, { synthetic: true })).toBe('notice')
    expect(promptOrigin(batch)).toBe('human')
  })

  test('a person\'s own words stay human, ultracode included; peer and trigger keep their origins', () => {
    expect(promptOrigin('ultracode: audit the routes')).toBe('human')
    expect(ultracodeRequested('ultracode: audit the routes')).toBe(true)
    expect(ultracodeRequested(`${NOTICE}\nultracode`)).toBe(false)
    expect(workflowOriginRefusal('human')).toBeNull()
    const peer = peerMessagePromptText({ kind: 'message', from: 'reviewer', fromShortId: '3f2a1b9c', messageId: 'm_1', summary: null, text: 'hi' })
    expect(promptOrigin(peer)).toBe('peer')
    expect(promptOrigin('<trigger_event>{}</trigger_event>')).toBe('trigger')
  })
})
