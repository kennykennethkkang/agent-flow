/**
 * Connects the hub to every open view (editor panel and sidebar): `hub-state` pushes (at most one per 250 ms),
 * the panel's hub messages, and the Claude Code settings Controls may change. Gatherers (history,
 * plan, servers, ...) register with addRefresher and run on refreshHub().
 */
import * as vscode from 'vscode'
import * as os from 'os'
import * as path from 'path'
import { hub } from './hub-service'
import { HistoryScanner } from './history'
import { applyPatch, controlPatch, readControls } from './controls'
import type { ChatRow, DeviceAsk, SwitchboardKey, WindowColor } from './types'
import { SHADES, titleBar, titleBarColors, windowColors } from './colors'
import { FLAGGED, cleanName, readProfiles } from './tools'
import { connections, ensureWeb, gitState, installed, listServers, newestPlan, newestPlanFile, phoneUrls, projectFolders, readChanges, syncLibrary, webUrl } from './local'
import { awsLogin, answerInTerminal, openLogin, bindCodexTerminals, startDev, stopDev, cloneProject, closeCodexChat, codexTied, sendToCodex, continueInFreshChat, exportKit, runSetup, focusChat, headBranch, newChat, openDiff, openNote, openProject, pickTools, rcServer, rcServers, resumeChat, saveChatTools } from './actions'
import { chatTerminal, closeChatTerminal, codexFiles, lastCodexPrompt, readAis, rolloutLines } from './ais'
import { dueForHandoff, fullCodex, idleHandedOff, readArchive, readChains, removeArchive, searchNotes } from './chains'
import { newestNotes, readStarred, starredRows, toggleStar, writeStarred } from './starred'
import { rcTargets, readChats } from './sessions'
import { chainVersion, cloneTarget, codexNote, handoffFile, mergeProjects, planLabel } from './projects'
import { addAwsProfile, awsProfiles, deleteAwsProfile, makeDefault, parseAwsConfig, profileFor, readAwsConfig, readChrome, readLabels, readPrefs, validProfileName, writeAwsConfig, writeLabels, writeOpenChrome, writePrefs } from './aws'
import { execFile } from 'child_process'
import * as fs from 'fs'
import { hasAgentFlowHook, readSettingsFile, removeAgentFlowHooks, writeJsonAtomic } from '../hook-entries'
import { configureClaudeHooks } from '../hooks-config'
import { askKeys } from './progress'
import { answerQuestion, choiceProblem, installAsk } from './questions'
import { claudeCall } from './setup'
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../protocol'
import { createLogger } from '../logger'
import { forgetAccessNote, syncAccessNote } from './access-note'
import { Posters, tickWork } from './posters'
import { kitHash, rulesState, syncRules, type SyncResult } from './rules'
import { LOGINS, applyLink, applyLogin, loginFor, pruneLinks, readLinks, readLogins, writeLogins, type LinkCommand, type LoginCommand } from './logins'
import { setRoleModel } from './roles'
import { ghPath, gitOp, readRepo, repoRoot } from './git'
import { addTodo, changeTodo, clearGoneChats, editTodo, loadTodos, removeItem, replaceRemoteTodo, restoreTicked, runMessage, runOrder, setTodoSync, startTodo, todoFolders } from './todo'
import { randomUUID } from 'crypto'
import { awakePid, devHome, devRows, knownDev, postWindow, readDev, readWindows, serve, setAwake, tailnet } from './dev'

const log = createLogger('Hub')
// Off stops updates; the note stays.
const keepAccessNote = () => { if (hub.get().controls.switchboard.accessNote) void syncAccessNote(hub.get().phoneUrls ?? null).catch(err => log.warn('Access note failed:', err)) }
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const PUSH_MS = 250
// After the first full read a rescan only reads appended lines, so this stays cheap.
const HISTORY_EVERY_MS = 5 * 60 * 1000
const LIVE_EVERY_MS = 15 * 1000
const WATCHED_MS = 30 * 1000
const AWS_EVERY_MS = 10 * 60 * 1000
// Probing for the standalone app's page: at most once a minute, and on a manual refresh.
const WEB_EVERY_MS = 60 * 1000
// An idle chat's uncommitted changes are read again at most once a minute; a busy chat's on every tick.
const CHANGES_IDLE_MS = 60 * 1000
const REPO_ROOTS = [path.join(os.homedir(), 'Documents', 'GitHub')]
export const KIT_DIR = path.join(REPO_ROOTS[0], 'claude-mods', 'kit')
// The kit's one-row status line; the Controls switch writes this command.
const STATUS_LINE = path.join(KIT_DIR, 'statusline.mjs')
const statusLineCommand = () => (fs.existsSync(STATUS_LINE) ? `node "${STATUS_LINE.replace(/\\/g, '/')}"` : undefined)

const posters = new Posters<ExtensionToWebviewMessage>()
// Set in startHub; the bundled browser app lives under it.
let extensionPath = ''
let extensionVersion = ''
// Kept across windows and restarts: the fresh-chat branch choice and Switchboard's own switches.
let store: vscode.Memento | undefined
const KEEP_KEY = 'switchboard.keep'
const CONTROLS_KEY = 'switchboard.controls'
// Codex chats Switchboard already handed off, so a full chat starts one fresh chat, not one per refresh.
const HANDED_KEY = 'switchboard.codexHandedOff'
// The kit hash last synced and what that sync found, so activation writes once per kit change.
const RULES_KEY = 'switchboard.rulesSync'
const handedOff = new Set<string>()
// Handed-off Codex chats still open: each is closed once it is idle. ponytail: not kept across reloads; such a chat stays open (but in History) after one.
const closingCodex = new Set<string>()
// When each full Codex chat was first seen mid-turn; its handoff waits on the turn for at most 30 minutes.
const codexBusySince = new Map<string, number>()
let envs: vscode.GlobalEnvironmentVariableCollection | undefined
let awsAt = -Infinity
let statusBar: vscode.StatusBarItem | undefined
// This window's colored folder name, left of the Switchboard button; the title bar keys Switchboard wrote, per workspace.
let windowItem: vscode.StatusBarItem | undefined
let windowStore: vscode.Memento | undefined
const TITLE_KEY = 'switchboard.titleBar'
let pending: NodeJS.Timeout | undefined
const workspace = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
const refreshers: Array<() => void | Promise<void>> = []
let webAt = -Infinity
let changesAt = 0
let nearAt = 0
let onShown = () => {}

export function addRefresher(fn: () => void | Promise<void>): void {
  refreshers.push(fn)
}

export function refreshHub(): void {
  for (const fn of refreshers) Promise.resolve().then(fn).catch(err => log.warn('A hub refresh failed:', err))
}

