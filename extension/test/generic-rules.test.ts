/**
 * The bundled rules name the user, not Kenneth.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GENERIC } from '../src/hub/rules'
const { genericRules, GENERIC: BUILD_GENERIC } = require('../esbuild.js') as { genericRules: (t: string) => string; GENERIC: string }

describe('genericRules', () => {
  it('swaps the name for the user, capitalized at a sentence start', () => {
    assert.equal(
      genericRules("Kenneth says hi.\nKenneth's work. Ask Kenneth. Once Kenneth has it.\n- Kenneth does that."),
      "The user says hi.\nThe user's work. Ask the user. Once the user has it.\n- The user does that.",
    )
  })
  it('marks generic copies the same way rules.ts reads them', () => assert.equal(BUILD_GENERIC, GENERIC))
  it('capitalizes at a comment or string start too', () => {
    assert.equal(genericRules(`// Kenneth's rules\nwhy: 'Kenneth commits', "Kenneth's guards"`), `// The user's rules\nwhy: 'The user commits', "The user's guards"`)
  })
  it('reads gender neutral', () => {
    assert.equal(genericRules('Kenneth commits and pushes himself, from his own terminal.'), 'The user commits and pushes themselves, from their own terminal.')
  })
  it('leaves other text alone', () => assert.equal(genericRules('No names here.'), 'No names here.'))
})
