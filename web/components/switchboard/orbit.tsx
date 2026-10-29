'use client'

/**
 * The picked chat drawn as its team: you, the lead in the middle, roles on a slow ring with one small
 * bubble per extra subagent of that role, and each new tool call popping out of the bubble that made it.
 * Changes ease between frames (see Scene) instead of jumping; reduced motion draws one still frame. Ported from the approved
 * mock (switchboard-orbit-live.html); colors come from the --hub-* tokens, re-read on a theme change.
 * The canvas is a picture only: the cards and panels around it carry the same facts as text.
 */
import { useEffect, useRef } from 'react'
import type { ChatProgress, ChatState, SessionLive } from '@/lib/hub-types'
import { ORDER, STATE } from './look'
import { PILL_MS, SAT_ROW, TAU as TW, approach, groupRoles, orbitMoves, satSlot } from '@/lib/orbit-motion'
import { vscodeBridge } from '@/lib/vscode-bridge'

/** models: each role's model, drawn under its bubble. */
export type OrbitChat = { id: string; name: string; state: ChatState; ago: string; progress?: ChatProgress; live?: SessionLive; models?: Record<string, string> }
/** running: the ids of this role's subagents still at work. */
type RoleOn = { role: string; state: 'active' | 'done' | 'waiting' | 'unused'; running: string[] }

/** The ring: the roles this chat used in plan order, plus researcher, engineer and qa dimmed when unused, so it never has fewer than 3. */
export function ringRoles(p?: ChatProgress): RoleOn[] {
  const used = new Map(groupRoles(p?.roles ?? []).map(g => [g.role, g]))
  const rank = (r: string) => (ORDER.indexOf(r) + 100) % 100
  return [...new Set([...used.keys(), 'researcher', 'engineer', 'qa'])].sort((a, b) => rank(a) - rank(b)).map(role => ({
    role, state: used.get(role)?.state ?? (p?.tasks.some(t => t.role === role && t.status !== 'completed') ? 'waiting' : 'unused'), running: used.get(role)?.running ?? [],
  }))
}

export function describe(c: OrbitChat): string {
  const roles = ringRoles(c.progress).filter(r => r.state !== 'unused')
    .map(r => `${r.role}${c.models?.[r.role] ? ` (${c.models[r.role]})` : ''} ${r.state}${r.running.length > 1 ? `, ${r.running.length} running` : ''}`)
  return `${c.name}: ${STATE[c.state].label}. You, the lead${roles.length ? `, and ${roles.join('; ')}` : ', no roles yet'}.`
}

/**
 * What the picture keeps between frames, so a change glides instead of jumping: every eased value by key,
 * the ring's turn, and the roles, subagents and texts still fading out after the data dropped them.
 * snap: the next frame lands every value on its target (a new chat, a theme change, reduced motion).
 */
type Scene = {
  v: Map<string, number>; seen: Set<string>; moving: boolean; glide: boolean; snap: boolean; dt: number
  spin: number; ring: Map<string, RoleOn>; sats: Map<string, string>; badge: Map<string, number>
  sub?: { text: string; prev?: string; at: number }; q?: string
}
export const newScene = (): Scene => ({ v: new Map(), seen: new Set(), moving: false, glide: false, snap: true, dt: 0, spin: 0, ring: new Map(), sats: new Map(), badge: new Map() })