/** Adds an open view's sender (editor panel or sidebar), sends it the current state at once and refreshes. Returns the remover. visible: whether it is on screen. */
export function addHubPoster(send: (m: ExtensionToWebviewMessage) => void, visible?: () => boolean): () => void {
  const remove = posters.add(send, visible)
  send({ type: 'hub-state', hub: hub.get() })
  refreshHub()
  return remove
}

/** A hidden view was shown again: it gets the current state now, and fresh reads unless the last ones are under 15 s old. */
export function hubViewShown(): void {
  posters.send({ type: 'hub-state', hub: hub.get() })
  onShown()
}

export function startHub(context: vscode.ExtensionContext): void {
  store = context.globalState
  for (const id of store.get<string[]>(HANDED_KEY) ?? []) handedOff.add(id)
  hub.runner = c => handleHubMessage(c as WebviewToExtensionMessage)
  hub.onDevice = d => {
    if ('done' in d) asking.delete(d.id)
    else { asking.set(d.id, { ...d, at: Date.now() }); setTimeout(listDevices, ASK_MS) }
    listDevices()
    promptDevices()
  }
  context.subscriptions.push(vscode.window.onDidChangeWindowState(s => { if (s.focused) promptDevices() }))
  // A stored onFull 'compact' from an older Switchboard is ignored: a full chat always continues fresh.
  const kept = store.get<{ freshBranch?: boolean }>(KEEP_KEY) ?? {}
  hub.set({ keep: { ...hub.get().keep, onFull: 'fresh', freshBranch: kept.freshBranch === true } })
  const controls = hub.get().controls
  hub.set({ controls: { ...controls, switchboard: { ...controls.switchboard, ...store.get(CONTROLS_KEY) } } })
  applyStatusBar()
  windowStore = context.workspaceState
  windowItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1)
  windowItem.command = 'agentVisualizer.open'
  context.subscriptions.push(windowItem,
    vscode.window.onDidChangeActiveColorTheme(() => refreshWindows()),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('switchboard.colorTitleBar')) refreshWindows() }))
  refreshWindows()
  readSettings()
  rulesState.kit = path.join(context.extensionPath, 'kit')
  extensionPath = context.extensionPath
  extensionVersion = context.extension.packageJSON.version
  // After an update, our running browser app still serves the old copy: restart it on the new one (never starts one).
  void ensureWeb(path.join(REPO_ROOTS[0], 'agent-flow'), false, { bundle: path.join(extensionPath, 'dist', 'app', 'app.js'), version: context.extension.packageJSON.version, refresh: true })
  syncKit()
  setupAsk(context.extensionPath)
  syncLibrary(path.join(extensionPath, 'kit', 'design-md')).then(c => { if (c) log.info('Design library copied') }, err => log.warn(`Design library: could not copy (${(err as Error).message})`))
  envs = context.environmentVariableCollection
  readSignIns()
  const history = new HistoryScanner()
  addRefresher(async () => hub.set(await history.scan()))
  addRefresher(refreshNear)
  addRefresher(async () => {
    const [inv, conns] = [await installed(), await connections(REPO_ROOTS)]
    const s = hub.get()
    const chats = readProfiles([...s.chats, ...s.starred].filter(c => (c.ai ?? 'claude') === 'claude').map(c => c.sessionId))
    hub.set({ installed: inv, connections: conns, tools: { flagged: FLAGGED, pick: s.tools?.pick ?? null, chats: { ...s.tools?.chats, ...chats } } })
  })
  const refreshProjects = async () => {
    const { repos, claude } = await projectFolders(REPO_ROOTS)
    hub.set({ projects: mergeProjects(repos, claude, workspace()) })
  }
  addRefresher(refreshProjects)
  // Once now as well, so New chat from the app or the phone works before the panel is ever opened.
  refreshProjects().catch(err => log.warn('Projects failed:', err))
  addRefresher(() => refreshAws())
  async function refreshNear() {
    nearAt = Date.now()
    readSettings()
    refreshWindows()
    const ws = workspace()
    const stars = readStarred()
    const webDue = Date.now() - webAt >= WEB_EVERY_MS
    if (webDue) webAt = Date.now()
    const [plan, git, servers, notes, web] = await Promise.all([
      newestPlan(ws), gitState(ws), listServers(), newestNotes(stars.map(s => s.sessionId)), webDue ? webUrl() : hub.get().webUrl, refreshChats(),
    ])
    hub.set({ plan, git, servers, rcServers: rcServers(), archive: readArchive(), webUrl: web, phoneUrls: await phoneUrls(web) })
    keepAccessNote()
    await refreshDev(servers)
    hub.set({ starred: starredRows(stars, hub.get(), notes, readChains()) })
    await refreshChanges(true)
    await loadTodos(todoFolders(ws)).catch(err => log.warn('To-do lists failed:', err))
  }
  const near = () => refreshNear().catch(err => log.warn('Plan, git or servers failed:', err))
  onShown = () => { if (Date.now() - nearAt >= LIVE_EVERY_MS) void near() }
  const slow = setInterval(() => { if (posters.shown) refreshHub() }, HISTORY_EVERY_MS)
  // Also while the standalone app reads /hub/state with no panel shown, so its chats stay current.
  // Views open but hidden read only the chats, so Codex handoffs and closing still happen.
  const fast = setInterval(() => {
    const work = tickWork(posters.shown, posters.size, Date.now() - hub.stateReadAt < WATCHED_MS)
    if (work === 'full') void near()
    else if (work === 'essentials') refreshChats().catch(err => log.warn('Chats failed:', err))
  }, LIVE_EVERY_MS)
  context.subscriptions.push({ dispose: () => { clearInterval(slow); clearInterval(fast) } })
  const sub = hub.onChange(() => {
    if (pending || !posters.shown) return
    pending = setTimeout(() => {
      pending = undefined
      posters.send({ type: 'hub-state', hub: hub.get() })
    }, PUSH_MS)
  })
  context.subscriptions.push({ dispose: () => { sub.dispose(); if (pending) clearTimeout(pending) } })
  // Runs with or without a panel open: the hook server takes the feed either way.
  context.subscriptions.push(hub.onHandoff(h => { void continueInFreshChat(h, workspace()) }))
  // A handed-off Claude chat runs exit; its terminal's shell would stay behind, so close that too.
  // A session can run in two processes at once (the Claude panel and a terminal), so every live one is tried.
  const livePids = (id: string) => hub.get().chats.filter(c => c.sessionId === id && c.live && c.pid).map(c => c.pid)
  context.subscriptions.push(hub.onClosing(id => {
    for (const pid of livePids(id)) void closeChatTerminal(pid, vscode.window.terminals)
  }))
  // A message sent from Switchboard (panel, browser or phone): this window brings up the chat's terminal if it holds it, keeping focus where it is.
  context.subscriptions.push(hub.onPrompted(async id => {
    for (const pid of livePids(id)) (await chatTerminal(pid, vscode.window.terminals))?.show(true)
  }))
  // The chat could not run exit itself: end its process, but only while it is idle, never mid-turn.
  // Read fresh: the cached row may be minutes old, and its pid reused.
  // Another window asked this one to start or stop a dev server; the folder is checked again here.
  context.subscriptions.push(hub.onDev(async d => {
    await refreshChats().catch(() => {})
    const row = knownDev(devRows(devFolders(), readDev, [], null), d.folder)
    if (!row) return
    if (d.kind === 'start') runDev(row)
    else stopDev(row.project)
  }))
  context.subscriptions.push(vscode.window.onDidCloseTerminal(t => {
    const s = served.get(t.name)
    if (!s) return
    served.delete(t.name)
    void serve(s.port, s.https, false).then(refreshHub)
  }))
  context.subscriptions.push(hub.onCloseFailed(async id => {
    const known = hub.get().chats.find(c => c.sessionId === id)
    const chat = (await readChats().catch(() => [])).find(c => c.sessionId === id)
    if (!known || !chat?.live || chat.status !== 'idle' || chat.pid !== known.pid) return
    try { process.kill(chat.pid, 'SIGTERM') } catch { /* already gone */ }
    setTimeout(refreshHub, 800)
  }))
}

