/**
 * Hub states for when no extension is there: empty, and a sample for the browser demo.
 * The sample mirrors a real week on Kenneth's Mac so the demo reads true.
 */
import type { HubCommand } from './vscode-bridge'
import { runIds } from './todo'
import type { ChangedFile, ChatProfile, HubState, RepoView, ToolCall } from './hub-types'

export const emptyHub = (): HubState => ({
  live: [], history: [], sessions: [], plan: null,
  servers: [], git: null, aws: [], signIns: { chrome: [], projects: {} }, jev: [], waits: [], installed: [], connections: [], rc: { atStartup: false },
  keep: { autoCompact: true, autoContinue: false, onFull: 'fresh', freshBranch: false },
  projects: [],
  controls: {
    claude: { tui: 'default', statusLine: false, push: false, needInput: false },
    switchboard: { hooks: false, statusBar: true, idleMinutes: 15, brief: true, askBrain: true, syncRules: true, accessNote: true, name: '' },
    statusLineReady: false,
  },
  chats: [], rcServers: [], ais: [], starred: [], progress: [], archive: [],
  changes: null, search: null, webUrl: null, phoneUrls: null,
  tools: { flagged: DEMO_FLAGGED, pick: null, chats: {} },
})

const DEMO_TAILNET = 'http://mac.tail1234.ts.net'
// Same list as extension/src/hub/tools.ts FLAGGED.
const DEMO_FLAGGED: string[] = []
/** The extension asks a model; the demo turns on what the goal names, plus superpowers, and never a flagged one. */
const demoPick = (h: HubState, goal: string): ChatProfile => {
  const g = goal.toLowerCase(), named = (n: string) => g.includes(n.split('@')[0].split('-')[0])
  return {
    plugins: Object.fromEntries(h.installed.filter(i => i.kind === 'plugin').map(i => [i.name, !DEMO_FLAGGED.includes(i.name) && (i.name.startsWith('superpowers@') || named(i.name))])),
    skills: Object.fromEntries(h.installed.filter(i => i.kind === 'skill' && i.enabled).map(i => [i.name, named(i.name)])),
  }
}

const DAY = 86_400_000
const REREAD = [128.0, 0, 0, 428.2, 699.1, 1281.7, 1631.5, 685.5, 1751.8, 929.7, 1436.5, 229.7, 1306.3, 236.0]
const CALLS = [185, 0, 0, 869, 1212, 2486, 2885, 1240, 3011, 1790, 2702, 401, 5698, 704]

