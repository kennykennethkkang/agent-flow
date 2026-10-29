/**
 * Discovery-file-based service discovery for hook forwarding.
 *
 * Each VS Code instance writes a discovery file containing its hook server
 * port and PID. The hook forwarding script reads these at invocation time
 * to find live instances — no port numbers in settings.json, no races.
 *
 * Discovery dir: ~/.claude/switchboard/
 * Discovery file: {workspace-hash}-{pid}.json
 * Hook script:   ~/.claude/switchboard/hook.js
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { execSync } from 'child_process'
import { HOOK_TIMEOUT_S, HOOK_SAFETY_MARGIN_MS, HOOK_FORWARD_TIMEOUT_MS, WORKSPACE_HASH_LENGTH } from './constants'
import { createLogger } from './logger'
import { hub } from './hub/hub-service'

const log = createLogger('Discovery')

// Its own folder, so Agent Flow's uninstall (which deletes ~/.claude/agent-flow) never touches it.
const DISCOVERY_DIR = path.join(os.homedir(), '.claude', 'switchboard')
const HOOK_SCRIPT_PATH = path.join(DISCOVERY_DIR, 'hook.js')
const WORKSPACES_MANIFEST_PATH = path.join(DISCOVERY_DIR, 'workspaces.json')

/** Identifier substring used to detect our command hooks in settings.json */
export const HOOK_COMMAND_MARKER = 'switchboard/hook.js'

/** Resolve the absolute path to the `node` binary.
 *  VS Code's extension host runs in Electron, so process.execPath is not node.
 *  We shell out to `command -v node` (POSIX) or `where node` (Windows) using
 *  the VS Code environment's PATH which typically has node available. */
let cachedNodePath: string | null = null
function resolveNodePath(): string {
  if (cachedNodePath) return cachedNodePath
  try {
    const cmd = process.platform === 'win32' ? 'where node' : 'command -v node'
    const result = execSync(cmd, { encoding: 'utf8', timeout: 3000 }).trim()
    // `where` on Windows may return multiple lines — use the first
    const firstLine = result.split(/\r?\n/)[0].trim()
    if (firstLine) {
      cachedNodePath = firstLine
      log.info(`Resolved node path: ${cachedNodePath}`)
      return cachedNodePath
    }
  } catch (err) {
    log.debug('Failed to resolve absolute node path, falling back to bare "node":', err)
  }
  cachedNodePath = 'node'
  return cachedNodePath
}

export function getHookCommand(): string {
  const nodePath = resolveNodePath()
  return `"${nodePath}" "${HOOK_SCRIPT_PATH}"`
}

/** Resolve and normalize a path, following symlinks where possible. */
function normalizePath(p: string): string {
  let resolved = path.resolve(p)
  try { resolved = fs.realpathSync(resolved) } catch { /* use path.resolve result if realpathSync fails */ }
  return resolved
}

export function hashWorkspace(workspace: string): string {
  return crypto.createHash('sha256').update(normalizePath(workspace)).digest('hex').slice(0, WORKSPACE_HASH_LENGTH)
}

// ─── Discovery Files ──────────────────────────────────────────────────────────

export function writeDiscoveryFile(port: number, workspace: string): void {
  ensureDir()
  const hash = hashWorkspace(workspace)
  const filePath = path.join(DISCOVERY_DIR, `${hash}-${process.pid}.json`)
  // hubToken lets this machine's usage mods post to the Hub; owner-only, like a key.
  fs.writeFileSync(filePath, JSON.stringify({
    port,
    pid: process.pid,
    workspace: normalizePath(workspace),
    hubToken: hub.token,
  }, null, 2) + '\n', { mode: 0o600 })
  try { fs.chmodSync(filePath, 0o600) } catch { /* Windows keeps its own ACLs */ }
  log.info(`Wrote ${filePath}`)
}

export function removeDiscoveryFile(workspace: string): void {
  const hash = hashWorkspace(workspace)
  const filePath = path.join(DISCOVERY_DIR, `${hash}-${process.pid}.json`)
  try {
    fs.unlinkSync(filePath)
    log.info(`Removed ${filePath}`)
  } catch { /* expected if file was already removed */ }
}

// ─── Workspace Manifest ──────────────────────────────────────────────────────
// Tracks every workspace where hooks have been written to settings.local.json.
// Survives crashes and discovery-file cleanup — the uninstall script reads this
// to find all project-level settings files that need cleaning.

export function addWorkspaceToManifest(workspace: string): void {
  ensureDir()
  const resolved = normalizePath(workspace)
  const workspaces = readManifest()
  if (workspaces.includes(resolved)) { return }
  workspaces.push(resolved)
  fs.writeFileSync(WORKSPACES_MANIFEST_PATH, JSON.stringify(workspaces, null, 2) + '\n')
}

function readManifest(): string[] {
  try {
    if (!fs.existsSync(WORKSPACES_MANIFEST_PATH)) { return [] }
    const data = JSON.parse(fs.readFileSync(WORKSPACES_MANIFEST_PATH, 'utf-8'))
    return Array.isArray(data) ? data : []
  } catch (err) {
    log.debug('Failed to read workspaces manifest:', err)
    return []
  }
}

// ─── Hook Script ──────────────────────────────────────────────────────────────