const KEYS = ['canvas', 'card', 'elev', 'hair', 'ink', 'body', 'mute', 'ash', 'blue', 'red', 'green', 'yellow', 'violet'] as const
type Pal = Record<(typeof KEYS)[number], string> & { sans: string; mono: string }
const TAU = Math.PI * 2
const out = (u: number) => 1 - Math.pow(1 - u, 3)
const inOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2)
/** hex a mixed toward hex b by u, as a hex, so a tinted fill is one fill. */
const mix = (a: string, b: string, u: number) => { const x = parseInt(a.replace('#', ''), 16) || 0, y = parseInt(b.replace('#', ''), 16) || 0; return '#' + [16, 8, 0].map(s => Math.round(((x >> s) & 255) * (1 - u) + ((y >> s) & 255) * u).toString(16).padStart(2, '0')).join('') }
const rgba = (hex: string, a: number) => { const n = parseInt(hex.replace('#', ''), 16) || 0; return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})` }
type P = { x: number; y: number }
/** Where a tool pill tries to go, in order, when its own spot is taken. */
const SPOTS: Array<[number, number]> = [[0, 0], [0, -34], [0, 34], [-64, 0], [64, 0], [0, -68], [0, 68]]
/** A role's own accent, drawn as an inner ring and a tint while it is not working or done. Any other role gets the plain look. */
const ACCENT: Record<string, 'violet'> = { jev: 'violet' }
/** The backing store never goes past 2 device pixels per CSS pixel: sharper than that costs CPU and nobody sees it. */
export const MAX_DPR = 2
const lum = (hex: string) => { const n = parseInt(hex.replace('#', ''), 16) || 0; return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 }
const labelSize = new Map<string, number>()
// The dot grid as one cached pattern, so a frame fills one rect instead of a few thousand.
let grid: { key: string; pat: CanvasPattern | null } = { key: '', pat: null }
function gridPattern(ctx: CanvasRenderingContext2D, d: number, color: string) {
  const key = `${d}|${color}`
  if (grid.key === key) return grid.pat
  const tile = document.createElement('canvas'), n = Math.round(24 * d), tc = tile.getContext('2d')
  tile.width = tile.height = n
  let pat: CanvasPattern | null = null
  if (tc) {
    const dot = Math.max(1, Math.round(d)), at = Math.round(11.5 * d)
    tc.fillStyle = color; tc.fillRect(at, at, dot, dot)
    pat = ctx.createPattern(tile, 'repeat'); pat?.setTransform(new DOMMatrix([1 / d, 0, 0, 1 / d, 0, 0]))
  }
  grid = { key, pat }
  return pat
}

function readPal(el: Element): Pal {
  // #fff as #ffffff: the color math reads six hex digits.
  const s = getComputedStyle(el), v = (k: string) => s.getPropertyValue(`--hub-${k}`).trim().replace(/^#(\w)(\w)(\w)$/, '#$1$1$2$2$3$3')
  return { ...Object.fromEntries(KEYS.map(k => [k, v(k) || '#888888'])), sans: v('sans') || 'sans-serif', mono: v('mono') || 'monospace' } as Pal
}

function draw(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, now: number, c: OrbitChat, showTools: boolean, born: Map<string, number>, C: Pal, still: boolean, d: number, S: Scene) {
  if (still) S.snap = true
  S.seen.clear(); S.moving = false
  // An eased value by key: a new key starts at from, or lands at once on a snap frame.
  const tw = (k: string, to: number, tau: number, from = to) => {
    const was = S.v.get(k), v = S.snap ? to : approach(was ?? from, to, S.dt, tau)
    S.v.set(k, v); S.seen.add(k)
    if (v !== to) S.moving = true
    return v
  }
  const twc = (k: string, hex: string) => {
    const n = parseInt(hex.replace('#', ''), 16) || 0
    return '#' + [16, 8, 0].map((sh, i) => Math.round(tw(`${k}.${i}`, (n >> sh) & 255, TW.color)).toString(16).padStart(2, '0')).join('')
  }
  const lerp = (a: number, b: number, u: number) => a + (b - a) * u
  // Crisp drawing: points land on whole device pixels, and a stroke of width lw sits where its edges do too.
  // While something glides, text follows it smoothly instead of stepping a pixel at a time.
  const snap = (v: number) => Math.round(v * d) / d
  const crisp = (v: number, lw: number) => (Math.round(v * d) + (Math.round(lw * d) % 2) / 2) / d
  const light = lum(C.canvas) > 0.5
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  const text = (s: string, x: number, y: number, o: { size?: number; color?: string; weight?: number; mono?: boolean; align?: CanvasTextAlign; alpha?: number } = {}) => {
    const { size = 12, color = C.ink, weight = 500, mono = false, align = 'center', alpha = 1 } = o
    ctx.font = `${weight} ${size}px ${mono ? C.mono : C.sans}`
    ctx.fillStyle = rgba(color, alpha); ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(s, S.glide ? x : snap(x), S.glide ? y : snap(y))
  }
  const fit = (s: string, max: number) => { if (ctx.measureText(s).width <= max) return s; while (s.length > 4 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1); return s + '…' }
  const curve = (a: P, b: P, bend: number, u: number) => {
    const cx = (a.x + b.x) / 2 - (b.y - a.y) * bend, cy = (a.y + b.y) / 2 + (b.x - a.x) * bend, v = 1 - u
    return { x: v * v * a.x + 2 * v * u * cx + u * u * b.x, y: v * v * a.y + 2 * v * u * cy + u * u * b.y, cx, cy }
  }
  const edge = (a: P, b: P, color: string, alpha: number, dash: number[] = [], bend = 0.1) => {
    if (alpha < 0.01) return
    const { cx, cy } = curve(a, b, bend, 0)
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(cx, cy, b.x, b.y)
    ctx.strokeStyle = rgba(color, alpha); ctx.lineWidth = 1.25; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([])
  }
  // A spark eases out of a and into b, fading in and out at the ends, so it reads as sent and received.
  const spark = (a: P, b: P, phase: number, color: string, bend = 0.1, r = 2.5, alpha = 1) => {
    const p = curve(a, b, bend, inOut(phase)), k = Math.sin(Math.PI * phase) * alpha
    if (k < 0.02) return
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.4, 0, TAU); ctx.fillStyle = rgba(color, 0.12 * k); ctx.fill()
    ctx.beginPath(); ctx.arc(p.x, p.y, r * (0.7 + 0.3 * k), 0, TAU); ctx.fillStyle = rgba(color, k); ctx.fill()
  }
  const tick = (x: number, y: number, s: number, color: string, lw: number) => {
    ctx.beginPath(); ctx.moveTo(x - 0.44 * s, y); ctx.lineTo(x - 0.1 * s, y + 0.34 * s); ctx.lineTo(x + 0.47 * s, y - 0.35 * s)
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.stroke()
  }
  // Draws f scaled by k about (x, y) at opacity a: how bubbles and badges pop in and out.
  const pop = (x: number, y: number, k: number, a: number, f: () => void) => {
    if (a < 0.01) return
    ctx.save(); ctx.globalAlpha *= a
    if (k !== 1) { ctx.translate(x, y); ctx.scale(k, k); ctx.translate(-x, -y) }
    f(); ctx.restore()
  }
  // A bubble: a canvas-colored gap that keeps lines and the dotted ring off its edge, a soft halo instead of a
  // (costly, blurry) canvas shadow, a 1px lip below for depth, the wash, a rim light on top and one 1.5px ring.
  const bubble = (x: number, y: number, r: number, color: string, o: { wash?: number; ring?: number; glow?: number; dim?: number; tint?: string; accent?: string } = {}) => {
    const { wash = 0.14, ring = 1, glow = 0, dim = 1, tint = color, accent } = o
    ctx.beginPath(); ctx.arc(x, y, r + 3, 0, TAU); ctx.fillStyle = C.canvas; ctx.fill()
    if (glow > 0.5) {
      const g = ctx.createRadialGradient(x, y, r, x, y, r + glow)
      g.addColorStop(0, rgba(color, (light ? 0.16 : 0.28) * dim)); g.addColorStop(1, rgba(color, 0))
      ctx.beginPath(); ctx.arc(x, y, r + glow, 0, TAU); ctx.fillStyle = g; ctx.fill()
    }
    ctx.beginPath(); ctx.arc(x, y + 1, r, 0, TAU); ctx.fillStyle = rgba('#000000', light ? 0.08 : 0.5); ctx.fill()
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = C.card; ctx.fill()
    const g = ctx.createRadialGradient(x - r * 0.2, y - r * 0.55, r * 0.05, x, y, r)
    g.addColorStop(0, rgba(tint, wash * 1.7 * dim)); g.addColorStop(0.65, rgba(tint, wash * 0.6 * dim)); g.addColorStop(1, rgba(tint, wash * 0.35 * dim))
    ctx.fillStyle = g; ctx.fill()
    const rim = ctx.createLinearGradient(x, y - r, x, y)
    rim.addColorStop(0, light ? 'rgba(255,255,255,0.9)' : rgba(C.ink, 0.16 * dim)); rim.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.beginPath(); ctx.arc(x, y, r - 2, 0, TAU); ctx.strokeStyle = rim; ctx.lineWidth = 1; ctx.stroke()
    if (accent) { ctx.beginPath(); ctx.arc(x, y, r - 3.5, 0, TAU); ctx.strokeStyle = rgba(accent, 0.55 * dim); ctx.lineWidth = 1; ctx.stroke() }
    ctx.beginPath(); ctx.arc(x, y, r - 0.75, 0, TAU); ctx.strokeStyle = rgba(color, 0.85 * ring * dim); ctx.lineWidth = 1.5; ctx.stroke()
  }
  // A pill: whole-pixel size, its 1px border on the pixel grid, a faint tint of its color, and a drawn check that fades in (check 0..1).
  const pillBox = (x: number, y: number, s: string, o: { size?: number; mono?: boolean; check?: number } = {}) => {
    const { size = 11, mono = true, check: ok = 0 } = o
    ctx.font = `500 ${size}px ${mono ? C.mono : C.sans}`
    const pw = Math.round(ctx.measureText(s).width + 16 + 14 * ok), ph = Math.round(size + 11)
    return { l: crisp(x - pw / 2, 1), top: crisp(y - ph / 2, 1), pw, ph }
  }
  const pill = (x: number, y: number, s: string, color: string, alpha: number, o: { size?: number; mono?: boolean; fg?: string; check?: number } = {}) => {
    const { size = 11, mono = true, fg, check: ok = 0 } = o
    const { l, top, pw, ph } = pillBox(x, y, s, o)
    ctx.beginPath(); ctx.roundRect(l, top, pw, ph, 6)
    ctx.fillStyle = rgba(mix(C.elev, color, 0.08), 0.96 * alpha); ctx.fill()
    ctx.strokeStyle = rgba(color, 0.6 * alpha); ctx.lineWidth = 1; ctx.stroke()
    text(s, l + 8, top + ph / 2, { size, color: fg ?? color, mono, alpha, align: 'left' })
    if (ok > 0.01) tick(snap(l + pw - 13), snap(top + ph / 2), 9, rgba(fg ?? color, alpha * ok), 1.5)
  }
  const arc = (x: number, y: number, r: number, from: number, frac: number, color: string, width = 2) => {
    if (frac <= 0.002) return
    ctx.beginPath(); ctx.arc(x, y, r, from, from + TAU * frac); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.stroke()
  }
  const pulse = (x: number, y: number, r: number, color: string, speed: number, weight: number) => {
    if (still || weight < 0.01) return
    for (let k = 0; k < 2; k++) { const p = (t * speed + k * 0.5) % 1; ctx.beginPath(); ctx.arc(x, y, r + out(p) * r * 0.8, 0, TAU); ctx.strokeStyle = rgba(color, (1 - p) * 0.3 * weight); ctx.lineWidth = 1; ctx.stroke() }
  }
  // The done badge, cut out of whatever is under it by a canvas-colored ring.
  const check = (x: number, y: number) => {
    ctx.beginPath(); ctx.arc(x, y, 10, 0, TAU); ctx.fillStyle = C.canvas; ctx.fill()
    ctx.beginPath(); ctx.arc(x, y, 8, 0, TAU); ctx.fillStyle = C.green; ctx.fill()
    tick(x, y, 8, light ? '#ffffff' : C.canvas, 1.75)
  }

  const legend: Array<[string, string]> = [['working', C.blue], ...(showTools ? [['tool call', C.yellow] as [string, string]] : []), ['done', C.green], ['needs you', C.red]]
  // The legend: one row, or more on a narrow stage (a key that would run past the edge starts a new row below);
  // each extra row lifts the picture above it by its height.
  ctx.font = `400 11px ${C.mono}`
  const rows: Array<Array<[string, string, number]>> = [[]]
  let lx = 16
  for (const [l, col] of legend) {
    const lw = ctx.measureText(l).width + 26
    if (lx > 16 && lx + lw - 15 > w - 8) { rows.push([]); lx = 16 }
    rows[rows.length - 1].push([l, col, lx]); lx += lw
  }
  const lift = (rows.length - 1) * 16
  const m = Math.min(w, h - lift), live = c.state === 'working', finished = c.state === 'done', needs = c.state === 'needs-you'
  const dim = tw('dim', c.state === 'idle' ? 0.45 : 1, TW.color)
  const wWork = tw('work', live ? 1 : 0, TW.color), wNeed = tw('need', needs ? 1 : 0, TW.color), wFin = tw('fin', finished ? 1 : 0, TW.color)
  const dots = gridPattern(ctx, d, C.hair)
  if (dots) { ctx.fillStyle = dots; ctx.fillRect(0, 0, w, h) }

  const cx = snap(w * 0.5), cy = snap((h - lift) * 0.5), R = m * 0.32, rr = m * 0.07, lr = m * 0.11, sr = Math.max(7, rr * 0.34)
  // The orbit: round 1.5px dots, 7px apart.
  ctx.setLineDash([0, 7]); ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.strokeStyle = rgba(C.ash, 0.6 * dim); ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([])
  const lead = { x: cx, y: cy }, you = { x: snap(cx - R * 1.55), y: snap(cy - R * 0.62) }, done = { x: snap(cx + R * 1.55), y: snap(cy + R * 0.66) }

  // The ring turns slowly while the chat works; once it stops, it settles back on its resting slots.
  const roles = ringRoles(c.progress), slot = TAU / roles.length
  if (live && !still) S.spin += tw('spinV', 0.035, TW.spin, 0) * S.dt / 1000
  else {
    const rest = Math.round(S.spin / slot) * slot
    S.spin = S.snap ? rest : approach(S.spin, rest, S.dt, TW.spin)
    if (S.spin !== rest) S.moving = true
  }
  // Each role glides to its slot when the ring grows; one the data dropped fades out where it was.
  for (const r of roles) S.ring.set(r.role, r)
  const order = new Map(roles.map((r, i) => [r.role, i]))
  type Look = P & { r: RoleOn; a: number; on: number; wA: number; wD: number; wU: number; wW: number; color: string; band: number }
  const pos = new Map<string, Look>()
  for (const r of S.ring.values()) {
    const i = order.get(r.role), key = r.role
    const on = tw(`on:${key}`, i === undefined ? 0 : 1, TW.enter, 0)
    if (i === undefined && on === 0) { S.ring.delete(key); continue }
    const a = tw(`a:${key}`, i === undefined ? S.v.get(`a:${key}`) ?? 0 : i * slot - Math.PI * 0.62, TW.move) + S.spin
    const extra = Math.max(0, r.running.length - 1)
    pos.set(key, {
      r, a, on, x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R,
      wA: tw(`wa:${key}`, r.state === 'active' ? 1 : 0, TW.color), wD: tw(`wd:${key}`, r.state === 'done' ? 1 : 0, TW.color),
      wU: tw(`wu:${key}`, r.state === 'unused' ? 1 : 0, TW.color), wW: tw(`ww:${key}`, r.state === 'waiting' ? 1 : 0, TW.color),
      color: twc(`c:${key}`, r.state === 'active' ? C.blue : r.state === 'done' ? C.green : C.ash),
      // How far the satellites reach past the bubble, so labels and tool pills clear them.
      band: tw(`band:${key}`, extra > SAT_ROW ? 2 * (2 * sr + 5) : extra ? 2 * sr + 5 : 0, TW.move),
    })
  }
  const active = roles.filter(r => r.state === 'active').map(r => r.role)

  edge(you, lead, C.ash, 0.7 * dim, [], -0.08)
  if (!still) spark(you, lead, (t * 0.3) % 1, C.blue, -0.08, 2, wWork)
  let seed = 0
  for (const p of pos.values()) {
    edge(lead, p, p.color, lerp(0.55, 0.35, p.wW) * dim * (1 - p.wU) * p.on, p.r.state === 'waiting' ? [3, 5] : [])
    seed += 0.37
    if (!still && p.wA > 0.01) for (let k = 0; k < 2; k++) spark(lead, p, (t * 0.42 + k / 2 + seed) % 1, C.blue, 0.1, 2.5, p.wA * p.on)
  }
  edge(lead, done, twc('de', finished ? C.green : C.ash), lerp(0.3 * dim, 0.7, wFin), finished ? [] : [3, 5], -0.06)

  // Tool calls: the newest few, out from whoever made them. A role not on the ring draws from the lead.
  if (showTools) {
    let calls = (c.progress?.tools ?? []).map(call => ({ call, age: still ? 0 : now - (born.get(`${call.at}:${call.tool}`) ?? -1e9) }))
      .filter(e => (still ? live : e.age < PILL_MS))
    if (!still) calls = calls.slice(-4)
    // Each source's pills fan out around its outward direction, newest nearest; a still frame keeps the newest 2 per source.
    const groups = new Map<string, typeof calls>(), placed: P[] = [done, you]
    for (const e of calls) { const k = pos.has(e.call.role) ? e.call.role : 'lead'; groups.set(k, [...(groups.get(k) ?? []), e]) }
    for (const [k, all] of groups) {
      const list = (still ? all.slice(-2) : all).reverse()
      list.forEach(({ call, age }, i) => {
        const ring = pos.get(k), src = ring ?? lead, key = `${call.at}:${call.tool}`
        const base = ring ? Math.atan2(src.y - cy, src.x - cx) : Math.PI * 1.5
        const r0 = (ring ? rr + ring.band : lr) + 8
        const dd = r0 + (still ? 1 : out(Math.min(1, age / 1400))) * m * 0.13 + i * 14
        // 0.45 rad apart, or at least 40px of arc on a small stage.
        const ang = base + (i - (list.length - 1) / 2) * Math.max(0.45, 40 / dd)
        // Kept inside the stage; a pill that would cover one already drawn takes the first free spot nearby,
        // and with none free it is left out (the Activity feed below still lists it).
        const x0 = src.x + Math.cos(ang) * dd, y0 = src.y + Math.sin(ang) * dd
        const spot = SPOTS.map(([dx, dy]) => ({ x: Math.min(w - 48, Math.max(48, x0 + dx)), y: Math.min(h - 52, Math.max(18, y0 + dy)) }))
          .find(s => !placed.some(p => Math.abs(p.x - s.x) < 60 && Math.abs(p.y - s.y) < 34))
        if (!spot) return
        placed.push(spot)
        // A newer call pushes older ones outward; they glide there instead of jumping a slot.
        const x = tw(`tx:${key}`, spot.x, TW.move), y = tw(`ty:${key}`, spot.y, TW.move)
        // A spark runs out to where the pill lands, drawing the line behind it; the pill fades in as it arrives.
        const reach = still ? 1 : out(Math.min(1, age / 340))
        const a = still ? 1 : age < 120 ? 0 : age < 340 ? (age - 120) / 220 : age > 2100 ? Math.max(0, 1 - (age - 2100) / 700) : 1
        const sx = src.x + Math.cos(ang) * (r0 - 8), sy = src.y + Math.sin(ang) * (r0 - 8), ex = lerp(sx, x, reach), ey = lerp(sy, y, reach)
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey)
        ctx.strokeStyle = rgba(C.yellow, 0.3 * (age > 2100 ? a : 1)); ctx.lineWidth = 1; ctx.stroke()
        if (!still && age < 420) { ctx.beginPath(); ctx.arc(ex, ey, 2.5, 0, TAU); ctx.fillStyle = rgba(C.yellow, age < 340 ? 1 : 1 - (age - 340) / 80); ctx.fill() }
        if (a <= 0) return
        pill(x, y, call.tool, C.yellow, a, { size: 11 })
        if (call.target) { ctx.font = `400 10px ${C.mono}`; text(fit(call.target, w * 0.28), x, y + 18, { size: 10, color: C.mute, mono: true, weight: 400, alpha: a }) }
      })
    }
  }

  bubble(you.x, you.y, m * 0.052, C.ash, { wash: 0.1, dim })
  text('You', you.x, you.y, { size: 12, alpha: dim })

  // One small bubble per extra subagent of a role (the role's own bubble is the first), fanned out past it.
  // A new one pops out of the role; one that stops shrinks back into it.
  for (const r of roles) for (const id of r.running.slice(1)) S.sats.set(id, r.role)
  for (const [id, role] of S.sats) {
    const p = pos.get(role), list = p?.r.running.slice(1) ?? [], i = list.indexOf(id), at = i < 0 ? undefined : satSlot(i, list.length)
    const on = tw(`son:${id}`, at && p ? 1 : 0, TW.enter, 0)
    if (!p || (!at && on === 0)) { S.sats.delete(id); continue }
    const across = tw(`sat:${id}`, at?.at ?? S.v.get(`sat:${id}`) ?? 0, TW.move), row = tw(`sro:${id}`, at?.row ?? S.v.get(`sro:${id}`) ?? 0, TW.move)
    const base = Math.atan2(p.y - cy, p.x - cx), dist = (rr + sr + 6 + row * (2 * sr + 5)) * (0.45 + 0.55 * on)
    const ang = base + across * (2 * sr + 5) / dist, x = p.x + Math.cos(ang) * dist, y = p.y + Math.sin(ang) * dist
    pop(x, y, 0.6 + 0.4 * on, on * p.on, () => {
      ctx.beginPath(); ctx.arc(x, y, sr + 2.5, 0, TAU); ctx.fillStyle = C.canvas; ctx.fill()
      ctx.beginPath(); ctx.arc(x, y, sr, 0, TAU); ctx.fillStyle = mix(C.card, C.blue, light ? 0.1 : 0.16); ctx.fill()
      // A slow breath, out of step with its neighbours, says it is working without a spinner on each one.
      const breath = still ? 1 : 0.75 + 0.25 * Math.sin(t * 2.2 + across * 1.3 + row)
      ctx.strokeStyle = rgba(C.blue, 0.85 * breath * dim); ctx.lineWidth = 1.5; ctx.stroke()
    })
  }

  // The question pill's box, so a model label under a role moves above its bubble instead of crowding it.
  const qText = needs ? c.progress?.question : undefined
  if (qText) S.q = qText
  ctx.font = `500 12px ${C.sans}`
  const qShown = S.q ? fit(S.q, w * 0.55) : '', qBox = qText ? pillBox(cx, cy - lr - 30, qShown, { size: 12, mono: false }) : undefined

  for (const p of pos.values()) {
    const { r, wA, wD, wU } = p
    const accent = ACCENT[r.role] ? C[ACCENT[r.role]] : undefined, quiet = r.state === 'unused' || r.state === 'waiting'
    pop(p.x, p.y, 0.6 + 0.4 * p.on, p.on, () => {
      bubble(p.x, p.y, rr, p.color, { wash: lerp(0.14, accent ? 0.06 : 0.03, wU), ring: lerp(1, 0.35, wU), glow: 14 * wA, dim, accent, tint: quiet && accent ? accent : p.color })
      // No per-role progress exists, so the active role gets a slow turning arc instead of a filling one.
      if (wA > 0.01) arc(p.x, p.y, rr - 5, -Math.PI / 2 + (still ? 0 : t * 1.6), 0.28, rgba(C.blue, 0.9 * wA), 2)
      // Shrinks to fit the bubble, down to 9px, before it cuts the name.
      // The fitted size is kept per name and bubble size, so a frame does not re-measure it.
      const key = `${r.role}|${Math.round(rr)}|${C.sans}`
      let size = labelSize.get(key) ?? Math.max(11, rr * 0.28)
      if (!labelSize.has(key)) {
        for (ctx.font = `500 ${size}px ${C.sans}`; size > 9 && ctx.measureText(r.role).width > rr * 1.7; size -= 0.5) ctx.font = `500 ${size - 0.5}px ${C.sans}`
        if (labelSize.size > 200) labelSize.clear()
        labelSize.set(key, size)
      }
      ctx.font = `500 ${size}px ${C.sans}`
      // An unused role reads quieter in mute, not in a faded ink that fails contrast.
      text(fit(r.role, rr * 1.7), p.x, p.y, { size, color: mix(C.ink, C.mute, wU), alpha: dim })
      const bx = p.x + rr * 0.72, by = p.y - rr * 0.72
      const ok = wD * (1 - wA)
      if (ok > 0.01) pop(bx, by, 0.6 + 0.4 * ok, ok, () => check(bx, by))
      // How many of this role run, once more than one does; the count stays while the badge fades.
      if (r.running.length > 1) S.badge.set(r.role, r.running.length)
      const kb = tw(`kb:${r.role}`, r.running.length > 1 ? 1 : 0, TW.enter, 0)
      if (kb > 0.01 && S.badge.has(r.role)) pop(bx, by, 0.7 + 0.3 * kb, kb, () => pill(bx + 4, by, `×${S.badge.get(r.role)}`, C.blue, 1, { size: 10, fg: C.ink }))
      else if (kb === 0) S.badge.delete(r.role)
      const model = c.models?.[r.role]
      if (model) {
        ctx.font = `400 10px ${C.mono}`
        const label = fit(model, rr * 2.4), half = ctx.measureText(label).width / 2 + 8
        let ly = p.y + rr + 11 + p.band * Math.max(0, Math.sin(p.a))
        if (qBox && p.x + half > qBox.l && p.x - half < qBox.l + qBox.pw && ly + 14 > qBox.top && ly - 14 < qBox.top + qBox.ph) ly = p.y - rr - 11 - p.band * Math.max(0, -Math.sin(p.a))
        text(label, p.x, tw(`ly:${r.role}`, ly, TW.move), { size: 10, color: C.mute, mono: true, weight: 400, alpha: dim })
      }
    })
  }

  const lc = twc('lead', C[STATE[c.state].key])
  pulse(cx, cy, lr, C.blue, 0.3, wWork)
  pulse(cx, cy, lr, C.red, 0.6, wNeed)
  bubble(cx, cy, lr, lc, { wash: 0.18, glow: 18 * Math.min(1, wWork + wNeed + wFin), dim })
  const tokens = c.live?.tokens, cap = c.live?.compactAt
  if (tokens && cap) {
    const fill = tw('fill', Math.min(1, tokens / cap), TW.move)
    ctx.beginPath(); ctx.arc(cx, cy, lr + 7, 0, TAU); ctx.strokeStyle = C.hair; ctx.lineWidth = 2; ctx.stroke()
    arc(cx, cy, lr + 7, -Math.PI / 2, fill, rgba(fill > 0.85 ? C.yellow : C.blue, 0.9 * dim), 2)
  }
  text('Lead', cx, cy - lr * 0.16, { size: Math.max(12, lr * 0.25), weight: 600, alpha: dim })
  // The line under Lead crossfades when it changes.
  const sub = live ? (active.length ? `${active.length > 1 ? `${active.length} roles` : active[0]} working` : 'planning') : needs ? 'waiting on you' : finished ? 'finished' : `idle ${c.ago}`
  if (S.snap || !S.sub) S.sub = { text: sub, at: -1e9 }
  else if (S.sub.text !== sub) S.sub = { text: sub, prev: S.sub.text, at: now }
  const fade = Math.min(1, (now - S.sub.at) / 180)
  if (fade < 1) S.moving = true
  const subAt = (s: string, a: number) => text(s, cx, cy + lr * 0.26, { size: Math.max(10, lr * 0.13), color: C.mute, mono: true, weight: 400, alpha: dim * a })
  if (S.sub.prev && fade < 1) subAt(S.sub.prev, 1 - fade)
  subAt(S.sub.text, fade)
  // The question slides down into place and fades; it fades back out once answered.
  const qOn = tw('q', qText ? 1 : 0, TW.enter, 0)
  if (qOn > 0.01 && qShown) pop(cx, cy - lr - 30, 1, qOn, () => pill(cx, cy - lr - 30 - (1 - qOn) * 6, qShown, C.red, 1, { size: 12, mono: false, fg: C.ink }))

  pill(done.x, done.y, 'Done', twc('dc', finished ? C.green : C.ash), lerp(dim, 1, wFin), { size: 12, mono: false, fg: twc('df', finished ? C.green : C.mute), check: wFin })
  if (wFin > 0.01) text(c.progress?.commit ? 'commit message ready' : 'no commit message', done.x, done.y + 24, { size: 10, color: C.green, mono: true, weight: 400, alpha: wFin })

  rows.forEach((row, i) => {
    const ly = h - 18 - (rows.length - 1 - i) * 16
    for (const [l, col, x] of row) {
      ctx.beginPath(); ctx.arc(snap(x + 3), snap(ly), 3, 0, TAU); ctx.fillStyle = col; ctx.fill()
      text(l, x + 11, ly, { size: 11, color: C.mute, mono: true, weight: 400, align: 'left' })
    }
  })

  for (const k of S.v.keys()) if (!S.seen.has(k)) S.v.delete(k)
  S.glide = S.moving || (live && !still)
  S.snap = still
}

/** instant: the chat was picked from the keyboard, so it swaps with no crossfade. */
export function Orbit({ chat, showTools, instant }: { chat: OrbitChat; showTools: boolean; instant?: boolean }) {
  const stage = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null)
  const shown = useRef(chat), tools = useRef(showTools), born = useRef(new Map<string, number>()), redraw = useRef(() => {})
  const scene = useRef(newScene())

  // New tool calls get a birth time; the first look at a chat dates its calls by their own clock, so old ones stay hidden.
  const stamp = (c: OrbitChat, first: boolean) => {
    const b = born.current, now = performance.now(), keep = new Set<string>()
    if (first) { b.clear(); scene.current = newScene() }
    for (const call of c.progress?.tools ?? []) {
      const k = `${call.at}:${call.tool}`; keep.add(k)
      if (!b.has(k)) b.set(k, first ? now - Math.max(0, Date.now() - call.at) : now)
    }
    for (const k of b.keys()) if (!keep.has(k)) b.delete(k)
  }

  useEffect(() => { tools.current = showTools; redraw.current() }, [showTools])
  useEffect(() => {
    const prev = shown.current
    if (prev.id === chat.id) { shown.current = chat; stamp(chat, false); redraw.current(); return }
    const commit = () => { shown.current = chat; stamp(chat, true); redraw.current(); stage.current?.classList.remove('swap') }
    if (instant || matchMedia('(prefers-reduced-motion: reduce)').matches) { commit(); return }
    stage.current?.classList.add('swap')
    const t = setTimeout(commit, 120)
    return () => clearTimeout(t)
  }, [chat, instant])

  useEffect(() => {
    const el = canvas.current!, ctx = el.getContext('2d')!
    const motion = matchMedia('(prefers-reduced-motion: reduce)'), light = matchMedia('(prefers-color-scheme: light)')
    let pal = readPal(el), W = 0, H = 0, raf = 0, onScreen = true, dpr = 1, last = 0
    const t0 = performance.now()
    stamp(shown.current, true)
    // dt: ms since the last drawn frame, capped so a frame after a pause steps, not jumps.
    const frame = (now: number, dt: number) => {
      ctx.clearRect(0, 0, W, H)
      scene.current.dt = Math.min(50, Math.max(0, dt)); last = now
      if (W && H) draw(ctx, W, H, (now - t0) / 1000, now, shown.current, tools.current, born.current, pal, motion.matches, dpr, scene.current)
    }
    // The loop runs only while the picture moves and can be seen; otherwise one frame is drawn and it sleeps until something changes.
    const moves = (now: number) => orbitMoves(shown.current, [...born.current.values()].map(b => now - b), tools.current, scene.current.moving)
    const run = (now: number) => !motion.matches && onScreen && !document.hidden && vscodeBridge?.shown !== false && moves(now)
    const loop = (now: number) => { frame(now, now - last); raf = run(now) ? requestAnimationFrame(loop) : 0 }
    const wake = () => { if (raf) return; const now = performance.now(); frame(now, 16); if (run(now)) raf = requestAnimationFrame(loop) }
    redraw.current = wake
    // The backing store matches the CSS size times the device pixel ratio (capped), so nothing is scaled by the browser.
    const size = () => {
      const r = el.getBoundingClientRect()
      dpr = Math.min(MAX_DPR, devicePixelRatio || 1)
      W = r.width; H = r.height
      const bw = Math.round(W * dpr), bh = Math.round(H * dpr)
      if (el.width !== bw || el.height !== bh) { el.width = bw; el.height = bh }
      dpr = W ? bw / W : dpr
      // A new size lands everything at once; gliding to a layout nobody asked for reads as a glitch.
      ctx.setTransform(dpr, 0, 0, H ? bh / H : dpr, 0, 0); scene.current.snap = true; frame(performance.now(), 0)
    }
    // A move to a screen with another pixel ratio (or a browser zoom) changes no CSS size, so it is watched on its own.
    let dprQuery: MediaQueryList | undefined
    const onDpr = () => { size(); watchDpr() }
    const watchDpr = () => { dprQuery?.removeEventListener('change', onDpr); dprQuery = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`); dprQuery.addEventListener('change', onDpr) }
    watchDpr()
    const theme = () => { pal = readPal(el); labelSize.clear(); scene.current.snap = true; frame(performance.now(), 0) }
    const ro = new ResizeObserver(size); ro.observe(el)
    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; wake() }); io.observe(el)
    const mo = new MutationObserver(theme); mo.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    light.addEventListener('change', theme); motion.addEventListener('change', wake); document.addEventListener('visibilitychange', wake)
    const offShown = vscodeBridge?.onShown(wake)
    void document.fonts?.ready.then(theme)
    wake()
    return () => {
      cancelAnimationFrame(raf); raf = 0; redraw.current = () => {}
      ro.disconnect(); io.disconnect(); mo.disconnect(); offShown?.(); dprQuery?.removeEventListener('change', onDpr)
      light.removeEventListener('change', theme); motion.removeEventListener('change', wake); document.removeEventListener('visibilitychange', wake)
    }
  }, [])

  return (
    <div ref={stage} className="hub-stage" style={{ position: 'relative', width: '100%', maxWidth: '100%', minWidth: 0, maxHeight: 520, borderRadius: 12, border: '1px solid var(--hub-hair)', background: 'var(--hub-canvas)', overflow: 'hidden' }}>
      <canvas ref={canvas} role="img" aria-label={describe(chat)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
    </div>
  )
}
