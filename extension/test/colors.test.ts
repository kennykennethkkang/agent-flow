import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { PALETTE, assignColors, titleBar, windowColors } from '../src/hub/colors'

describe('window colors', () => {
  it('keeps a saved color and gives a new folder the first one no live window uses', () => {
    const saved = { '/a': 'violet', '/b': 'amber' } as const
    const { colors, changed } = assignColors({ ...saved }, ['/b', '/c', '/a'])
    assert.equal(colors['/a'], 'violet')
    assert.equal(colors['/b'], 'amber')
    assert.equal(colors['/c'], 'teal')
    assert.equal(changed, true)
    assert.equal(assignColors(colors, ['/a', '/c']).changed, false)
  })

  it('only counts live windows: a closed folder frees its color for a new one', () => {
    const { colors } = assignColors({ '/gone': 'violet' }, ['/new'])
    assert.equal(colors['/new'], 'violet')
    assert.equal(colors['/gone'], 'violet')
  })

  it('wraps around when every color is taken', () => {
    const live = PALETTE.map((_, i) => `/w${i}`)
    const { colors } = assignColors({}, [...live, '/extra'])
    assert.equal(new Set(live.map(w => colors[w])).size, PALETTE.length)
    assert.ok(PALETTE.includes(colors['/extra']))
  })

  it('persists to the colors file and reads it back', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'colors-')), 'colors.json')
    assert.deepEqual(windowColors(['/x', '/y'], file), { '/x': 'violet', '/y': 'amber' })
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { '/x': 'violet', '/y': 'amber' })
    assert.deepEqual(windowColors(['/y', '/z'], file), { '/x': 'violet', '/y': 'amber', '/z': 'violet' })
    fs.writeFileSync(file, 'not json')
    assert.equal(windowColors(['/q'], file)['/q'], 'violet')
  })
})

describe('title bar colors', () => {
  const want = { 'titleBar.activeBackground': '#111111', 'titleBar.activeForeground': '#eeeeee' }

  it('adds its keys beside the ones already set', () => {
    const r = titleBar({ 'editor.background': '#000000' }, {}, want)
    assert.deepEqual(r?.next, { 'editor.background': '#000000', ...want })
    assert.deepEqual(r?.wrote, want)
  })

  it('never overwrites a key set by hand, and updates its own', () => {
    const r = titleBar({ 'titleBar.activeBackground': '#ff0000', 'titleBar.activeForeground': '#aaaaaa' }, { 'titleBar.activeForeground': '#aaaaaa' }, want)
    assert.deepEqual(r?.next, { 'titleBar.activeBackground': '#ff0000', 'titleBar.activeForeground': '#eeeeee' })
    assert.deepEqual(r?.wrote, { 'titleBar.activeForeground': '#eeeeee' })
  })

  it('removes only its own keys when turned off, and does nothing when nothing changes', () => {
    const r = titleBar({ ...want, 'titleBar.activeForeground': '#123456' }, want, {})
    assert.deepEqual(r?.next, { 'titleBar.activeForeground': '#123456' })
    assert.deepEqual(r?.wrote, {})
    assert.equal(titleBar(want, want, want), undefined)
    assert.equal(titleBar(undefined, {}, {}), undefined)
  })
})