/** The ask tool's server into ~/.claude/switchboard/ask, registered with claude once; never blocks activation. */
function setupAsk(ext: string): void {
  try {
    installAsk(path.join(ext, 'ask'), os.homedir(), server => {
      const c = claudeCall(['mcp', 'add', '--scope', 'user', 'switchboard', '--', 'node', server])
      execFile(c.cmd, c.args, { timeout: 30_000, shell: c.shell, windowsHide: true }, err => {
        if (err) log.warn('Ask tool not registered:', err.message)
        else log.info(`Ask tool registered: ${server}`)
      })
    })
  } catch (err) {
    log.warn('Ask tool not installed:', err)
  }
}

/** Bundled rules and roles into ~/.claude and ~/.codex. force (Re-sync now) writes even with the switch off. */
function syncKit(force = false): void {
  const on = hub.get().controls.switchboard.syncRules
  const write = on || force
  let note: string
  try {
    const hash = kitHash(rulesState.kit)
    const last = store?.get<SyncResult & { hash: string }>(RULES_KEY)
    const r = !force && on && last?.hash === hash ? last : syncRules({ home: os.homedir(), kit: rulesState.kit, write })
    if (write) void store?.update(RULES_KEY, { hash, note: r.note, ready: r.ready, changed: [] })
    rulesState.ready = r.ready
    note = write ? r.note : 'Rules and roles: sync off'
    if (write && r.changed.length) log.info(r.note)
  } catch (err) {
    note = `Rules and roles: could not sync (${(err as Error).message})`
    log.warn(note)
  }
  hub.set({ controls: { ...hub.get().controls, rulesNote: note } })
}

/** AWS statuses at most every ten minutes (each is an STS call), unless forced after a change; Chrome profiles and picks every time. */
async function refreshAws(force = false): Promise<void> {
  readSignIns()
  if (!force && Date.now() - awsAt < AWS_EVERY_MS) return
  awsAt = Date.now()
  hub.set({ aws: await awsProfiles() })
}

/** Every live window with its color, and this window's status bar item and title bar in its color. */
function refreshWindows(): void {
  const ws = workspace()
  let own = ws
  try { if (ws) own = fs.realpathSync(ws) } catch { /* keep the path as VS Code has it */ }
  const live = [...new Set([...readWindows().map(w => w.workspace), ...(own ? [own] : [])])]
  const colors = windowColors(live)
  hub.set({ windows: live.map(w => ({ workspace: w, name: path.basename(w), color: colors[w] })), thisWindow: own })
  if (own) paintWindow(own, colors[own])
}

function paintWindow(own: string, color: WindowColor): void {
  if (windowItem) {
    const light = [vscode.ColorThemeKind.Light, vscode.ColorThemeKind.HighContrastLight].includes(vscode.window.activeColorTheme.kind)
    windowItem.text = `$(circle-filled) ${path.basename(own)}`
    windowItem.color = SHADES[color][light ? 'light' : 'dark']
    windowItem.tooltip = `${path.basename(own)} window: open Switchboard`
    windowItem.show()
  }
  if (!windowStore) return
  // Merged into the workspace's colorCustomizations; a key set by hand is never touched (colors.ts titleBar).
  const on = vscode.workspace.getConfiguration('switchboard').get('colorTitleBar', true)
  const config = vscode.workspace.getConfiguration('workbench')
  const r = titleBar(config.inspect<Record<string, unknown>>('colorCustomizations')?.workspaceValue, windowStore.get<Record<string, string>>(TITLE_KEY) ?? {}, on ? titleBarColors(color) : {})
  if (!r) return
  config.update('colorCustomizations', Object.keys(r.next).length ? r.next : undefined, vscode.ConfigurationTarget.Workspace).then(
    () => windowStore?.update(TITLE_KEY, r.wrote),
    err => log.warn('Could not color the title bar:', err))
}

/** Chrome profiles, the profile picked per project, and this window's AWS_PROFILE for its terminals. */
function readSignIns(): void {
  const { projects, browsers } = readPrefs()
  hub.set({ signIns: { chrome: readChrome(), projects, browsers, ...(workspace() ? { window: workspace() } : {}), apps: readLogins(), links: readLinks() } })
  applyWindowAws(projects, browsers)
}

/** Each workspace folder's terminals get AWS_PROFILE for the profile picked for it; Use default takes it away. */
function applyWindowAws(projects: Record<string, string>, browsers: Record<string, string>): void {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const scoped = envs?.getScoped({ workspaceFolder: folder })
    const p = projects[folder.uri.fsPath]
    if (!scoped) continue
    // CLI sign-ins (aws login, gh auth, vercel login) open the project's Chrome profile through BROWSER.
    const b = browsers[folder.uri.fsPath]
    if (b) {
      if (scoped.get('SWITCHBOARD_CHROME_DIR')?.value !== b) { scoped.replace('BROWSER', writeOpenChrome()); scoped.replace('SWITCHBOARD_CHROME_DIR', b) }
    } else if (scoped.get('SWITCHBOARD_CHROME_DIR')) { scoped.delete('BROWSER'); scoped.delete('SWITCHBOARD_CHROME_DIR') }
    if (p && validProfileName(p)) {
      scoped.description = `Switchboard: AWS profile ${p} for this window`
      if (scoped.get('AWS_PROFILE')?.value !== p) scoped.replace('AWS_PROFILE', p)
    } else if (scoped.get('AWS_PROFILE')) scoped.delete('AWS_PROFILE')
  }
}

