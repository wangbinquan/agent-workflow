// Locks the workgroup chatroom speaker-role bubble skin (user ask
// 2026-07-14: "聊天室的对话太不明显，用明显的气泡渲染，且 leader / agent / 人
// 的气泡颜色要区分").
//
// The contract:
//   1. Every non-system message renders as a real bubble — padding + border +
//      radius + shrink-to-fit (align-self) + max-width — not a bare text row.
//   2. The three speaker roles are color-coded: leader = accent tint, agent
//      member = neutral tint, human = success tint AND right-aligned (classic
//      IM "my side"). The three backgrounds must stay pairwise DISTINCT.
//   3. System rows are NOT bubbles (they keep the muted full-width meta-line
//      look) — the bubble selector group must never grow a --system entry.
//   4. The PR-6 decision accent (thicker left flank) still layers on top.
//
// jsdom does no layout, so — like workgroup-room-composer-outline-clip
// .test.ts — these are source-level assertions against styles.css. The
// role→class wiring itself is asserted in workgroup-room.test.tsx.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')

function ruleBody(selector: string, from = 0): string {
  const idx = css.indexOf(selector, from)
  expect(idx, `selector ${selector} not found`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', idx)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

// The shared bubble base is the grouped rule that STARTS with the leader
// selector + comma; the standalone per-role overrides come after it.
const bubbleGroupSelector =
  '.workgroup-room__msg--leader,\n.workgroup-room__msg--agent,\n.workgroup-room__msg--human {'
const standaloneStart = css.indexOf('.workgroup-room__msg--leader {')

function background(body: string): string {
  const m = /background:\s*([^;]+);/.exec(body)?.[1]
  expect(m, `no background declaration in:\n${body}`).toBeDefined()
  return (m ?? '').trim()
}

describe('workgroup room speaker-role bubbles', () => {
  it('non-system messages get real bubble chrome (padding + border + radius + fit + cap)', () => {
    const body = ruleBody(bubbleGroupSelector)
    expect(body).toMatch(/padding:\s*8px\s+12px/)
    expect(body).toMatch(/border:\s*1px\s+solid\s+var\(--border\)/)
    expect(body).toMatch(/border-radius:\s*var\(--radius-lg\)/)
    expect(body).toMatch(/align-self:\s*flex-start/)
    expect(body).toMatch(/max-width:/)
  })

  it('system rows are not bubbles: the bubble selector group has no --system entry', () => {
    expect(bubbleGroupSelector).not.toContain('--system')
    // …and the muted system skin is still present.
    expect(css).toContain('.workgroup-room__msg--system .workgroup-room__body')
  })

  it('leader bubbles are accent-tinted', () => {
    const body = ruleBody('.workgroup-room__msg--leader {', standaloneStart)
    expect(background(body)).toContain('var(--accent)')
    expect(body).toMatch(/border-color:[^;]*var\(--accent\)/)
  })

  it('human bubbles are success-tinted and right-aligned', () => {
    const body = ruleBody('.workgroup-room__msg--human {', standaloneStart)
    expect(background(body)).toContain('var(--success)')
    expect(body).toMatch(/border-color:[^;]*var\(--success\)/)
    expect(body).toMatch(/align-self:\s*flex-end/)
  })

  it('the three role backgrounds are pairwise distinct (the whole point)', () => {
    const agent = background(ruleBody(bubbleGroupSelector)) // group base IS the agent skin
    const leader = background(ruleBody('.workgroup-room__msg--leader {', standaloneStart))
    const human = background(ruleBody('.workgroup-room__msg--human {', standaloneStart))
    expect(leader).not.toBe(agent)
    expect(human).not.toBe(agent)
    expect(human).not.toBe(leader)
  })

  it('the decision accent flank still layers on top of the role bubble', () => {
    const body = ruleBody('.workgroup-room__msg--decision {')
    expect(body).toMatch(/border-left:\s*3px\s+solid\s+var\(--accent\)/)
  })
})
