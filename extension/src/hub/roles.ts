/**
 * The model: line of a role file's frontmatter (~/.claude/agents/<role>.md), read for the hub
 * and rewritten by the gear's Role models rows. No vscode here.
 */
import * as fs from 'fs'
import * as path from 'path'

/** What the gear may write; inherit runs the role on the main chat's model. */
export const ROLE_MODELS = ['inherit', 'fable', 'opus', 'sonnet', 'haiku'] as const

const FRONT = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/
const LINE = /^model:[ \t]*(.*?)[ \t]*$/m

export function modelOf(text: string): string | undefined {
  const v = FRONT.exec(text)?.[0].match(LINE)?.[1].replace(/^["']|["']$/g, '')
  return v || undefined
}

/** text with its frontmatter model set (added before the closing fence when missing); undefined with no frontmatter. */
export function withModel(text: string, model: string): string | undefined {
  const front = FRONT.exec(text)?.[0]
  if (front === undefined) return undefined
  const nl = front.includes('\r\n') ? '\r\n' : '\n'
  const next = LINE.test(front) ? front.replace(LINE, `model: ${model}`) : front.replace(/\r?\n---$/, `${nl}model: ${model}${nl}---`)
  return next + text.slice(front.length)
}

/** Rewrites one role's model line; the reason when refused. role must name a file already in dir. */
export function setRoleModel(dir: string, role: string, model: string): string | undefined {
  if (!(ROLE_MODELS as readonly string[]).includes(model)) return `unknown model ${model}`
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch { /* no agents folder */ }
  if (!/^[\w.-]+$/.test(role) || !names.includes(`${role}.md`)) return `no role named ${role}`
  const file = path.join(dir, `${role}.md`)
  try {
    const next = withModel(fs.readFileSync(file, 'utf8'), model)
    if (next === undefined) return `${role}.md has no frontmatter`
    fs.writeFileSync(file, next)
  } catch (err) { return `could not write ${role}.md (${(err as Error).message})` }
  return undefined
}
