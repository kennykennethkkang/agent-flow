/**
 * The Hub tab's data, shared word for word with extension/src/hub/types.ts.
 *
 * Live arrives from each Claude Code session's usage mod (POST /hub); the rest
 * the extension gathers itself.
 */

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type SessionLive = {
  sessionId: string
  cwd: string
  label?: string
  model?: string
  tokens?: number
  compactAt?: number
  limits: Limit[]
  costUsd?: number
  /** The latest prompt, redacted and cut short by the usage mod. */
  prompt?: string
  /** The latest file a tool read or wrote, and when it changed. */
  file?: string
  fileAt?: number
  at: number
}

export type DayUsage = { day: string; reread: number; written: number; io: number; calls: number; sessions: number }
export type SessionRow = { sessionId: string; label: string; project: string; reread: number; calls: number; startedAt: number; lastAt: number }
export type PlanView = { name: string; tasks: { title: string; done: number; total: number }[]; decisions?: string[] }
/** folder: the cwd's last two names, for show; cwd: the full one. */
export type Server = { pid: number; command: string; port: number; folder: string; cwd?: string }
/** A project folder with a dev script. Running when port is set; link is its tailscale serve address, when served. */
export type DevProject = { folder: string; project: string; command: string; port?: number; link?: string }
export type GitState = { branch?: string; ahead?: number; behind?: number; changed: number; staged: number; untracked: number }
export type AwsStatus = 'signed-in' | 'expired' | 'never'
/** One ~/.aws/config profile. label: from aws-labels.json, by account. chrome: the Chrome profile folder its sign-in opens in ('' = system browser). stale: an old default's backup. */
export type AwsProfile = { name: string; label?: string; account?: string; region?: string; isDefault: boolean; status: AwsStatus; chrome?: string; checkedAt: number; stale?: boolean; /** Signs in as the account root (aws login): AWS sets the session length, no way to extend it. */ root?: boolean }
export type ChromeProfile = { dir: string; name: string; email?: string }
/** Chrome profiles to sign in with, the AWS profile picked per project folder, and this window's folder. */
/** A saved web login: only where to sign in and in which Chrome profile, never a password or token. */
export type WebLogin = { id: string; label: string; url: string; chrome?: string }
/** A web app with its saved logins (~/.claude/switchboard/logins.json); url is where a new login starts. */
export type WebApp = { id: string; name: string; url: string; logins: WebLogin[]; active?: string }
/** Apps a project uses, by project folder then app id; the login id is that project's default, null = the app's own. */
export type Links = Record<string, Record<string, string | null>>
/** apps, links: an older extension sends none. */
export type SignIns = { chrome: ChromeProfile[]; projects: Record<string, string>; window?: string; apps?: WebApp[]; links?: Links; /** Chrome folder per project folder, '' the system browser; a login's own pick wins. */ browsers?: Record<string, string> }
/** One Jev run from the usage mod, tied to the chat that ran it when known. */
export type JevRun = { sessionId?: string; preset?: string; items: number; costUsd: number; seconds: number; at: number }
/** A full chat whose handoff waits on its running subagents (Claude) or open turn (Codex). next: the fresh chat's version, like v2. */
export type HandoffWait = { sessionId: string; tasks: number; next: string; since: number }
/** skills: a plugin's own skill names. model: a role's frontmatter model (inherit, an alias or a full id). description: plugin.json's or SKILL.md's, cut short. */
/** asset: a design reference in the project; path is relative to the project folder. */
export type Installed = { kind: 'mod' | 'plugin' | 'skill' | 'role' | 'preset' | 'asset'; name: string; enabled: boolean; tokens?: number; source?: string; skills?: string[]; model?: string; description?: string; path?: string }
/** One chat's plugins (by id) and user skills (by name), on or off; tools.ts turns it into the chat's --settings file. */
/** assets: design references by project-relative path, named to the chat in its system note. */
export type ChatProfile = { plugins: Record<string, boolean>; skills: Record<string, boolean>; assets?: Record<string, boolean> }
/** flagged: plugins never turned on by a pick. pick: the last hub-pick-tools answer, for its goal. chats: saved profiles by session id. */
export type ToolsState = { flagged: string[]; pick: { goal: string; profile: ChatProfile } | null; chats: Record<string, ChatProfile> }
export type Connection = { kind: 'mcp' | 'app' | 'project' | 'window' | 'repo'; name: string; status: 'on' | 'off' | 'error'; detail?: string }