/** The Sign-ins panel's commands; a string is why one was refused. */
function awsCommand(m: Extract<WebviewToExtensionMessage, { type: `hub-aws-${string}` }>): string | undefined {
  const known = (p: string) => validProfileName(p) && parseAwsConfig(readAwsConfig()).some(s => s.name === p)
  const after = () => { void refreshAws(true) }
  switch (m.type) {
    case 'hub-aws-check': after(); return undefined
    case 'hub-aws-login':
      if (!known(m.profile)) return `no AWS profile named ${m.profile}`
      return awsLogin(m.profile, m.chrome ?? profileFor(readPrefs().browsers, workspace() ?? ''), after)
    case 'hub-aws-add':
      return addAwsProfile(m.profile, m.region, m.chrome, hub.get().signIns.chrome.map(c => c.dir)) ?? awsLogin(m.profile, m.chrome, after)
    case 'hub-aws-default': {
      const next = known(m.profile) ? makeDefault(readAwsConfig(), m.profile) : undefined
      if (!next) return `no AWS profile named ${m.profile}`
      writeAwsConfig(next)
      after()
      return undefined
    }
    case 'hub-aws-label': {
      const row = hub.get().aws.find(a => a.name === m.profile)
      if (!row || !known(m.profile)) return `no AWS profile named ${m.profile}`
      const key = row.account ?? `profile:${row.name}`
      const label = m.label.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80)
      const { [key]: _old, ...rest } = readLabels()
      writeLabels(label ? { ...rest, [key]: label } : rest)
      hub.set({ aws: hub.get().aws.map(a => (a.account ?? `profile:${a.name}`) === key ? { ...a, label: label || undefined } : a) })
      return undefined
    }
    case 'hub-aws-delete': {
      if (!known(m.profile)) return `no AWS profile named ${m.profile}`
      const problem = deleteAwsProfile(m.profile)
      if (problem) return problem
      // Windows that picked it fall back to the default.
      const prefs = readPrefs()
      const { [m.profile]: _c, ...chrome } = prefs.chrome
      writePrefs({ ...prefs, chrome, projects: Object.fromEntries(Object.entries(prefs.projects).filter(([, p]) => p !== m.profile)) })
      readSignIns()
      hub.set({ aws: hub.get().aws.filter(a => a.name !== m.profile) })
      after()
      return undefined
    }
    case 'hub-aws-window': {
      const ws = workspace()
      if (!ws) return 'this window has no folder open'
      if (m.profile !== null && !known(m.profile)) return `no AWS profile named ${m.profile}`
      const prefs = readPrefs()
      const { [ws]: _was, ...rest } = prefs.projects
      writePrefs({ ...prefs, projects: m.profile === null ? rest : { ...rest, [ws]: m.profile } })
      readSignIns()
      return undefined
    }
  }
}

/** Saved web logins: the change is written to logins.json; Sign in then opens the login in its Chrome profile. */
function loginCommand(m: LoginCommand | LinkCommand): string | undefined {
  const apps = readLogins(), links = readLinks(LOGINS, apps)
  if (m.type === 'hub-login-link') {
    const folders = [...hub.get().projects.map(p => p.path), ...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)]
    const next = applyLink(apps, links, m, folders)
    if (typeof next === 'string') return next
    writeLogins(apps, LOGINS, next)
    hub.set({ signIns: { ...hub.get().signIns, links: next } })
    return undefined
  }
  // Sign in with no id opens the project's pick for the app, else the app's active login.
  const app = m.type === 'hub-login-open' && m.id === undefined ? apps.find(a => a.id === m.app) : undefined
  const c = app && m.type === 'hub-login-open' ? { ...m, id: loginFor(app, links, m.folder) } : m
  const next = applyLogin(apps, c, undefined, hub.get().signIns.chrome.map(x => x.dir))
  if (typeof next === 'string') return next
  writeLogins(next, LOGINS, links)
  hub.set({ signIns: { ...hub.get().signIns, apps: next, links: pruneLinks(links, next) } })
  if (c.type !== 'hub-login-open') return undefined
  const row = next.find(a => a.id === c.app)?.logins.find(l => l.id === c.id)
  // The login's own Chrome profile holds its account; without one, the project's browser.
  return row ? openLogin(row.url, row.chrome ?? (c.folder ? profileFor(readPrefs().browsers, c.folder) : undefined)) : 'no such login'
}

/** The browser a project's links and terminal sign-ins open in; null forgets it. */
function browserCommand(m: Extract<WebviewToExtensionMessage, { type: 'hub-browser' }>): string | undefined {
  const folders = [...hub.get().projects.map(p => p.path), ...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)]
  if (!folders.includes(m.folder)) return 'that folder is not in the project list'
  if (m.chrome && !hub.get().signIns.chrome.some(c => c.dir === m.chrome)) return 'That Chrome profile is not in Chrome\'s list'
  const prefs = readPrefs()
  const { [m.folder]: _was, ...rest } = prefs.browsers
  writePrefs({ ...prefs, browsers: m.chrome === null ? rest : { ...rest, [m.folder]: m.chrome } })
  readSignIns()
  return undefined
}

/** The chats (every AI), and what follows from them: Codex terminals, closing handed-off Codex chats, Codex handoffs. */
async function refreshChats(): Promise<void> {
  const { chats, ais } = await readAis()
  bindCodexTerminals(chats)
  hub.set({ chats: chats.map(c => ({ ...c, takes: hub.takes(c, codexTied(c.sessionId)) })), ais })
  void clearGoneChats().catch(err => log.warn('To-do lists failed:', err))
  for (const c of idleHandedOff(chats, closingCodex)) {
    closingCodex.delete(c.sessionId)
    if (!closeCodexChat(c.sessionId)) log.info(`No terminal is tied to the handed-off Codex chat ${c.sessionId.slice(0, 8)}; it stays open`)
  }
  await codexHandoffs(chats)
}

/**
 * A full Codex chat has no usage mod to write its note: Switchboard writes one (folder,
 * branch, plan, last prompt) and starts the next Codex chat on it, once per chat.
 */
