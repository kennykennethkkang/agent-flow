/**
 * What the Hub's buttons do in VS Code: open or clone a project, start a chat,
 * run a Remote Control server, sign in to AWS. Each acts only on folders and
 * profiles the hub already lists. Called from hub-panel.ts.
 */
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import { execFile, spawn } from 'child_process'
import { hub, type Handoff } from './hub-service'
import type { AiId, ChatProfile, ChatRow, Installed } from './types'
import { AIS, chatTerminal, cliPath, codexPaste, codexReady } from './ais'
import { quickAsk, withBrief } from './brain'
import { rulesState, withPointer } from './rules'
import { accountsNote, readLinks, readLogins } from './logins'
import { awsBinary, chromeCall, profileFor, readPrefs, validProfileName, writeOpenChrome, writePrefs } from './aws'
import { SHELL, chainBase, chainVersion, cloneTarget, freshPrompt, inWorkspace, labelNote, newChatCommand, nextChainName, projectName, stillRunning } from './projects'
import { insideCwd, libraryInventory, projectContext, projectInventory, safeFile } from './local'
import { matchCodexStarts, recordArchive, recordChain, type CodexStart } from './chains'
import { RC_NAME, rcRunning, rcRunningNow, rcServerCommand } from './sessions'
import { titleFor } from './title'
import { moveTodoChat } from './todo'
import { KEY_ENV, setupState, setupSteps, type SetupKit } from './setup'
import { FLAGGED, PICK_MS, chatSettings, cleanProfile, defaultProfile, handoffSettings, pickProfile, nameNote, readProfiles, saveProfile, startProfile, toolsNote } from './tools'
import { createLogger } from '../logger'

const log = createLogger('Tools')

// A window opened by `code` from inside a chat inherits Claude's child marker, and a chat started
// under it saves no transcript (no --resume, no handoff). Chat terminals drop it; null unsets.
const OWN_CHAT = { CLAUDE_CODE_CHILD_SESSION: null }
/** A chat terminal's env: no child marker, and the AWS profile picked for its folder (Sign-ins). */
const chatEnv = (cwd: string): Record<string, string | null> => {
  const p = profileFor(hub.get().signIns.projects, cwd), b = profileFor(hub.get().signIns.browsers ?? {}, cwd)
  return { ...OWN_CHAT, ...(p && validProfileName(p) ? { AWS_PROFILE: p } : {}), ...(b ? { BROWSER: writeOpenChrome(), SWITCHBOARD_CHROME_DIR: b } : {}) }
}
const HANDOFFS = path.join(os.homedir(), '.claude', 'handoffs')
// A Codex chat has no pid to stop: the terminal Switchboard started it in, by session id. A terminal waits in
// codexStarts under the name its row will show (the message's first 60 characters, or a handoff's To: name) until
// bindCodexTerminals ties it to exactly one new rollout. Lost on reload: such a chat is then never closed by Switchboard.
const codexTerminals = new Map<string, vscode.Terminal>()
const codexBorn = new WeakMap<vscode.Terminal, number>()
let codexStarts: (CodexStart & { terminal: vscode.Terminal })[] = []
const START_TTL_MS = 60 * 60 * 1000
/** The first message in a temp file for newChatCommand's textFile; nothing for an empty one. */
const messageFile = (text: string) => {
  if (!text.trim()) return undefined
  const file = path.join(os.tmpdir(), `switchboard-${crypto.randomUUID()}.txt`)
  fs.writeFileSync(file, text.trim())
  return file
}
const rowName = (first: string) => first.replace(/\s+/g, ' ').trim().slice(0, 60)
const waitForCodex = (terminal: vscode.Terminal, cwd: string, name: string | undefined) => {
  if (name) codexStarts.push({ key: Math.random().toString(36).slice(2), cwd, name, at: Date.now(), terminal })
}

