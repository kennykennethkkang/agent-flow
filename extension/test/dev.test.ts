import { describe, it } from 'node:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import assert from 'node:assert/strict'
import { awakeArgs, devCommand, devHome, devLink, devRows, knownDev, offArgs, serveArgs, servedPorts } from '../src/hub/dev'

describe('dev button', () => {
  it('runs the dev script with the package manager its lockfile names', () => {
    const pkg = { scripts: { dev: 'next dev' } }
    assert.equal(devCommand(pkg, ['package.json', 'pnpm-lock.yaml']), 'pnpm run dev')
    assert.equal(devCommand(pkg, ['yarn.lock']), 'yarn run dev')
    assert.equal(devCommand(pkg, ['bun.lockb']), 'bun run dev')
    assert.equal(devCommand(pkg, ['bun.lock']), 'bun run dev')
    assert.equal(devCommand(pkg, ['package-lock.json']), 'npm run dev')
    assert.equal(devCommand(pkg, []), 'npm run dev')
  })

  it('has no command without a dev script', () => {
    assert.equal(devCommand({ scripts: { build: 'x' } }, ['pnpm-lock.yaml']), undefined)
    assert.equal(devCommand(undefined, []), undefined)
    assert.equal(devCommand({ scripts: { dev: 3 } }, []), undefined)
  })

  it('serves on port+10000, https with cert domains, else http', () => {
    assert.deepEqual(serveArgs(5173, true), ['serve', '--bg', '--https=15173', 'http://localhost:5173'])
    assert.deepEqual(serveArgs(5173, false), ['serve', '--bg', '--http=15173', 'http://localhost:5173'])
    assert.deepEqual(offArgs(5173, true), ['serve', '--https=15173', 'off'])
    assert.deepEqual(offArgs(5173, false), ['serve', '--http=15173', 'off'])
    assert.equal(devLink('mac.tail1.ts.net.', 5173, true), 'https://mac.tail1.ts.net:15173')
    assert.equal(devLink('mac.tail1.ts.net', 5173, false), 'http://mac.tail1.ts.net:15173')
  })

  it('reads the served ports from serve status --json', () => {
    assert.deepEqual(servedPorts('{"TCP":{"15173":{"HTTP":true},"443":{"HTTPS":true}}}'), new Set([15173, 443]))
    assert.deepEqual(servedPorts(''), new Set())
    assert.deepEqual(servedPorts('{}'), new Set())
  })

  it('sends dev-start to the window holding the folder, else keeps it here', () => {
    const wins = [
      { pid: 1, port: 9001, hubToken: 'a', workspace: '/r/agent-flow' },
      { pid: 2, port: 9002, hubToken: 'b', workspace: '/r/QR-Test' },
      { pid: 3, port: 9003, hubToken: 'c', workspace: '/r' },
    ]
    assert.equal(devHome(wins, '/r/QR-Test', 1)?.pid, 2)
    assert.equal(devHome(wins, '/r/agent-flow/web', 2)?.pid, 1)
    assert.equal(devHome(wins, '/r/Other', 1)?.pid, 3)
    assert.equal(devHome(wins.slice(0, 2), '/x/Other', 1), undefined)
    assert.equal(devHome(wins, '/r/QR-Test', 2), undefined)
    assert.equal(devHome(wins, '/r/QR-Test-2', 1)?.pid, 3)
  })

  it('lists folders with a dev script, running when a server cwd is inside, linked when served', () => {
    const read = (f: string) => f === '/r/QR-Test' ? { command: 'npm run dev' } : f === '/r/Web' ? { command: 'pnpm run dev' } : undefined
    const servers = [
      { pid: 7, command: 'node', port: 3131, folder: 'r/QR-Test', cwd: '/r/QR-Test' },
      { pid: 8, command: 'node', port: 5173, folder: 'QR-Test/app', cwd: '/r/QR-Test/app' },
    ]
    const rows = devRows(['/r/QR-Test', '/r/Web', '/r/QR-Test', '/r/None'], read, servers, { dns: 'mac.ts.net', https: false, served: new Set([15173]) })
    assert.deepEqual(rows, [
      { folder: '/r/QR-Test', project: 'QR-Test', repo: 'QR-Test', command: 'npm run dev', port: 5173, link: 'http://mac.ts.net:15173' },
      { folder: '/r/Web', project: 'Web', repo: 'Web', command: 'pnpm run dev' },
    ])
    assert.deepEqual(devRows(['/r/QR-Test'], read, servers, null)[0], { folder: '/r/QR-Test', project: 'QR-Test', repo: 'QR-Test', command: 'npm run dev', port: 5173 })
  })

  it('files a repo subfolder row under its repo, keeping the folder name for its terminal', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dev-'))
    try {
      const web = path.join(tmp, 'agent-flow', 'web')
      fs.mkdirSync(path.join(tmp, 'agent-flow', '.git'), { recursive: true })
      fs.mkdirSync(web)
      const [row] = devRows([web], () => ({ command: 'pnpm dev' }), [], null)
      assert.deepEqual([row.project, row.repo], ['web', 'agent-flow'])
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })

  it('starts only a listed project folder, never a free path', () => {
    const rows = [{ folder: '/r/QR-Test', project: 'QR-Test', repo: 'QR-Test', command: 'npm run dev' }]
    assert.equal(knownDev(rows, '/r/QR-Test')?.project, 'QR-Test')
    assert.equal(knownDev(rows, '/r/QR-Test/../Armasu'), undefined)
    assert.equal(knownDev(rows, '/etc'), undefined)
    assert.equal(knownDev(undefined, '/r/QR-Test'), undefined)
  })
})

describe('keep awake', () => {
  it('lives as long as VS Code, not the extension host, so an extension update or reload keeps it on', () => {
    assert.deepEqual(awakeArgs(4242), ['-dis', '-w', '4242'])
    // The extension host is a child of the VS Code app process.
    assert.deepEqual(awakeArgs(), ['-dis', '-w', String(process.ppid)])
  })
})
