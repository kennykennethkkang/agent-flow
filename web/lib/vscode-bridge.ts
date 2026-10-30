/**
 * VS Code Bridge: enables the visualizer to communicate with the VS Code extension host.
 *
 * When running standalone (npm run dev), this is a no-op.
 * When running inside a VS Code webview iframe, it forwards messages
 * between the React app and the extension host.
 */

export type { AgentEvent, SessionInfo, ConnectionStatus } from './bridge-types'
import type { AgentEvent, SessionInfo, ConnectionStatus } from './bridge-types'
import type { AiId, ChatProfile, Choice, GitOp, HubState, SettingKey, SwitchboardKey } from './hub-types'

type InitCallback = () => void
type EventCallback = (event: AgentEvent) => void
type StatusCallback = (status: ConnectionStatus, source: string) => void
type ConfigCallback = (config: Partial<{ mode: string; autoPlay: boolean; showMockData: boolean; disable1MContext: boolean }>) => void
type SessionCallback = (type: 'list' | 'started' | 'ended' | 'updated' | 'reset', data: SessionInfo[] | SessionInfo | string | { sessionId: string; label: string }) => void
type HubCallback = (hub: HubState) => void

/** What the Hub sends back to the extension. */
export type HubCommand =
  | { type: 'hub-refresh' }
  | { type: 'hub-send'; sessionId: string; text: string }
  | { type: 'hub-answer'; sessionId: string; askId: string; choice: Choice }
  | { type: 'hub-rc'; on: boolean; sessionId?: string }
  | { type: 'hub-open-url'; url: string }
  | { type: 'hub-web'; phone: boolean }
  | { type: 'hub-stop-server'; pid: number; confirmed?: boolean }
  | { type: 'hub-toggle'; kind: 'mod' | 'plugin' | 'skill'; name: string; enabled: boolean }
  | { type: 'hub-setting'; key: SettingKey; value: boolean | number | string | null }
  | { type: 'hub-switchboard'; key: SwitchboardKey; value: boolean | number | string | null }
  | { type: 'hub-vscode'; action: 'reload' | 'restart' }
  | { type: 'hub-compact'; sessionId: string }
  | { type: 'hub-open-project'; path: string; newWindow: boolean }
  | { type: 'hub-clone'; repo: string; newWindow: boolean }
  | { type: 'hub-new-chat'; path: string; text?: string; remote: boolean; branch?: string; ai?: AiId; tools?: ChatProfile }
  | { type: 'hub-pick-tools'; text: string; path?: string }
  | { type: 'hub-chat-tools'; sessionId: string; tools: ChatProfile }
  | { type: 'hub-star'; sessionId: string; ai: AiId; on: boolean }
  | { type: 'hub-resume'; sessionId: string; ai: AiId }
  | { type: 'hub-open-note'; sessionId: string }
  | { type: 'hub-focus-chat'; sessionId: string }
  | { type: 'hub-keep'; onFull?: 'compact' | 'fresh'; freshBranch?: boolean }
  | { type: 'hub-aws-login'; profile: string; chrome?: string }
  | { type: 'hub-aws-default'; profile: string }
  | { type: 'hub-aws-label'; profile: string; label: string }
  | { type: 'hub-aws-add'; profile: string; region: string; chrome?: string }
  | { type: 'hub-aws-window'; profile: string | null }
  | { type: 'hub-aws-check' }
  | { type: 'hub-aws-delete'; profile: string }
  | { type: 'hub-login-app-add'; name: string; url: string }
  | { type: 'hub-login-add'; app: string; label: string; url: string; chrome?: string }
  | { type: 'hub-login-open'; app: string; id?: string; chrome?: string; folder?: string }
  /** login: a login id, null for the app's default, 'off' to drop the app from the project. */
  | { type: 'hub-login-link'; folder: string; app: string; login: string | null }
  | { type: 'hub-browser'; folder: string; chrome: string | null }
  | { type: 'hub-login-active'; app: string; id: string }
  | { type: 'hub-login-rename'; app: string; id: string; label: string }
  | { type: 'hub-login-delete'; app: string; id: string }
  | { type: 'hub-login-app-delete'; app: string }
  | { type: 'hub-kit-export' }
  | { type: 'hub-setup' }
  | { type: 'hub-rules-sync' }
  | { type: 'hub-role-model'; role: string; model: 'inherit' | 'fable' | 'opus' | 'sonnet' | 'haiku' }
  | { type: 'hub-rc-server'; folder: string; on: boolean }
  | { type: 'hub-handoff'; sessionId: string }
  | { type: 'hub-dev-start'; folder: string }
  | { type: 'hub-dev-stop'; folder: string }
  | { type: 'hub-awake'; on: boolean }
  | { type: 'hub-device'; id: string; allow: boolean }
  | { type: 'hub-changes'; sessionId: string }
  | { type: 'hub-open-diff'; sessionId: string; file: string }
  | { type: 'hub-search'; q: string }
  | { type: 'hub-git'; sessionId: string; op: GitOp; files?: string[]; summary?: string; description?: string; branch?: string; stash?: boolean; confirmed?: boolean }
  | { type: 'hub-todo-add'; path: string; text: string }
  | { type: 'hub-todo-edit'; path: string; id: string; text: string }
  | { type: 'hub-todo-remove'; path: string; id: string }
  /** Puts back an item a finished chat ticked off. */
  | { type: 'hub-todo-restore'; path: string; id: string }
  /** Items and their open prerequisites, in a new chat or sent to a running one (to). */
  | { type: 'hub-todo-run'; path: string; ids: string[]; to?: string }
  | { type: 'hub-todo-sync'; path: string; on: boolean }
  | { type: 'hub-todo-replace'; path: string; remote: string }

