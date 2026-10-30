import type { AiId, ChatProfile, Choice, GitOp, HubState, SettingKey, SwitchboardKey } from './hub/types'
/**
 * Message protocol between VS Code extension host and webview.
 *
 * Extension → Webview: agent events, state updates, connection status
 * Webview → Extension: user commands (inject, connect/disconnect)
 */

// ─── Agent Event Types (from real agent sessions) ────────────────────────────

export type AgentEventType =
  | 'agent_spawn'
  | 'agent_complete'
  | 'agent_idle'
  | 'message'
  | 'context_update'
  | 'model_detected'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'subagent_dispatch'
  | 'subagent_return'
  | 'permission_requested'
  | 'error'

export interface AgentEvent {
  time: number
  type: AgentEventType
  payload: Record<string, unknown>
  sessionId?: string
}

export interface SessionInfo {
  id: string
  label: string
  status: 'active' | 'completed'
  startTime: number
  lastActivityTime: number
}

// ─── Extension → Webview Messages ────────────────────────────────────────────

export type ExtensionToWebviewMessage =
  | { type: 'connection-status'; status: 'connected' | 'disconnected' | 'watching'; source: string }
  | { type: 'agent-event'; event: AgentEvent }
  | { type: 'agent-event-batch'; events: AgentEvent[] }
  | { type: 'reset'; reason: string }
  | { type: 'config'; config: Partial<VisualizerConfig> }
  | { type: 'session-list'; sessions: SessionInfo[] }
  | { type: 'session-started'; session: SessionInfo }
  | { type: 'session-ended'; sessionId: string }
  | { type: 'session-updated'; sessionId: string; label: string }
  | { type: 'hub-state'; hub: HubState }
  /** The view was hidden or shown: a hidden view stops its animation (VS Code keeps it alive but sets no document.hidden). */
  | { type: 'hub-visible'; visible: boolean }

export interface VisualizerConfig {
  mode: 'live' | 'replay'
  autoPlay: boolean
  showMockData: boolean
  disable1MContext: boolean
}

// ─── Webview → Extension Messages ────────────────────────────────────────────

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'request-connect' }
  | { type: 'request-disconnect' }
  | { type: 'open-file'; filePath: string; line?: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
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

// ─── Transcript Types (from Claude Code JSONL files) ─────────────────────────

export interface TranscriptEntry {
  sessionId: string
  type: string
  uuid?: string
  message: {
    role: string
    model?: string
    content: Array<TranscriptContentBlock> | string
  }
}

export interface ToolUseBlock {
  type: 'tool_use'
  name: string
  id: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<{ text?: string; type?: string }>
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
}

export interface TextBlock {
  type: 'text'
  text: string
}

export type TranscriptContentBlock =
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | TextBlock
  | { type: string; [key: string]: unknown }

// ─── Shared Helpers ─────────────────────────────────────────────────────────

/** Minimal emitter interface used by {@link emitSubagentSpawn}. */
export interface AgentEventEmitter {
  emit(event: AgentEvent, sessionId?: string): void
  elapsed(sessionId?: string): number
}

/**
 * Emit the paired subagent_dispatch + agent_spawn events.
 *
 * This two-event sequence is required every time a subagent is spawned and was
 * previously duplicated in SessionWatcher and TranscriptParser.
 */
export function emitSubagentSpawn(
  emitter: AgentEventEmitter,
  parent: string,
  child: string,
  task: string,
  sessionId?: string,
): void {
  emitter.emit({
    time: emitter.elapsed(sessionId),
    type: 'subagent_dispatch',
    payload: { parent, child, task },
  }, sessionId)
  emitter.emit({
    time: emitter.elapsed(sessionId),
    type: 'agent_spawn',
    payload: { name: child, parent, task },
  }, sessionId)
}

// ─── Shared Internal Types ───────────────────────────────────────────────────

/** A tool call that has started but not yet received its result */
export interface PendingToolCall {
  name: string
  args: string
  filePath?: string
  startTime: number
}

// ─── Session Types ──────────────────────────────────────────────────────────

export interface SubagentState {
  watcher: import('fs').FSWatcher | null
  fileSize: number
  agentName: string
  pendingToolCalls: Map<string, PendingToolCall>
  seenToolUseIds: Set<string>
  permissionTimer: NodeJS.Timeout | null
  permissionEmitted: boolean
  spawnEmitted: boolean
}

/** State tracked for a single watched Claude Code session */
export interface WatchedSession {
  sessionId: string
  filePath: string
  fileWatcher: import('fs').FSWatcher | null
  pollTimer: NodeJS.Timeout | null
  fileSize: number
  sessionStartTime: number
  pendingToolCalls: Map<string, PendingToolCall>
  seenToolUseIds: Set<string>
  seenMessageHashes: Set<string>
  sessionDetected: boolean
  sessionCompleted: boolean
  lastActivityTime: number
  inactivityTimer: NodeJS.Timeout | null
  subagentWatchers: Map<string, SubagentState>
  /** Names of subagents already spawned (by transcript parser or file watcher) — prevents duplicate spawns */
  spawnedSubagents: Set<string>
  /** Subagent names currently receiving inline progress events — file watcher skips these */
  inlineProgressAgents: Set<string>
  subagentsDirWatcher: import('fs').FSWatcher | null
  subagentsDir: string | null
  label: string
  labelSet: boolean
  model: string | null
  /** Maps agent names to their last emitted model ID — re-emits on model change */
  modelDetectedAgents: Map<string, string>
  permissionTimer: NodeJS.Timeout | null
  permissionEmitted: boolean
  contextBreakdown: {
    systemPrompt: number
    userMessages: number
    toolResults: number
    reasoning: number
    subagentResults: number
  }
}

// ─── Claude Settings Types ──────────────────────────────────────────────────

export interface ClaudeHookDef {
  type?: string
  url?: string
  command?: string
  timeout?: number
}

export interface ClaudeHookEntry {
  hooks?: ClaudeHookDef[]
}

