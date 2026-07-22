// Regression net for two user-reported bugs in the workgroup task execution
// page's RIGHT-HAND rail (the 220–280px `.workgroup-room__side` track):
//
//   1. 执行记录 — "轮次标签因为宽度不够会被换行导致很丑". The row was one nowrap
//      flex line holding four fields (member / turn kind / status / duration),
//      which never fit the rail. The overflow landed in the worst places:
//      `.chip` has no white-space rule, so its CJK label ("领导轮") broke
//      BETWEEN GLYPHS into a vertical stack, while `.status-chip` (white-space:
//      nowrap ⇒ unshrinkable min-content floor) spilled past the card's edge
//      and pushed the duration out of view entirely.
//      Fix: two grid rows — identity (name + duration) then state (both chips).
//
//   2. 工作组信息 — "工作组目标如果太长了会直接截断了看不到后面的信息". The goal
//      was a bare `max-height: 6.5em; overflow: hidden`, and although the CSS
//      comment claimed "full text via title" the JSX never set a title, so the
//      tail of a long goal was unreachable by any means. Fix: <ClampedText>
//      (fold + 展开/收起), whose own contract lives in clamped-text.test.tsx.
//
// jsdom performs no layout, so the geometry half is asserted at the source
// level against styles.css (same approach as
// workgroup-room-composer-outline-clip.test.ts); the DOM half is asserted
// against the rendered room.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { NodeRun } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { WorkgroupRoom } from '../src/components/workgroup/WorkgroupRoom'
import type { WorkgroupRoomResponse } from '../src/lib/workgroup-room'
import '../src/i18n'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')

function ruleBody(selector: string): string {
  const idx = css.indexOf(selector)
  expect(idx, `selector ${selector} not found`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', idx)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

function makeRun(over: Partial<NodeRun>): NodeRun {
  return {
    id: 'nr1',
    taskId: 't1',
    nodeId: '__wg_member__',
    parentNodeRunId: null,
    iteration: 0,
    shardKey: null,
    retryIndex: 0,
    wgRound: null,
    rerunCause: null,
    reviewIteration: 0,
    status: 'done',
    startedAt: 1000,
    finishedAt: 2000,
    pid: null,
    exitCode: 0,
    errorMessage: null,
    supersededByReview: null,
    rolledBack: null,
    promptText: null,
    tokInput: null,
    tokOutput: null,
    tokTotal: null,
    tokCacheCreate: null,
    tokCacheRead: null,
    opencodeSessionId: null,
    ...over,
  } satisfies NodeRun
}

function makeRoom(over: Partial<WorkgroupRoomResponse> = {}): WorkgroupRoomResponse {
  return {
    // RFC-209 —— 已用回合数（fc 右栏预算表的数据源；与 max_rounds 触顶判据同源）。
    budgetUsed: 0,
    taskId: 't1',
    taskStatus: 'running',
    config: {
      workgroupId: 'wg1',
      workgroupName: 'review-squad',
      mode: 'leader_worker',
      leaderMemberId: 'mem_lead',
      switches: { shareOutputs: true, directMessages: true, blackboard: false },
      maxRounds: 20,
      completionGate: false,
      instructions: '',
      goal: 'ship the audit',
      members: [
        {
          id: 'mem_lead',
          memberType: 'agent',
          agentName: 'coordinator',
          userId: null,
          displayName: 'Lead',
          roleDesc: '',
        },
      ],
    },
    gate: { declaredDone: false, awaitingConfirmation: false, rejected: false, summary: null },
    dw: null,
    messages: [],
    assignments: [],
    memberRuns: {},
    runHistory: [],
    ...over,
  }
}

function entry(over: Partial<WorkgroupRoomResponse['runHistory'][number]> = {}) {
  return {
    nodeRunId: 'nr1',
    memberId: 'mem_lead',
    displayName: 'Lead',
    kind: 'leader-round' as const,
    status: 'done',
    round: 1,
    startedAt: 1_000,
    finishedAt: 61_000,
    triggerMessageId: null,
    assignmentId: null,
    note: null,
    ...over,
  }
}

function installFetch(room: WorkgroupRoomResponse) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/room')) return json(room)
      if (url.includes('/node-runs')) return json({ runs: [makeRun({ id: 'nr1' })], outputs: [] })
      if (url.includes('/api/users/lookup')) return json([])
      void init
      return json({})
    },
  )
}