class VSCodeBridge {
  private _isVSCode = false
  private _status: ConnectionStatus = 'disconnected'
  private _source = ''

  private initListeners: InitCallback[] = []
  private eventListeners: EventCallback[] = []
  private statusListeners: StatusCallback[] = []
  private configListeners: ConfigCallback[] = []
  private sessionListeners: SessionCallback[] = []
  private hubListeners: HubCallback[] = []
  private lastHub: HubState | null = null
  private shownListeners: Array<() => void> = []
  /** False while VS Code keeps this view alive but hidden (sidebar collapsed, tab in the background). */
  shown = true

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('message', this.handleMessage)
    }
  }

  private handleMessage = (e: MessageEvent) => {
    const data = e.data
    if (!data || typeof data.type !== 'string') { return }

    switch (data.type) {
      case '__vscode-bridge-init':
        this._isVSCode = true
        this.postToExtension({ type: 'ready' })
        for (const cb of this.initListeners) cb()
        this.initListeners = [] // one-shot: no need to keep listeners after init
        break

      case 'agent-event':
        for (const cb of this.eventListeners) {
          cb(data.event)
        }
        break

      case 'agent-event-batch':
        for (const event of data.events) {
          for (const cb of this.eventListeners) {
            cb(event)
          }
        }
        break

      case 'connection-status':
        this._status = data.status
        this._source = data.source || ''
        for (const cb of this.statusListeners) {
          cb(this._status, this._source)
        }
        break

      case 'config':
        for (const cb of this.configListeners) {
          cb(data.config)
        }
        break

      case 'reset':
        for (const cb of this.sessionListeners) {
          cb('reset', data.reason || 'panel-reopened')
        }
        break

      case 'session-list':
        for (const cb of this.sessionListeners) {
          cb('list', data.sessions)
        }
        break

      case 'session-started':
        for (const cb of this.sessionListeners) {
          cb('started', data.session)
        }
        break

      case 'session-ended':
        for (const cb of this.sessionListeners) {
          cb('ended', data.sessionId)
        }
        break

      case 'session-updated':
        for (const cb of this.sessionListeners) {
          cb('updated', { sessionId: data.sessionId, label: data.label })
        }
        break
      case 'hub-state':
        this.lastHub = data.hub
        for (const cb of this.hubListeners) cb(data.hub)
        break
      case 'hub-visible':
        this.shown = data.visible !== false
        for (const cb of this.shownListeners) cb()
        break
    }
  }

  get isVSCode(): boolean {
    return this._isVSCode
  }

  // ─── Subscribe to events ─────────────────────────────────────────────────

  private subscribe<T>(listeners: T[], callback: T): () => void {
    listeners.push(callback)
    return () => {
      const idx = listeners.indexOf(callback)
      if (idx >= 0) listeners.splice(idx, 1)
    }
  }

  /** Subscribe to bridge init. If already initialized, fires synchronously. */
  onInit(callback: InitCallback): () => void {
    if (this._isVSCode) {
      callback()
      return () => {} // already fired, nothing to unsubscribe
    }
    return this.subscribe(this.initListeners, callback)
  }

  onEvent(callback: EventCallback): () => void {
    return this.subscribe(this.eventListeners, callback)
  }

  onStatus(callback: StatusCallback): () => void {
    return this.subscribe(this.statusListeners, callback)
  }

  onConfig(callback: ConfigCallback): () => void {
    return this.subscribe(this.configListeners, callback)
  }

  onSession(callback: SessionCallback): () => void {
    return this.subscribe(this.sessionListeners, callback)
  }

  /** Subscribe to the Hub's state; a late subscriber gets the last one at once. */
  onHub(callback: HubCallback): () => void {
    if (this.lastHub) callback(this.lastHub)
    return this.subscribe(this.hubListeners, callback)
  }

  /** Called when the view is hidden or shown again; read `shown`. */
  onShown(callback: () => void): () => void {
    return this.subscribe(this.shownListeners, callback)
  }

  // ─── Send commands to extension ──────────────────────────────────────────

  openFile(filePath: string, line?: number): void {
    this.postToExtension({ type: 'open-file', filePath, line })
  }

  sendHub(command: HubCommand): void {
    this.postToExtension(command)
  }

  private postToExtension(message: Record<string, unknown>): void {
    if (this._isVSCode && typeof window !== 'undefined') {
      // When inside VS Code iframe, post to parent (the webview frame)
      window.parent.postMessage(message, '*')
    }
  }

  /** Configure the bridge for direct VS Code webview API (production build). */
  configureWebviewApi(postMessage: (msg: Record<string, unknown>) => void): void {
    this._isVSCode = true
    this.postToExtension = (msg: Record<string, unknown>) => {
      postMessage(msg)
    }
    for (const cb of this.initListeners) cb()
    this.initListeners = []
  }

  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.handleMessage)
    }
    this.initListeners = []
    this.eventListeners = []
    this.statusListeners = []
    this.configListeners = []
    this.sessionListeners = []
    this.hubListeners = []
    this.shownListeners = []
  }
}

// Singleton, safe to import from anywhere
export const vscodeBridge = typeof window !== 'undefined' ? new VSCodeBridge() : null
