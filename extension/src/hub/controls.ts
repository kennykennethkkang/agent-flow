/**
 * The Controls whitelist: every Claude Code setting Switchboard may change and
 * the values each may take, plus reading them back for the cards. Kept free of
 * vscode so the rule is tested on its own; env, permissions and hooks never pass.
 */
import type { ClaudeControls } from './types'

const BOOLEANS = new Set(['autoCompactEnabled', 'autoContinueAtUsageLimit', 'remoteControlAtStartup', 'agentPushNotifEnabled', 'inputNeededNotifEnabled'])
// null unsets the key, so Claude Code falls back to its own default.
const CHOICES = new Map<string, readonly unknown[]>([
  ['autoCompactWindow', [200000, 400000, 1000000]],
  ['model', ['fable', 'opus', 'sonnet', 'haiku', null]],
  ['effortLevel', ['low', 'medium', 'high', 'xhigh', 'max', null]],
  ['tui', ['default', 'fullscreen']],
])

/** The one change a control may make: values to write, null to unset; undefined when refused. */
export function controlPatch(key: string, value: unknown, statusLineCommand?: string): Record<string, unknown> | undefined {
  if (BOOLEANS.has(key)) return typeof value === 'boolean' ? { [key]: value } : undefined
  const choices = CHOICES.get(key)
  if (choices) return choices.includes(value) ? { [key]: value } : undefined
  if (key === 'statusLine' && typeof value === 'boolean' && statusLineCommand) {
    return { statusLine: value ? { type: 'command', command: statusLineCommand } : null }
  }
  return undefined
}

/** A copy of the settings with the patch applied; null removes the key. */
export function applyPatch(settings: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...settings }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next
}

const pick = <T extends string>(v: unknown, from: readonly T[]) => (from.includes(v as T) ? (v as T) : undefined)

/** What the Controls cards show. A full model id reads as no alias picked. */
export function readControls(s: Record<string, unknown>): ClaudeControls {
  return {
    model: pick(s.model, ['fable', 'opus', 'sonnet', 'haiku'] as const),
    effortLevel: pick(s.effortLevel, ['low', 'medium', 'high', 'xhigh', 'max'] as const),
    tui: s.tui === 'fullscreen' ? 'fullscreen' : 'default',
    statusLine: Boolean(s.statusLine),
    push: s.agentPushNotifEnabled === true,
    needInput: s.inputNeededNotifEnabled === true,
  }
}

/**
 * terminal.integrated.commandsToSkipShell with the command added, so its keybinding works while a terminal
 * has focus; undefined when nothing changes (already there, taken out on purpose with -id, or not a list).
 */
export function withSkipShell(list: unknown, id: string): string[] | undefined {
  if (list !== undefined && !Array.isArray(list)) return undefined
  const now = (list ?? []) as string[]
  return now.includes(id) || now.includes(`-${id}`) ? undefined : [...now, id]
}