export type HubState = {
  live: SessionLive[]
  history: DayUsage[]
  sessions: SessionRow[]
  plan: PlanView | null
  servers: Server[]
  git: GitState | null
  aws: AwsProfile[]
  signIns: SignIns
  jev: JevRun[]
  waits: HandoffWait[]
  installed: Installed[]
  connections: Connection[]
  rc: { atStartup: boolean; requestedAt?: number }
  keep: KeepWorking
  projects: Project[]
  controls: Controls
  chats: ChatRow[]
  rcServers: RcServer[]
  ais: AiStatus[]
  starred: StarredChat[]
  progress: ChatProgress[]
  archive: ArchivedChat[]
  /** The changes of the chat the panel asked for (hub-changes), refreshed with the near data. */
  changes: Changes | null
  /** The last History search (hub-search): closed chats whose handoff note holds q. */
  search: NoteSearch | null
  /** Where the browser version answers, or null when none runs. */
  webUrl: string | null
  /** The app's phone links with their secret, one per network, for the QRs. Only the VS Code panel gets them; /hub/state blanks them. */
  phoneUrls?: PhoneUrls | null
  /** Per chat tool sets; an older extension sends none. */
  tools?: ToolsState
  /** Projects with a dev script; an older extension sends none. */
  dev?: DevProject[]
  /** Whether tailscale is installed and up, for the Phone links. */
  tailscale?: boolean
  /** Keep awake (caffeinate) is on. */
  awake?: boolean
  /** Devices waiting for Allow or Deny; kept out of /hub/state, so only the Mac answers. */
  devices?: DeviceAsk[]
  /** Every open VS Code window and its color; an older extension sends none. */
  windows?: WindowInfo[]
  /** The workspace of the window showing the panel; /hub/state leaves it out. */
  thisWindow?: string
  /** The Git panel's repo: the one holding the chat hub-changes asked for. */
  repo?: RepoView | null
}

/** A palette key, not a hex: the panel picks the theme's shade. */
export type WindowColor = 'violet' | 'amber' | 'teal' | 'rose' | 'lime' | 'cobalt'
export type WindowInfo = { workspace: string; name: string; color: WindowColor }

