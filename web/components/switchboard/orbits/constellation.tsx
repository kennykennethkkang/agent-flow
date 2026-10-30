'use client'
// Constellation: the lead in the middle, each role on its own bearing, on the inner ring while it works and the
// outer ring otherwise. A change is one eased move along that bearing, so nothing wobbles or crosses.
// The frame loop runs only while something moves and the picture can be seen; reduced motion draws still frames.
import { useEffect, useRef } from 'react'
import { almostDone } from '../look'
import { approach, TAU as TW } from '@/lib/orbit-motion'
import { ringHeight, rings, teamOf } from '@/lib/orbit-views'
import { vscodeBridge } from '@/lib/vscode-bridge'
import { describe, MAX_DPR, type OrbitChat } from '../orbit'
import { LABEL, Legend, NAME, Reveal, glyphOf, leadLine, type ViewProps } from './parts'
import { CommitText } from '../commit-text'

const KEYS = ['canvas', 'card', 'hair', 'ink', 'mute', 'ash', 'blue', 'red', 'green', 'yellow', 'teal'] as const
type Pal = Record<(typeof KEYS)[number], string> & { sans: string; mono: string }
const TAU = Math.PI * 2
const POP_MS = 1600
const rgba = (hex: string, a: number) => { const n = parseInt(hex.replace('#', ''), 16) || 0; return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})` }
const inOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2)
function readPal(el: Element): Pal {
  const s = getComputedStyle(el), v = (k: string) => s.getPropertyValue(`--hub-${k}`).trim().replace(/^#(\w)(\w)(\w)$/, '#$1$1$2$2$3$3')
  return { ...Object.fromEntries(KEYS.map(k => [k, v(k) || '#888888'])), sans: v('sans') || 'sans-serif', mono: v('mono') || 'monospace' } as Pal
}

/** Eased values by key, satellites still fading out, tool labels by role, and the call keys already seen. */
type Scene = { v: Map<string, number>; seen: Set<string>; moving: boolean; snap: boolean; dt: number; sats: Map<string, { role: string; slot: number }>; pops: Map<string, { tool: string; born: number }>; calls: Set<string> | null }
const newScene = (): Scene => ({ v: new Map(), seen: new Set(), moving: false, snap: true, dt: 0, sats: new Map(), pops: new Map(), calls: null })

function draw(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, now: number, c: OrbitChat, showTools: boolean, C: Pal, still: boolean, S: Scene) {
  if (still) S.snap = true
  S.seen.clear(); S.moving = false
  const tw = (k: string, to: number, tau: number = TW.move * 1.2, from = to) => {
    const v = S.snap ? to : approach(S.v.get(k) ?? from, to, S.dt, tau)
    S.v.set(k, v); S.seen.add(k)
    if (v !== to) S.moving = true
    return v
  }
  // A color eased channel by channel, so a state change fades instead of flipping.
  const twc = (k: string, hex: string) => { const n = parseInt(hex.replace('#', ''), 16) || 0; return '#' + [16, 8, 0].map((sh, i) => Math.round(tw(`${k}.${i}`, (n >> sh) & 255, TW.color * 2)).toString(16).padStart(2, '0')).join('') }
  const text = (s: string, x: number, y: number, o: { size?: number; color?: string; weight?: number; mono?: boolean; alpha?: number; max?: number } = {}) => {
    const { size = 12, color = C.ink, weight = 500, mono = false, alpha = 1, max = 999 } = o
    ctx.font = `${weight} ${size}px ${mono ? C.mono : C.sans}`
    if (ctx.measureText(s).width > max) { while (s.length > 3 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1); s += '…' }
    ctx.fillStyle = rgba(color, alpha); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(s, Math.round(x), Math.round(y))
  }
  const glyph = (k: string, x: number, y: number, color: string, s = 14) => {
    ctx.save(); ctx.translate(x - s / 2, y - s / 2); ctx.scale(s / 16, s / 16)
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    for (const g of glyphOf(k)) {
      const p = g.d ? new Path2D(g.d) : new Path2D()
      if (g.c) p.arc(g.c[0], g.c[1], g.c[2], 0, TAU)
      if (g.r) p.roundRect(g.r[0], g.r[1], g.r[2], g.r[3], g.r[4])
      if (g.f) ctx.fill(p); else ctx.stroke(p)
    }
    ctx.restore()
  }
  // A thin line between two circles, trimmed to their edges.
  const tether = (ax: number, ay: number, ar: number, bx: number, by: number, br: number, color: string, alpha: number, dash: number[] = []) => {
    const d = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / d, uy = (by - ay) / d
    if (alpha < 0.01 || d < ar + br + 4) return
    ctx.beginPath(); ctx.moveTo(ax + ux * (ar + 3), ay + uy * (ar + 3)); ctx.lineTo(bx - ux * (br + 3), by - uy * (br + 3))
    ctx.strokeStyle = rgba(color, alpha); ctx.lineWidth = 1; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([])
  }
  const disc = (x: number, y: number, r: number, ring: string, o: { alpha?: number; dash?: number[]; width?: number; tint?: number } = {}) => {
    const { alpha = 1, dash = [], width = 1.5, tint = 0 } = o
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = C.card; ctx.fill()
    if (tint > 0.01) { ctx.fillStyle = rgba(ring, tint); ctx.fill() }
    ctx.beginPath(); ctx.arc(x, y, r - width / 2, 0, TAU); ctx.strokeStyle = rgba(ring, alpha); ctx.lineWidth = width; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([])
  }

  const p = c.progress, team = teamOf(p), L = rings(team, W, H), almost = almostDone(p)
  const live = c.state === 'working', needs = c.state === 'needs-you', finished = c.state === 'done'
  const dim = tw('dim', c.state === 'idle' ? 0.55 : 1)
  const tone = (s: string) => s === 'active' ? C.blue : s === 'done' ? C.green : C.ash

  // The two rings, as faint dotted hairlines; the inner one widens or narrows with its roles.
  const inner = tw('inner', L.inner)
  ctx.lineWidth = 1; ctx.strokeStyle = rgba(C.ash, 0.45 * dim); ctx.setLineDash([1, 5])
  for (const k of [inner, 1]) { ctx.beginPath(); ctx.ellipse(L.cx, L.cy, L.rx * k, L.ry * k, 0, 0, TAU); ctx.stroke() }
  ctx.setLineDash([])

  const pos = new Map(team.map(m => {
    const a = L.angle[m.role], k = tw(`k:${m.role}`, m.state === 'active' ? L.inner : 1)
    return [m.role, { m, x: L.cx + Math.cos(a) * L.rx * k, y: L.cy + Math.sin(a) * L.ry * k, color: twc(`c:${m.role}`, tone(m.state)), on: tw(`on:${m.role}`, 1, TW.enter * 2, 0) }]
  }))
  const lr = L.lr, nr = L.nr

  // Lines first, so nodes sit on top.
  const youC = twc('youc', needs ? C.red : C.ash)
  // You link to the lead only while it waits on you, so the line never cuts across the rings otherwise.
  tether(L.you.x, L.you.y, 12, L.cx, L.cy, lr + 4, youC, tw('youT', needs ? 0.8 : 0, TW.color * 3), [3, 3])
  let seed = 0
  for (const { m, x, y, color, on } of pos.values()) {
    const a = m.state === 'active' ? 0.7 : m.state === 'done' ? 0.35 : m.state === 'waiting' ? 0.45 : 0
    tether(L.cx, L.cy, lr + 4, x, y, nr, color, tw(`ta:${m.role}`, a) * dim * on, m.state === 'waiting' ? [2, 4] : [])
    seed += 0.31
    // One small spark at a time runs out to a working role.
    if (m.state === 'active' && !still) {
      const u = (t * 0.45 + seed) % 1, e = inOut(u), k = Math.sin(Math.PI * u)
      const sx = L.cx + (x - L.cx) * e, sy = L.cy + (y - L.cy) * e
      ctx.beginPath(); ctx.arc(sx, sy, 2, 0, TAU); ctx.fillStyle = rgba(C.blue, 0.9 * k); ctx.fill()
    }
  }

  // You.
  disc(L.you.x, L.you.y, 12, youC, { width: 1, alpha: needs ? 0.9 : 0.6 })
  glyph('you', L.you.x, L.you.y, needs ? C.red : C.mute, 11)
  text('You', L.you.x, L.you.y + 24, { size: 11, color: C.mute, alpha: dim })

  // Satellites: one dot per extra subagent of a role, in an orderly arc on its far side; a stopped one fades out in place.
  for (const { m } of pos.values()) m.runs.filter(r => r.state === 'active').slice(1, 7).forEach((r, i) => S.sats.set(r.id, { role: m.role, slot: i }))
  for (const [id, s] of S.sats) {
    const q = pos.get(s.role), list = q ? q.m.runs.filter(r => r.state === 'active').slice(1, 7) : []
    const i = list.findIndex(r => r.id === id), a = tw(`sa:${id}`, i < 0 ? 0 : 1, TW.enter * 2, 0)
    if (!q || (i < 0 && a === 0)) { S.sats.delete(id); continue }
    if (i >= 0) s.slot = i
    const n = Math.max(1, i < 0 ? list.length + 1 : list.length), slot = tw(`ss:${id}`, s.slot - (n - 1) / 2)
    const out = Math.atan2(q.y - L.cy, q.x - L.cx), dist = nr + 9, ang = out + (slot * 9) / dist
    const sx = q.x + Math.cos(ang) * dist, sy = q.y + Math.sin(ang) * dist
    ctx.beginPath(); ctx.arc(sx, sy, 3 * (0.7 + 0.3 * a), 0, TAU); ctx.fillStyle = rgba(C.blue, 0.9 * a * dim); ctx.fill()
  }

  // Roles.
  for (const { m, x, y, color, on } of pos.values()) {
    ctx.save(); ctx.globalAlpha = on
    const unused = m.state === 'unused', waiting = m.state === 'waiting'
    disc(x, y, nr, color, { alpha: (unused ? 0.4 : waiting ? 0.7 : 0.9) * dim, width: unused || waiting ? 1 : 1.5, dash: unused ? [2, 3] : [], tint: m.state === 'active' ? 0.08 : 0 })
    glyph(m.role, x, y, unused ? rgba(C.ash, 0.7) : waiting ? C.mute : color, 14)
    const wa = tw(`wa:${m.role}`, m.state === 'active' ? 1 : 0, TW.color * 2)
    if (wa > 0.01) {
      const a0 = still ? -Math.PI / 2 : t * 2.4
      ctx.beginPath(); ctx.arc(x, y, nr + 4, a0, a0 + 1.1); ctx.strokeStyle = rgba(C.blue, 0.9 * wa); ctx.lineWidth = 1.5; ctx.lineCap = 'round'; ctx.stroke()
    }
    const ok = tw(`ok:${m.role}`, m.state === 'done' ? 1 : 0, TW.enter * 2, 0)
    if (ok > 0.01) {
      const bx = x + nr * 0.74, by = y - nr * 0.74, s = 0.7 + 0.3 * ok
      ctx.beginPath(); ctx.arc(bx, by, 7 * s, 0, TAU); ctx.fillStyle = rgba(C.canvas, ok); ctx.fill()
      ctx.beginPath(); ctx.arc(bx, by, 5.5 * s, 0, TAU); ctx.fillStyle = rgba(C.green, ok); ctx.fill()
      ctx.beginPath(); ctx.moveTo(bx - 2.4 * s, by); ctx.lineTo(bx - 0.6 * s, by + 1.8 * s); ctx.lineTo(bx + 2.5 * s, by - 1.8 * s)
      ctx.strokeStyle = rgba(C.canvas, ok); ctx.lineWidth = 1.4; ctx.stroke()
    }
    if (m.running > 7) text(`+${m.running - 7}`, x + nr + 12, y - nr, { size: 10, color: C.blue, mono: true })
    text(NAME(m.role), x, y + nr + 12, { size: 12, color: unused ? C.mute : C.ink, alpha: dim, max: L.label })
    text(unused ? LABEL.unused : [LABEL[m.state], c.models?.[m.role]].filter(Boolean).join(' · '), x, y + nr + 26, { size: 10.5, mono: true, weight: 400, color: C.ash, alpha: dim, max: L.label })
    ctx.restore()
  }

  // The lead: a soft breathing halo while it works or waits on you, its context as a thin arc.
  const lc = twc('lead', needs ? C.red : finished ? (almost ? C.teal : C.green) : live ? C.blue : c.state === 'idle' ? C.yellow : C.ash)
  const halo = tw('halo', live || needs ? 1 : 0, TW.color * 3)
  if (halo > 0.01) {
    const b = still ? 0.7 : 0.6 + 0.4 * Math.sin(t * 2.2)
    const g = ctx.createRadialGradient(L.cx, L.cy, lr, L.cx, L.cy, lr + 16)
    g.addColorStop(0, rgba(lc, 0.18 * b * halo)); g.addColorStop(1, rgba(lc, 0))
    ctx.beginPath(); ctx.arc(L.cx, L.cy, lr + 16, 0, TAU); ctx.fillStyle = g; ctx.fill()
  }
  disc(L.cx, L.cy, lr, lc, { alpha: 0.95 * dim, tint: 0.06 })
  const tokens = c.live?.tokens, cap = c.live?.compactAt
  if (tokens && cap) {
    const fill = tw('fill', Math.min(1, tokens / cap))
    ctx.beginPath(); ctx.arc(L.cx, L.cy, lr + 4, 0, TAU); ctx.strokeStyle = rgba(C.hair, 1); ctx.lineWidth = 1.5; ctx.stroke()
    ctx.beginPath(); ctx.arc(L.cx, L.cy, lr + 4, -Math.PI / 2, -Math.PI / 2 + TAU * fill); ctx.strokeStyle = rgba(fill > 0.85 ? C.yellow : lc, 0.9); ctx.lineCap = 'round'; ctx.stroke()
  }
  text('Lead', L.cx, L.cy, { size: 13, weight: 600, alpha: dim })
  const active = team.filter(m => m.state === 'active').map(m => m.role)
  text(leadLine(c, almost, active), L.cx, L.cy + lr + 14, { size: 11, mono: true, weight: 400, color: C.mute, alpha: dim, max: L.leadW })

  // Tool calls: the newest per role, a small label that rises a few pixels above it and fades.
  if (showTools) for (const [role, pop] of S.pops) {
    const age = now - pop.born
    if (age > POP_MS) { S.pops.delete(role); continue }
    S.moving = true
    const q = role === 'lead' ? { x: L.cx, y: L.cy - lr + nr } : pos.get(role)
    if (!q) continue
    const a = still ? 1 : age < 160 ? age / 160 : age > POP_MS - 400 ? (POP_MS - age) / 400 : 1, rise = still ? 0 : 3 * Math.min(1, age / 400)
    text(pop.tool, q.x, q.y - nr - 11 - rise, { size: 10.5, mono: true, color: C.yellow, alpha: a, max: L.label })
  }

  for (const k of S.v.keys()) if (!S.seen.has(k)) S.v.delete(k)
  S.snap = still
}

export function Constellation({ chat, showTools }: ViewProps) {
  const stage = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null)
  const shown = useRef(chat), tools = useRef(showTools), redraw = useRef(() => {}), scene = useRef(newScene())

  // New tool calls become labels; the first look at a chat shows none.
  const stamp = (c: OrbitChat) => {
    const S = scene.current, keys = (c.progress?.tools ?? []).map(k => `${k.at}:${k.tool}`)
    if (!S.calls) { S.calls = new Set(keys); return }
    ;(c.progress?.tools ?? []).forEach((k, i) => { if (!S.calls!.has(keys[i])) S.pops.set(k.role, { tool: k.tool, born: performance.now() }) })
    S.calls = new Set(keys)
  }
  useEffect(() => { tools.current = showTools; redraw.current() }, [showTools])
  useEffect(() => { shown.current = chat; stamp(chat); redraw.current() }, [chat])

  useEffect(() => {
    const el = canvas.current!, box = stage.current!, ctx = el.getContext('2d')!
    const motion = matchMedia('(prefers-reduced-motion: reduce)'), light = matchMedia('(prefers-color-scheme: light)')
    let pal = readPal(el), W = 0, H = 0, raf = 0, onScreen = true, last = 0
    const t0 = performance.now()
    const frame = (now: number, dt: number) => {
      const S = scene.current
      S.dt = Math.min(50, Math.max(0, dt)); last = now
      // The stage's height follows its width and team size; a change lands at once.
      const want = ringHeight(W, teamOf(shown.current.progress).length)
      if (W && Math.abs(want - H) > 1) { box.style.height = `${want}px`; return }
      ctx.clearRect(0, 0, W, H)
      if (W && H) draw(ctx, W, H, (now - t0) / 1000, now, shown.current, tools.current, pal, motion.matches, S)
    }
    const moves = () => {
      const c = shown.current, S = scene.current
      return S.moving || S.pops.size > 0 || c.state === 'working' || c.state === 'needs-you' || (c.progress?.roles ?? []).some(r => r.state === 'active')
    }
    const run = () => !motion.matches && onScreen && !document.hidden && vscodeBridge?.shown !== false && moves()
    const loop = (now: number) => { frame(now, now - last); raf = run() ? requestAnimationFrame(loop) : 0 }
    const wake = () => { if (raf) return; const now = performance.now(); frame(now, 16); if (run()) raf = requestAnimationFrame(loop) }
    redraw.current = wake
    const size = () => {
      // client sizes, not the bounding rect: the fade-in's transform would make them fractional.
      const d = Math.min(MAX_DPR, devicePixelRatio || 1)
      W = box.clientWidth; H = box.clientHeight
      el.width = Math.round(W * d); el.height = Math.round(H * d)
      ctx.setTransform(el.width / (W || 1), 0, 0, el.height / (H || 1), 0, 0)
      scene.current.snap = true; frame(performance.now(), 0)
    }
    const theme = () => { pal = readPal(el); scene.current.snap = true; frame(performance.now(), 0) }
    const ro = new ResizeObserver(size); ro.observe(box)
    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; wake() }); io.observe(box)
    const mo = new MutationObserver(theme); mo.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    light.addEventListener('change', theme); motion.addEventListener('change', wake); document.addEventListener('visibilitychange', wake)
    const offShown = vscodeBridge?.onShown(wake)
    void document.fonts?.ready.then(theme)
    stamp(shown.current); wake()
    return () => {
      cancelAnimationFrame(raf); raf = 0; redraw.current = () => {}
      ro.disconnect(); io.disconnect(); mo.disconnect(); offShown?.()
      light.removeEventListener('change', theme); motion.removeEventListener('change', wake); document.removeEventListener('visibilitychange', wake)
    }
  }, [])

  const p = chat.progress, almost = almostDone(p)
  return (
    <div className="ov-stage ov-sky">
      <div ref={stage} className="ov-canvas">
        <canvas ref={canvas} role="img" aria-label={describe(chat)} />
      </div>
      <Reveal on={chat.state === 'needs-you'} className="ov-call"><span data-tone="needs"><b>Needs you</b>{p?.question ?? 'This chat is waiting on you.'}</span></Reveal>
      <Reveal on={chat.state === 'done'} className="ov-call"><span data-tone={almost ? 'almost' : 'done'}><b>{almost ? 'Almost done' : 'Finished'}</b>{p?.commit ? <CommitText text={p.commit} max={180} /> : 'No commit message.'}</span></Reveal>
      <Legend tools={showTools} almost={almost} />
    </div>
  )
}