/** Ties started Codex terminals to their sessions; hub-panel.ts calls it with each fresh chat list. */
export function bindCodexTerminals(chats: ChatRow[], now = Date.now()): void {
  codexStarts = codexStarts.filter(s => now - s.at < START_TTL_MS && s.terminal.exitStatus === undefined)
  const tied = matchCodexStarts(codexStarts, chats, new Set(codexTerminals.keys()))
  for (const [key, sessionId] of tied) codexTerminals.set(sessionId, codexStarts.find(s => s.key === key)!.terminal)
  codexStarts = codexStarts.filter(s => !tied.has(s.key))
}

/**
 * A Codex chat runs as its terminal's own process, with no shell around it: when Codex quits the terminal ends,
 * so a message typed into it can never land at a shell prompt. Answers why it could not start.
 */
async function codexTerminal(name: string, cwd: string, args: string[]): Promise<vscode.Terminal | string> {
  const bin = await cliPath('codex')
  if (!bin) return 'codex is not on PATH'
  const t = vscode.window.createTerminal({ name, cwd, env: chatEnv(cwd), shellPath: bin, shellArgs: args })
  codexBorn.set(t, Date.now())
  return t
}

/** One terminal per name: running again replaces it, which also stops what it was running. */
function freshTerminal(name: string, cwd: string): vscode.Terminal {
  vscode.window.terminals.find(t => t.name === name)?.dispose()
  const t = vscode.window.createTerminal({ name, cwd })
  t.show(true)
  return t
}

export function openProject(folder: string, newWindow: boolean): void {
  if (!hub.get().projects.some(p => p.path === folder)) return
  void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: newWindow })
}

