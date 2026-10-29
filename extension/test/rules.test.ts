/**
 * Rules and roles sync: when a rules file is written, skipped or given a managed block, and when a role file is touched.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { BLOCK_END, BLOCK_START, HEADER, decideAgent, decideRules, rulesFile, rulesSha, syncRules, upsertBlock, withPointer } from '../src/hub/rules'

const RULES = '# Working style\n\nBe brief.\n'
const V = '2026-10-28T10:00:00Z'

describe('rules file', () => {
  it('carries the kit header and a version line with the hash', () => {
    const t = rulesFile(RULES, V)
    assert.ok(t.startsWith(HEADER))
    assert.match(t, new RegExp(`<!-- rules-version: ${V} sha256:${rulesSha(RULES)} -->`))
    assert.ok(t.endsWith(RULES))
    assert.equal(rulesSha(RULES).length, 12)
  })

  it('writes a missing file', () => {
    assert.deepEqual(decideRules(undefined, RULES, V), { action: 'write', text: rulesFile(RULES, V), why: 'missing' })
  })

  it('leaves a generated file whose rules already match, with or without a version line', () => {
    assert.equal(decideRules(rulesFile(RULES, V), RULES, V).action, 'skip')
    assert.equal(decideRules(`${HEADER}\n${RULES}`, RULES, V).action, 'skip')
  })

  it('never downgrades rules the kit wrote later', () => {
    const d = decideRules(rulesFile('# Newer\n', '2026-11-01T00:00:00Z'), RULES, V)
    assert.deepEqual([d.action, d.why], ['skip', 'kit newer'])
  })

  it('rewrites older generated rules, and old ones with no version line', () => {
    assert.equal(decideRules(rulesFile('# Old\n', '2026-01-01T00:00:00Z'), RULES, V).action, 'write')
    assert.equal(decideRules(`${HEADER}\n# Old\n`, RULES, V).action, 'write')
  })

  it('adds a managed block to a hand-written file and keeps the rest', () => {
    const d = decideRules('# Mine\n', RULES, V)
    assert.equal(d.action, 'write')
    assert.ok(d.text!.startsWith('# Mine\n'))
    assert.ok(d.text!.includes(`${BLOCK_START}\n${RULES.trimEnd()}\n${BLOCK_END}`))
    assert.equal(decideRules(d.text, RULES, V).action, 'skip')
  })

  it('replaces a stale managed block in place', () => {
    const old = upsertBlock('# Mine\n', '# Old\n')
    const next = upsertBlock(`${old}\n# After\n`, RULES)
    assert.ok(!next.includes('# Old'))
    assert.ok(next.includes('# After'))
    assert.equal(next.split(BLOCK_START).length, 2)
  })
})

describe('role files', () => {
  const sha = rulesSha
  it('installs, skips, updates an untouched old copy, keeps an edited one', () => {
    assert.equal(decideAgent(undefined, 'new', []), 'install')
    assert.equal(decideAgent('new', 'new', []), 'skip')
    assert.equal(decideAgent('old', 'new', [sha('old')]), 'update')
    assert.equal(decideAgent('mine', 'new', [sha('old')]), 'edited')
  })
  it('a model picked in the gear is not an edit', () => {
    const v1 = '---\nname: qa\nmodel: opus\n---\nv1\n', v2 = '---\nname: qa\nmodel: opus\n---\nv2\n'
    const picked = (t: string) => t.replace('model: opus', 'model: haiku')
    assert.equal(decideAgent(picked(v2), v2, []), 'skip')
    assert.equal(decideAgent(picked(v1), v2, [sha(v1)]), 'retune')
    assert.equal(decideAgent(picked(v1).replace('v1', 'mine'), v2, [sha(v1)]), 'edited')
  })
})

describe('syncRules', () => {
  const kit = (dir: string) => {
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'rules.md'), RULES)
    fs.writeFileSync(path.join(dir, 'agents', 'qa.md'), 'qa v2')
    fs.writeFileSync(path.join(dir, 'agents', 'engineer.md'), 'eng v2')
    fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify({ rulesVersion: V, history: { 'qa.md': [rulesSha('qa v1')] } }))
  }
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rules-'))

  it('writes only for installed tools, keeps edited roles as .switchboard-new, and is quiet the second time', () => {
    const home = tmp(), k = tmp()
    kit(k)
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'agents', 'engineer.md'), 'my engineer')
    const r = syncRules({ home, kit: k, write: true })
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), rulesFile(RULES, V))
    assert.ok(!fs.existsSync(path.join(home, '.codex')))
    assert.deepEqual(r.ready, { claude: true, codex: false })
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'agents', 'qa.md'), 'utf8'), 'qa v2')
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'agents', 'engineer.md'), 'utf8'), 'my engineer')
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'agents', 'engineer.md.switchboard-new'), 'utf8'), 'eng v2')
    assert.match(r.note, /engineer\.md edited/)
    assert.equal(syncRules({ home, kit: k, write: true }).changed.length, 0)
  })

  it('dry mode touches nothing', () => {
    const home = tmp(), k = tmp()
    kit(k)
    fs.mkdirSync(path.join(home, '.claude'))
    const r = syncRules({ home, kit: k, write: false })
    assert.ok(r.changed.length > 0)
    assert.equal(r.ready.claude, false)
    assert.deepEqual(fs.readdirSync(path.join(home, '.claude')), [])
  })

  it('says up to date when everything matches', () => {
    const home = tmp(), k = tmp()
    kit(k)
    fs.mkdirSync(path.join(home, '.claude'))
    syncRules({ home, kit: k, write: true })
    assert.equal(syncRules({ home, kit: k, write: true }).note, 'Rules and roles: up to date')
  })

  it('updates an old role whose model was picked in the gear and keeps that model', () => {
    const home = tmp(), k = tmp()
    kit(k)
    const v1 = '---\nname: qa\nmodel: opus\n---\nv1\n', v2 = '---\nname: qa\nmodel: opus\n---\nv2\n'
    fs.writeFileSync(path.join(k, 'agents', 'qa.md'), v2)
    fs.writeFileSync(path.join(k, 'bundle.json'), JSON.stringify({ rulesVersion: V, history: { 'qa.md': [rulesSha(v1)] } }))
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'agents', 'qa.md'), v1.replace('opus', 'haiku'))
    syncRules({ home, kit: k, write: true })
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'agents', 'qa.md'), 'utf8'), v2.replace('opus', 'haiku'))
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'agents', 'qa.md.switchboard-new')))
  })
})

describe('withPointer', () => {
  it('adds the bundled rules path only for a tool whose rules are missing, and never makes a message out of nothing', () => {
    assert.equal(withPointer('go', true, '/k'), 'go')
    assert.equal(withPointer('', false, '/k'), '')
    assert.equal(withPointer('go', false, '/k'), 'go\n\nFollow the working style in /k/rules.md; role briefs are in /k/agents.')
  })
})
