import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { boxNote } from './message-box'
import type { ChatRow } from './hub-types'

const row = (extra: Partial<ChatRow>): ChatRow => ({ pid: 1, sessionId: 's1', cwd: '/w', link: '', live: true, why: [], ...extra })

describe('message box', () => {
  it('has no note for a chat that takes messages', () => {
    assert.equal(boxNote(row({ takes: true })), undefined)
  })

  it('says why a chat cannot take messages, per AI', () => {
    assert.match(boxNote(row({ ai: 'codex' }))!, /Codex/)
    assert.match(boxNote(row({}))!, /usage-meter/)
  })

  it('says a chat that is not live is not running, whatever its AI', () => {
    assert.match(boxNote(row({ ai: 'codex', live: false }))!, /not running/)
  })
})