export async function cloneProject(repo: string, newWindow: boolean, root: string): Promise<void> {
  // hub-panel.ts refuses a repo with no target before this runs.
  const target = cloneTarget(repo)
  if (!target) return
  const dest = path.join(root, target.name)
  if (!fs.existsSync(dest)) {
    const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Cloning ${target.name}` }, () =>
      new Promise<boolean>(resolve => execFile('git', ['clone', '--', target.url, dest],
        // No prompt to hang on: a private repo without saved credentials fails and says so.
        { timeout: 10 * 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
        err => {
          if (err) void vscode.window.showWarningMessage(`Switchboard: git clone failed (${err.message.split('\n')[0]}).`)
          resolve(!err)
        })))
    if (!ok) return
  }
  void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dest), { forceNewWindow: newWindow })
}

/**
 * A chat in its own terminal, named by a short title made from the goal (the project's name
 * with no goal). Remote Control gets the same title: its name outranks --name. Answers why it could not start.
 * id: the Claude chat's session id, when the caller tracks it (a To-do item).
 * noRemote: Remote Control stays off even when it is on at startup, so a To-do run stays in VS Code.
 */
export async function newChat(folder: string, text: string | undefined, remote: boolean, branch: string | undefined, ai: AiId = 'claude', tools?: ChatProfile, id?: string, noRemote = false): Promise<string | undefined> {
  const project = hub.get().projects.find(p => p.path === folder)
  if (!project) return `${folder} is not in the project list yet; open Switchboard once and try again`
  const goal = text?.trim()
  const inv = ai === 'claude' && hub.get().installed.length ? await chatInventory(folder) : []
  // Every Claude chat gets its own tool set, never the user's settings.json. Codex keeps its own.
  const [title, profile] = await Promise.all([
    goal ? titleFor(goal, quickAsk) : project.name,
    startProfile(inv, tools, goal, g => pickFor(g, inv, folder)),
  ])
  // Codex has no hook to read the brief from, so it rides in front of the first message.
  const first = withPointer(ai === 'claude' ? '' : withBrief(hub.get(), folder, text), rulesState.ready[ai], rulesState.kit)
  if (ai === 'codex') {
    const t = await codexTerminal(`${AIS.codex.name}: ${title}`, folder, first.trim() ? [first] : [])
    if (typeof t === 'string') return t
    t.show()
    // The row is named by the message, never the brief in front of it (ais.ts).
    waitForCodex(t, folder, rowName(text ?? '') || undefined)
    return undefined
  }
  let command: string
  try {
    const sessionId = id ?? (profile ? crypto.randomUUID() : undefined)
    const settings = chatSettings(sessionId, profile, noRemote)
    if (sessionId && profile) setChatProfile(sessionId, profile)
    command = newChatCommand({ textFile: messageFile(withPointer(text ?? '', rulesState.ready.claude, rulesState.kit)), name: title, remote: remote ? title : undefined, branch, sessionId, settings, system: [settings && profile ? toolsNote(profile) : '', myName(), accountsNote(readLogins(), readLinks(), folder, hub.get().signIns.chrome) ?? ''].filter(Boolean).join(' ') || undefined }, SHELL)
  } catch (err) {
    return (err as Error).message
  }
  const t = vscode.window.createTerminal({ name: `${AIS[ai].name}: ${title}`, cwd: folder, env: chatEnv(folder) })
  t.show()
  t.sendText(command)
  return undefined
}

const devName = (project: string) => `Dev: ${project}`
const devTerminal = (project: string) => vscode.window.terminals.find(t => t.name === devName(project) && t.exitStatus === undefined)

/**
 * A project's dev server as its terminal's own process, like a Codex chat: Ctrl+C, a crash or Stop ends the
 * terminal too. A second press brings the running one up. False when it was already running.
 * ponytail: found by name, so two projects with one folder name share a terminal.
 */
export function startDev(folder: string, project: string, command: string): boolean {
  const open = devTerminal(project)
  if (open) { open.show(true); return false }
  const win = process.platform === 'win32'
  const t = vscode.window.createTerminal({ name: devName(project), cwd: folder, env: chatEnv(folder),
    shellPath: win ? process.env.ComSpec ?? 'cmd.exe' : process.env.SHELL || '/bin/zsh', shellArgs: win ? ['/d', '/c', command] : ['-lc', command] })
  t.show(true)
  return true
}

/** Ends this window's dev terminal for the project; false when it has none. */
export function stopDev(project: string): boolean {
  const t = devTerminal(project)
  t?.dispose()
  return !!t
}

/** The user's plugins and skills plus the project's own skills and design references. */
const chatInventory = async (folder: string | undefined) => [...hub.get().installed, ...(folder ? await projectInventory(folder).catch(() => []) : []), ...await libraryInventory()]
const pickFor = async (goal: string, inv: Installed[], folder?: string) =>
  pickProfile(goal, inv, quickAsk, PICK_MS, why => log.warn(`Tool pick fell back to the default set (${why})`), folder ? await projectContext(folder).catch(() => '') : '')

const myName = () => nameNote(hub.get().controls.switchboard.name) ?? ''

const toolsState = () => hub.get().tools ?? { flagged: FLAGGED, pick: null, chats: {} }
/** Shows a chat's saved profile in the panel at once, before the next refresh reads it back. */
export const setChatProfile = (sessionId: string, p: ChatProfile) => hub.set({ tools: { ...toolsState(), chats: { ...toolsState().chats, [sessionId]: p } } })

/** The New chat form's pick for a goal, shown as chips before Start; with the folder, its project skills and design references too. */
export async function pickTools(goal: string, folder?: string): Promise<void> {
  const profile = await pickFor(goal, await chatInventory(folder), folder)
  hub.set({ tools: { ...toolsState(), pick: { goal, folder, profile } } })
}

/** A chat's tools changed in the panel: saved now, used when it is resumed. */
export async function saveChatTools(sessionId: string, p: ChatProfile): Promise<string | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return 'Not a chat id'
  // The chat's own folder, so its project skills and design references survive the save.
  const profile = cleanProfile(p, await chatInventory(hub.get().chats.find(c => c.sessionId === sessionId)?.cwd))
  saveProfile(sessionId, profile)
  setChatProfile(sessionId, profile)
  return undefined
}

/** Ends a Codex chat Switchboard started, by closing the terminal tied to its session; false when none is. Called only once the chat is idle. */
export function closeCodexChat(sessionId: string): boolean {
  const t = codexTerminals.get(sessionId)
  codexTerminals.delete(sessionId)
  t?.dispose()
  return !!t
}

/** Whether a live terminal is tied to this Codex chat, so the message box can type into it. */
export const codexTied = (sessionId: string) => { const t = codexTerminals.get(sessionId); return !!t && t.exitStatus === undefined }

/** Types a message into a Codex chat's terminal as Kenneth would; Enter goes a beat later so Codex reads the paste first. */
export async function sendToCodex(chat: ChatRow, text: string): Promise<string | undefined> {
  const paste = codexPaste(text)
  if (!paste) return 'the message has control characters in it, so it was not typed into Codex'
  const t = codexTerminals.get(chat.sessionId)
  const problem = await codexReady({ terminal: t, live: chat.live, startedAt: (t && codexBorn.get(t)) ?? 0, now: Date.now() })
  if (problem || !t) return problem
  t.show(true)
  t.sendText(paste, false)
  setTimeout(() => t.sendText('\r', false), 150)
  return undefined
}

/** Opens one of a chat's changed files against HEAD; only a file in its listed changes, inside its folder. */
export async function openDiff(sessionId: string, file: string): Promise<string | undefined> {
  const c = hub.get().changes
  const f = c?.sessionId === sessionId ? c.files.find(x => x.path === file) : undefined
  if (!c || !f || !insideCwd(c.cwd, file)) return 'That file is not in this chat\'s changes'
  // A deleted file has nothing on disk; any other must be a plain file whose real path stays in the folder (no symlinks).
  const real = f.status === 'deleted' ? path.join(c.cwd, file) : await safeFile(c.cwd, file)
  if (!real) return 'That file is a symlink or leads outside the chat\'s folder, so it is not opened'
  const right = vscode.Uri.file(real)
  if (f.status === 'untracked' || f.status === 'added') { await vscode.window.showTextDocument(right, { preview: true }); return undefined }
  type GitApi = { toGitUri(uri: vscode.Uri, ref: string): vscode.Uri; openRepository?(root: vscode.Uri): Promise<unknown> }
  const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git')
  const api = (ext?.isActive ? ext.exports : await ext?.activate())?.getAPI(1)
  if (!api) { if (f.status !== 'deleted') await vscode.window.showTextDocument(right, { preview: true }); return api ? undefined : 'VS Code\'s Git extension is off' }
  await api.openRepository?.(vscode.Uri.file(c.cwd))
  const left = api.toGitUri(right, 'HEAD')
  if (f.status === 'deleted') await vscode.window.showTextDocument(left, { preview: true })
  else await vscode.commands.executeCommand('vscode.diff', left, right, `${file} (HEAD vs working tree)`)
  return undefined
}

/** Opens a closed chat's handoff note in the editor; only a note under ~/.claude/handoffs. */
export function openNote(sessionId: string): string | undefined {
  const note = hub.get().archive.find(a => a.sessionId === sessionId)?.note
  const full = note ? path.resolve(note) : ''
  if (!full.startsWith(HANDOFFS + path.sep) || !fs.existsSync(full)) return 'That chat\'s handoff note is gone'
  void vscode.window.showTextDocument(vscode.Uri.file(full), { preview: true })
  return undefined
}

/** Shows the terminal a chat runs in, found by its name; false when none matches. */
export function focusChat(sessionId: string): boolean {
  // ponytail: name matching misses chats not started from Switchboard; match by pid (the chat is a child of the terminal's shell) if that matters.
  const name = hub.get().chats.find(c => c.sessionId === sessionId)?.name
  const t = name ? vscode.window.terminals.find(x => x.name.endsWith(`: ${name}`)) : undefined
  t?.show()
  return !!t
}

/** Types a prompt's answer into the chat's terminal, one key at a time; 300ms apart was checked to land. */
/** claim runs once the terminal is known, before any key goes out, so a refused answer leaves the prompt showing; false: a second tap got there first. */
export async function answerInTerminal(pid: number, keys: string[], claim: () => boolean): Promise<string | undefined> {
  const t = await chatTerminal(pid, vscode.window.terminals)
  if (!t) return 'that chat runs outside this VS Code window, so answer it in its terminal'
  if (!claim()) return 'that prompt is already answered or gone'
  for (const [i, k] of keys.entries()) {
    if (i) await new Promise(r => setTimeout(r, 300))
    t.sendText(k, false)
  }
  return undefined
}

/** Reopens a chat by its id in a new terminal in the chat's folder. */
export async function resumeChat(sessionId: string, ai: AiId): Promise<string | undefined> {
  // The id goes into a shell line: only the hex and dashes a session id has.
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return 'Not a chat id'
  const s = hub.get()
  const cwd = [...s.chats, ...s.starred, ...s.archive].find(c => c.sessionId === sessionId)?.cwd
  if (!cwd || !fs.existsSync(cwd)) return 'That chat\'s folder is gone'
  const name = `${AIS[ai].name}: ${projectName(cwd)}`
  if (ai === 'codex') {
    const t = await codexTerminal(name, cwd, ['resume', sessionId])
    if (typeof t === 'string') return t
    t.show()
    codexTerminals.set(sessionId, t)
    return undefined
  }
  const t = vscode.window.createTerminal({ name, cwd, env: chatEnv(cwd) })
  t.show()
  t.sendText(AIS[ai].resumeCommand(sessionId, myName()))
  return undefined
}

/** A name git does not have yet: the name, then name-2 up to name-9. */
async function freeBranch(cwd: string, name: string): Promise<string> {
  const taken = (b: string) => new Promise<boolean>(resolve => execFile('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { cwd }, err => resolve(!err)))
  for (let i = 1; i <= 9; i++) {
    const b = i === 1 ? name : `${name}-${i}`
    if (!(await taken(b))) return b
  }
  return `${name}-${Date.now().toString(36)}`
}

/** The checked-out branch from .git/HEAD, without running git. */
export function headBranch(cwd: string): string | undefined {
  try { return /^ref: refs\/heads\/(.+)$/m.exec(fs.readFileSync(path.join(cwd, '.git', 'HEAD'), 'utf8'))?.[1].trim() } catch { return undefined }
}

/**
 * A full chat's handoff: the note gets a header naming both chats, the old chat is
 * recorded in its chain and archived for History, and a fresh chat named `<origin> vN`
 * starts in the same folder on the note. The old chat is closed by hub-service.ts
 * (Claude) or hub-panel.ts (Codex) once it is safe to.
 */
export async function continueInFreshChat(h: Handoff, workspace: string | undefined): Promise<boolean> {
  if (!inWorkspace(h.cwd, workspace)) return false
  const name = projectName(h.cwd)
  const fresh = nextChainName(h.name, name, h.plan, h.task)
  const base = chainBase(fresh) ?? fresh
  const ai = h.ai ?? 'claude'
  try {
    const note = fs.readFileSync(h.note, 'utf8')
    fs.writeFileSync(h.note, labelNote(stillRunning(note, h.running), {
      n: chainVersion(fresh), base, from: h.name || name, id8: h.sessionId.slice(0, 8), to: fresh,
      branch: h.branch || headBranch(h.cwd) || 'unknown', plan: h.plan ? path.relative(h.cwd, h.plan) : 'none',
    }))
    recordChain(h.sessionId, base)
  } catch (err) { void vscode.window.showWarningMessage(`Switchboard: could not label the handoff note (${(err as Error).message}).`) }
  const text = withPointer(freshPrompt(h.note), rulesState.ready[ai], rulesState.kit)
  const codex = ai === 'codex'
  // The fresh chat keeps the old one's tool set; one started outside Switchboard gets the defaults.
  const carried = codex ? undefined : readProfiles([h.sessionId])[h.sessionId]
    ?? (hub.get().installed.length ? defaultProfile(await chatInventory(h.cwd)) : undefined)
  // Always an id for a Claude chat, so a To-do item in progress follows it.
  const freshId = codex ? undefined : crypto.randomUUID()
  // A To-do chat stays off Remote Control in every version of it.
  let settings: string | undefined, off = false
  try { if (freshId) ({ settings, off } = handoffSettings(h.sessionId, freshId, carried)) } catch { /* starts with the user's defaults */ }
  const system = [settings && carried ? toolsNote(carried) : '', myName()].filter(Boolean).join(' ') || undefined
  const tools = { ...(settings ? { settings } : {}), system }
  const claude = (branch?: string) => newChatCommand({ textFile: messageFile(text), name: fresh, remote: hub.get().rc.atStartup && !off ? fresh : undefined, branch, sessionId: freshId, ...tools }, SHELL)
  let command = ''
  try {
    // Codex has no --name and no hook to read the brief from: the brief rides in front, the name lives in the note.
    if (!codex) {
      const branch = h.branch ? await freeBranch(h.cwd, h.branch) : undefined
      try { command = claude(branch) } catch {
        // A branch the shell line cannot carry: the fresh chat starts on the current branch instead, and says so.
        command = claude()
        void vscode.window.showWarningMessage(`Switchboard: ${fresh} starts on the current branch; "${h.branch}" is not a usable branch name.`)
      }
    }
  } catch (err) {
    void vscode.window.showWarningMessage(`Switchboard: ${(err as Error).message}.`)
    return false
  }
  const t = codex
    ? await codexTerminal(`Codex: ${fresh}`, h.cwd, [withBrief(hub.get(), h.cwd, text)])
    : vscode.window.createTerminal({ name: `Claude: ${fresh}`, cwd: h.cwd, env: chatEnv(h.cwd) })
  if (typeof t === 'string') {
    void vscode.window.showWarningMessage(`Switchboard: ${t}.`)
    return false
  }
  t.show()
  if (codex) waitForCodex(t, h.cwd, fresh)
  else t.sendText(command)
  // Only now that the fresh chat runs: the old chat moves to History and is closed once the fresh one posts.
  try {
    recordArchive({
      sessionId: h.sessionId, ai, name: h.name || base, origin: base, version: chainVersion(fresh) - 1, cwd: h.cwd, project: name,
      note: h.note, startedAt: hub.get().progress.find(p => p.sessionId === h.sessionId)?.startedAt, archivedAt: Date.now(),
    })
  } catch (err) { void vscode.window.showWarningMessage(`Switchboard: could not move the old chat to History (${(err as Error).message}).`) }
  if (!codex) hub.closeAfterFresh(h.sessionId, h.cwd)
  if (freshId) void moveTodoChat(h.cwd, h.sessionId, freshId).catch(() => {})
  return true
}

/** Refreshes the portable kit from this machine, in a terminal so the result shows. Answers why it could not. */
export function exportKit(root: string): string | undefined {
  const setup = path.join(root, 'claude-mods', 'kit', 'setup.mjs')
  if (!fs.existsSync(setup)) return `no kit at ${setup}`
  freshTerminal('Kit: export', path.dirname(setup)).sendText(`node "${setup}" --export`)
  return undefined
}

/** Set up: asks for the 21st key (empty skips), then runs the missing install steps in a terminal. The key rides in the env only. */
export async function runSetup(ext: string): Promise<void> {
  const key = await vscode.window.showInputBox({ title: 'Switchboard setup', prompt: '21st.dev API key for Magic (from 21st.dev/mcp). Leave empty to skip.', password: true, ignoreFocusOut: true })
  if (key === undefined) return
  const kit = JSON.parse(fs.readFileSync(path.join(ext, 'kit', 'setup.json'), 'utf8')) as SetupKit
  const steps = setupSteps(kit, { ...setupState(os.homedir()), key21st: !!key.trim(), modsDir: path.join(ext, 'kit', 'mods') })
  const plan = path.join(os.tmpdir(), 'switchboard-setup.json')
  fs.writeFileSync(plan, JSON.stringify(steps))
  vscode.window.terminals.find(t => t.name === 'Switchboard setup')?.dispose()
  const t = vscode.window.createTerminal({ name: 'Switchboard setup', cwd: os.homedir(), env: key.trim() ? { [KEY_ENV]: key.trim() } : undefined })
  t.show(true)
  // Same line in sh, cmd and PowerShell.
  t.sendText(`node "${path.join(ext, 'kit', 'setup-run.mjs')}" "${plan}"`)
}

/** Where the one Remote Control server runs: phone chats start here and can work in any repo under it. */
const RC_ROOT = () => path.join(os.homedir(), 'Documents', 'GitHub')
const RC_TERMINAL = `RC ${RC_NAME}`

/** The machine's one Remote Control server, in its own long-lived terminal, unless the kit's LaunchAgent runs it. */
export async function rcServer(folder: string, on: boolean): Promise<string | undefined> {
  if (folder !== RC_ROOT()) return `Remote Control runs only in ${RC_ROOT()}`
  const open = vscode.window.terminals.find(t => t.name === RC_TERMINAL)
  if (!on) {
    if (!open && await rcRunningNow()) return `the Remote Control server was started by the kit's login item (LaunchAgent com.kenneth.switchboard.rc, or switchboard-rc.vbs in the Windows Startup folder), so turn it off there`
    open?.sendText('\x03', false)
    open?.dispose()
    return undefined
  }
  // The kit's LaunchAgent may already run one outside VS Code; a second would clash with it.
  if (open || await rcRunningNow()) return undefined
  if (!fs.existsSync(RC_ROOT())) return `no ${RC_ROOT()} folder`
  freshTerminal(RC_TERMINAL, RC_ROOT()).sendText(rcServerCommand())
  return undefined
}