// The room fixture reaches the component through the mocked fetch, so this
// takes no argument — call installFetch() with the shape under test first.
function renderRoom() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <WorkgroupRoom taskId="t1" taskStatus="running" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('执行记录 rail — the turn-kind chip must never wrap or clip', () => {
  test('a row is two grid lines: [name | duration] then a meta line carrying BOTH chips', async () => {
    installFetch(makeRoom({ runHistory: [entry()] }))
    renderRoom()

    const row = await screen.findByTestId('wg-runlog-nr1')
    const kids = Array.from(row.children)
    expect(kids).toHaveLength(3)
    expect(kids[0]?.className).toContain('workgroup-room__member-name')
    expect(kids[1]?.className).toContain('workgroup-room__time')
    expect(kids[2]?.className).toContain('workgroup-room__runlog-meta')

    // Both chips live together on the meta line — that grouping is what lets a
    // future third chip join without another layout rethink, and what keeps
    // the status chip from being the thing that overflows the card.
    // Asserted structurally, not by label text: the bundle language under test
    // is not pinned, and the bug was about geometry, not copy.
    const meta = kids[2] as HTMLElement
    const kindChip = meta.querySelector('.chip')
    expect(kindChip?.textContent).toBeTruthy()
    expect(meta.querySelector('.status-chip')).toBeTruthy()
  })

  test('the member name is the only truncating cell, so it carries the full value in title', async () => {
    const long = entry({ displayName: 'security-scanner-agent' })
    installFetch(makeRoom({ runHistory: [long] }))
    renderRoom()

    const row = await screen.findByTestId('wg-runlog-nr1')
    const name = row.querySelector('.workgroup-room__member-name') as HTMLElement
    expect(name.textContent).toBe('@security-scanner-agent')
    // Ellipsis is a CSS effect; the tooltip is the only way the full name
    // stays recoverable at the 220px rail width.
    expect(name.getAttribute('title')).toBe('@security-scanner-agent')
  })

  test('styles.css: the row is a 2-line grid, not the single flex line that overflowed', () => {
    const body = ruleBody('.workgroup-room__runlog-row {')
    expect(body).toMatch(/display:\s*grid/)
    expect(body).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) auto/)
    // Inheriting the 16px document default (button carries `font: inherit`)
    // both mismatched the 13px roster above it and drove most of the overflow.
    expect(body).toMatch(/font-size:\s*13px/)
  })

  test('styles.css: chips keep their intrinsic width and never break between glyphs', () => {
    const body = ruleBody('.workgroup-room__runlog-meta > .chip,')
    expect(body).toMatch(/white-space:\s*nowrap/)
    expect(body).toMatch(/flex:\s*0 0 auto/)
    // The meta line spans both grid columns — otherwise the chips would be
    // squeezed into the 1fr identity column again.
    expect(ruleBody('.workgroup-room__runlog-meta {')).toMatch(/grid-column:\s*1 \/ -1/)
  })

  // Codex review gate finding: two unshrinkable chips still overflow a 220px
  // rail once the labels get long. English is the worst case — "Assignment
  // turn" + "Awaiting answer" — and without a wrap allowance the fixed-width
  // children spill past the card exactly like the status chip used to.
  test('styles.css: the meta line may wrap BETWEEN chips (so long labels never spill)', () => {
    expect(ruleBody('.workgroup-room__runlog-meta {')).toMatch(/flex-wrap:\s*wrap/)
    // …while each chip itself stays an atom. Both halves are the fix.
    expect(ruleBody('.workgroup-room__runlog-meta > .chip,')).toMatch(/white-space:\s*nowrap/)
  })

  test('styles.css: the name degrades to an ellipsis rather than wrapping the row open', () => {
    const body = ruleBody('.workgroup-room__runlog-row > .workgroup-room__member-name {')
    expect(body).toMatch(/text-overflow:\s*ellipsis/)
    expect(body).toMatch(/white-space:\s*nowrap/)
    expect(body).toMatch(/min-width:\s*0/)
  })
})

describe('工作组信息 — a long goal must stay readable', () => {
  test('a long goal folds and 展开 reveals the tail that used to be unreachable', async () => {
    const tail = 'THE-PART-THAT-WAS-CUT-OFF'
    const goal = `${'把所有凭据处理路径审计一遍，确认没有明文残留。'.repeat(8)}${tail}`
    installFetch(makeRoom({ config: { ...makeRoom().config, goal } }))
    renderRoom()

    const body = await screen.findByTestId('workgroup-room-goal')
    expect(body.className).toContain('clamped-text__body--clamped')
    // The old bug was NOT that the text was missing from the DOM — it was that
    // there was no way to see past the clip. Assert both halves.
    expect(body.textContent).toContain(tail)

    const toggle = screen.getByTestId('workgroup-room-goal-toggle')
    fireEvent.click(toggle)
    expect(body.className).not.toContain('clamped-text__body--clamped')
    fireEvent.click(toggle)
    expect(body.className).toContain('clamped-text__body--clamped')
  })

  test('a short goal renders with no fold and no toggle', async () => {
    installFetch(makeRoom())
    renderRoom()

    const body = await screen.findByTestId('workgroup-room-goal')
    expect(body.textContent).toBe('ship the audit')
    expect(body.className).not.toContain('clamped-text__body--clamped')
    expect(screen.queryByTestId('workgroup-room-goal-toggle')).toBeNull()
  })

  test('styles.css: the goal no longer carries a bare unreachable clip', () => {
    const body = ruleBody('.workgroup-room__goal {')
    // The exact shape of the original bug: a hard height cap with hidden
    // overflow and no toggle. Clamping now belongs to .clamped-text__body.
    expect(body).not.toMatch(/max-height/)
    expect(body).not.toMatch(/overflow:\s*hidden/)
  })

  test('styles.css: the fold height is derived from a pinned line-height, not a guess', () => {
    // `normal` (~1.2) vs the assumed 1.5 leaves a sliver of the next line
    // peeking out from under the fold, which reads as a rendering glitch.
    expect(ruleBody('.clamped-text__body {')).toMatch(
      /--clamped-text-line-height:\s*1\.5[\s\S]*line-height:\s*var\(--clamped-text-line-height\)/,
    )
    expect(ruleBody('.clamped-text__body--clamped {')).toMatch(
      /max-height:\s*calc\(var\(--clamped-text-lines, 4\) \* var\(--clamped-text-line-height\) \* 1em\)/,
    )
  })
})