async function codexHandoffs(chats: ChatRow[]): Promise<void> {
  const ws = workspace()
  const due = dueForHandoff(chats, handedOff, ws, Date.now(), codexBusySince)
  const held = fullCodex(chats, handedOff, ws).filter(c => !due.includes(c))
  hub.setCodexWaits(held.map(c => ({ sessionId: c.sessionId, tasks: 1, next: `v${chainVersion(c.name) + 1}`, since: codexBusySince.get(c.sessionId) ?? Date.now() })))
  for (const c of due) {
    codexBusySince.delete(c.sessionId)
    handedOff.add(c.sessionId)
    void store?.update(HANDED_KEY, [...handedOff].slice(-200))
    const project = path.basename(c.cwd)
    const plan = await newestPlanFile(c.cwd)
    const file = codexFiles.get(c.sessionId)
    const prompt = file ? lastCodexPrompt(await rolloutLines(file)) : undefined
    const note = path.join(os.homedir(), '.claude', 'handoffs', project, handoffFile(project, planLabel(plan), c.sessionId))
    try {
      await fs.promises.mkdir(path.dirname(note), { recursive: true })
      await fs.promises.writeFile(note, codexNote({ project, cwd: c.cwd, branch: headBranch(c.cwd) ?? 'unknown', plan, prompt }))
    } catch (err) {
      // Unmarked, so the next refresh tries again.
      handedOff.delete(c.sessionId)
      log.warn('A Codex handoff note could not be written:', err)
      continue
    }
    if (await continueInFreshChat({ sessionId: c.sessionId, cwd: c.cwd, note, plan, name: c.name, ai: 'codex' }, ws)) closingCodex.add(c.sessionId)
  }
}

// The chat whose changes a panel asked for; ponytail: one for all views, the last asked wins. Per view if two views ever disagree.
let watched: string | undefined

/** The watched chat's uncommitted changes, read again with each near refresh (onTick); an idle chat's at most once a minute. */
async function refreshChanges(onTick = false): Promise<void> {
  const id = watched
  const chat = id ? hub.get().chats.find(c => c.sessionId === id) : undefined
  if (!id || !chat?.cwd || !fs.existsSync(chat.cwd)) { if (hub.get().changes) hub.set({ changes: null }); return }
  if (onTick && chat.status === 'idle' && hub.get().changes?.sessionId === id && Date.now() - changesAt < CHANGES_IDLE_MS) return
  changesAt = Date.now()
  const root = await repoRoot(chat.cwd)
  const [files, repo] = await Promise.all([readChanges(chat.cwd), root ? readRepo(root, await ghPath()) : undefined])
  if (watched !== id) return
  const was = hub.get().repo
  const keep = was?.sessionId === id ? { busy: was.busy, result: was.result } : {}
  hub.set({ changes: { sessionId: id, cwd: chat.cwd, files, at: Date.now() }, repo: repo ? { ...repo, sessionId: id, ...keep } : null })
}

// One git op per repo at a time.
const gitBusy = new Set<string>()

/** A Git panel button: the repo comes from the chat's own folder, never from the page. */
async function runGit(m: Extract<WebviewToExtensionMessage, { type: 'hub-git' }>): Promise<boolean | string> {
  const chat = hub.get().chats.find(c => c.sessionId === m.sessionId)
  const root = chat?.cwd && fs.existsSync(chat.cwd) ? await repoRoot(chat.cwd) : undefined
  if (!root) return refuse('that chat\'s folder is not in a git repo')
  if (gitBusy.has(root)) return refuse('another git command is still running in this repo')
  gitBusy.add(root)
  const mark = (patch: object) => { const r = hub.get().repo; if (r?.sessionId === m.sessionId) hub.set({ repo: { ...r, ...patch } }) }
  mark({ busy: m.op })
  try {
    const { sessionId: _s, type: _t, ...cmd } = m
    const r = await gitOp(root, cmd, await ghPath())
    if (r.open) void vscode.env.openExternal(vscode.Uri.parse(r.open))
    mark({ busy: undefined, result: { text: r.text, ok: r.ok, at: Date.now() } })
    return r.ok || refuse(r.text)
  } catch (err) {
    mark({ busy: undefined, result: { text: (err as Error).message, ok: false, at: Date.now() } })
    return refuse((err as Error).message)
  } finally {
    gitBusy.delete(root)
    watched = m.sessionId
    void refreshChanges().catch(err => log.warn('Changes failed:', err))
    refreshHub()
  }
}

/** A to-do change, only for a project the panel lists; run starts a chat on the items or sends them to one. */
async function todoCommand(m: Extract<WebviewToExtensionMessage, { type: `hub-todo-${string}` }>): Promise<boolean | string> {
  const list = hub.get().todos?.[m.path]
  if (!list) return refuse('that project has no to-do list here')
  try {
    if (m.type === 'hub-todo-add') await changeTodo(m.path, d => addTodo(d, m.text))
    else if (m.type === 'hub-todo-edit') await changeTodo(m.path, d => editTodo(d, m.id, m.text))
    else if (m.type === 'hub-todo-remove') await changeTodo(m.path, d => removeItem(d, m.id))
    else if (m.type === 'hub-todo-restore') await changeTodo(m.path, d => restoreTicked(d, m.id))
    else if (m.type === 'hub-todo-sync') await setTodoSync(m.path, m.on)
    else if (m.type === 'hub-todo-replace') {
      const why = await replaceRemoteTodo(m.path, m.remote)
      if (why) return refuse(`could not replace the remote list (${why})`)
    }
    else {
      const items = runOrder(list.todo, m.ids)
      if (!items.length) return refuse('those to-do items are gone')
      const text = runMessage(items)
      const mark = (chat: string | undefined) => changeTodo(m.path, d => items.reduce((out, t) => startTodo(out, t.id, chat), d))
      if (m.to) {
        if (text.length > 4000) return refuse('too many items for one message; run them in a new chat')
        const sent = await sendToChat(m.to, text)
        if (sent !== true) return sent
        await mark(m.to)
        return true
      }
      const sessionId = randomUUID()
      await mark(sessionId)
      void newChat(m.path, text, false, undefined, 'claude', undefined, sessionId, true).then(problem => {
        if (!problem) return
        refuse(problem)
        void mark(undefined).catch(() => {})
      })
    }
    return true
  } catch (err) {
    return refuse(`could not change the to-do list (${(err as Error).message})`)
  }
}

/** Everything the Hub shows from Claude Code's settings; also run on refresh, so edits made elsewhere show up. */
function readSettings(): void {
  const read = readSettingsFile(SETTINGS_PATH)
  if (!read.ok) return
  const s = read.settings
  const controls = hub.get().controls
  hub.set({
    rc: { ...hub.get().rc, atStartup: s.remoteControlAtStartup === true },
    keep: { ...hub.get().keep, autoCompact: s.autoCompactEnabled !== false, window: typeof s.autoCompactWindow === 'number' ? s.autoCompactWindow : undefined, autoContinue: s.autoContinueAtUsageLimit === true },
    controls: { ...controls, claude: readControls(s), switchboard: { ...controls.switchboard, hooks: hasAgentFlowHook(s) }, statusLineReady: statusLineCommand() !== undefined },
  })
}

