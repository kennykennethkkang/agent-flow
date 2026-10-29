/** Saved web logins (logins.json), deleting an AWS profile, and the sign-in command shapes. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AUTH0, applyLogin, loginUrl, readLogins, writeLogins } from '../src/hub/logins'
import { deleteAwsProfile, parseAwsConfig, removeProfile } from '../src/hub/aws'
import { commandProblem } from '../src/hub/routes'
import type { WebApp } from '../src/hub/types'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-logins-'))
let n = 0
const id = () => `id${++n}`

describe('logins.json', () => {
  it('starts with Auth0 when there is no file', () => {
    assert.deepEqual(readLogins(path.join(tmp(), 'logins.json')), [AUTH0])
    assert.equal(AUTH0.url, 'https://manage.auth0.com/')
  })

  it('writes and reads back, dropping hand-edited entries that are not http(s)', () => {
    const file = path.join(tmp(), 'sub', 'logins.json')
    const apps: WebApp[] = [{ ...AUTH0, logins: [{ id: 'a', label: 'Work', url: 'https://manage.auth0.com/dashboard/us/work', chrome: 'Profile 2' }], active: 'a' }]
    writeLogins(apps, file)
    assert.deepEqual(readLogins(file), apps)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    raw.apps[0].logins.push({ id: 'b', label: 'bad', url: 'javascript:alert(1)' }, { id: 'c', label: 'x' })
    raw.apps.push({ id: 'z', name: 'Zed', url: 'file:///etc/passwd', logins: [] })
    fs.writeFileSync(file, JSON.stringify(raw))
    assert.deepEqual(readLogins(file), apps)
  })

  it('accepts only http(s) URLs with no credentials in them', () => {
    assert.equal(loginUrl(' https://manage.auth0.com/ '), 'https://manage.auth0.com/')
    assert.equal(loginUrl('http://localhost:3001/login'), 'http://localhost:3001/login')
    for (const bad of ['javascript:alert(1)', 'file:///x', 'manage.auth0.com', 'https://u:p@x.com/', 'https://x.com/?access_token=abc', 'https://x.com/?password=1'])
      assert.equal(loginUrl(bad), undefined, bad)
  })
})

describe('applyLogin', () => {
  const add = (apps: WebApp[], label: string) => applyLogin(apps, { type: 'hub-login-add', app: 'auth0', label, url: 'https://manage.auth0.com/', chrome: 'Default' }, id) as WebApp[]

  it('adds an app and logins; the first login is active', () => {
    const apps = applyLogin([AUTH0], { type: 'hub-login-app-add', name: ' Vercel ', url: 'https://vercel.com/login' }, id) as WebApp[]
    assert.deepEqual(apps.map(a => a.name), ['Auth0', 'Vercel'])
    assert.deepEqual(apps[1].logins, [])
    const one = add(apps, 'Personal'), two = add(one, 'Work')
    assert.deepEqual(two[0].logins.map(l => l.label), ['Personal', 'Work'])
    assert.equal(two[0].active, two[0].logins[0].id)
    assert.equal(two[0].logins[0].chrome, 'Default')
  })

  it('makes active, renames, saves the browser on sign in, and deletes', () => {
    let apps = add(add([AUTH0], 'Personal'), 'Work')
    const [p, w] = apps[0].logins
    apps = applyLogin(apps, { type: 'hub-login-active', app: 'auth0', id: w.id }) as WebApp[]
    assert.equal(apps[0].active, w.id)
    apps = applyLogin(apps, { type: 'hub-login-rename', app: 'auth0', id: w.id, label: ' Work tenant\n' }) as WebApp[]
    assert.equal(apps[0].logins[1].label, 'Work tenant')
    apps = applyLogin(apps, { type: 'hub-login-open', app: 'auth0', id: p.id, chrome: 'Profile 2' }) as WebApp[]
    assert.equal(apps[0].logins[0].chrome, 'Profile 2')
    // Deleting the active one hands active to the next.
    apps = applyLogin(apps, { type: 'hub-login-delete', app: 'auth0', id: w.id }) as WebApp[]
    assert.deepEqual(apps[0].logins.map(l => l.id), [p.id])
    assert.equal(apps[0].active, p.id)
    apps = applyLogin(apps, { type: 'hub-login-delete', app: 'auth0', id: p.id }) as WebApp[]
    assert.deepEqual(apps[0].logins, [])
    assert.equal(apps[0].active, undefined)
  })

  it('deletes a whole app with its logins', () => {
    const apps = applyLogin(add([AUTH0], 'Personal'), { type: 'hub-login-app-add', name: 'Vercel', url: 'https://vercel.com/login' }, id) as WebApp[]
    assert.deepEqual((applyLogin(apps, { type: 'hub-login-app-delete', app: 'auth0' }) as WebApp[]).map(a => a.name), ['Vercel'])
    assert.equal(typeof applyLogin(apps, { type: 'hub-login-app-delete', app: 'nope' }), 'string')
  })

  it('refuses bad input with a reason', () => {
    const apps = add([AUTH0], 'Personal')
    assert.equal(typeof applyLogin(apps, { type: 'hub-login-add', app: 'auth0', label: 'x', url: 'ftp://x' }, id), 'string')
    assert.equal(typeof applyLogin(apps, { type: 'hub-login-add', app: 'auth0', label: '  ', url: 'https://x.com' }, id), 'string')
    assert.equal(typeof applyLogin(apps, { type: 'hub-login-add', app: 'nope', label: 'x', url: 'https://x.com' }, id), 'string')
    assert.equal(typeof applyLogin(apps, { type: 'hub-login-delete', app: 'auth0', id: 'nope' }), 'string')
    assert.equal(typeof applyLogin(apps, { type: 'hub-login-app-add', name: 'auth0', url: 'https://x.com' }, id), 'string', 'name taken')
    assert.equal(typeof applyLogin(apps, { type: 'hub-login-app-add', name: 'Y', url: 'javascript:1' }, id), 'string')
  })
})

describe('deleting an AWS profile', () => {
  const CONFIG = '[default]\nregion = us-west-1\noutput = json\n\n# the sandbox\n[profile sandbox]\nregion = us-east-2\n\n[profile live]\nregion = us-west-1\noutput = json\n\n[profile ops]\nrole_arn = arn:aws:iam::555555555555:role/B\nsource_profile = base\n\n[profile base]\nregion = eu-west-1\n'

  it('removes the block and its comment, leaving the rest', () => {
    const r = removeProfile(CONFIG, 'sandbox')
    assert.ok('text' in r)
    assert.deepEqual(parseAwsConfig(r.text).map(s => s.name), ['default', 'live', 'ops', 'base'])
    assert.ok(!r.text.includes('sandbox'))
    assert.ok(r.text.includes('[default]\nregion = us-west-1\noutput = json\n\n[profile live]'))
  })

  it('refuses the default, the profile the default copies, one another profile sources from, and unknown names', () => {
    for (const name of ['default', 'live', 'base', 'nope']) assert.ok('problem' in removeProfile(CONFIG, name), name)
  })

  it('writes a timestamped backup next to the config before changing it', () => {
    const dir = tmp(), file = path.join(dir, 'config')
    fs.writeFileSync(file, CONFIG, { mode: 0o600 })
    assert.equal(deleteAwsProfile('sandbox', file, Date.UTC(2026, 9, 28, 15, 4, 5)), undefined)
    assert.equal(fs.readFileSync(path.join(dir, 'config.backup-20261028-150405'), 'utf8'), CONFIG)
    assert.ok(!fs.readFileSync(file, 'utf8').includes('sandbox'))
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.join(dir, 'config.backup-20261028-150405')).mode & 0o777, 0o600)
  })

  it('leaves the config and writes no backup when refused', () => {
    const dir = tmp(), file = path.join(dir, 'config')
    fs.writeFileSync(file, CONFIG)
    assert.match(deleteAwsProfile('default', file, 1) ?? '', /default/)
    assert.equal(fs.readFileSync(file, 'utf8'), CONFIG)
    assert.deepEqual(fs.readdirSync(dir), ['config'])
  })
})

describe('sign-in command shapes', () => {
  it('accepts the new commands and refuses missing fields', () => {
    const ok = [
      { type: 'hub-login-app-add', name: 'Vercel', url: 'https://vercel.com/login' },
      { type: 'hub-login-add', app: 'auth0', label: 'Work', url: 'https://manage.auth0.com/', chrome: 'Default' },
      { type: 'hub-login-add', app: 'auth0', label: 'Work', url: 'https://manage.auth0.com/' },
      { type: 'hub-login-open', app: 'auth0', id: 'a', chrome: '' },
      { type: 'hub-login-active', app: 'auth0', id: 'a' },
      { type: 'hub-login-rename', app: 'auth0', id: 'a', label: 'x' },
      { type: 'hub-login-delete', app: 'auth0', id: 'a' },
      { type: 'hub-aws-delete', profile: 'sandbox' },
      { type: 'hub-login-app-delete', app: 'auth0' },
    ]
    for (const c of ok) assert.equal(commandProblem(c), undefined, c.type)
    assert.ok(commandProblem({ type: 'hub-login-delete', app: 'auth0' }))
    assert.ok(commandProblem({ type: 'hub-login-add', app: 'auth0', label: 'x', url: 1 }))
    assert.ok(commandProblem({ type: 'hub-aws-delete' }))
  })
})