export function demoHub(now = Date.now()): HubState {
  const day = (i: number) => {
    const d = new Date(now - (13 - i) * DAY)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  return {
    ...emptyHub(),
    controls: {
      claude: { model: 'opus', tui: 'fullscreen', statusLine: false, push: true, needInput: true },
      switchboard: { hooks: true, statusBar: true, idleMinutes: 15, brief: true, askBrain: true, syncRules: true, accessNote: true, name: '' },
      statusLineReady: true,
    },
    projects: [
      { name: 'Armasu', path: '/Users/k/Documents/GitHub/Armasu', kind: 'repo', isOpen: true },
      { name: 'Gemini-Test', path: '/Users/k/Documents/GitHub/Gemini-Test', kind: 'repo', isOpen: false },
      { name: 'claude-mods', path: '/Users/k/Documents/GitHub/claude-mods', kind: 'repo', isOpen: false },
      { name: 'CSEN122', path: '/Users/k/Documents/CSEN122', kind: 'project', isOpen: false },
    ],
    // A browser has no window of its own, so no thisWindow; claude-mods has no window open and lands in Other.
    windows: [
      { workspace: '/Users/k/GitHub/agent-flow', name: 'agent-flow', color: 'violet' },
      { workspace: '/Users/k/GitHub/Armasu', name: 'Armasu', color: 'amber' },
    ],
    chats: [
      { pid: 1, sessionId: 'd-work', takes: true, name: 'Fix login redirect v4', chain: 'Fix login redirect', cwd: '/Users/k/GitHub/Armasu', link: '', live: true, why: [] },
      { pid: 2, sessionId: 'd-done', takes: true, name: 'Hub AIs and Starred', cwd: '/Users/k/GitHub/agent-flow', link: '', live: true, why: [] },
      { pid: 3, sessionId: 'd-ask', takes: true, name: 'Outfit picker copy', cwd: '/Users/k/GitHub/Armasu', link: '', live: true, why: [] },
      { pid: 6, sessionId: 'd-almost', takes: true, name: 'Finished receipt', cwd: '/Users/k/GitHub/agent-flow', link: '', live: true, why: [] },
      { pid: 5, sessionId: 'd-wrap', takes: true, name: 'Accurate Done state', cwd: '/Users/k/GitHub/agent-flow', link: '', live: true, why: [] },
      { pid: 4, sessionId: 'd-idle', name: 'Kit cleanup', cwd: '/Users/k/GitHub/claude-mods', link: '', live: true, why: [] },
    ],
    // Several items, one prerequisite, one in progress, one from a finished chat, one whose chat ended; agent-flow's show as "in other projects".
    todos: {
      '/Users/k/GitHub/Armasu': { sync: { state: 'synced', canSync: true }, todo: [
        { id: 'dt1', text: 'Add CSV export to the receipts page', at: now - 3 * DAY },
        { id: 'dt2', text: 'Put a Stripe test key in .env.local', at: now - 2 * DAY, before: 'dt1', from: 'd-work' },
        { id: 'dt3', text: 'Fix the login redirect on Safari', at: now - DAY, chat: 'd-work' },
        { id: 'dt4', text: 'Check the outfit picker on a real phone', at: now - 5 * 60e3, from: 'd-gone' },
        { id: 'dt5', text: 'Move the route release preset to the shared kit', at: now - 60 * 60e3, chat: 'd-gone' },
      ], ticked: [{ id: 'dt6', text: 'Show the login error under the form', at: now - 20 * 60e3, by: 'd-done', from: 'd-work' }] },
      '/Users/k/GitHub/agent-flow': { sync: { state: 'local', why: 'public repo', canSync: true }, todo: [
        { id: 'da1', text: 'Rebuild the vsix and reload VS Code', at: now - 4 * 60e3, from: 'd-almost' },
        { id: 'da2', text: 'Check the phone layout on a real device', at: now - 4 * 60e3, from: 'd-almost' },
      ] },
    },
    progress: [
      { sessionId: 'd-work', cwd: '/Users/k/GitHub/Armasu', state: 'working', startedAt: now - 30 * 60e3, at: now,
        roles: [...demoRuns(11_000, now), JEV_ROLE],
        // Timed so the estimate shows: 8 and 16 min done, 6 min into the third.
        tasks: [
          { id: '1', subject: 'Find where the redirect loops', status: 'completed', role: 'researcher', startedAt: now - 30 * 60e3, doneAt: now - 22 * 60e3 },
          { id: '2', subject: 'Write a failing test', status: 'completed', role: 'engineer', startedAt: now - 22 * 60e3, doneAt: now - 6 * 60e3 },
          { id: '3', subject: 'Fix the cookie check', status: 'in_progress', role: 'engineer', startedAt: now - 6 * 60e3 },
          { id: '4', subject: 'Run tests and review', status: 'pending', role: 'qa' },
        ],
        tools: [
          { tool: 'Grep', target: 'redirect', role: 'researcher', at: now - 50e3 },
          { tool: 'Read', target: 'auth/middleware.ts', role: 'researcher', at: now - 40e3 },
          { tool: 'Write', target: 'auth/redirect.test.ts', role: 'engineer', at: now - 20e3 },
          { tool: 'Edit', target: 'auth/middleware.ts', role: 'engineer', at: now - 5e3 },
          { ...JEV_CALL, at: now - 3e3 },
        ],
        tests: { command: 'npx tsx --test auth/*.test.ts', ok: false, at: now - 2 * 60e3, failed: 2, total: 538, first: 'redirects once after a Safari login',
          tail: ['ℹ tests 538', 'ℹ pass 536', 'ℹ fail 2', 'ℹ duration_ms 4210', '✖ failing tests:', '✖ redirects once after a Safari login (4.1ms)', '  AssertionError: expected 1 redirect, got 3', '✖ keeps the session cookie on refresh (2.7ms)'] } },
      { sessionId: 'd-done', cwd: '/Users/k/GitHub/agent-flow', state: 'done', startedAt: now - 42 * 60e3, at: now - 60e3,
        roles: (['researcher', 'engineer', 'qa'] as const).map((role, i) => ({ id: `${role[0]}1`, role, state: 'done' as const, startedAt: now - (40 - i * 10) * 60e3 })),
        tasks: [{ id: '1', subject: 'Types', status: 'completed' }, { id: '2', subject: 'AI registry', status: 'completed' }],
        commit: 'feat(hub): multi-AI chats and Starred chats', finishedAt: now - 60e3, finishing: true,
        asked: ['Add Codex to the hub next to Claude', 'Let me star chats and resume them later'], covered: [0.95, 0.91],
        report: { done: ['Chats from Claude and Codex in one list', 'Starred chats with a resume command', 'Tests and build pass'], left: [] },
        tools: [
          { tool: 'Edit', target: 'hub/types.ts', role: 'engineer', at: now - 5 * 60e3 },
          { tool: 'Bash', target: 'pnpm test', role: 'qa', at: now - 2 * 60e3 },
        ] },
      // Finished, but one request is not covered: almost done, in teal. Its Left items are in the to-do.
      { sessionId: 'd-almost', cwd: '/Users/k/GitHub/agent-flow', state: 'done', startedAt: now - 70 * 60e3, at: now - 4 * 60e3,
        roles: (['researcher', 'engineer', 'qa', 'designer'] as const).map((role, i) => ({ id: `${role[0]}2`, role, state: 'done' as const, startedAt: now - (65 - i * 12) * 60e3 })),
        tasks: [{ id: '1', subject: 'Parse the standup', status: 'completed', role: 'engineer' }, { id: '2', subject: 'Receipt on the card', status: 'completed', role: 'designer' }, { id: '3', subject: 'QA pass', status: 'completed', role: 'qa' }],
        commit: 'Show what is left on a finished chat', finishedAt: now - 4 * 60e3, finishing: true,
        asked: ['Make finished unmistakable: full green only when everything is done', 'And a different color for almost done', 'Send me a summary at the end of the day'], covered: [0.93, 0.9, 0.08],
        report: { done: ['Standup parsed from the last message', 'Almost done chip in teal', 'Receipt on the card and the picture'], left: ['Rebuild the vsix and reload VS Code', 'Check the phone layout on a real device'] },
        tools: [{ tool: 'Bash', target: 'npm test', role: 'qa', at: now - 5 * 60e3 }] },
      // The lead stopped with a commit block, but an engineer and a test run still go, so it is not finished.
      { sessionId: 'd-wrap', cwd: '/Users/k/GitHub/agent-flow', state: 'working', waiting: true, finishing: true, startedAt: now - 25 * 60e3, at: now - 20e3,
        roles: [{ id: 'r1', role: 'researcher', state: 'done', startedAt: now - 24 * 60e3 }, { id: 'e1', role: 'engineer', state: 'active', startedAt: now - 9 * 60e3 }],
        running: ['e1'], jobs: [{ id: 'toolu_demo', label: 'Run root and extension test suites', startedAt: now - 3 * 60e3 }],
        tasks: [
          { id: '1', subject: 'Trace the Stop handling', status: 'completed', role: 'researcher' },
          { id: '2', subject: 'Done waits for background work', status: 'completed', role: 'engineer' },
          { id: '3', subject: 'Task tracker on the cards', status: 'completed', role: 'engineer' },
        ],
        commit: 'fix(hub): done only when nothing runs' },
      { sessionId: 'd-ask', cwd: '/Users/k/GitHub/Armasu', state: 'needs-you', startedAt: now - 5 * 60e3, at: now,
        roles: [{ id: 'g1', role: 'designer', state: 'active', startedAt: now - 4 * 60e3 }],
        tasks: [{ id: '1', subject: 'Draft the picker labels', status: 'completed', role: 'designer' }, { id: '2', subject: 'Pick the closet name', status: 'in_progress', role: 'designer' }, { id: '3', subject: 'Ship copy for review', status: 'pending', role: 'growth' }],
        question: "Keep 'Closet' or rename it to 'Wardrobe'?" },
      { sessionId: 'd-idle', cwd: '/Users/k/GitHub/claude-mods', state: 'idle', startedAt: now - 90 * 60e3, at: now - 30 * 60e3,
        roles: [], tasks: [{ id: '1', subject: 'Drop old presets', status: 'pending' }] },
    ],
    ais: [
      { id: 'claude', name: 'Claude Code', installed: true, chats: 3 },
      { id: 'codex', name: 'Codex', installed: false, detail: 'CLI not installed: npm i -g @openai/codex', chats: 0 },
    ],
    starred: [
      { sessionId: 'd1b7e00d-d8c7-429e-a4b3-4420e8b32e67', ai: 'claude', name: 'agentFlow', cwd: '/Users/k/Documents/GitHub/agent-flow', starredAt: now - DAY, live: false,
        digest: { lastPrompt: 'add codex to the hub', resume: 'claude --resume d1b7e00d-d8c7-429e-a4b3-4420e8b32e67', updatedAt: now - 3600_000 } },
    ],
    // The working chat's three earlier chats, each closed when it filled up, and one older chain.
    archive: [...[1, 2, 3].map(v => ({
      sessionId: `d-fix-v${v}`, ai: 'claude' as const, name: v === 1 ? 'Fix login redirect' : `Fix login redirect v${v}`, origin: 'Fix login redirect', version: v,
      cwd: '/Users/k/GitHub/Armasu', project: 'Armasu', note: `/Users/k/.claude/handoffs/Armasu/fix-login-redirect-v${v}.md`,
      startedAt: now - (4 - v) * 5 * 3600_000 - 3 * 3600_000, archivedAt: now - (4 - v) * 5 * 3600_000,
    })), {
      sessionId: 'd-banner-v1', ai: 'claude' as const, name: 'Cookie banner copy', origin: 'Cookie banner copy', version: 1,
      cwd: '/Users/k/GitHub/Armasu', project: 'Armasu', note: '/Users/k/.claude/handoffs/Armasu/cookie-banner-copy-v1.md',
      startedAt: now - 5 * DAY - 2 * 3600_000, archivedAt: now - 5 * DAY,
    }],
    rcServers: [{ folder: '/Users/k/Documents/GitHub', name: 'Mac', on: true }],
    live: [{ sessionId: 'd-work', cwd: '/Users/k/GitHub/Armasu', label: 'Fix login redirect v4', model: 'claude-opus-5-5', tokens: 64_000, compactAt: 167_000, costUsd: 1.84, at: now, limits: [] },
      { sessionId: 'demo-1', cwd: '/Users/k/Documents/GitHub/Armasu', label: 'Setupfeatures', model: 'claude-opus-5-5', tokens: 82_000, compactAt: 167_000, at: now,
      limits: [{ kind: 'five_hour', percentUsed: 41, resetsAt: new Date(now + 130 * 60_000).toISOString() }, { kind: 'seven_day', percentUsed: 78, resetsAt: new Date(now + 2.1 * DAY).toISOString() }] }],
    history: REREAD.map((m, i) => ({ day: day(i), reread: m * 1e6, written: m * 2e4, io: m * 4e3, calls: CALLS[i], sessions: CALLS[i] ? 1 + (i % 3) : 0 })),
    sessions: [
      { sessionId: 'demo-1', label: 'Setupfeatures', project: 'Armasu', reread: 363.7e6, calls: 2100, startedAt: now - 9 * 3600_000, lastAt: now - 4 * 60_000 },
      { sessionId: 'demo-2', label: 'Closet regen button', project: 'Armasu', reread: 1.03e9, calls: 5100, startedAt: now - 20 * 3600_000, lastAt: now - 4 * 60_000 },
      { sessionId: 'demo-3', label: 'CSEN122 notes', project: 'CSEN122', reread: 20.3e6, calls: 140, startedAt: now - 3 * DAY, lastAt: now - 2 * DAY },
    ],
    plan: { name: '2026-10-23-switchboard.md', tasks: [
      { title: '1 Fork identity and a clean build', done: 4, total: 4 }, { title: '2 Contract, hub service and the feed routes', done: 5, total: 5 },
      { title: '3 History and sessions from the transcripts', done: 3, total: 3 }, { title: '4 The usage mod becomes the feed', done: 2, total: 4 },
      { title: '5 Hub tab', done: 0, total: 4 }, { title: '6 Timeline', done: 0, total: 5 },
    ] },
    servers: [
      { pid: 29313, command: 'node', port: 3000, folder: 'GitHub/Armasu' },
      { pid: 2635, command: 'Python', port: 4211, folder: 'scratchpad/profile-site' },
      { pid: 18558, command: 'node', port: 4262, folder: 'GitHub/Armasu' },
    ],
    git: { branch: 'Social-media-dev', ahead: 0, behind: 0, changed: 55, staged: 0, untracked: 7 },
    dev: [
      { folder: '/Users/k/Documents/GitHub/Armasu', project: 'Armasu', repo: 'Armasu', command: 'pnpm run dev', port: 3000, link: `${DEMO_TAILNET}:13000` },
      { folder: '/Users/k/Documents/GitHub/QR-Test', project: 'QR-Test', repo: 'QR-Test', command: 'npm run dev' },
    ],
    tailscale: true,
    awake: false,
    tools: { flagged: DEMO_FLAGGED, pick: null, chats: { 'd-work': { plugins: { 'superpowers@superpowers-dev': true, 'aws-core@claude-plugins-official': false, 'stitch-design@google-labs-code-stitch-skills': false }, skills: { 'claude-x-jev': false, phone: false }, assets: { 'docs/design/raycast-DESIGN.md': true } } } },
    installed: [
      { kind: 'mod', name: 'usage-meter@kenneth-mods', enabled: true }, { kind: 'mod', name: 'repo-rules@kenneth-mods', enabled: true }, { kind: 'mod', name: 'paid-guard@kenneth-mods', enabled: true },
      { kind: 'plugin', name: 'superpowers@superpowers-dev', enabled: true, skills: ['brainstorming', 'test-driven-development', 'writing-plans'], description: 'Planning, test-first coding and review habits for every chat.' }, { kind: 'plugin', name: 'aws-core@claude-plugins-official', enabled: true, description: 'AWS docs, CLI help and account checks.' }, { kind: 'plugin', name: 'stitch-design@google-labs-code-stitch-skills', enabled: false },
      { kind: 'skill', name: 'claude-x-jev', enabled: true, description: 'Sorts and scores many items cheaply with Jev.' }, { kind: 'skill', name: 'phone', enabled: true, description: 'Sends a push notification to your phone.' }, { kind: 'skill', name: 'drei', enabled: false },
      { kind: 'role', name: 'researcher', enabled: true, model: 'haiku' }, { kind: 'role', name: 'engineer', enabled: true, model: 'opus' }, { kind: 'role', name: 'qa', enabled: true, model: 'opus' },
      { kind: 'role', name: 'designer', enabled: true, model: 'opus' }, { kind: 'role', name: 'ops', enabled: true, model: 'haiku' }, { kind: 'role', name: 'growth', enabled: true, model: 'sonnet' },
      { kind: 'preset', name: 'armasu-copy-check', enabled: true }, { kind: 'preset', name: 'armasu-route-release', enabled: true },
    ],
    connections: [
      { kind: 'mcp', name: 'openrouter', status: 'on', detail: 'Armasu' }, { kind: 'mcp', name: 'aws-mcp', status: 'error', detail: 'sign in' }, { kind: 'app', name: 'Claude Docs', status: 'on' },
      { kind: 'project', name: 'Armasu', status: 'on', detail: 'Claude Code history' }, { kind: 'project', name: 'CSEN122', status: 'on', detail: 'Claude Code history' },
      { kind: 'window', name: 'Armasu', status: 'on', detail: 'Switchboard window' }, { kind: 'repo', name: 'Gemini-Test', status: 'on', detail: 'GitHub' },
    ],
    aws: [
      { name: 'default', isDefault: true, account: '111122223333', label: 'k@example.com', region: 'us-west-1', status: 'signed-in', chrome: 'Default', checkedAt: now },
      { name: 'live', isDefault: false, account: '111122223333', label: 'k@example.com', region: 'us-west-1', status: 'signed-in', chrome: 'Default', checkedAt: now },
      { name: 'yo', isDefault: false, account: '444455556666', label: 'Work sandbox', region: 'us-east-1', status: 'expired', chrome: 'Profile 2', checkedAt: now },
      { name: 'scratch', isDefault: false, region: 'eu-central-1', status: 'never', checkedAt: now },
      { name: 'owner', isDefault: false, account: '777788889999', label: 'Main account root', region: 'us-east-1', status: 'signed-in', checkedAt: now, root: true },
      { name: 'previous-default-20261029-073925', isDefault: false, account: '444455556666', region: 'us-west-1', status: 'expired', checkedAt: now, stale: true },
      { name: 'previous-default-20261029-073933', isDefault: false, account: '444455556666', region: 'us-west-1', status: 'expired', checkedAt: now, stale: true },
    ],
    signIns: {
      chrome: [{ dir: 'Default', name: 'Personal', email: 'k@example.com' }, { dir: 'Profile 2', name: 'Work', email: 'k@work.example' }],
      projects: { '/Users/k/GitHub/Armasu': 'live' },
      window: '/Users/k/GitHub/Armasu',
      apps: [{
        id: 'auth0', name: 'Auth0', url: 'https://manage.auth0.com/', active: 'a-work',
        logins: [
          { id: 'a-work', label: 'Work tenant', url: 'https://manage.auth0.com/dashboard/us/acme-prod/', chrome: 'Profile 2' },
          { id: 'a-dev', label: 'Dev tenant', url: 'https://manage.auth0.com/dashboard/us/acme-dev/', chrome: 'Profile 2' },
          { id: 'a-me', label: 'Personal', url: 'https://manage.auth0.com/', chrome: 'Default' },
        ],
      }, {
        id: 'vercel', name: 'Vercel', url: 'https://vercel.com/login', active: 'v-me',
        logins: [{ id: 'v-me', label: 'k@example.com personal team', url: 'https://vercel.com/login', chrome: 'Default' }],
      }],
      links: { '/Users/k/GitHub/Armasu': { auth0: 'a-dev', vercel: null }, '/Users/k/Documents/GitHub/Gemini-Test': { auth0: 'a-me' } },
    },
    jev: [
      { sessionId: 'd-work', preset: 'triage-comments', items: 24, costUsd: 0.0061, seconds: 7.2, at: now - 8 * 60e3 },
      { sessionId: 'd-done', preset: 'lead-score', items: 40, costUsd: 0.0123, seconds: 11.4, at: now - 30 * 60e3 },
    ],
  }
}

const ROLES = ['researcher', 'engineer', 'qa']
// The working demo chat ran Jev, so the orbit shows its bubble and, every sixth tick, a Jev pill.
const JEV_ROLE = { id: 'jev', role: 'jev', state: 'done', startedAt: 0 } as const
// The working demo chat's subagents over one 20 s loop: [id, role, start, end] in ms, so bubbles pop in and out.
const RUNS: [string, string, number, number][] = [
  ['r1', 'researcher', 0, 6_667], ['r2', 'researcher', 1_200, 12_000],
  ['e1', 'engineer', 6_667, 15_000], ['e2', 'engineer', 8_000, 20_000],
  ['q1', 'qa', 10_000, 20_000], ['q2', 'qa', 15_500, 20_000],
]
/** The runs started by ms into the loop; at 11 s: two engineers, a researcher and qa running, one researcher done. */
const demoRuns = (ms: number, now: number) => RUNS.filter(r => r[2] <= ms)
  .map(([id, role, start, end]) => ({ id, role, state: end <= ms ? 'done' as const : 'active' as const, startedAt: now - (ms - start) }))
const JEV_CALL = { tool: 'triage-comments', target: '24 items · $0.0061', role: 'jev' }
const CALLS_BY_ROLE: Record<string, [string, string][]> = {
  researcher: [['Grep', 'redirect'], ['Read', 'auth/middleware.ts'], ['Glob', '**/*.test.ts'], ['Read', 'lib/session.ts']],
  engineer: [['Edit', 'auth/middleware.ts'], ['Write', 'auth/redirect.test.ts'], ['Bash', 'pnpm test auth'], ['Edit', 'lib/session.ts']],
  qa: [['Bash', 'pnpm test'], ['Bash', 'pnpm tsc --noEmit'], ['Read', 'auth/middleware.ts'], ['Grep', 'TODO']],
}

/** One more tool call on the working demo chat; the calling role turns researcher, engineer, qa every 20 s, and subagents start and stop on RUNS. */
export function demoTick(h: HubState, now: number): HubState {
  const i = Math.floor((now % 20_000) / (20_000 / 3)), role = ROLES[i]
  const pick = CALLS_BY_ROLE[role][Math.floor(now / 900) % 4]
  const call: ToolCall = Math.floor(now / 900) % 6 === 0 ? { ...JEV_CALL, at: now } : { tool: pick[0], target: pick[1], role, at: now }
  return { ...h, progress: h.progress.map(p => p.sessionId !== 'd-work' ? p : {
    ...p, at: now,
    roles: [...demoRuns(now % 20_000, now), JEV_ROLE],
    tasks: p.tasks.map((t, n) => {
      // A role with two tasks is on its later one.
      const j = ROLES.indexOf(t.role ?? ''), later = p.tasks.slice(n + 1).some(u => u.role === t.role)
      return { ...t, status: j < i || (j === i && later) ? 'completed' : j === i ? 'in_progress' : 'pending' }
    }),
    tools: [...(p.tools ?? []), call].slice(-200),
  }) }
}

// What the demo's handoff notes say, for History search.
const NOTES: Record<string, string> = {
  'd-fix-v1': 'Found the redirect loop in auth/middleware.ts: /login sends a signed-in user back to /login.',
  'd-fix-v2': 'Wrote the failing test in auth/redirect.test.ts. Next: the session check in lib/session.ts.',
  'd-fix-v3': 'The cookie check skipped SameSite on Safari, so the session looked empty and the redirect looped. Fix the check next.',
  'd-banner-v1': 'Rewrote the banner text to match the new privacy page. Waiting on legal for the last line.',
}

const diffOf = (rows: string[]) => rows.join('\n')
/** The demo chats' uncommitted files. */
const CHANGES: Record<string, ChangedFile[]> = {
  'd-work': [
    { path: 'auth/middleware.ts', added: 18, removed: 6, status: 'modified', diff: diffOf(['@@ -12,9 +12,21 @@ export function middleware(req: Request) {', '   const session = readSession(req)', '-  if (!session) return redirect(\'/login\')', '+  if (!session && !isLogin(req)) return redirect(\'/login\')', '+  if (session && isLogin(req)) return redirect(\'/home\')', '   return next()']) },
    { path: 'auth/redirect.test.ts', added: 24, removed: 0, status: 'untracked', diff: diffOf(['+import { next } from \'./middleware\'', '+', "+it('stops the redirect loop', async () => {", "+  expect(await next('/login')).toBe('/home')", '+})']) },
    { path: 'lib/session.ts', added: 0, removed: 3, status: 'modified', diff: diffOf(['@@ -40,7 +40,4 @@ export function readSession(req: Request) {', '-  // TODO: cover the loop', '-  if (ua.includes(\'Safari\')) return null', '-', '   return parse(req.headers.get(\'cookie\'))']) },
    { path: 'public/login-hero.png', added: 0, removed: 0, status: 'modified', note: 'Binary file: no text diff.' },
  ],
  'd-done': [
    { path: 'extension/src/hub/ais.ts', added: 149, removed: 0, status: 'added', note: 'This diff is too big to show here (152 lines). Open it in VS Code.' },
    { path: 'extension/src/hub/types.ts', added: 6, removed: 1, status: 'modified', diff: diffOf(['@@ -60,7 +60,12 @@', "-export type ChatRow = { pid: number; sessionId: string }", "+export type AiId = 'claude' | 'codex'", '+export type ChatRow = { pid: number; sessionId: string; ai?: AiId }']) },
  ],
}

/** The demo's Git panel: the chat's changed files on a feature branch two commits ahead. */
const demoRepo = (h: HubState, sessionId: string): RepoView => {
  const cwd = h.chats.find(x => x.sessionId === sessionId)?.cwd ?? ''
  const files = (CHANGES[sessionId] ?? []).map(f => ({ path: f.path, status: f.status }))
  const branch = sessionId === 'd-done' ? 'main' : 'fix/login-redirect'
  return {
    sessionId, name: cwd.split('/').pop() ?? '', branch, upstream: `origin/${branch}`, ahead: 2, behind: 0, files,
    branches: [branch, 'main', 'design/outfit-copy'].filter((b, i, a) => a.indexOf(b) === i), sync: { kind: 'push', label: 'Push 2' },
    log: [{ hash: 'a41c9e2', subject: 'Wrote the failing redirect test', when: '12 minutes ago' }, { hash: '7d03b18', subject: 'Read the session cookie on Safari', when: '40 minutes ago' }, { hash: '1f9e0aa', subject: 'Add login page hero', when: '2 days ago' }],
    stashes: 0, github: `https://github.com/kennykennethkkang/${cwd.split('/').pop()}`, at: Date.now(),
    ...(sessionId === 'd-work' ? demoMerge(Date.now()) : {}),
  }
}

/** The PR and CI cards: main moved on under the login fix, with Lena's key rotation on the same lines, and CI failed on it. */
const demoMerge = (now: number): Pick<RepoView, 'pr' | 'merge' | 'ci'> => {
  const ago = (m: number) => now - m * 60e3
  return {
    ci: { id: 9182736451, workflow: 'CI', status: 'completed', conclusion: 'failure', url: 'https://github.com/kennykennethkkang/Armasu/actions/runs/9182736451', sha: 'a41c9e2', at: ago(3),
      jobs: [{ name: 'lint', status: 'completed', conclusion: 'success' }, { name: 'typecheck', status: 'completed', conclusion: 'success' }, { name: 'test (node 22)', status: 'completed', conclusion: 'failure', step: 'npm test' }, { name: 'build', status: 'completed', conclusion: 'skipped' }] },
    pr: { url: 'https://github.com/kennykennethkkang/Armasu/pull/128', state: 'OPEN', title: 'Stop the login redirect loop on Safari', number: 128, additions: 482, deletions: 37, base: 'main' },
    merge: {
      base: 'main', behind: 4, files: 3,
      conflicts: [
        { path: 'auth/auth.ts', by: 'Lena', line: 42, theirs: 'const key = await rotateSessionKey(user.id)', ours: 'const key = readSessionKey(req, { safari: true })' },
        { path: 'auth/middleware.ts', by: 'Lena', line: 18, theirs: 'if (!session || session.expired) return redirect(\'/login\')', ours: 'if (!session && !isLogin(req)) return redirect(\'/login\')' },
        { path: 'lib/session.ts', by: 'Lena', line: 7, theirs: 'export const KEY_TTL = 60 * 60', ours: '' },
      ],
      commits: [
        { hash: 'a41c9e2', author: 'You', at: ago(0) }, { hash: 'c7e21f0', author: 'Lena', at: ago(6) }, { hash: '7d03b18', author: 'You', at: ago(18) },
        { hash: '5b8d4a1', author: 'Lena', at: ago(41) }, { hash: '0e6f3c9', author: 'Sam', at: ago(120) },
      ],
    },
  }
}

/** The browser demo has no extension behind it, so the Hub's own settings apply here. */
export function demoApply(h: HubState, c: HubCommand): HubState {
  switch (c.type) {
    // A full chat always continues fresh, so only the branch switch applies.
    case 'hub-keep': return c.freshBranch === undefined ? h : { ...h, keep: { ...h.keep, freshBranch: c.freshBranch } }
    case 'hub-setting': {
      const keep = { ...h.keep }, claude = { ...h.controls.claude }
      if (c.key === 'autoCompactEnabled') keep.autoCompact = c.value === true
      if (c.key === 'autoContinueAtUsageLimit') keep.autoContinue = c.value === true
      if (c.key === 'autoCompactWindow' && typeof c.value === 'number') keep.window = c.value
      if (c.key === 'model') claude.model = (c.value ?? undefined) as typeof claude.model
      if (c.key === 'effortLevel') claude.effortLevel = (c.value ?? undefined) as typeof claude.effortLevel
      if (c.key === 'tui') claude.tui = c.value === 'fullscreen' ? 'fullscreen' : 'default'
      if (c.key === 'statusLine') claude.statusLine = c.value === true
      if (c.key === 'agentPushNotifEnabled') claude.push = c.value === true
      if (c.key === 'inputNeededNotifEnabled') claude.needInput = c.value === true
      return { ...h, keep, controls: { ...h.controls, claude } }
    }
    case 'hub-switchboard': return { ...h, controls: { ...h.controls, switchboard: { ...h.controls.switchboard, [c.key]: c.value } } }
    case 'hub-toggle': return { ...h, installed: h.installed.map(i => (i.kind === c.kind && i.name === c.name ? { ...i, enabled: c.enabled } : i)) }
    case 'hub-rc': {
      if (!c.sessionId) return { ...h, rc: { ...h.rc, atStartup: c.on } }
      const bridgeId = `session_01${c.sessionId}`
      return { ...h, chats: h.chats.map(x => (x.sessionId !== c.sessionId ? x : c.on ? { ...x, bridgeId, link: `https://claude.ai/code/${bridgeId}`, why: [] } : { ...x, bridgeId: undefined, link: 'https://claude.ai/code', why: ['not connected'] })) }
    }
    case 'hub-star': {
      if (!c.on) return { ...h, starred: h.starred.filter(s => s.sessionId !== c.sessionId) }
      const chat = h.chats.find(x => x.sessionId === c.sessionId), row = h.sessions.find(x => x.sessionId === c.sessionId)
      const resume = c.ai === 'codex' ? `codex resume ${c.sessionId}` : `claude --resume ${c.sessionId}`
      return { ...h, starred: [...h.starred.filter(s => s.sessionId !== c.sessionId), { sessionId: c.sessionId, ai: c.ai, name: chat?.name ?? row?.label ?? c.sessionId.slice(0, 8), cwd: chat?.cwd ?? '', starredAt: Date.now(), live: !!chat?.live, digest: { resume } }] }
    }
    case 'hub-new-chat': {
      // The extension asks a model for the name; the demo takes the goal's first five words.
      const first = (c.text ?? '').split(/\s+/).filter(Boolean).slice(0, 5).join(' ')
      const name = first ? first[0].toUpperCase() + first.slice(1) : 'New chat'
      const sessionId = `d-new-${h.chats.length + 1}`, now = Date.now()
      return {
        ...h,
        chats: [{ pid: 0, sessionId, name, cwd: c.path, link: '', live: true, why: [] }, ...h.chats],
        progress: [{ sessionId, cwd: c.path, state: 'working', roles: [], tasks: [], startedAt: now, at: now }, ...h.progress],
        ...(h.tools ? { tools: { ...h.tools, pick: null, chats: { ...h.tools.chats, [sessionId]: c.tools ?? demoPick(h, c.text ?? '') } } } : {}),
      }
    }
    case 'hub-pick-tools': return h.tools ? { ...h, tools: { ...h.tools, pick: { goal: c.text, profile: demoPick(h, c.text) } } } : h
    case 'hub-chat-tools': return h.tools ? { ...h, tools: { ...h.tools, chats: { ...h.tools.chats, [c.sessionId]: c.tools } } } : h
    case 'hub-focus-chat': return h
    case 'hub-changes': {
      const cwd = h.chats.find(x => x.sessionId === c.sessionId)?.cwd ?? ''
      return { ...h, changes: { sessionId: c.sessionId, cwd, files: CHANGES[c.sessionId] ?? [], at: Date.now() }, repo: demoRepo(h, c.sessionId) }
    }
    case 'hub-git': {
      const r = h.repo?.sessionId === c.sessionId ? h.repo : demoRepo(h, c.sessionId)
      const done = (text: string, patch: Partial<RepoView> = {}) => ({ ...h, repo: { ...r, ...patch, result: { text: `Demo: ${text}`, ok: true, at: Date.now() } } })
      if (c.op === 'commit') return done(`committed ${c.files?.length ?? 0} files to ${r.branch}`, { files: r.files.filter(f => !c.files?.includes(f.path)), ahead: r.ahead + 1, sync: { kind: 'push', label: `Push ${r.ahead + 1}` } })
      if (c.op === 'sync') return done(`pushed ${r.ahead} commits to ${r.upstream}`, { ahead: 0, sync: { kind: 'fetch', label: 'Fetch' } })
      if (c.op === 'rerun' && r.ci) return done(`re-running the failed jobs in ${r.ci.workflow}`, { ci: { ...r.ci, status: 'in_progress', conclusion: undefined, jobs: r.ci.jobs.map(j => j.conclusion === 'success' ? j : { name: j.name, status: 'queued' }) } })
      return done(`git ${c.op} would run here`)
    }
    case 'hub-search': {
      const q = c.q.trim()
      if (!q) return { ...h, search: null }
      const hits = h.archive.flatMap(a => {
        const text = NOTES[a.sessionId] ?? '', at = text.toLowerCase().indexOf(q.toLowerCase())
        return at < 0 ? [] : [{ sessionId: a.sessionId, snippet: `${at > 30 ? '...' : ''}${text.slice(Math.max(0, at - 30), at + q.length + 50)}...` }]
      })
      return { ...h, search: { q, hits } }
    }
    case 'hub-aws-default': {
      const to = h.aws.find(a => a.name === c.profile), was = h.aws.find(a => a.isDefault)
      if (!to || to.isDefault) return h
      const backup = was && was.account !== to.account ? [{ ...was, name: 'previous-default-demo', isDefault: false }] : []
      return { ...h, aws: [...h.aws.map(a => a.isDefault ? { ...to, name: a.name, isDefault: true } : a), ...backup] }
    }
    case 'hub-aws-label': {
      const row = h.aws.find(a => a.name === c.profile)
      if (!row) return h
      const same = (a: typeof row) => (row.account ? a.account === row.account : a.name === row.name)
      return { ...h, aws: h.aws.map(a => same(a) ? { ...a, label: c.label.trim() || undefined } : a) }
    }
    case 'hub-aws-add':
      return h.aws.some(a => a.name === c.profile) ? h : { ...h, aws: [...h.aws, { name: c.profile, isDefault: false, region: c.region, status: 'never', chrome: c.chrome ?? '', checkedAt: Date.now() }] }
    case 'hub-aws-login':
      return { ...h, aws: h.aws.map(a => a.name === c.profile ? { ...a, status: 'signed-in', chrome: c.chrome ?? '' } : a) }
    case 'hub-aws-window': {
      const w = h.signIns.window
      if (!w) return h
      const { [w]: _was, ...rest } = h.signIns.projects
      return { ...h, signIns: { ...h.signIns, projects: c.profile === null ? rest : { ...rest, [w]: c.profile } } }
    }
    case 'hub-role-model': return { ...h, installed: h.installed.map(i => (i.kind === 'role' && i.name === c.role ? { ...i, model: c.model } : i)) }
    case 'hub-aws-delete':
      return h.aws.some(a => a.name === c.profile && !a.isDefault) ? { ...h, aws: h.aws.filter(a => a.name !== c.profile) } : h
    case 'hub-login-app-add': {
      const apps = h.signIns.apps ?? []
      if (!c.name.trim() || apps.some(a => a.name.toLowerCase() === c.name.trim().toLowerCase())) return h
      return { ...h, signIns: { ...h.signIns, apps: [...apps, { id: `app-${Date.now()}`, name: c.name.trim(), url: c.url, logins: [] }] } }
    }
    case 'hub-login-app-delete':
      return { ...h, signIns: { ...h.signIns, apps: (h.signIns.apps ?? []).filter(a => a.id !== c.app) } }
    case 'hub-browser': {
      const { [c.folder]: _was, ...rest } = h.signIns.browsers ?? {}
      return { ...h, signIns: { ...h.signIns, browsers: c.chrome === null ? rest : { ...rest, [c.folder]: c.chrome } } }
    }
    case 'hub-login-link': {
      const links = h.signIns.links ?? {}
      const { [c.app]: _was, ...rest } = links[c.folder] ?? {}
      return { ...h, signIns: { ...h.signIns, links: { ...links, [c.folder]: c.login === 'off' ? rest : { ...rest, [c.app]: c.login } } } }
    }
    case 'hub-login-add':
    case 'hub-login-open':
    case 'hub-login-active':
    case 'hub-login-rename':
    case 'hub-login-delete': {
      const apps = (h.signIns.apps ?? []).map(a => {
        if (a.id !== c.app) return a
        if (c.type === 'hub-login-add') {
          const id = `l-${Date.now()}`
          return { ...a, logins: [...a.logins, { id, label: c.label.trim(), url: c.url, chrome: c.chrome }], active: a.active ?? id }
        }
        if (c.type === 'hub-login-active') return { ...a, active: c.id }
        if (c.type === 'hub-login-delete') {
          const logins = a.logins.filter(l => l.id !== c.id)
          return { ...a, logins, active: a.active === c.id ? logins[0]?.id : a.active }
        }
        return { ...a, logins: a.logins.map(l => l.id !== c.id ? l : c.type === 'hub-login-rename' ? { ...l, label: c.label.trim() || l.label } : { ...l, chrome: c.chrome ?? l.chrome }) }
      })
      return { ...h, signIns: { ...h.signIns, apps } }
    }
    case 'hub-dev-start':
    case 'hub-dev-stop': {
      const row = h.dev?.find(d => d.folder === c.folder)
      if (!row) return h
      const { port: _p, link: _l, ...stopped } = row
      const next = c.type === 'hub-dev-stop' ? stopped : row.port ? row : { ...row, port: 5173, link: `${DEMO_TAILNET}:15173` }
      return { ...h, dev: h.dev?.map(d => (d === row ? next : d)) }
    }
    case 'hub-todo-add':
    case 'hub-todo-edit':
    case 'hub-todo-remove':
    case 'hub-todo-restore':
    case 'hub-todo-run': {
      const list = h.todos?.[c.path]
      if (!list) return h
      const set = (l: typeof list) => ({ ...h, todos: { ...h.todos, [c.path]: l } })
      const now = Date.now(), id = `dt-${now.toString(36)}`
      if (c.type === 'hub-todo-add') return c.text.trim() ? set({ ...list, todo: [...list.todo, { id, text: c.text.trim(), at: now }] }) : h
      if (c.type === 'hub-todo-edit') return set({ ...list, todo: list.todo.map(t => (t.id === c.id ? { ...t, text: c.text.trim() || t.text, at: now } : t)) })
      if (c.type === 'hub-todo-remove') {
        const t = list.todo.find(x => x.id === c.id)
        return t ? set({ ...list, todo: list.todo.filter(x => x !== t), ticked: [{ id: t.id, text: t.text, at: now }, ...list.ticked ?? []].slice(0, 10) }) : h
      }
      if (c.type === 'hub-todo-restore') {
        const t = list.ticked?.find(x => x.id === c.id)
        if (!t) return h
        const { id: _i, at: _a, by: _b, ...more } = t
        return set({ ...list, ticked: list.ticked!.filter(x => x !== t), todo: [...list.todo, { ...more, id, at: now }] })
      }
      // Run: a new demo chat (or the one named) takes the items and their open prerequisites.
      const run = runIds(list.todo, c.ids), items = list.todo.filter(t => run.has(t.id))
      const started = c.to ? h : demoApply(h, { type: 'hub-new-chat', path: c.path, text: items.map(t => t.text).join('; '), remote: false })
      const chat = c.to ?? started.chats[0].sessionId
      return { ...started, todos: { ...h.todos, [c.path]: { ...list, todo: list.todo.map(t => (run.has(t.id) ? { ...t, chat, at: now } : t)) } } }
    }
    case 'hub-awake': return { ...h, awake: c.on }
    case 'hub-rc-server': return { ...h, rcServers: h.rcServers.map(r => (r.folder === c.folder ? { ...r, on: c.on } : r)) }
    default: return h
  }
}
