import * as vscode from 'vscode'
import { VisualizerPanel } from './webview-provider'
import { JsonlEventSource } from './event-source'
import { WebviewToExtensionMessage } from './protocol'
import { startClaudeRuntime } from './claude-runtime'
import { startCodexRuntime } from './codex-runtime'
import { promptHookSetupIfNeeded, configureClaudeHooks, isDisable1MContext } from './hooks-config'
import { createLogger } from './logger'
import { startHub, addHubPoster, handleHubMessage, bindStatusBar, hubViewShown, KIT_DIR } from './hub/hub-panel'
import { startSelfUpdate } from './hub/self-update'
import type { AgentRuntime, AgentRuntimeMode } from './session-runtime'
import { withSkipShell } from './hub/controls'
import { orphanTab } from './orphan-tab'

const log = createLogger('Extension')

type ConfiguredRuntimeMode = AgentRuntimeMode | 'auto'

// Time VS Code gets to revive a restored tab before it counts as left behind.
const ORPHAN_CHECK_MS = 2000

let eventSource: JsonlEventSource | undefined
let runtimes: AgentRuntime[] = []

function readConfiguredMode(): ConfiguredRuntimeMode {
  const raw = vscode.workspace.getConfiguration('agentVisualizer').get<string>('runtime', 'auto')
  return raw === 'claude' || raw === 'codex' ? raw : 'auto'
}

interface StartRuntimesResult {
  runtimes: AgentRuntime[]
  failures: AgentRuntimeMode[]
}

async function startRuntimes(
  mode: ConfiguredRuntimeMode,
  context: vscode.ExtensionContext,
): Promise<StartRuntimesResult> {
  const runtimes: AgentRuntime[] = []
  const failures: AgentRuntimeMode[] = []
  if (mode === 'claude' || mode === 'auto') {
    log.info('Starting Claude runtime...')
    try { runtimes.push(await startClaudeRuntime(context)) }
    catch (err) { log.error('Claude runtime failed to start:', err); failures.push('claude') }
  }
  if (mode === 'codex' || mode === 'auto') {
    log.info('Starting Codex runtime...')
    try { runtimes.push(startCodexRuntime(context)) }
    catch (err) { log.error('Codex runtime failed to start:', err); failures.push('codex') }
  }
  return { runtimes, failures }
}