export const rcServers = () => [{ folder: RC_ROOT(), name: RC_NAME, on: vscode.window.terminals.some(t => t.name === RC_TERMINAL) || rcRunning() }]

const LOGIN_MS = 5 * 60 * 1000

/**
 * `aws login --profile <p>` with no stdin, opened in the picked Chrome profile (or the system browser when chrome is '').
 * Python's webbrowser runs BROWSER, a fixed script; the Chrome folder rides in the env and must be one Chrome lists.
 * The choice is kept per profile. done: called when it ends, signed in or not.
 */
export function awsLogin(profile: string, chrome: string | undefined, done: () => void): string | undefined {
  if (!validProfileName(profile)) return 'Not a profile name'
  const dir = chrome || ''
  if (dir && !hub.get().signIns.chrome.some(c => c.dir === dir)) return 'That Chrome profile is not in Chrome\'s list'
  const prefs = readPrefs()
  writePrefs({ ...prefs, chrome: { ...prefs.chrome, [profile]: dir } })
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (dir) { env.BROWSER = writeOpenChrome(); env.SWITCHBOARD_CHROME_DIR = dir }
  const child = spawn(awsBinary(), ['login', '--profile', profile], { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true })
  let out = ''
  const keep = (b: Buffer) => { out = (out + b.toString()).slice(-4000) }
  child.stdout.on('data', keep); child.stderr.on('data', keep)
  const timer = setTimeout(() => child.kill(), LOGIN_MS)
  child.on('error', err => { clearTimeout(timer); void vscode.window.showWarningMessage(`Switchboard: aws login could not start (${err.message}).`); done() })
  child.on('close', code => {
    clearTimeout(timer)
    if (code === 0) void vscode.window.showInformationMessage(`Switchboard: signed in to AWS as ${profile}.`)
    else void vscode.window.showWarningMessage(`Switchboard: aws login --profile ${profile} did not finish${out.trim() ? ` (${out.trim().split('\n').pop()?.slice(0, 200)})` : ''}.`)
    done()
  })
  return undefined
}

/** A saved web login's URL in its Chrome profile, through the same helper aws login uses, or the system browser. */
export function openLogin(url: string, chrome: string | undefined): string | undefined {
  if (!/^https?:\/\//.test(url)) return 'Not a web address'
  if (!chrome) { void vscode.env.openExternal(vscode.Uri.parse(url)); return undefined }
  if (!hub.get().signIns.chrome.some(c => c.dir === chrome)) return 'That Chrome profile is not in Chrome\'s list'
  const c = chromeCall(url, chrome)
  if (!c) return 'Chrome not found'
  execFile(c.cmd, c.args, { timeout: 10_000, windowsHide: true }, err => {
    if (err) void vscode.window.showWarningMessage(`Switchboard: could not open Chrome (${err.message}).`)
  })
  return undefined
}
