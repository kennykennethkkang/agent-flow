/**
 * Keeps Switchboard on the newest kit build: installs a newer switchboard-X.Y.Z.vsix from the kit,
 * then reloads the window once the user is not in it.
 */
import type * as vscode from 'vscode'
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { createLogger } from '../logger'

const log = createLogger('SelfUpdate')
const EVERY_MS = 5 * 60 * 1000
const VSIX = /^switchboard-(\d+\.\d+\.\d+)\.vsix$/

/** a > b, part by part as numbers; a missing b counts as older. */
export function newerVersion(a: string, b: string | undefined): boolean {
  if (!b) return true
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

export function newestVsix(names: string[]): { file: string; version: string } | undefined {
  let best: { file: string; version: string } | undefined
  for (const file of names) {
    const version = VSIX.exec(file)?.[1]
    if (version && (!best || newerVersion(version, best.version))) best = { file, version }
  }
  return best
}

/** Our registered version in the extensions folder's extensions.json; old folders sit in .obsolete. */
export function diskVersion(json: string, id: string): string | undefined {
  try {
    const rows = JSON.parse(json) as Array<{ identifier?: { id?: string }; version?: string }>
    return rows.find(r => r.identifier?.id?.toLowerCase() === id.toLowerCase())?.version
  } catch { return undefined }
}

/** git in dir, no shell; rejects on a non-zero exit or after the timeout. */
export const gitIn = (dir: string) => (args: string[]) => new Promise<string>((ok, fail) => {
  execFile('git', args, { cwd: dir, timeout: 60_000, windowsHide: true }, (err, out) => (err ? fail(err) : ok(String(out))))
})

/** Fast-forwards the kit's repo when its branch tracks an upstream; one pull at a time, failures logged. */
export function gitPuller(run: (args: string[]) => Promise<string>): () => Promise<void> {
  let inFlight: Promise<void> | undefined
  return () => inFlight ??= (async () => {
    // Fails outside a repo and on a branch without an upstream: nothing to pull then.
    try { await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) } catch { return }
    try { await run(['pull', '--ff-only', '--quiet']) } catch (err) { log.warn('Kit pull failed:', err) }
  })().finally(() => { inFlight = undefined })
}

export function startSelfUpdate(context: vscode.ExtensionContext, kitDir: string, pull = gitPuller(gitIn(path.dirname(kitDir)))): Promise<void> {
  // Loaded here so the tests can import the helpers above without VS Code.
  const vs: typeof vscode = require('vscode')
  if (context.extensionMode !== vs.ExtensionMode.Production) return Promise.resolve()
  const running = context.extension.packageJSON.version as string
  const id = context.extension.id
  const listing = path.join(path.dirname(context.extensionPath), 'extensions.json')
  // In globalState, like TRIED: a row that stays ahead of the running version reloads once, not on every start.
  const PROMPTED = 'selfUpdate.prompted'
  let prompted = context.globalState.get<string>(PROMPTED)
  let pending = false
  const reload = () => vs.commands.executeCommand('workbench.action.reloadWindow')

  const askReload = (version: string) => {
    if (prompted === version) return
    prompted = version
    void context.globalState.update(PROMPTED, version)
    pending = true
    if (!vs.window.state.focused) { void reload(); return }
    void vs.window.showInformationMessage(`Switchboard ${version} is installed.`, 'Reload').then(pick => { if (pick) void reload() })
  }

  const readDisk = async () => diskVersion(await fs.promises.readFile(listing, 'utf8').catch(() => '[]'), id)
  // One try per kit version, across activations, so a failed install does not repeat every start.
  const TRIED = 'selfUpdate.tried'

  const check = async () => {
    // Asked while focused, and the window went to the background without a blur event reaching us.
    if (pending && !vs.window.state.focused) { void reload(); return }
    try {
      // No row means a dev host or a folder we do not manage: never install or reload there.
      let disk = await readDisk()
      if (!disk) return
      // Another computer pushed a newer vsix: fetch it first.
      await pull()
      const names = await fs.promises.readdir(kitDir).catch(() => [] as string[])
      const kit = newestVsix(names)
      if (kit && kit.version !== context.globalState.get(TRIED) && newerVersion(kit.version, disk)) {
        await context.globalState.update(TRIED, kit.version)
        log.info(`Installing ${kit.file} from the kit`)
        // ponytail: several windows may install the same vsix at once; VS Code copes, so no lock.
        await vs.commands.executeCommand('workbench.extensions.installExtension', vs.Uri.file(path.join(kitDir, kit.file)))
        // Trust the row, not the command: a failed install leaves it as it was.
        disk = await readDisk()
      }
      if (disk && newerVersion(disk, running)) askReload(disk)
    } catch (err) {
      log.warn('Self update failed:', err)
    }
  }

  const first = check()
  const timer = setInterval(() => void check(), EVERY_MS)
  context.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    // Reload when the user leaves the window, not while they are in it.
    vs.window.onDidChangeWindowState(s => { if (!s.focused && pending) void reload() }),
  )
  // The first check, so the tests can wait on it; check never rejects.
  return first
}
