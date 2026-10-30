/** The four extra center pictures: their pure parts (team rows, loops, timeline, ring layout). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatProgress } from './hub-types'
import { axisTicks, laneBars, PX_PER_MIN, trackWidth, loopBacks, loopsOf, parseView, ringHeight, rings, teamOf, timeline } from './orbit-views'

const M = 60e3
const prog = (o: Partial<ChatProgress>): ChatProgress => ({ sessionId: 's', cwd: '/x', state: 'working', roles: [], tasks: [], startedAt: 0, at: 0, ...o })

test('parseView: a known style, else orbit', () => {
  assert.equal(parseView('lanes'), 'lanes')
  assert.equal(parseView('deck'), 'deck')
  assert.equal(parseView(null), 'orbit')
  assert.equal(parseView('bogus'), 'orbit')
})

test('teamOf: no progress still shows researcher, engineer and qa, unused', () => {
  assert.deepEqual(teamOf(undefined).map(r => [r.role, r.state]), [['researcher', 'unused'], ['engineer', 'unused'], ['qa', 'unused']])
})

test('teamOf: plan order, extra roles last, a role with only a task is waiting', () => {
  const t = teamOf(prog({
    roles: [{ id: 'j', role: 'jev', state: 'done', startedAt: 0 }, { id: 'g1', role: 'designer', state: 'active', startedAt: 5 }],
    tasks: [{ id: '1', subject: 'Labels', status: 'completed', role: 'designer' }, { id: '2', subject: 'Closet name', status: 'in_progress', role: 'designer' }, { id: '3', subject: 'Ship copy', status: 'pending', role: 'growth' }],
    tools: [{ tool: 'Edit', role: 'designer', at: 9 }, { tool: 'Read', role: 'lead', at: 8 }],
  }))
  assert.deepEqual(t.map(r => r.role), ['researcher', 'engineer', 'qa', 'designer', 'growth', 'jev'])
  const d = t.find(r => r.role === 'designer')!
  assert.equal(d.state, 'active'); assert.equal(d.running, 1); assert.equal(d.task, 'Closet name'); assert.equal(d.tools.length, 1)
  assert.equal(t.find(r => r.role === 'growth')!.state, 'waiting')
  assert.equal(t.find(r => r.role === 'growth')!.task, 'Ship copy')
})

test('teamOf: a finished role names its last done task', () => {
  const r = teamOf(prog({ roles: [{ id: 'q1', role: 'qa', state: 'done', startedAt: 1 }], tasks: [{ id: '1', subject: 'Run tests', status: 'completed', role: 'qa' }] })).find(x => x.role === 'qa')!
  assert.equal(r.state, 'done'); assert.equal(r.task, 'Run tests')
})

test('loopsOf: an engineer run again after qa started is one loop back', () => {
  const run = (id: string, role: string, startedAt: number) => ({ id, role, state: 'done' as const, startedAt })
  assert.equal(loopsOf(prog({ roles: [run('e1', 'engineer', 1), run('q1', 'qa', 2), run('e2', 'engineer', 3)] })), 1)
  assert.equal(loopsOf(prog({ roles: [run('r1', 'researcher', 1), run('e1', 'engineer', 2), run('q1', 'qa', 3)] })), 0)
  // First time in is not a loop, even after a later role.
  assert.equal(loopsOf(prog({ roles: [run('q1', 'qa', 1), run('e1', 'engineer', 2)] })), 0)
  assert.equal(loopsOf(undefined), 0)
})

test('timeline: a working chat runs to now; an active run ends now', () => {
  const tl = timeline(prog({ startedAt: 0, at: 9 * M, roles: [{ id: 'e1', role: 'engineer', state: 'active', startedAt: 4 * M }] }), 10 * M)
  assert.equal(tl.t0, 0); assert.equal(tl.t1, 10 * M)
  const e = tl.rows.find(r => r.role === 'engineer')!.runs[0]
  assert.deepEqual([e.from, e.to, e.state], [4 * M, 10 * M, 'active'])
  assert.deepEqual(tl.lead, [{ from: 0, to: 10 * M, kind: 'working' }])
})

test('timeline: a done run ends at its last tool call, else its last done task, else the next start', () => {
  const tl = timeline(prog({
    state: 'done', startedAt: 0, at: 30 * M, finishedAt: 30 * M,
    roles: [
      { id: 'r1', role: 'researcher', state: 'done', startedAt: 1 * M },
      { id: 'e1', role: 'engineer', state: 'done', startedAt: 10 * M },
      { id: 'q1', role: 'qa', state: 'done', startedAt: 20 * M },
    ],
    tasks: [{ id: '1', subject: 'Build', status: 'completed', role: 'engineer', startedAt: 10 * M, doneAt: 18 * M }],
    tools: [{ tool: 'Bash', role: 'qa', at: 26 * M }],
  }), 99 * M)
  const end = (role: string) => tl.rows.find(r => r.role === role)!.runs[0].to
  assert.equal(tl.t1, 30 * M)
  assert.equal(end('qa'), 26 * M)
  assert.equal(end('engineer'), 18 * M)
  assert.equal(end('researcher'), 10 * M)
  assert.deepEqual(tl.done, 30 * M)
})

test('timeline: overlapping runs of one role take their own track; a bogus start clamps to the chat start', () => {
  const tl = timeline(prog({ startedAt: 5 * M, at: 20 * M, roles: [
    { id: 'r1', role: 'researcher', state: 'active', startedAt: 6 * M },
    { id: 'r2', role: 'researcher', state: 'active', startedAt: 7 * M },
    { id: 'j', role: 'jev', state: 'done', startedAt: 0 },
  ] }), 20 * M)
  const r = tl.rows.find(x => x.role === 'researcher')!
  assert.deepEqual(r.runs.map(x => x.track), [0, 1]); assert.equal(r.tracks, 2)
  assert.equal(tl.rows.find(x => x.role === 'jev')!.runs[0].from, 5 * M)
})

test('timeline: a chat waiting on you shows the wait from its last event', () => {
  const tl = timeline(prog({ state: 'needs-you', startedAt: 0, at: 8 * M, question: 'Which?' }), 10 * M)
  assert.deepEqual(tl.lead, [{ from: 0, to: 8 * M, kind: 'working' }, { from: 8 * M, to: 10 * M, kind: 'needs' }])
  assert.equal(tl.asked, 8 * M)
})

test('axisTicks: at most 5 round marks from 0, none crowding the end where now sits', () => {
  assert.deepEqual(axisTicks(0, 30 * M).map(t => t.label), ['0', '10m', '20m'])
  assert.deepEqual(axisTicks(0, 3 * M).map(t => t.label), ['0', '1m', '2m'])
  assert.deepEqual(axisTicks(0, 42 * M).map(t => t.label), ['0', '10m', '20m', '30m'])
  assert.equal(axisTicks(0, 5 * 60 * M).at(-1)!.label, '4h')
  for (const span of [1, 7, 13, 30, 61, 95, 240, 600]) {
    const t = axisTicks(0, span * M)
    assert.ok(t.length >= 2 && t.length <= 5, `${span}m: ${t.length}`)
    assert.ok(t.at(-1)!.at <= span * M * 0.88, `${span}m crowds the end`)
  }
})

test('trackWidth: a fixed minute scale, never narrower than the stage', () => {
  assert.equal(trackWidth(0, 3 * 60 * M, 900), 180 * PX_PER_MIN)
  assert.equal(trackWidth(0, 3 * M, 900), 900)
})

test('axisTicks: a long chat on the scrolling scale gets a mark every few minutes, spaced by pixels', () => {
  const px = trackWidth(0, 3 * 60 * M, 300), t = axisTicks(0, 3 * 60 * M, px, 120)
  assert.equal(t[1].at - t[0].at, 5 * M)
  assert.equal(t.length, 36)
  assert.equal(t.at(-1)!.label, '2h 55m')
})

test('laneBars: overlapping runs merge into one bar with a count; apart they stay apart', () => {
  const run = (id: string, from: number, to: number, state: 'active' | 'done' = 'done') => ({ id, from, to, state, track: 0 })
  const b = laneBars([run('a', 0, 10 * M), run('b', 5 * M, 12 * M, 'active'), run('c', 20 * M, 25 * M)], 0, 30 * M)
  assert.deepEqual(b.map(x => [x.from, x.to, x.count, x.state]), [[0, 12 * M, 2, 'active'], [20 * M, 25 * M, 1, 'done']])
})

test('laneBars: runs nearly touching (closer than half the minimum width) read as one bar', () => {
  const run = (id: string, from: number, to: number) => ({ id, from, to, state: 'done' as const, track: 0 })
  assert.deepEqual(laneBars([run('a', 0, 10 * M), run('b', 10.2 * M, 12 * M)], 0, 30 * M).map(x => [x.from, x.to, x.count]), [[0, 12 * M, 2]])
})

test('laneBars: a tiny run gets a minimum width, kept inside the chart', () => {
  const b = laneBars([{ id: 'a', from: 29.9 * M, to: 30 * M, state: 'active', track: 0 }], 0, 30 * M)
  assert.ok(b[0].to - b[0].from >= 0.03 * 30 * M - 1)
  assert.ok(b[0].to <= 30 * M && b[0].from >= 0)
})

test('loopBacks: when and where a plan role ran again after a later one started', () => {
  const run = (id: string, role: string, startedAt: number) => ({ id, role, state: 'done' as const, startedAt })
  assert.deepEqual(loopBacks(prog({ roles: [run('e1', 'engineer', 1), run('q1', 'qa', 2), run('e2', 'engineer', 3)] })), [{ role: 'engineer', at: 3 }])
  assert.deepEqual(loopBacks(undefined), [])
})

type Box = { l: number; r: number; t: number; b: number }
const hit = (a: Box, b: Box) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b
const states = ['active', 'done', 'waiting', 'unused'] as const

test('rings: active roles sit inside, the rest outside, and no node or label overlaps another', () => {
  for (const w of [350, 700, 1100]) for (let n = 3; n <= 7; n++) for (const mix of [0, 1, 2, 3]) {
    const h = ringHeight(w, n)
    const team = Array.from({ length: n }, (_, i) => ({ role: `r${i}`, state: mix === 0 ? 'active' : mix === 1 ? 'done' : states[(i + mix) % 4] }))
    const L = rings(team, w, h)
    const boxes: Box[] = [
      { l: L.cx - L.leadW / 2, r: L.cx + L.leadW / 2, t: L.cy - L.lr, b: L.cy + L.lr + 22 },
      { l: L.you.x - 16, r: L.you.x + 16, t: L.you.y - 16, b: L.you.y + 34 },
      ...team.map(m => { const p = L.at[m.role]; return { l: p.x - L.label / 2, r: p.x + L.label / 2, t: p.y - L.nr, b: p.y + L.nr + 32 } }),
    ]
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!hit(boxes[i], boxes[j]), `${w}x${h} n=${n} mix=${mix}: ${i} hits ${j}`)
    for (const b of boxes) assert.ok(b.l >= 0 && b.r <= w && b.t >= 0 && b.b <= h, `${w}x${h} n=${n} mix=${mix}: off stage`)
    const d = (r: string) => Math.hypot((L.at[r].x - L.cx) / L.rx, (L.at[r].y - L.cy) / L.ry)
    for (const m of team) assert.ok(m.state === 'active' ? d(m.role) < 0.9 : d(m.role) > 0.99)
  }
})

test('rings: a role keeps its bearing when it moves between rings', () => {
  const a = rings([{ role: 'a', state: 'active' }, { role: 'b', state: 'done' }, { role: 'c', state: 'done' }], 700, 420)
  const b = rings([{ role: 'a', state: 'done' }, { role: 'b', state: 'done' }, { role: 'c', state: 'done' }], 700, 420)
  assert.equal(a.angle.a, b.angle.a)
})