export async function activate(context: vscode.ExtensionContext) {
  log.info('Extension activated')

  // The hub and the Activity Bar view first: a click on the Switchboard icon resolves the view at once,
  // without waiting for the session runtimes below to start.
  startHub(context)
  startSelfUpdate(context, KIT_DIR)

  // Activity Bar icon: VS Code can only open a sidebar view from it, so the view opens Switchboard as an
  // editor tab, which has the room, and closes the sidebar again.
  const openEditor = () => {
    wirePanel(VisualizerPanel.create(context.extensionUri, vscode.ViewColumn.One))
    promptHookSetupIfNeededForClaude(context)
  }
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VisualizerPanel.sidebarViewType, {
      resolveWebviewView(view: vscode.WebviewView) {
        view.webview.html = '<p style="padding: 8px; color: var(--vscode-foreground); font-family: var(--vscode-font-family)">Switchboard opens in the editor.</p>'
        // Explorer is left as the sidebar's view, so Cmd+B opens Explorer instead of bouncing back here.
        const handOff = async () => {
          if (!view.visible) return
          await vscode.commands.executeCommand('workbench.view.explorer')
          await vscode.commands.executeCommand('workbench.action.closeSidebar')
          openEditor()
        }
        view.onDidChangeVisibility(() => void handOff())
        void handOff()
      },
    }),
  )


  const mode = readConfiguredMode()
  log.info(`Runtime mode: ${mode}`)
  const { runtimes: started, failures } = await startRuntimes(mode, context)
  runtimes = started
  log.info(`Active runtimes: ${runtimes.map(r => r.mode).join(', ') || 'none'}`)

  // Surface startup failures to the user — the log-only path leaves them
  // staring at a "disconnected" visualizer with no explanation.
  if (runtimes.length === 0 && failures.length > 0) {
    vscode.window.showWarningMessage(
      `Switchboard: ${failures.join(' and ')} runtime${failures.length > 1 ? 's' : ''} failed to start. See the Output panel for details.`,
    )
  } else if (failures.length > 0) {
    log.info(`Partial startup — ${failures.join(', ')} failed but ${runtimes.map(r => r.mode).join(', ')} active`)
  }

  // On screen unless turned off in Controls, so the panel never has to be found through the palette.
  const button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0)
  button.text = '$(pulse) Switchboard'
  button.tooltip = 'Open Switchboard'
  button.command = 'agentVisualizer.open'
  bindStatusBar(button)
  context.subscriptions.push(button)

  // A terminal with focus sends keys to its shell, so Cmd+Alt+A would never reach VS Code while a chat runs
  // in one. Listing the command in commandsToSkipShell (user settings, added once, others kept) lets it through.
  const term = vscode.workspace.getConfiguration('terminal.integrated')
  const skip = withSkipShell(term.inspect<string[]>('commandsToSkipShell')?.globalValue, 'agentVisualizer.open')
  if (skip) term.update('commandsToSkipShell', skip, vscode.ConfigurationTarget.Global).then(
    () => log.info('Added agentVisualizer.open to terminal.integrated.commandsToSkipShell'),
    err => log.warn('Could not update terminal.integrated.commandsToSkipShell:', err))

  // ─── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.open', openEditor),
  )

  // The sidebar's title button: the same Switchboard, in an editor tab.
  context.subscriptions.push(vscode.commands.registerCommand('agentVisualizer.openInEditor', () => vscode.commands.executeCommand('agentVisualizer.open')))

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.openToSide', () => {
      const panel = VisualizerPanel.create(context.extensionUri, vscode.ViewColumn.Beside)
      wirePanel(panel)
      promptHookSetupIfNeededForClaude(context)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.connectToAgent', async () => {
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(radio-tower) Claude Code Hooks', description: 'Auto-configure hooks for live streaming', value: 'hooks' },
          { label: '$(file) Watch JSONL File', description: 'Watch a file for agent events', value: 'jsonl' },
          { label: '$(play) Mock Data', description: 'Use built-in demo scenario', value: 'mock' },
        ],
        { placeHolder: 'Select event source' },
      )

      if (!choice) { return }

      if (choice.value === 'hooks') {
        await configureClaudeHooks()
      } else if (choice.value === 'jsonl') {
        const fileUri = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { 'JSONL Files': ['jsonl', 'json', 'ndjson'] },
          title: 'Select agent event log file',
        })

        if (fileUri?.[0]) {
          connectToJsonl(fileUri[0].fsPath, context)
        }
      } else if (choice.value === 'mock') {
        for (const panel of VisualizerPanel.all()) {
          panel.postMessage({ type: 'config', config: { mode: 'replay', autoPlay: true, showMockData: true } })
        }
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.configureHooks', async () => {
      await configureClaudeHooks()
    }),
  )

  // ─── Serializer (restore panel on VS Code restart) ─────────────────────────

  vscode.window.registerWebviewPanelSerializer(VisualizerPanel.viewType, {
    async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
      const panel = VisualizerPanel.revive(webviewPanel, context.extensionUri)
      if (!panel) return
      wirePanel(panel)
      promptHookSetupIfNeededForClaude(context)
    },
  })

  // A tab left over from an earlier extension host is replaced with a live one. Checked a moment after
  // activation and after each tab switch, so a tab VS Code is still reviving gets the chance first.
  let check: NodeJS.Timeout | undefined
  const replaceOrphan = () => {
    if (check) return
    check = setTimeout(() => {
      check = undefined
      const tab = orphanTab(vscode.window.tabGroups.all.flatMap(g => g.tabs), VisualizerPanel.tabColumns())
      if (!tab) return
      log.info('Replacing a Switchboard tab left by the previous extension host')
      void vscode.window.tabGroups.close(tab).then(() => wirePanel(VisualizerPanel.create(context.extensionUri, tab.group.viewColumn, true)))
    }, ORPHAN_CHECK_MS)
  }
  replaceOrphan()
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(replaceOrphan), { dispose: () => clearTimeout(check) })
}

/** Only prompt for Claude hook setup if a Claude runtime is active —
 *  otherwise a Codex-only user would see an irrelevant prompt. */
function promptHookSetupIfNeededForClaude(context: vscode.ExtensionContext): void {
  if (runtimes.some(r => r.mode === 'claude')) {
    promptHookSetupIfNeeded(context)
  }
}

function collectActiveSessions(): ReturnType<AgentRuntime['watcher']['getActiveSessions']> {
  const all: ReturnType<AgentRuntime['watcher']['getActiveSessions']> = []
  for (const r of runtimes) all.push(...r.watcher.getActiveSessions())
  return all
}

