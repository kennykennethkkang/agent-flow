/** Each VS Code window's color, by folder, kept in ~/.claude/switchboard/colors.json. The panel picks the theme's shade by key. */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { WindowColor } from './types'

export const PALETTE: WindowColor[] = ['violet', 'amber', 'teal', 'rose', 'lime', 'cobalt']
const FILE = path.join(os.homedir(), '.claude', 'switchboard', 'colors.json')

/** Status bar text on light and dark themes, the same shades as the panel's --hub-w-* tokens. Title bar: dark tints, active then inactive. */
export const SHADES: Record<WindowColor, { light: string; dark: string; bar: [string, string] }> = {
  violet: { light: '#6a4cd0', dark: '#a08bff', bar: ['#3a2d6e', '#2d2647'] },
  amber: { light: '#b26b00', dark: '#f2b24c', bar: ['#5a3c0a', '#3d2e15'] },
  teal: { light: '#0b8a87', dark: '#4fd1c9', bar: ['#0f4645', '#173332'] },
  rose: { light: '#b8306f', dark: '#ff7ab3', bar: ['#5c2140', '#3e2030'] },
  lime: { light: '#4a7d12', dark: '#9bd65a', bar: ['#2f4614', '#27331a'] },
  cobalt: { light: '#2f5fd0', dark: '#7ea2ff', bar: ['#1f3566', '#1f2a43'] },
}

/** A saved folder keeps its color; a new one gets the first color no other live window has, wrapping when all are taken. */
export function assignColors(saved: Record<string, WindowColor>, live: string[]): { colors: Record<string, WindowColor>; changed: boolean } {
  const colors = { ...saved }
  let changed = false
  for (const ws of live) {
    if (colors[ws]) continue
    const used = new Set(live.map(w => colors[w]).filter(Boolean))
    colors[ws] = PALETTE.find(c => !used.has(c)) ?? PALETTE[used.size % PALETTE.length]
    changed = true
  }
  return { colors, changed }
}

/** Reads the colors file, gives each live folder one and writes it back when that added any. */
export function windowColors(live: string[], file = FILE): Record<string, WindowColor> {
  let saved: Record<string, WindowColor> = {}
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (v && typeof v === 'object' && !Array.isArray(v)) saved = Object.fromEntries(Object.entries(v).filter(([, c]) => PALETTE.includes(c as WindowColor))) as Record<string, WindowColor>
  } catch { /* none yet, or broken: start over */ }
  const { colors, changed } = assignColors(saved, live)
  if (changed) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(colors, null, 2) + '\n')
    } catch { /* colors still show, just not kept */ }
  }
  return colors
}

export const titleBarColors = (c: WindowColor): Record<string, string> => ({
  'titleBar.activeBackground': SHADES[c].bar[0],
  'titleBar.activeForeground': '#f4f4f6',
  'titleBar.inactiveBackground': SHADES[c].bar[1],
  'titleBar.inactiveForeground': '#f4f4f699',
})

type Colors = Record<string, unknown>

/**
 * workbench.colorCustomizations with Switchboard's title bar keys in it. A key is only written while absent or still what
 * Switchboard wrote (wrote); one it wrote that `want` lacks is removed. Undefined when nothing changes.
 */
export function titleBar(current: Colors | undefined, wrote: Record<string, string>, want: Record<string, string>): { next: Colors; wrote: Record<string, string> } | undefined {
  const next: Colors = { ...current }
  const mine: Record<string, string> = {}
  for (const k of new Set([...Object.keys(wrote), ...Object.keys(want)])) {
    const ours = next[k] === undefined || next[k] === wrote[k]
    if (!ours) continue
    if (want[k] === undefined) delete next[k]
    else { next[k] = want[k]; mine[k] = want[k] }
  }
  const same = JSON.stringify(next) === JSON.stringify({ ...current })
  return same && JSON.stringify(mine) === JSON.stringify(wrote) ? undefined : { next, wrote: mine }
}