/** One whitelisted change to Claude Code's settings, written whole and atomically. */
function writeSetting(key: string, value: unknown): void {
  const patch = controlPatch(key, value, statusLineCommand())
  const read = readSettingsFile(SETTINGS_PATH)
  if (!patch || !read.ok) return
  writeJsonAtomic(SETTINGS_PATH, applyPatch(read.settings, patch))
  readSettings()
}

/** extension.ts hands over its status bar button; the Controls switch shows or hides it. */
export function bindStatusBar(item: vscode.StatusBarItem): void {
  statusBar = item
  applyStatusBar()
}

function applyStatusBar(): void {
  if (hub.get().controls.switchboard.statusBar) statusBar?.show()
  else statusBar?.hide()
}

/** Switchboard's own switches. Hooks live in Claude Code's settings; the rest in globalState. */
async function setSwitchboard(key: SwitchboardKey, value: boolean | number | string | null): Promise<void> {
  if (key === 'hooks') {
    if (value === true) await configureClaudeHooks()
    else {
      const read = readSettingsFile(SETTINGS_PATH)
      if (read.ok) writeJsonAtomic(SETTINGS_PATH, removeAgentFlowHooks(read.settings))
    }
    readSettings()
    return
  }
  if (key === 'name') value = cleanName(value)
  const valid = key === 'idleMinutes' ? value === null || [5, 15, 30, 60].includes(value as number) : key === 'name' || typeof value === 'boolean'
  if (!valid) return
  const controls = hub.get().controls
  const switchboard = { ...controls.switchboard, [key]: value }
  const { hooks: _fromSettings, ...kept } = switchboard
  void store?.update(CONTROLS_KEY, kept)
  hub.set({ controls: { ...controls, switchboard } })
  if (key === 'statusBar') applyStatusBar()
  if (key === 'syncRules') syncKit()
  // Turning it back on rewrites the note, so one deleted by hand comes back.
  if (key === 'accessNote' && value) { forgetAccessNote(); keepAccessNote() }
}

/** Writes remoteControlAtStartup; on, connects every live chat that is not connected yet. Off leaves connected chats alone. */
export function setRemoteControl(on: boolean): string | undefined {
  const read = readSettingsFile(SETTINGS_PATH)
  if (!read.ok) return `could not read ${SETTINGS_PATH} (${read.error}), so it was left alone`
  writeJsonAtomic(SETTINGS_PATH, { ...read.settings, remoteControlAtStartup: on })
  const targets = on ? rcTargets(hub.get().chats) : []
  for (const id of targets) hub.queue(id, { kind: 'rc' })
  hub.set({ rc: { atStartup: on, requestedAt: on ? Date.now() : undefined } })
  log.info(`Remote Control at startup ${on ? 'on' : 'off'}; connecting ${targets.length} chat(s)`)
  return undefined
}

/** Shows a refusal on the Mac and hands it back, so /hub/command answers 400 with it. */
function refuse(problem: string): string {
  void vscode.window.showWarningMessage(`Switchboard: ${problem}.`)
  return problem
}

/** A prompt for a running chat: queued for its usage mod, or typed into Codex. */
function sendToChat(sessionId: string, message: string): true | string | Promise<true | string> {
  const text = message.trim().slice(0, 4000)
  const chat = hub.get().chats.find(c => c.sessionId === sessionId)
  if (!text || !chat) return refuse(text ? 'that chat is not running' : 'the message is empty')
  if (!chat.live) return refuse('that chat is not running')
  if (chat.ai === 'codex') return sendToCodex(chat, text).then(problem => (problem ? refuse(problem) : true))
  if (!hub.takes(chat, false)) return refuse('that chat is not collecting messages (it is not running, or has no usage-meter mod); type in its terminal')
  hub.queue(chat.sessionId, { kind: 'prompt', text })
  return true
}