function replaySessions(sessionIds: string[]): void {
  for (const r of runtimes) {
    const ownIds = r.watcher.getActiveSessions()
      .map(s => s.id)
      .filter(id => sessionIds.includes(id))
    if (ownIds.length > 0) r.watcher.replaySessionStart(ownIds)
  }
}

function combinedConnectionStatus(): string {
  if (runtimes.length === 0) return 'disconnected'
  return runtimes.map(r => r.connectionStatus()).join(' + ')
}

function wirePanel(panel: VisualizerPanel): void {
  if (panel.isWired) { return }
  panel.markWired()
  let readyHandled = false
  panel.onCommand((message: WebviewToExtensionMessage) => {
    switch (message.type) {
      case 'ready':
        if (readyHandled) { return }
        readyHandled = true
        log.info('Webview ready')
        // Allow events to flow before replay — replay emits through the
        // same onEvent listener, and it's synchronous so no live events
        // can interleave. Events before this point were gated (dropped),
        // and replayExistingContent covers them from the JSONL file.
        panel.markReady()
        // Clear stale webview state from any previous panel instance
        panel.postMessage({ type: 'reset', reason: 'panel-reopened' })
        // Send environment-derived config (e.g. CLAUDE_CODE_DISABLE_1M_CONTEXT)
        if (isDisable1MContext()) {
          panel.postMessage({ type: 'config', config: { disable1MContext: true } })
        }
        // Report current connection status and replay active sessions
        // Send session list FIRST so the webview selects a session
        // before replay events arrive (otherwise they have no selected
        // session to match and are only buffered, not delivered).
        const sessions = collectActiveSessions()
        if (sessions.length > 0) {
          panel.postMessage({ type: 'session-list', sessions })
          VisualizerPanel.replayTo(panel, () => replaySessions(sessions.map(s => s.id)))
        }
        panel.setConnectionStatus('watching', combinedConnectionStatus())
        panel.onDidDispose(addHubPoster(m => panel.postMessage(m), () => panel.visible))
        // A hidden view gets no hub pushes and stops its animation; shown again, it gets the current state at once.
        panel.onDidChangeVisible(visible => {
          panel.postMessage({ type: 'hub-visible', visible })
          if (visible) hubViewShown()
        })
        break

      case 'request-connect':
        vscode.commands.executeCommand('agentVisualizer.connectToAgent')
        break

      case 'request-disconnect':
        disconnectEventSource()
        panel.setConnectionStatus('disconnected', '')
        break

      case 'open-file':
        handleOpenFile(message.filePath, message.line)
        break

      case 'log': {
        const webviewLog = createLogger('Webview')
        const logFn = message.level === 'error' ? webviewLog.error
          : message.level === 'warn' ? webviewLog.warn
          : webviewLog.info
        logFn(message.message)
        break
      }

      default:
        handleHubMessage(message)
    }
  })
}

// ─── JSONL Connection ──────────────────────────────────────────────────────

function connectToJsonl(filePath: string, context: vscode.ExtensionContext): void {
  disconnectEventSource()

  eventSource = new JsonlEventSource(filePath)
  context.subscriptions.push(eventSource)

  if (VisualizerPanel.all().length === 0) { return }

  eventSource.onEvent((event) => {
    for (const panel of VisualizerPanel.all()) panel.sendEvent(event)
  })

  eventSource.onStatus((status) => {
    for (const panel of VisualizerPanel.all()) {
      panel.setConnectionStatus(
        status === 'connected' ? 'watching' : 'disconnected',
        filePath,
      )
    }
  })

  eventSource.start()
}

function disconnectEventSource(): void {
  if (eventSource) {
    eventSource.dispose()
    eventSource = undefined
  }
}

// ─── File Handlers ────────────────────────────────────────────────────────

async function handleOpenFile(filePath: string, line?: number): Promise<void> {
  try {
    const uri = vscode.Uri.file(filePath)
    const doc = await vscode.workspace.openTextDocument(uri)
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    })
    if (line && line > 0) {
      const pos = new vscode.Position(line - 1, 0)
      editor.selection = new vscode.Selection(pos, pos)
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
    }
  } catch (err) {
    log.error(`Failed to open file: ${filePath}`, err)
  }
}

export function deactivate(): void {
  disconnectEventSource()
  for (const r of runtimes) r.dispose()
  runtimes = []
}
