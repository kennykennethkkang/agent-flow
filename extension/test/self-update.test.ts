import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diskVersion, gitPuller, newerVersion, newestVsix } from '../src/hub/self-update'

test('newerVersion: dotted parts compare as numbers', () => {
  assert.equal(newerVersion('0.17.10', '0.17.9'), true)
  assert.equal(newerVersion('0.17.9', '0.17.10'), false)
  assert.equal(newerVersion('1.0.0', '0.99.99'), true)
  assert.equal(newerVersion('0.17.9', '0.17.9'), false)
  assert.equal(newerVersion('0.17.9', undefined), true)
})

test('newestVsix: highest version wins, other files ignored', () => {
  assert.deepEqual(newestVsix(['switchboard-0.17.9.vsix', 'switchboard-0.17.10.vsix', 'rules.md', 'other-1.0.0.vsix']),
    { file: 'switchboard-0.17.10.vsix', version: '0.17.10' })
  assert.equal(newestVsix(['rules.md']), undefined)
  assert.equal(newestVsix(['switchboard-0.17.9-beta.vsix', 'switchboard-x.vsix', 'switchboard-1.0.vsix']), undefined)
})

test('diskVersion: our entry in extensions.json, nothing when missing or broken', () => {
  const json = JSON.stringify([
    { identifier: { id: 'someone.else' }, version: '9.9.9' },
    { identifier: { id: 'kennykennethkkang.switchboard' }, version: '0.17.9' },
  ])
  assert.equal(diskVersion(json, 'kennykennethkkang.switchboard'), '0.17.9')
  assert.equal(diskVersion(json, 'missing.id'), undefined)
  assert.equal(diskVersion('not json', 'kennykennethkkang.switchboard'), undefined)
})

test('startSelfUpdate: installs and reloads only for a production install whose row shows the new version', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const Module = require('module')
  const id = 'kennykennethkkang.switchboard'
  const row = (v: string) => JSON.stringify([{ identifier: { id }, version: v }])
  const calls: string[] = []
  let listing = '', landed: string | undefined
  let state = new Map<string, unknown>()
  let leave: (s: { focused: boolean }) => void = () => {}
  const fake = {
    ExtensionMode: { Production: 1, Development: 2 },
    commands: { executeCommand: async (c: string) => { calls.push(c); if (landed && c.endsWith('installExtension')) fs.writeFileSync(listing, row(landed)) } },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    window: { state: { focused: false }, showInformationMessage: async () => undefined, onDidChangeWindowState: (f: (s: { focused: boolean }) => void) => { leave = f; return { dispose() {} } } },
  }
  const orig = Module._load
  Module._load = function (req: string, ...a: unknown[]) { return req === 'vscode' ? fake : orig.call(this, req, ...a) }
  const { startSelfUpdate } = await import('../src/hub/self-update')
  const run = async (mode: number, json: string | undefined, installs?: string) => {
    const exts = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-su-')), kit = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-kit-'))
    fs.writeFileSync(path.join(kit, 'switchboard-0.17.10.vsix'), '')
    listing = path.join(exts, 'extensions.json')
    landed = installs
    if (json) fs.writeFileSync(listing, json)
    const ctx = { globalState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v) } }, extensionMode: mode, extension: { packageJSON: { version: '0.17.9' }, id }, extensionPath: path.join(exts, `${id}-0.17.9`), subscriptions: [] as { dispose(): void }[] }
    await startSelfUpdate(ctx as never, kit, async () => { calls.push('pull') })
    for (const s of ctx.subscriptions) s.dispose()
    return calls.splice(0)
  }
  try {
    assert.deepEqual(await run(2, row('0.17.9')), [], 'dev host')
    assert.deepEqual(await run(1, undefined), [], 'no extensions.json')
    assert.deepEqual(await run(1, '[]'), [], 'no row for us')
    assert.deepEqual(await run(1, row('0.17.9')), ['pull', 'workbench.extensions.installExtension'], 'install did not land: no reload')
    assert.deepEqual(await run(1, row('0.17.9')), ['pull'], 'same version is not tried again')
    state = new Map()
    assert.deepEqual(await run(1, row('0.17.9'), '0.17.10'), ['pull', 'workbench.extensions.installExtension', 'workbench.action.reloadWindow'])
    // the row stays ahead of the running version (reload did not take): next start does not reload again
    assert.deepEqual(await run(1, row('0.17.10')), ['pull'], 'reloads at most once per version')
    leave({ focused: false })
    assert.deepEqual(calls.splice(0), [], 'leaving the window does not reload with nothing pending')
  } finally {
    Module._load = orig
  }
})

test('startSelfUpdate: a reload held back while focused happens at the next check once the window is in the background', async (t) => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const Module = require('module')
  const id = 'kennykennethkkang.switchboard'
  const calls: string[] = []
  const win = { focused: true }
  const fake = {
    ExtensionMode: { Production: 1 },
    commands: { executeCommand: async (c: string) => { calls.push(c) } },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    window: { state: win, showInformationMessage: async () => undefined, onDidChangeWindowState: () => ({ dispose() {} }) },
  }
  const orig = Module._load
  Module._load = function (req: string, ...a: unknown[]) { return req === 'vscode' ? fake : orig.call(this, req, ...a) }
  t.mock.timers.enable({ apis: ['setInterval'] })
  try {
    const { startSelfUpdate } = await import('../src/hub/self-update')
    const exts = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-su-')), kit = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-kit-'))
    fs.writeFileSync(path.join(exts, 'extensions.json'), JSON.stringify([{ identifier: { id }, version: '0.17.11' }]))
    const state = new Map<string, unknown>()
    const ctx = { globalState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v) } }, extensionMode: 1, extension: { packageJSON: { version: '0.17.10' }, id }, extensionPath: path.join(exts, `${id}-0.17.10`), subscriptions: [] as { dispose(): void }[] }
    await startSelfUpdate(ctx as never, kit, async () => {})
    assert.deepEqual(calls.splice(0), [], 'focused: asks, does not reload')
    // Already in the background, so no blur event comes.
    win.focused = false
    t.mock.timers.tick(5 * 60 * 1000)
    await new Promise(r => setImmediate(r))
    assert.deepEqual(calls.splice(0), ['workbench.action.reloadWindow'])
    for (const s of ctx.subscriptions) s.dispose()
  } finally {
    Module._load = orig
  }
})

test('gitPuller: pulls only with an upstream, one at a time, and never throws', async () => {
  const calls: string[] = []
  let upstream = true, failPull = false, release = () => {}
  const run = async (args: string[]) => {
    calls.push(args.join(' '))
    if (args[0] === 'rev-parse' && !upstream) throw new Error('no upstream')
    if (args[0] === 'pull') {
      await new Promise<void>(r => { release = r })
      if (failPull) throw new Error('conflict')
    }
    return ''
  }
  const pull = gitPuller(run)
  const a = pull(), b = pull()
  await new Promise(r => setTimeout(r, 5))
  release()
  await Promise.all([a, b])
  assert.deepEqual(calls.splice(0), ['rev-parse --abbrev-ref --symbolic-full-name @{u}', 'pull --ff-only --quiet'])
  upstream = false
  await pull()
  assert.deepEqual(calls.splice(0), ['rev-parse --abbrev-ref --symbolic-full-name @{u}'], 'no upstream or not a repo: no pull')
  upstream = true; failPull = true
  const c = pull()
  await new Promise(r => setTimeout(r, 5))
  release()
  await c
  assert.equal(calls.length, 2, 'a failed pull is swallowed')
})