/** Handles the panel's hub messages; false for anything else, a string for why it was refused. */
export function handleHubMessage(m: WebviewToExtensionMessage): boolean | string | Promise<boolean | string> {
  switch (m.type) {
    case 'hub-refresh':
      // A manual refresh probes for the standalone app's page too.
      webAt = -Infinity
      refreshHub()
      void loadTodos(todoFolders(workspace()), true).catch(err => log.warn('To-do lists failed:', err))
      return true
    case 'hub-send':
      return sendToChat(m.sessionId, m.text)
    case 'hub-answer': {
      const chat = hub.get().chats.find(c => c.sessionId === m.sessionId)
      const ask = hub.get().progress.find(p => p.sessionId === m.sessionId)?.ask
      // The ask tool's question takes its answer over the hub, wherever the chat runs.
      if (ask?.via === 'hub' && ask.id === m.askId) {
        const problem = choiceProblem(ask, m.choice)
        if (problem) return refuse(problem)
        if (!answerQuestion(ask.id, m.choice)) return refuse('that prompt is already answered or gone')
        hub.answered(m.sessionId, ask.id)
        return true
      }
      if (!chat?.live || chat.ai === 'codex') return refuse('answer that chat in its terminal')
      if (!ask || ask.id !== m.askId) return refuse('that prompt is already answered or gone')
      const keys = askKeys(ask, m.choice)
      if (typeof keys === 'string') return refuse(keys)
      const claim = () => {
        if (hub.get().progress.find(p => p.sessionId === chat.sessionId)?.ask?.id !== ask.id) return false
        hub.answered(chat.sessionId, ask.id)
        return true
      }
      return answerInTerminal(chat.pid, keys, claim).then(problem => (problem ? refuse(problem) : true))
    }
    case 'hub-rc': {
      if (m.sessionId) {
        // The chat's rc command toggles, so a chat already in the asked state is left alone.
        const row = hub.get().chats.find(x => x.sessionId === m.sessionId)
        if (!(row && !!row.bridgeId === m.on)) hub.queue(m.sessionId, { kind: 'rc' })
        return true
      }
      const problem = setRemoteControl(m.on)
      return problem ? refuse(`Remote Control ${problem}`) : true
    }
    case 'hub-rc-server': {
      return rcServer(m.folder, m.on).then(problem => {
        setTimeout(refreshHub, 800)
        return problem ? refuse(problem) : true
      })
    }
    case 'hub-open-url':
      if (/^https?:\/\//.test(m.url)) void vscode.env.openExternal(vscode.Uri.parse(m.url))
      return true
    case 'hub-web':
      // Starts the browser app (the vsix's copy, else the agent-flow checkout's) when it is not running, with --lan for Phone; phone only wants the QR link.
      void ensureWeb(path.join(REPO_ROOTS[0], 'agent-flow'), m.phone === true, { bundle: path.join(extensionPath, 'dist', 'app', 'app.js'), version: extensionVersion }).then(async r => {
        if ('problem' in r) return void refuse(r.problem)
        hub.set({ webUrl: r.url, phoneUrls: await phoneUrls(r.url) })
        keepAccessNote()
        if (!m.phone) void vscode.env.openExternal(vscode.Uri.parse(r.url))
      })
      return true
    case 'hub-stop-server':
      void stopServer(m.pid, m.confirmed === true)
      return true
    case 'hub-toggle':
      void toggle(m.kind, m.name, m.enabled)
      return true
    case 'hub-setting':
      writeSetting(m.key, m.value)
      return true
    case 'hub-switchboard':
      void setSwitchboard(m.key, m.value)
      return true
    case 'hub-vscode':
      void vscode.commands.executeCommand(m.action === 'reload' ? 'workbench.action.reloadWindow' : 'workbench.action.restartExtensionHost')
      return true
    case 'hub-compact':
      hub.queue(m.sessionId, { kind: 'compact' })
      return true
    case 'hub-keep': {
      // onFull is taken from older clients and ignored: a full chat always continues fresh.
      if (m.freshBranch === undefined) return true
      void store?.update(KEEP_KEY, { freshBranch: m.freshBranch })
      hub.set({ keep: { ...hub.get().keep, freshBranch: m.freshBranch } })
      return true
    }
    case 'hub-open-project':
      openProject(m.path, m.newWindow)
      return true
    case 'hub-clone': {
      if (!cloneTarget(m.repo)) return refuse('give a GitHub repo as owner/repo or its github.com address')
      void cloneProject(m.repo, m.newWindow, REPO_ROOTS[0])
      return true
    }
    case 'hub-new-chat':
      // Naming the chat waits on a quick model call, so a refusal shows on the Mac but the route has already answered.
      void newChat(m.path, m.text, m.remote, m.branch, m.ai, m.tools).then(problem => { if (problem) refuse(problem) })
      return true
    case 'hub-pick-tools': {
      const goal = m.text.trim().slice(0, 2000)
      if (m.path && !hub.get().projects.some(p => p.path === m.path)) return refuse(`${m.path} is not in the project list`)
      if (goal) void pickTools(goal, m.path).catch(err => log.warn('Tool pick failed:', err))
      return true
    }
    case 'hub-chat-tools':
      void saveChatTools(m.sessionId, m.tools).catch(err => `could not save the chat's tools (${(err as Error).message})`).then(problem => { if (problem) refuse(problem) })
      return true
    case 'hub-focus-chat':
      focusChat(m.sessionId)
      return true
    case 'hub-star': {
      const s = hub.get()
      const chat = s.chats.find(c => c.sessionId === m.sessionId) ?? s.starred.find(c => c.sessionId === m.sessionId)
      writeStarred(toggleStar(readStarred(), { sessionId: m.sessionId, ai: m.ai, name: chat?.name ?? m.sessionId.slice(0, 8), cwd: chat?.cwd ?? '' }, m.on))
      refreshHub()
      return true
    }
    case 'hub-open-note': {
      const problem = openNote(m.sessionId)
      return problem ? refuse(problem) : true
    }
    case 'hub-resume': {
      return resumeChat(m.sessionId, m.ai).then(problem => {
        if (problem) return refuse(problem)
        // Back among the live chats: History stops hiding it.
        if (removeArchive(m.sessionId)) hub.set({ archive: readArchive() })
        return true
      })
    }
    case 'hub-changes':
      watched = m.sessionId
      void refreshChanges().catch(err => log.warn('Changes failed:', err))
      return true
    case 'hub-git':
      return runGit(m)
    case 'hub-open-diff':
      void openDiff(m.sessionId, m.file).then(problem => { if (problem) refuse(problem) })
      return true
    case 'hub-search': {
      const q = m.q.trim().slice(0, 100)
      hub.set({ search: q ? { q, hits: searchNotes(hub.get().archive, q) } : null })
      return true
    }
    case 'hub-aws-login':
    case 'hub-aws-add':
    case 'hub-aws-default':
    case 'hub-aws-label':
    case 'hub-aws-window':
    case 'hub-aws-delete':
    case 'hub-aws-check': {
      let problem: string | undefined
      try { problem = awsCommand(m) } catch (err) { problem = `could not change the AWS config (${(err as Error).message})` }
      return problem ? refuse(problem) : true
    }
    case 'hub-login-app-add':
    case 'hub-login-add':
    case 'hub-login-open':
    case 'hub-login-active':
    case 'hub-login-rename':
    case 'hub-login-delete':
    case 'hub-login-app-delete':
    case 'hub-login-link': {
      let problem: string | undefined
      try { problem = loginCommand(m) } catch (err) { problem = `could not save the login (${(err as Error).message})` }
      return problem ? refuse(problem) : true
    }
    case 'hub-browser': {
      let problem: string | undefined
      try { problem = browserCommand(m) } catch (err) { problem = `could not save the browser (${(err as Error).message})` }
      return problem ? refuse(problem) : true
    }
    case 'hub-kit-export': {
      const problem = exportKit(REPO_ROOTS[0])
      return problem ? refuse(problem) : true
    }
    case 'hub-setup':
      syncKit(true)
      void runSetup(extensionPath).catch(err => refuse(`Set up failed (${(err as Error).message})`))
      return true
    case 'hub-rules-sync':
      syncKit(true)
      return true
    case 'hub-role-model': {
      const problem = setRoleModel(path.join(os.homedir(), '.claude', 'agents'), m.role, m.model)
      if (problem) return refuse(problem)
      void installed().then(i => hub.set({ installed: i })).catch(err => log.warn('Roles failed:', err))
      return true
    }
    case 'hub-handoff':
      hub.handoffNow(m.sessionId)
      return true
    case 'hub-dev-start': {
      const row = devRequest(m.folder)
      if (!row) return refuse('that folder is not a project with a dev script')
      const home = devHome(readWindows(), row.folder, process.pid)
      // The window holding the project runs it; when that window does not answer, this one does.
      if (home) void postWindow(home, { kind: 'dev-start', folder: row.folder }).then(ok => { if (!ok) runDev(row) })
      else runDev(row)
      return true
    }
    case 'hub-dev-stop': {
      const row = devRequest(m.folder)
      if (!row) return refuse('that folder is not a project with a dev script')
      stopDev(row.project)
      for (const w of readWindows()) if (w.pid !== process.pid) void postWindow(w, { kind: 'dev-stop', folder: row.folder })
      // A server started by hand has no terminal anywhere: once the terminals had their chance, stop it by pid (the Mac asks first).
      setTimeout(async () => {
        const port = devRows([row.folder], () => row, await listServers(), null)[0]?.port
        const pid = hub.get().servers.find(s => s.port === port)?.pid
        if (pid) void stopServer(pid)
        else refreshHub()
      }, 3000)
      return true
    }
    case 'hub-awake':
      return setAwake(m.on).then(problem => {
        if (problem) return refuse(problem)
        hub.set({ awake: m.on })
        return true
      })
    case 'hub-device':
      return answerDevice(m.id, m.allow)
    case 'hub-todo-add':
    case 'hub-todo-edit':
    case 'hub-todo-remove':
    case 'hub-todo-restore':
    case 'hub-todo-run':
    case 'hub-todo-sync':
    case 'hub-todo-replace':
      return todoCommand(m)
    default:
      return false
  }
}

// Devices asking in through the browser app's sign-in page. Every window lists them in its panel;
// the prompt shows in the focused window, or in the next one to get focus, so a background window stays quiet.
const ASK_MS = 2 * 60_000
const asking = new Map<string, DeviceAsk & { port: number; at: number; shown?: boolean }>()

function listDevices(): void {
  for (const [id, d] of asking) if (Date.now() - d.at >= ASK_MS) asking.delete(id)
  hub.set({ devices: [...asking.values()].map(({ id, ip, ua, network }) => ({ id, ip, ua, network })) })
}

function promptDevices(): void {
  if (!vscode.window.state.focused) return
  listDevices()
  for (const d of asking.values()) {
    if (d.shown) continue
    d.shown = true
    void vscode.window.showInformationMessage(`A device wants to open Switchboard: ${d.ua} at ${d.ip} (${d.network})`, 'Allow', 'Deny')
      .then(pick => { if (pick) void answerDevice(d.id, pick === 'Allow') })
  }
}

/** Tells the browser app on loopback; it checks the token against the window files. */
async function answerDevice(id: string, allow: boolean): Promise<boolean | string> {
  const d = asking.get(id)
  if (!d) return refuse('that device was already answered, or gave up')
  asking.delete(id)
  listDevices()
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/device/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, allow, token: hub.token }), signal: AbortSignal.timeout(3000) })
    return r.ok || refuse(r.status === 409 ? 'that device was already answered, or gave up' : 'the browser app did not take the answer')
  } catch { return refuse('the browser app is not answering') }
}