export function ensureHookScript(): void {
  ensureDir()
  const script = getHookScriptContent()
  try {
    if (fs.existsSync(HOOK_SCRIPT_PATH) && fs.readFileSync(HOOK_SCRIPT_PATH, 'utf8') === script) {
      return // already up to date
    }
  } catch { /* failed to read existing script — rewrite it */ }
  // Atomic write: write to temp file then rename, so a concurrent
  // `node hook.js` never reads a truncated/empty file during updates.
  const tmpPath = HOOK_SCRIPT_PATH + `.${process.pid}.tmp`
  fs.writeFileSync(tmpPath, script, { mode: 0o755 })
  fs.renameSync(tmpPath, HOOK_SCRIPT_PATH)
  log.info(`Installed hook script → ${HOOK_SCRIPT_PATH}`)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!fs.existsSync(DISCOVERY_DIR)) {
    fs.mkdirSync(DISCOVERY_DIR, { recursive: true })
  }
}

/** The forwarder script's text; exported for the test that runs it. */
export function getHookScriptContent(): string {
  return `#!/usr/bin/env node
// Agent Flow hook forwarder v7, installed by the Agent Flow VS Code extension.
// Claude Code invokes this as a command hook. It reads a discovery directory to
// find live extension instances, checks their PIDs, and forwards the event via
// HTTP POST. Dead instances are cleaned up automatically.
//
// v3: containment-based workspace matching (supports subdirectory CWD),
//     realpathSync normalization (handles symlinks), Windows-safe PID checks.
// v4: a cwd no window contains goes to the live window with the lowest pid.
// v5: Bash tool calls are allowed without a permission prompt.
// v6: every other live window gets a copy marked x-switchboard-mirror, for chat status only.
// v7: mirror copies give up after 300ms, so a frozen window barely slows the hook.
//
// Discovery dir: ~/.claude/switchboard/
// Discovery file: {workspace-hash}-{pid}.json  →  { port, pid, workspace }
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

// Hard safety deadline — guarantees exit well before Claude Code's
// ${HOOK_TIMEOUT_S}s kill timeout (500ms margin). Prevents ANY hanging scenario
// (stdin stall, HTTP hang, unexpected blocking) from blocking Claude Code.
setTimeout(() => process.exit(0), ${HOOK_TIMEOUT_S * 1000 - HOOK_SAFETY_MARGIN_MS});

const DIR = path.join(os.homedir(), '.claude', 'switchboard');
const IS_WIN = process.platform === 'win32';

/** Normalize a path: resolve and follow symlinks where possible */
function normPath(p) {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch {}
  return r;
}

/** Check if a process is alive. On Windows, process.kill(pid, 0) is unreliable
 *  (can throw even for live processes), so we skip the check and let stale
 *  discovery files be cleaned up by the extension on activation instead. */
function isAlive(pid) {
  if (IS_WIN) return true;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  let cwd, ev;
  try { ev = JSON.parse(input); cwd = ev.cwd; } catch { process.exit(0); }
  // Bash never asks; deny rules in settings still win over a hook's allow. writeSync: an async pipe write can be cut off by exit.
  if (ev.hook_event_name === 'PreToolUse' && ev.tool_name === 'Bash') {
    fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }));
  }
  if (!cwd) process.exit(0);

  const resolvedCwd = normPath(cwd);

  // Read all discovery files
  let allFiles;
  try {
    allFiles = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'workspaces.json');
  } catch { process.exit(0); }
  if (!allFiles.length) process.exit(0);

  // Parse discovery files and find workspaces that contain this cwd.
  // Use longest-match-wins so /project/sub matches before /project.
  const matches = [];
  const live = [];
  for (const file of allFiles) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); } catch { continue; }
    if (!d.workspace || !d.pid || !d.port) continue;

    // Clean up dead instances (skip on Windows where PID check is unreliable)
    if (!isAlive(d.pid)) {
      try { fs.unlinkSync(path.join(DIR, file)); } catch {}
      continue;
    }
    live.push(d);

    // Containment check: is cwd equal to or under this workspace?
    const ws = normPath(d.workspace);
    if (resolvedCwd === ws || resolvedCwd.startsWith(ws + path.sep)) {
      matches.push({ d, file, wsLen: ws.length });
    }
  }

  // A chat in a folder no window has open goes to the live window with the lowest pid, so Switchboard
  // still sees it and the target stays put when another window opens mid-chat.
  if (!matches.length) {
    if (!live.length) process.exit(0);
    matches.push({ d: [...live].sort((a, b) => a.pid - b.pid)[0], file: '', wsLen: 0 });
  }

  // Sort by workspace path length descending — most specific match first
  matches.sort((a, b) => b.wsLen - a.wsLen);
  const bestLen = matches[0].wsLen;
  // Forward to all instances of the best (most specific) workspace match
  const targets = matches.filter(m => m.wsLen === bestLen);
  // Owners first; the rest only update their chat status, so every window shows the same.
  const owned = new Set(targets.map(t => t.d.port));
  const posts = [...targets.map(t => ({ d: t.d, mirror: false })), ...live.filter(d => !owned.has(d.port)).map(d => ({ d, mirror: true }))];

  let pending = posts.length;
  for (const { d, mirror } of posts) {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; done(); };
    const req = http.request({
      hostname: '127.0.0.1', port: d.port, method: 'POST',
      headers: mirror ? { 'Content-Type': 'application/json', 'x-switchboard-mirror': '1' } : { 'Content-Type': 'application/json' },
      timeout: mirror ? 300 : ${HOOK_FORWARD_TIMEOUT_MS},
    }, res => { res.resume(); res.on('end', finish); });
    req.on('error', finish);
    req.on('timeout', () => { req.destroy(); });
    req.write(input);
    req.end();
  }

  function done() { if (--pending <= 0) process.exit(0); }
});
`
}
