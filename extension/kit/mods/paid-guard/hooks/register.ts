// Asks the user before a tool call that spends money.
import type { EngineInterface, Register } from 'claude-code'

type Spend = { key: string; what: string }

const AWS_CHANGE = /\baws\s+[\w-]+\s+(create|delete|put|update|modify|run|terminate|start|stop|reboot|attach|detach|associate|deploy|register|deregister|import|restore|copy|purchase)\b[\w-]*/
const AWS_SPEND: Spend = { key: 'aws', what: 'an AWS change (may cost money)' }

const BASH: { test: RegExp; spend: Spend }[] = [
  { test: /\bbland\s+(call|sms|batch)\s+(send|create)\b|api\.bland\.ai/, spend: { key: 'bland', what: 'a Bland call or text (Bland credit)' } },
  { test: /openrouter\.ai\/api/, spend: { key: 'openrouter', what: 'an OpenRouter request (OpenRouter credit)' } },
  { test: /thenewblack\.ai|\/api\/closet\/virtualtryon/, spend: { key: 'newblack', what: 'a NewBlack try-on render (render credit)' } },
  { test: /\/api\/fitoftheday\/(preview|generate)/, spend: { key: 'fit', what: 'a fit of the day render or generation (Gemini, shop searches, render credit)' } },
  { test: /\/api\/shop\/(search|image-search|brands|product)/, spend: { key: 'shop', what: 'a paid Channel3 shop search' } },
  { test: /generativelanguage\.googleapis\.com/, spend: { key: 'gemini', what: 'a Gemini request' } },
  { test: /upload_to_stitch|stitch\.googleapis\.com/, spend: { key: 'stitch', what: 'a Stitch upload (sends project HTML and screens to Google, uses your Stitch API key)' } },
  { test: AWS_CHANGE, spend: AWS_SPEND },
]

const MCP: { test: RegExp; spend: Spend }[] = [
  { test: /^mcp__openrouter__(generate-image|generate-speech|send-message|send-batch|transcribe-audio|spawn-ori-eval)$/, spend: { key: 'openrouter', what: 'an OpenRouter generation (OpenRouter credit)' } },
  { test: /^mcp__plugin_bland_bland__(create_call|send_call|send_sms|send_sms_batch|create_batch|create_sms_conversation|send_sms_conversation_message|buy_credits|buy_phone_plan|purchase_phone_number|run_test_scenario|batch_run_test_scenarios|create_eval_run|start_agent_check_run|create_disposition_test_run|start_tornado_session|create_translation_session)$/, spend: { key: 'bland', what: 'a Bland call, text or purchase (Bland credit)' } },
]

export const spendOf = (tool: string, input: Record<string, unknown>): Spend | undefined => {
  if (tool === 'Bash') return typeof input.command === 'string' ? BASH.find(r => r.test.test(input.command as string))?.spend : undefined
  // aws-core's server runs CLI commands passed in its input (call_aws).
  if (tool.startsWith('mcp__plugin_aws-core_aws-mcp__')) return AWS_CHANGE.test(JSON.stringify(input)) ? AWS_SPEND : undefined
  return MCP.find(r => r.test.test(tool))?.spend
}

const ONCE = 'Allow once'
const SESSION = 'Allow for this session'

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** Tells the Switchboard window for this folder what was asked and the answer; silent when there is none. */
async function report($: EngineInterface, action: 'asked' | 'allowed' | 'refused', detail: string) {
  const home = norm((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '')
  const dir = `${home}/.claude/switchboard`
  const cwd = norm(await $.session.cwd())
  let best: { port: number; token: string; workspace: string } | undefined
  for (const e of await $.fs.list(dir).catch(() => [])) {
    if (e.kind !== 'file' || !e.name.endsWith('.json') || e.name === 'workspaces.json') continue
    try {
      const f = JSON.parse(String(await $.fs.read(`${dir}/${e.name}`)))
      const w = typeof f.workspace === 'string' ? norm(f.workspace) : ''
      if (typeof f.port !== 'number' || typeof f.hubToken !== 'string' || !w || (cwd !== w && !cwd.startsWith(`${w}/`))) continue
      if (!best || w.length > best.workspace.length) best = { port: f.port, token: f.hubToken, workspace: w }
    } catch { /* a file mid-write */ }
  }
  if (!best) return
  await $.http.fetch(`http://127.0.0.1:${best.port}/hub`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: best.token, kind: 'guard', mod: 'paid-guard', action, detail, sessionId: await $.session.id() }),
  }).catch(() => undefined)
}

// Kinds allowed for the rest of the session; a reload asks again.
const allowed = new Set<string>()

async function decide($: EngineInterface, spend: Spend) {
  if (allowed.has(spend.key)) return true
  await report($, 'asked', spend.what).catch(() => undefined)
  const answer = await $.ui.ask(`This call is ${spend.what}. Run it?`, [ONCE, SESSION, 'Deny']).catch(() => 'Deny')
  if (answer === SESSION) allowed.add(spend.key)
  const ok = answer === ONCE || answer === SESSION
  await report($, ok ? 'allowed' : 'refused', spend.what).catch(() => undefined)
  return ok
}

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    const spend = spendOf(String(e.tool), e as unknown as Record<string, unknown>)
    if (!spend) return next(e)
    return (await decide($, spend)) ? next(e) : { deny: `paid-guard: the user did not allow ${spend.what}.` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'paid-guard: the guard failed, so the call was held.' }))
}
