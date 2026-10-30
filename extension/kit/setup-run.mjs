#!/usr/bin/env node
// Runs a Switchboard setup plan (JSON steps from src/hub/setup.ts) on any OS.
//   node setup-run.mjs plan.json [--dry-run]
//   node setup-run.mjs --headers <name>   (the 21st headersHelper: prints {"<name>": key} from the OS store)
// The 21st key comes from API_KEY_21ST in the env only, goes to the OS store by stdin or env, and is never printed.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SERVICE = 'switchboard-21st'
// Copied out of the extension folder, which moves on update.
const HELPER = '~/.claude/switchboard/setup-run.mjs'
const KEY_FILE = '~/.claude/switchboard/21st.key'

export const expand = (p, home = homedir()) => (p.startsWith('~/') ? join(home, p.slice(2)) : p)

/** macOS keychain, or a DPAPI file only this Windows user can read; undefined where there is no store. */
export function storeKey(key, platform = process.platform, home = homedir()) {
  // detached: no controlling terminal, else security prompts on the tty and ignores stdin.
  if (platform === 'darwin') return { cmd: 'security', args: ['add-generic-password', '-U', '-s', SERVICE, '-a', userInfo().username, '-w'], input: `${key}\n${key}\n`, detached: true }
  if (platform === 'win32') return { cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', 'ConvertTo-SecureString $env:API_KEY_21ST -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -NoNewline $env:SB_KEY_FILE'], env: { API_KEY_21ST: key, SB_KEY_FILE: expand(KEY_FILE, home) } }
  return undefined
}

export function readKey(platform = process.platform, home = homedir()) {
  if (platform === 'darwin') return { cmd: 'security', args: ['find-generic-password', '-s', SERVICE, '-w'] }
  if (platform === 'win32') return { cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', "[Net.NetworkCredential]::new('', (Get-Content $env:SB_KEY_FILE | ConvertTo-SecureString)).Password"], env: { SB_KEY_FILE: expand(KEY_FILE, home) } }
  return undefined
}

/** The server's config: a headersHelper reading the store, else ${API_KEY_21ST}, which Claude Code fills from its env. */
export function mcpConfig(url, header, platform = process.platform, home = homedir()) {
  if (!readKey(platform, home)) return { type: 'http', url, headers: { [header]: '${API_KEY_21ST}' } }
  const helper = platform === 'win32' ? expand(HELPER, home).replace(/\\/g, '/') : expand(HELPER, home)
  return { type: 'http', url, headersHelper: `node "${helper}" --headers ${header}` }
}

/** claude is claude.cmd on Windows, which only runs through a shell; args with spaces or quotes are quoted for it. */
export function commandFor(cmd, args, platform = process.platform) {
  if (platform !== 'win32') return { cmd, args, shell: false }
  // Backslashes before a quote, or the closing one, double.
  return { cmd, args: args.map(a => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"` : a)), shell: true }
}

function run(cmd, args, quiet) {
  const c = commandFor(cmd, args)
  return spawnSync(c.cmd, c.args, { stdio: ['inherit', quiet ? 'ignore' : 'inherit', 'inherit'], shell: c.shell }).status === 0
}

// Not through a shell: the key rides in stdin or env only. The timeout keeps a prompt from hanging Set up.
const direct = (c, stdio) => spawnSync(c.cmd, c.args, { input: c.input, env: { ...process.env, ...c.env }, stdio, encoding: 'utf8', windowsHide: true, detached: c.detached, timeout: 15_000 })

/** The key from the env, else from the plain-text header an older Set up wrote into ~/.claude.json. */
export function keyFor(k, env = process.env, home = homedir()) {
  const key = (env.API_KEY_21ST ?? '').trim()
  if (key) return key
  try {
    const v = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers[k.name].headers[k.header]
    return typeof v === 'string' && !v.includes('${') ? v.trim() : ''
  } catch { return '' }
}

/** Stores the key, then replaces the server (an older Set up left the key in ~/.claude.json). false when it failed. */
function addKeyed(k, key, dry) {
  const store = storeKey(key)
  const config = JSON.stringify(mcpConfig(k.url, k.header))
  console.log(store ? `> keep the ${k.name} key in ${process.platform === 'win32' ? expand(KEY_FILE) : 'the keychain'}` : `> ${k.name}: no secret store here, so set API_KEY_21ST in your shell profile`)
  console.log(`> claude mcp remove --scope user ${k.name}`)
  console.log(`> claude mcp add-json --scope user ${k.name} ${config}`)
  if (dry) return true
  if (store) {
    mkdirSync(dirname(expand(KEY_FILE)), { recursive: true })
    cpSync(fileURLToPath(import.meta.url), expand(HELPER))
    if (direct(store, ['pipe', 'ignore', 'ignore']).status !== 0) return false
  }
  run('claude', ['mcp', 'remove', '--scope', 'user', k.name], true)
  return run('claude', ['mcp', 'add-json', '--scope', 'user', k.name, config], true)
}

const cloneUrl = repo => `https://github.com/${repo}.git`

/** '' when cloned, else git's last line. */
function gitClone(repo, dir) {
  const r = spawnSync('git', ['clone', '-q', '--depth', '1', cloneUrl(repo), dir], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  if (r.error) return r.error.message
  return r.status === 0 ? '' : (r.stderr.trim().split('\n').at(-1) || `git exited ${r.status}`)
}

/** Clones the repo shallow and copies each named skill (by its SKILL.md name) into ~/.claude/skills; one already there is the user's and stays. */
export function installSkills(k, { home = homedir(), clone = gitClone, log = console.log } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'sb-skills-'))
  const out = { added: [], kept: [], missing: [] }
  try {
    const err = clone(k.repo, join(tmp, 'repo'))
    if (err) { log(`${k.repo}: could not fetch (${err}), skipped.`); return { ...out, error: err } }
    const root = join(tmp, 'repo', 'skills')
    const found = {}
    for (const d of existsSync(root) ? readdirSync(root) : []) {
      const md = join(root, d, 'SKILL.md')
      const name = existsSync(md) && /^name:\s*["']?([^"'\s]+)/m.exec(readFileSync(md, 'utf8'))?.[1]
      if (name) found[name] = join(root, d)
    }
    for (const n of k.names) {
      const to = join(home, '.claude', 'skills', n)
      if (existsSync(to)) out.kept.push(n)
      else if (!found[n]) { out.missing.push(n); log(`${k.repo}: no skill named ${n}, skipped.`) }
      else { cpSync(found[n], to, { recursive: true }); out.added.push(n); log(`Added skill ${n}`) }
    }
    return out
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}

function main(planFile, dry) {
  const steps = JSON.parse(readFileSync(planFile, 'utf8'))
  if (!dry && !run('claude', ['--version'], true)) {
    console.log('Install Claude Code first (https://claude.com/claude-code), then run Set up again.')
    process.exit(1)
  }
  const failed = []
  for (const s of steps) {
    if (s.say !== undefined) { console.log(s.say); continue }
    if (s.ifExists && !existsSync(expand(s.ifExists))) continue
    if (s.key) {
      const key = keyFor(s.key)
      if (!key) console.log(`${s.label}: no key in the env, skipped.`)
      else if (addKeyed(s.key, key, dry)) { if (!dry) console.log(`Added ${s.label}`) }
      else failed.push(s.label)
      continue
    }
    if (s.skills) {
      console.log(`> git clone --depth 1 ${cloneUrl(s.skills.repo)}, copy ${s.skills.names.join(' ')} to ~/.claude/skills`)
      if (!dry && installSkills(s.skills).error) failed.push(s.label)
      continue
    }
    if (s.copy) {
      const from = expand(s.copy.from), to = expand(s.copy.to)
      console.log(`> copy ${from} to ${to}`)
      if (!dry) { mkdirSync(dirname(to), { recursive: true }); rmSync(to, { recursive: true, force: true }); cpSync(from, to, { recursive: true }) }
    }
    if (!s.run) continue
    const args = s.run.slice(1).map(a => expand(a))
    console.log(`> ${s.quiet ? s.label : [s.run[0], ...args].join(' ')}`)
    if (dry) continue
    if (run(s.run[0], args, s.quiet)) { if (s.quiet) console.log(`Added ${s.label}`) }
    else failed.push(s.label)
  }
  if (failed.length) console.log(`\nDid not finish, run Set up again or try by hand:\n  ${failed.join('\n  ')}`)
}

function headers(name) {
  const c = readKey()
  const r = c && direct(c, ['ignore', 'pipe', 'ignore'])
  const key = r?.status === 0 ? r.stdout.trim() : ''
  if (!key) process.exit(1)
  process.stdout.write(JSON.stringify({ [name]: key }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--headers') headers(process.argv[3])
  else main(process.argv[2], process.argv.includes('--dry-run'))
}