// Dev terminals this window started and the tailscale serve each got, by terminal name; turned off when either ends.
// ponytail: lost on reload, so an entry outlives a reload until the same port is served again.
const served = new Map<string, { port: number; https: boolean }>()
const DEV_WAIT_MS = 60_000
const devFolders = () => [...readWindows().map(w => w.workspace), ...hub.get().chats.map(c => c.cwd)]

/** Dev rows for every device, Keep awake, and serve entries whose server has stopped turned off. */
async function refreshDev(servers: Awaited<ReturnType<typeof listServers>>): Promise<void> {
  for (const [name, s] of served) if (!servers.some(x => x.port === s.port)) { served.delete(name); await serve(s.port, s.https, false) }
  const [ts, awake] = await Promise.all([tailnet(), awakePid()])
  hub.set({ dev: devRows(devFolders(), readDev, servers, ts), tailscale: !!ts, awake: !!awake })
}

/** Starts the terminal here, then serves its port on the tailnet once it listens (within a minute). */
function runDev(row: { folder: string; project: string; command: string }): void {
  if (!startDev(row.folder, row.project, row.command)) return
  const name = `Dev: ${row.project}`
  const until = Date.now() + DEV_WAIT_MS
  const look = async () => {
    const terminal = vscode.window.terminals.find(t => t.name === name && t.exitStatus === undefined)
    if (!terminal || Date.now() > until) return
    const port = devRows([row.folder], () => row, await listServers(), null)[0]?.port
    if (!port) return void setTimeout(look, 2000)
    const ts = await tailnet()
    if (ts) { await serve(port, ts.https, true); served.set(name, { port, https: ts.https }) }
    refreshHub()
  }
  setTimeout(look, 2000)
}

/** The folder of a dev command a request names: only a listed project's. */
const devRequest = (folder: string) => knownDev(hub.get().dev, folder) ?? knownDev(devRows(devFolders(), readDev, [], null), folder)

/** confirmed: already asked elsewhere, so the Mac asks nothing. */
async function stopServer(pid: number, confirmed = false): Promise<void> {
  const server = hub.get().servers.find(s => s.pid === pid)
  if (!server) return
  if (!confirmed) {
    const pick = await vscode.window.showWarningMessage(`Stop ${server.command} on :${server.port}${server.folder ? ` (${server.folder})` : ''}?`, { modal: true }, 'Stop it')
    if (pick !== 'Stop it') return
  }
  try { process.kill(pid) } catch (err) { void vscode.window.showWarningMessage(`Switchboard: could not stop it (${(err as Error).message}).`) }
  setTimeout(refreshHub, 800)
}

/** Plugins and mods through the claude CLI; skills by moving their folder in or out of the archive. */
async function toggle(kind: 'mod' | 'plugin' | 'skill', name: string, enabled: boolean): Promise<void> {
  if (kind === 'skill') {
    const claude = path.join(os.homedir(), '.claude')
    const [from, to] = enabled ? ['skills-archive', 'skills'] : ['skills', 'skills-archive']
    if (!/^[\w.-]+$/.test(name)) return
    try {
      await fs.promises.mkdir(path.join(claude, to), { recursive: true })
      await fs.promises.rename(path.join(claude, from, name), path.join(claude, to, name))
    } catch (err) { void vscode.window.showWarningMessage(`Switchboard: could not move ${name} (${(err as Error).message}).`) }
  } else {
    if (!/^[\w.@-]+$/.test(name)) return
    await new Promise<void>(resolve => execFile(claudeBinary(), ['plugin', enabled ? 'enable' : 'disable', name], { timeout: 30000 }, err => {
      if (err) void vscode.window.showWarningMessage(`Switchboard: claude plugin ${enabled ? 'enable' : 'disable'} ${name} failed.`)
      resolve()
    }))
  }
  refreshHub()
}

/** VS Code's PATH often lacks ~/.local/bin, where the claude CLI lives. */
function claudeBinary(): string {
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  return fs.existsSync(local) ? local : 'claude'
}
