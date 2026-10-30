// Pure parts of the ask server, so tests need no stdio.
import * as path from 'node:path'

const str = v => typeof v === 'string' && v.trim() !== ''

/** AskUserQuestion's shape, options as {label, description?}; or why it is refused. */
export function checkInput(args) {
  const qs = args?.questions
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 4) return 'questions: 1 to 4 questions'
  const questions = []
  for (const [n, q] of qs.entries()) {
    const at = `questions[${n}]`
    if (!str(q?.question)) return `${at}.question: a string`
    if (q.header !== undefined && typeof q.header !== 'string') return `${at}.header: a string`
    if (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') return `${at}.multiSelect: true or false`
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) return `${at}.options: 2 to 4 options`
    const options = []
    for (const o of q.options) {
      const label = typeof o === 'string' ? o : o?.label
      if (!str(label)) return `${at}.options: each a string or {label, description}`
      options.push(typeof o === 'object' && typeof o.description === 'string' ? { label, description: o.description } : { label })
    }
    questions.push({ ...(q.header ? { header: q.header } : {}), question: q.question, options, ...(q.multiSelect ? { multiSelect: true } : {}) })
  }
  return { questions }
}

/** The elicitation form: q1, q1_other, q2, ... */
export function toSchema(questions) {
  const properties = {}
  questions.forEach((q, i) => {
    const labels = q.options.map(o => o.label)
    const notes = q.options.filter(o => o.description).map(o => `${o.label}: ${o.description}`)
    const base = { title: q.header || `Question ${i + 1}`, description: [q.question, ...notes].join('\n') }
    properties[`q${i + 1}`] = q.multiSelect ? { type: 'array', ...base, items: { type: 'string', enum: labels } } : { type: 'string', ...base, enum: labels }
    properties[`q${i + 1}_other`] = { type: 'string', title: 'Other (optional)' }
  })
  return { type: 'object', properties, required: questions.map((_, i) => `q${i + 1}`) }
}

const line = (q, picked, other) => `"${q.question}": ${[picked.join(', ') || '(none)', ...(other ? [`other: ${other}`] : [])].join('; ')}`

export function fromContent(questions, content = {}) {
  return questions.map((q, i) => {
    const v = content[`q${i + 1}`], other = content[`q${i + 1}_other`]
    return line(q, Array.isArray(v) ? v : v === undefined ? [] : [String(v)], str(other) ? other.trim() : '')
  }).join('\n')
}

/** choice: an index per question, several for a multiSelect one, or { picks?, other } for Other text. */
export function fromChoice(questions, choice) {
  return questions.map((q, i) => {
    const c = choice[i], typed = c !== null && typeof c === 'object' && !Array.isArray(c)
    const other = typed ? Array.from(String(c.other ?? '').replace(/[\p{Cc}\u2028\u2029]/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, 200).join('') : ''
    return line(q, [typed ? c.picks ?? [] : c].flat().map(n => q.options[n]?.label).filter(Boolean), other)
  }).join('\n')
}

/** Same pick as hook.js: the live window whose workspace holds cwd (longest wins), else the lowest live pid. */
export function pickWindow(files, cwd, isAlive, platform = process.platform) {
  // Windows: VS Code writes c:\, Claude Code C:\, and either may use /.
  const norm = s => (platform === 'win32' ? s.replace(/\//g, '\\').toLowerCase() : s)
  const sep = platform === 'win32' ? '\\' : path.sep
  const at = norm(cwd)
  const live = files.filter(d => d?.workspace && d.pid && d.port && d.hubToken && isAlive(d.pid))
  const holds = live.filter(d => at === norm(d.workspace) || at.startsWith(norm(d.workspace) + sep)).sort((a, b) => b.workspace.length - a.workspace.length)
  return holds[0] ?? [...live].sort((a, b) => a.pid - b.pid)[0]
}
