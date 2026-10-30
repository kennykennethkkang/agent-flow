/**
 * Claude Code runtime.
 *
 * Wires together the two event sources for a Claude Code session:
 *   1. Hook server — receives live events via a stdin-piped hook script
 *      configured in Claude's settings.json
 *   2. Session watcher — tails Claude Code's JSONL transcripts at
 *      ~/.claude/projects/<encoded>/<session>.jsonl
 *
 * Both sources can be active simultaneously; this runtime routes hook
 * events around the watcher when the watcher is already parsing that
 * session's transcript, to avoid duplicate events with divergent names
 * (hooks use agent_type+id; transcripts use description).
 */

import * as vscode from 'vscode'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { HookServer } from './hook-server'
import { SessionWatcher } from './session-watcher'
import { VisualizerPanel } from './webview-provider'
import { AgentEvent } from './protocol'
import {
  ORCHESTRATOR_NAME, HOOK_SERVER_NOT_STARTED,
} from './constants'
import { migrateHttpHooks } from './hooks-config'
import {
  writeDiscoveryFile, removeDiscoveryFile, ensureHookScript, hashWorkspace,
} from './discovery'
import { createLogger } from './logger'
import { hub } from './hub/hub-service'
import { dailySummary, notify } from './hub/notify'
import { newerVersion } from './hub/progress'
import { checkAsked } from './hub/coverage'
import { readWindows } from './hub/dev'
import { chatEnded, chatFinished } from './hub/todo'
import type { ChatProgress, ChatState } from './hub/types'
import { wireWatcherToPanel } from './session-runtime'
import type { AgentRuntime } from './session-runtime'

const log = createLogger('ClaudeRuntime')

/** Events the session watcher already owns end-to-end via the transcript parser.
 *  Letting hooks re-emit these would create duplicate nodes with divergent names
 *  (hook = agent_type-id, transcript = description). */
const SUBAGENT_LIFECYCLE_EVENTS = new Set<AgentEvent['type']>([
  'agent_spawn', 'subagent_dispatch', 'subagent_return', 'agent_complete',
])

/** Convert orchestrator agent_complete to agent_idle unless it's a session end.
 *  Prevents premature "completed" state during long API calls. */
function filterOrchestratorCompletion(event: AgentEvent): AgentEvent | null {
  if (event.type !== 'agent_complete') return event
  const agentName = event.payload?.agent ?? event.payload?.name
  const isOrchestrator = agentName === ORCHESTRATOR_NAME || !agentName
  if (!isOrchestrator) return event
  if (event.payload?.sessionEnd) return event
  return { ...event, type: 'agent_idle' }
}