/** One uncommitted file in a chat's folder. diff: from the first hunk, capped; note: why there is none (binary, too big). */
export type ChangedFile = { path: string; added: number; removed: number; status: 'modified' | 'added' | 'deleted' | 'untracked'; diff?: string; note?: string }
export type Changes = { sessionId: string; cwd: string; files: ChangedFile[]; at: number }
/** One file git status lists, relative to the repo root. from: a rename's old path. */
export type RepoFile = { path: string; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict'; from?: string }
export type GitOp = 'sync' | 'commit' | 'commit-push' | 'switch' | 'create' | 'undo' | 'discard' | 'pr' | 'stash' | 'pop' | 'delete-branch'
/** sync: the one sync button (Publish branch, Pull N, Push N or Fetch). github: the repo's page, from the branch's remote (origin by default). pr: the branch's open PR when gh can tell. busy: the op running now; result: the last one's outcome. */
export type RepoView = {
  sessionId: string; name: string; branch?: string; upstream?: string; ahead: number; behind: number; files: RepoFile[]; branches: string[]
  sync: { kind: 'publish' | 'pull' | 'push' | 'fetch'; label: string }
  log: { hash: string; subject: string; when: string }[]; stashes: number; github?: string; pr?: { url: string; state: string; title: string }
  busy?: GitOp; result?: { text: string; ok: boolean; at: number }; at: number
}
export type NoteSearch = { q: string; hits: { sessionId: string; snippet: string }[] }

/** The settings behind the Keep working card. A full chat always continues in a fresh chat: onFull stays for usage mods that still ask. */
export type KeepWorking = { autoCompact: boolean; window?: number; autoContinue: boolean; onFull: 'fresh'; freshBranch: boolean }
export type KeepSetting = 'autoCompactEnabled' | 'autoCompactWindow' | 'autoContinueAtUsageLimit'
/** The Claude Code settings a switch may write; the whitelist and its values are in controls.ts. */
export type SettingKey = KeepSetting | 'remoteControlAtStartup' | 'agentPushNotifEnabled' | 'inputNeededNotifEnabled' | 'model' | 'effortLevel' | 'tui' | 'statusLine'
export type ClaudeControls = { model?: 'fable' | 'opus' | 'sonnet' | 'haiku'; effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; tui: 'default' | 'fullscreen'; statusLine: boolean; push: boolean; needInput: boolean }
/** Switchboard's own switches, kept in VS Code's globalState. idleMinutes null: never hide. */
export type SwitchboardControls = { hooks: boolean; statusBar: boolean; idleMinutes: number | null; brief: boolean; askBrain: boolean; syncRules: boolean }
export type SwitchboardKey = keyof SwitchboardControls
/** rulesNote: what the last rules and roles sync did, one line. */
export type Controls = { claude: ClaudeControls; switchboard: SwitchboardControls; statusLineReady: boolean; rulesNote?: string }
/** The brain's view for hub_ask: live chats by project, and what it suggests. */
export type BoardChat = { sessionId: string; label?: string; prompt?: string; file?: string; percent?: number; at: number }
export type BoardProject = { project: string; cwd: string; chats: BoardChat[] }
export type Suggestion = { id: string; kind: 'clash' | 'full' | 'task' | 'server'; text: string; sessions: string[]; folder?: string; task?: string }
export type Project = { name: string; path: string; kind: 'repo' | 'project'; isOpen: boolean }
/** One running chat, and why it may be missing from the Claude app. fill: a Codex chat's context, 0..1. chain: the handoff chain it is in. takes: the message box reaches it. */
export type ChatRow = { pid: number; sessionId: string; name?: string; cwd: string; status?: string; version?: string; kind?: string; updatedAt?: number; bridgeId?: string; link: string; live: boolean; why: string[]; ai?: AiId; fill?: number; chain?: string; takes?: boolean }
/** The AIs the hub knows; a new one is one member here and one entry in ais.ts. */
export type AiId = 'claude' | 'codex'
export type AiStatus = { id: AiId; name: string; installed: boolean; detail?: string; chats: number }
/** A starred chat and what the hub knows of it, read from disk with no model call. */
export type StarredChat = { sessionId: string; ai: AiId; name: string; cwd: string; starredAt: number; live: boolean; chain?: string; digest: { lastPrompt?: string; note?: string; resume: string; updatedAt?: number } }
/** A chat closed by a handoff, shown under History. origin: its chain's first chat's name; version: 1 for the origin. note: the handoff note it wrote. */
export type ArchivedChat = { sessionId: string; ai: AiId; name: string; origin: string; version: number; cwd: string; project: string; note?: string; startedAt?: number; archivedAt: number }
/** Where a chat is: working, done (finished with a commit message or every task; almost done while its standup lists Left items), needs you (a question), idle (stopped, work open). */
export type ChatState = 'working' | 'done' | 'needs-you' | 'idle'
/** One subagent run, keyed by its agent id (the role when a payload has none). */
export type RoleStep = { id: string; role: string; state: 'active' | 'done'; startedAt: number }
export type TaskRow = { id: string; subject: string; status: 'pending' | 'in_progress' | 'completed'; role?: string; /** When it went in progress, and when it completed; drive the time estimate. */ startedAt?: number; doneAt?: number }
/** One chat's progress, built from its hook events with no model call. */
/** A background Bash or Monitor, keyed by its tool_use_id; label is its description. */
/** task: the shell's backgroundTaskId, the name TaskStop uses. */
export type BgJob = { id: string; label?: string; task?: string; startedAt: number }
/** One tool call for the picture: role is "lead" for the main chat, else the subagent type. target: the file, pattern or command it touched, cut short. */
export type ToolCall = { tool: string; target?: string; role: string; at: number }
export type ChatProgress = { sessionId: string; cwd: string; state: ChatState; roles: RoleStep[]; tasks: TaskRow[]; question?: string; commit?: string; startedAt: number; at: number; /** The newest tool calls, oldest first, at most 8. */ tools?: ToolCall[]; /** Subagents still running, by agent id (or role); they outlive the chat's Stop. */ running?: string[]; /** The lead's turn ended while some still ran. */ waiting?: boolean; /** Background shells and monitors the lead started, until their task-notification. */ jobs?: BgJob[]; /** The lead's last turn ended with a commit block or every task done; Done once nothing runs. */ finishing?: true; /** When it last reached Done. */ finishedAt?: number; /** The prompt the terminal shows, while it waits. */ ask?: Ask; /** Every prompt waiting, oldest (ask) first. */ asks?: Ask[]; /** The lead's last turn died on an API error (StopFailure), until it makes real progress. */ limited?: { at: number; error: string }; /** The standup in the lead's last message; Left items keep a done chat almost done. */ report?: Report; /** Kenneth's own prompts in this chat, newest last, at most 8. */ asked?: string[]; /** Jev's score per asked item (0 to 1, null: no answer) for whether Done covers it. */ covered?: Array<number | null> }
/** A standup's Done and Left items, cut short. */
export type Report = { done: string[]; left: string[] }
/** One AskUserQuestion question; options in the terminal's order. */
export type AskQuestion = { header?: string; question: string; options: string[]; multiSelect?: boolean }
/** A prompt in the chat's terminal and its choices in order. id: a stale answer is refused. preview: what the tool will run, cut short. */
export type Ask = { id: string; kind: 'permission' | 'question'; tool: string; preview?: string; options: string[]; questions?: AskQuestion[]; /** Raised by a subagent, so the lead's own calls leave it. */ sub?: true }
/** A `claude remote-control` server for a folder, so the Claude app can start chats there. */
export type RcServer = { folder: string; name: string; on: boolean }

export type InboxDraft = { kind: 'prompt'; text: string } | { kind: 'rc' } | { kind: 'compact' } | { kind: 'close' } | { kind: 'handoff' }
export type InboxItem = InboxDraft & { id: string }

// code: typed with an address on a device that has no cookie yet. The *Name links use this Mac's mDNS or MagicDNS name, which outlast an IP change.
export type PhoneUrls = { wifi?: string; tailscale?: string; wifiName?: string; tailscaleName?: string; code?: string }
/** A device on the sign-in page that asked the Mac to let it in. */
export type DeviceAsk = { id: string; ip: string; ua: string; network: 'Wi-Fi' | 'Tailscale' }
