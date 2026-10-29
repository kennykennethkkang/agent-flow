/**
 * Role models: reading and rewriting the model: line of a role file's frontmatter.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { modelOf, setRoleModel, withModel } from '../src/hub/roles'
import { commandProblem } from '../src/hub/routes'

const QA = '---\nname: qa\ndescription: tests\nmodel: opus\nmaxTurns: 40\n---\n\nmodel: not this one\n'

describe('modelOf and withModel', () => {
  it('read and rewrite only the frontmatter line', () => {
    assert.equal(modelOf(QA), 'opus')
    assert.equal(withModel(QA, 'haiku'), QA.replace('model: opus', 'model: haiku'))
    assert.equal(modelOf('no frontmatter\nmodel: x\n'), undefined)
    assert.equal(withModel('no frontmatter\n', 'opus'), undefined)
  })
  it('adds the line before the closing fence when the role has none', () => {
    const bare = '---\nname: ops\n---\nbody\n'
    assert.equal(modelOf(bare), undefined)
    assert.equal(withModel(bare, 'inherit'), '---\nname: ops\nmodel: inherit\n---\nbody\n')
  })
  it('keeps CRLF files intact', () => {
    const crlf = '---\r\nname: qa\r\nmodel: opus\r\n---\r\n'
    assert.equal(modelOf(crlf), 'opus')
    assert.equal(withModel(crlf, 'sonnet'), '---\r\nname: qa\r\nmodel: sonnet\r\n---\r\n')
  })
})

describe('setRoleModel', () => {
  const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-roles-')); fs.writeFileSync(path.join(d, 'qa.md'), QA); return d }
  it('rewrites the one role file', () => {
    const d = dir()
    assert.equal(setRoleModel(d, 'qa', 'sonnet'), undefined)
    assert.equal(fs.readFileSync(path.join(d, 'qa.md'), 'utf8'), QA.replace('model: opus', 'model: sonnet'))
  })
  it('refuses unknown models, missing roles and paths', () => {
    const d = dir()
    assert.match(setRoleModel(d, 'qa', 'gpt-5') ?? '', /model/)
    assert.match(setRoleModel(d, 'nobody', 'opus') ?? '', /no role/)
    assert.match(setRoleModel(d, '../qa', 'opus') ?? '', /no role/)
    assert.match(setRoleModel(d, 'qa.md', 'opus') ?? '', /no role/)
    assert.equal(fs.readFileSync(path.join(d, 'qa.md'), 'utf8'), QA)
  })
})

describe('hub-role-model command', () => {
  it('takes a role name and one of the picker models', () => {
    assert.equal(commandProblem({ type: 'hub-role-model', role: 'qa', model: 'inherit' }), undefined)
    assert.match(commandProblem({ type: 'hub-role-model', role: 'qa', model: 'gpt-5' }) ?? '', /model/)
    assert.match(commandProblem({ type: 'hub-role-model', model: 'opus' }) ?? '', /role/)
  })
})