export async function startClaudeRuntime(
  context: vscode.ExtensionContext,
): Promise<AgentRuntime> {
  // ─── Hook server ───────────────────────────────────────────────────────────
  const hookServer = new HookServer()
  context.subscriptions.push(hookServer)

  let hookPort: number
  try {
    hookPort = await hookServer.start()
  } catch (err) {
    log.error('Failed to start hook server:', err)
    hookPort = HOOK_SERVER_NOT_STARTED
  }

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

  if (hookPort === HOOK_SERVER_NOT_STARTED) {
    log.info('Hook server skipped (another instance owns the port) — using session watcher only')
  } else {
    log.info(`Hook server running on port ${hookPort}`)

    // Write discovery file so the hook script can find us.
    // The hook script reads this at invocation time — no port in settings.json.
    if (workspace) {
      ensureHookScript()
      writeDiscoveryFile(hookPort, workspace)
      hub.keepRetries(path.join(os.homedir(), '.claude', 'switchboard', `retries-${hashWorkspace(workspace)}.json`))
      migrateHttpHooks()
    }
  }

  // ─── Session watcher ───────────────────────────────────────────────────────
  const watcher = new SessionWatcher()
  context.subscriptions.push(watcher)

  const summary = setInterval(() => dailySummary(), 10 * 60_000)
  const reload = setInterval(() => reloadIfUpdated(context, context.extension.packageJSON.version as string), 60_000)
  context.subscriptions.push({ dispose: () => { clearInterval(summary); clearInterval(reload) } })

  // Route hook events → panel, but filter out events the watcher already owns
  if (hookPort !== HOOK_SERVER_NOT_STARTED) {
    context.subscriptions.push(hub.onEnded(p => { chatEnded(p).catch(err => log.warn('To-do update failed:', err)) }))
    hookServer.onRaw(({ payload, mirror }) => {
      const change = hub.hook(payload, Date.now(), mirror)
      if (!change) return
      // Only the owning window gets a change, so one window updates the project's To-do and Left lists.
      if (change.to.state === 'done' && change.from !== 'done') chatFinished(change.to).catch(err => log.warn('To-do update failed:', err))
      // A first Done waits for Jev's verdict on Kenneth's requests, so one notification says it all.
      if (change.to.state === 'done' && change.from !== 'done' && change.to.asked?.length) void withCoverage(change)
      else notify(change)
    })
    hookServer.onEvent((event) => {
      const panels = VisualizerPanel.ready()
      if (panels.length === 0) return
      const panel = { sendEvent: (e: AgentEvent) => { for (const p of panels) p.sendEvent(e) } }

      const eventSessionId = event.sessionId
      const watcherHandlesThis = eventSessionId
        ? watcher.isSessionActive(eventSessionId)
        : watcher.isActive()

      if (watcherHandlesThis) {
        const agentName = event.payload?.agent ?? event.payload?.name
        const isOrchestrator = agentName === ORCHESTRATOR_NAME || !agentName

        if (isOrchestrator) {
          const filtered = filterOrchestratorCompletion(event)
          if (filtered) panel.sendEvent(filtered)
          return
        }

        // Subagent lifecycle events — let the watcher handle these (it has
        // the correct display name from transcript/meta files)
        if (SUBAGENT_LIFECYCLE_EVENTS.has(event.type)) return

        // Subagent tool/message events — pass through
        panel.sendEvent(event)
        return
      }

      panel.sendEvent(event)
      for (const p of panels) p.setConnectionStatus('watching', `Claude Code hooks (:${hookPort})`)
    })
  }

  // Route watcher events + lifecycle → panel (with orchestrator completion filter)
  const wiring = wireWatcherToPanel(watcher, {
    sessionLabelPrefix: 'Claude',
    transformEvent: filterOrchestratorCompletion,
  })

  watcher.start()

  const connectionStatus = (): string => {
    if (hookPort > 0) return `Hooks :${hookPort} + session watcher`
    return 'Session watcher'
  }

  const dispose = (): void => {
    // Remove our discovery file so the hook script won't forward to a dead port.
    // Hook entries in settings.json are left intact — the command is stable
    // (node ~/.claude/agent-flow/hook.js) and the script handles dead instances
    // gracefully via PID checks. This avoids breaking multi-window setups and
    // means hooks survive VS Code restarts without reconfiguration.
    if (workspace) { removeDiscoveryFile(workspace) }
    wiring.dispose()
    hookServer.dispose()
    watcher.dispose()
  }

  return { mode: 'claude', watcher, connectionStatus, dispose }
}

/** Scores the chat's requests with Jev, shares them with every window, then notifies once. */
async function withCoverage(change: { from?: ChatState; to: ChatProgress }): Promise<void> {
  const p = change.to
  const scores = await checkAsked(p).catch(() => undefined)
  if (scores) {
    const ev = { session_id: p.sessionId, cwd: p.cwd, hook_event_name: 'SwitchboardCovered', scores }
    hub.hook(ev)
    const body = JSON.stringify(ev)
    for (const w of readWindows().filter(w => w.pid !== process.pid)) {
      void fetch(`http://127.0.0.1:${w.port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-switchboard-mirror': '1' }, body, signal: AbortSignal.timeout(2000) }).catch(() => undefined)
    }
  }
  notify({ ...change, to: hub.get().progress.find(x => x.sessionId === p.sessionId) ?? p })
}

/** A newer Switchboard installed: reload this window once none of its own chats is mid-turn, so nothing in flight is lost. */
function reloadIfUpdated(context: vscode.ExtensionContext, running: string): void {
  const dir = path.join(os.homedir(), '.vscode', 'extensions')
  let newest = running
  try {
    let obsolete: Record<string, unknown> = {}
    try { obsolete = JSON.parse(fs.readFileSync(path.join(dir, '.obsolete'), 'utf8')) } catch { /* none */ }
    for (const n of fs.readdirSync(dir)) {
      const v = /^kennykennethkkang\.switchboard-(\d+\.\d+\.\d+)$/.exec(n)?.[1]
      if (v && !obsolete[n] && newerVersion(v, newest)) newest = v
    }
  } catch { return }
  // Once per version: a copy that will not load must not reload the window every minute.
  if (newest === running || context.globalState.get('reloadedFor') === newest) return
  const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
  const busy = hub.get().progress.some(p => p.state === 'working' && roots.some(r => p.cwd === r || p.cwd.startsWith(r + path.sep)))
  if (!busy) void context.globalState.update('reloadedFor', newest).then(() => vscode.commands.executeCommand('workbench.action.reloadWindow'))
}
