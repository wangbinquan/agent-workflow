// Locks the AttemptPicker dropdown in SessionTab. Originally the picker
// was a `radiogroup` chip-row (RFC-027 §UX) that itself replaced a bare
// native `<select>` the user had flagged as "丑". With many retries /
// fan-out shards / clarify rounds the chips wrapped awkwardly inside the
// node drawer, so the picker now uses the project's styled Select
// (RFC-036) — combobox + portaled listbox — which sidesteps the original
// native-dropdown complaint while collapsing back to a single control.
//
// What this suite locks:
//   - renders a `combobox` (not a `radiogroup`)
//   - opening the listbox exposes one `option` per attempt group
//   - the picked option is the only aria-selected=true row
//   - iter label uses the right key for retry / loop / clarify / initial
//   - clicking a different option flips the picked state
//   - shard / inline-rounds metadata is still visible per row
//
// If this goes red back to a chip-row or a bare `<select>`, that's the
// regression direction to investigate before re-greening.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { NodeRun, SessionViewResponse } from '@agent-workflow/shared'
import i18n from '../src/i18n'
import { NodeDetailDrawer } from '../src/components/NodeDetailDrawer'

function openCombobox() {
  const trigger = screen.getByRole('combobox', { name: /attempt/i })
  fireEvent.click(trigger)
  return screen.getByRole('listbox')
}

function run(partial: Partial<NodeRun> & { id: string }): NodeRun {
  return {
    id: partial.id,
    taskId: 't1',
    nodeId: partial.nodeId ?? 'agent_1',
    parentNodeRunId: partial.parentNodeRunId ?? null,
    iteration: partial.iteration ?? 0,
    shardKey: partial.shardKey ?? null,
    retryIndex: partial.retryIndex ?? 0,
    reviewIteration: partial.reviewIteration ?? 0,
    status: partial.status ?? 'done',
    startedAt: partial.startedAt ?? 1700_000_000_000,
    finishedAt: partial.finishedAt ?? 1700_000_001_000,
    pid: partial.pid ?? null,
    exitCode: partial.exitCode ?? null,
    errorMessage: partial.errorMessage ?? null,
    supersededByReview: partial.supersededByReview ?? null,
    rolledBack: partial.rolledBack ?? null,
    promptText: partial.promptText ?? null,
    tokInput: partial.tokInput ?? null,
    tokOutput: partial.tokOutput ?? null,
    tokTotal: partial.tokTotal ?? null,
    tokCacheCreate: partial.tokCacheCreate ?? null,
    tokCacheRead: partial.tokCacheRead ?? null,
    opencodeSessionId: partial.opencodeSessionId ?? null,
  }
}

function renderDrawer(props: {
  nodeRunId: string
  nodeId: string | null
  workflowNodeKind: string | null
  runs: NodeRun[]
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <NodeDetailDrawer
          taskId="t1"
          taskStatus="done"
          nodeRunId={props.nodeRunId}
          nodeId={props.nodeId}
          workflowNodeKind={props.workflowNodeKind}
          agentName={null}
          runs={props.runs}
          outputs={[]}
          onClose={vi.fn()}
        />
      </I18nextProvider>
    </QueryClientProvider>,
  )
}

const SAMPLE_SESSION: SessionViewResponse = {
  tree: {
    sessionId: 's',
    parentSessionId: null,
    agentName: null,
    captureComplete: true,
    messages: [],
  },
}

const originalFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify(SAMPLE_SESSION), { status: 200 }),
  ) as unknown as typeof globalThis.fetch
})
afterEach(() => {
  // Unmount React via testing-library first so portaled children (the
  // Select listbox lives on document.body) get cleaned up by React.
  // Wiping document.body.innerHTML before cleanup() races React's
  // removeChild and crashes happy-dom.
  cleanup()
  globalThis.fetch = originalFetch
})

describe('Session attempts dropdown picker', () => {
  test('renders a combobox (not a radiogroup) and the picked label is on the trigger', () => {
    // RFC-074 PR-C: a process retry follows a FAILED attempt (the only state
    // that spawns one), so r0/r1 are failed and r2 is the live retry — round
    // stays 0 and the label reads retry#N, not a spurious clarify#N.
    const r0 = run({ id: 'r0', retryIndex: 0, startedAt: 100, status: 'failed' })
    const r1 = run({ id: 'r1', retryIndex: 1, startedAt: 200, status: 'failed' })
    const r2 = run({ id: 'r2', retryIndex: 2, startedAt: 300 })
    renderDrawer({
      nodeRunId: r2.id,
      nodeId: r0.nodeId,
      workflowNodeKind: 'agent-single',
      runs: [r0, r1, r2],
    })
    expect(screen.queryByRole('radiogroup')).toBeNull()
    const trigger = screen.getByRole('combobox', { name: /attempt/i })
    expect(trigger).toBeTruthy()
    // Trigger shows the picked attempt's iter label (retryIndex=2).
    expect(trigger.textContent ?? '').toMatch(/retry#2/i)
  })

  test('opening the listbox exposes one option per attempt + only the picked is aria-selected', () => {
    const r0 = run({ id: 'r0', retryIndex: 0, startedAt: 100 })
    const r1 = run({ id: 'r1', retryIndex: 1, startedAt: 200 })
    const r2 = run({ id: 'r2', retryIndex: 2, startedAt: 300 })
    renderDrawer({
      nodeRunId: r2.id,
      nodeId: r0.nodeId,
      workflowNodeKind: 'agent-single',
      runs: [r0, r1, r2],
    })
    openCombobox()
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    const selected = options.filter((o) => o.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    // attempts are sorted ascending by (iteration, retryIndex, startedAt)
    // — the picked one (selectedRunId='r2') is the last option.
    expect(selected[0]).toBe(options[2]!)
  })

  test('clicking a different option flips the picked state without errors', () => {
    const r0 = run({ id: 'r0', retryIndex: 0, startedAt: 100 })
    const r1 = run({ id: 'r1', retryIndex: 1, startedAt: 200 })
    renderDrawer({
      nodeRunId: r1.id,
      nodeId: r0.nodeId,
      workflowNodeKind: 'agent-single',
      runs: [r0, r1],
    })
    openCombobox()
    const before = screen.getAllByRole('option')
    expect(before[1]!.getAttribute('aria-selected')).toBe('true')
    fireEvent.mouseDown(before[0]!)
    // Re-open: the listbox is portaled and Select closes on mouseDown.
    openCombobox()
    const after = screen.getAllByRole('option')
    expect(after[0]!.getAttribute('aria-selected')).toBe('true')
    expect(after[1]!.getAttribute('aria-selected')).toBe('false')
  })

  test('iter label distinguishes initial / retry / loop / clarify rows (id-order derivation, RFC-074 PR-C)', () => {
    // RFC-074 PR-C: the clarify round is DERIVED from prior-`done` id-order
    // (clarifyRoundForRun), retry-agnostic. `initial` (01a) FAILED and `retry`
    // (01b) is its successful process retry — so 01b stays round 0 (label
    // retry#1), while the later clarify reruns 01d/01e (each following a `done`
    // row) read clarify#1 / clarify#2.
    const initial = run({ id: '01a', retryIndex: 0, iteration: 0, status: 'failed' })
    const retry = run({ id: '01b', retryIndex: 1, iteration: 0, startedAt: 200 })
    const loop = run({ id: '01c', retryIndex: 0, iteration: 2, startedAt: 300 })
    const clarify = run({ id: '01d', retryIndex: 0, iteration: 0, startedAt: 400 })
    const clarify2 = run({ id: '01e', retryIndex: 0, iteration: 0, startedAt: 500 })
    renderDrawer({
      nodeRunId: clarify.id,
      nodeId: initial.nodeId,
      workflowNodeKind: 'agent-single',
      runs: [initial, retry, loop, clarify, clarify2],
    })
    openCombobox()
    const html = document.body.innerHTML
    expect(html).toMatch(/initial/i)
    expect(html).toMatch(/retry#1/i)
    expect(html).toMatch(/loop#2/i)
    expect(html).toMatch(/clarify#1/i)
    expect(html).toMatch(/clarify#2/i)
  })

  test('shard rows show the shardKey alongside the iter label', () => {
    const parent = run({ id: 'p', promptText: null })
    const shardA = run({ id: 'sa', parentNodeRunId: 'p', shardKey: 'src/a.ts', startedAt: 200 })
    const shardB = run({ id: 'sb', parentNodeRunId: 'p', shardKey: 'src/b.ts', startedAt: 300 })
    renderDrawer({
      nodeRunId: shardA.id,
      nodeId: parent.nodeId,
      workflowNodeKind: 'agent-single',
      runs: [parent, shardA, shardB],
    })
    openCombobox()
    const html = document.body.innerHTML
    expect(html).toContain('src/a.ts')
    expect(html).toContain('src/b.ts')
  })

  test('no native <select> element is rendered (the original "丑" dropdown stays gone)', () => {
    const r = run({ id: 'r1' })
    const { container } = renderDrawer({
      nodeRunId: r.id,
      nodeId: r.nodeId,
      workflowNodeKind: 'agent-single',
      runs: [r],
    })
    expect(container.querySelector('select')).toBeNull()
    // The styled trigger is a <button role="combobox">, never a <select>.
    const trigger = screen.getByRole('combobox', { name: /attempt/i })
    expect(trigger.tagName.toLowerCase()).toBe('button')
  })

  // RFC-026 inline clarify reruns share an opencode session across many
  // node_runs. The picker MUST fold those rounds into one option so the
  // user sees "one logical conversation" rather than N separate attempts.
  test('inline-session siblings collapse into a single option labelled "inline · N rounds"', () => {
    const r0 = run({
      id: 'r0',
      opencodeSessionId: 'opc_inline_A',
      startedAt: 100,
    })
    const r1 = run({
      id: 'r1',
      opencodeSessionId: 'opc_inline_A',
      startedAt: 200,
    })
    const r2 = run({
      id: 'r2',
      opencodeSessionId: 'opc_inline_A',
      startedAt: 300,
    })
    renderDrawer({
      nodeRunId: r2.id,
      nodeId: r0.nodeId,
      workflowNodeKind: 'agent-single',
      runs: [r0, r1, r2],
    })
    // Trigger shows the merged label without opening the listbox.
    const trigger = screen.getByRole('combobox', { name: /attempt/i })
    expect(trigger.textContent ?? '').toMatch(/3 rounds/i)
    openCombobox()
    const options = screen.getAllByRole('option')
    // Three node_runs but one option — inline-session merge.
    expect(options).toHaveLength(1)
    expect(options[0]!.getAttribute('aria-selected')).toBe('true')
    expect(options[0]!.textContent ?? '').toMatch(/3 rounds/i)
  })

  test('isolated attempts (no opencodeSessionId) still render as separate options', () => {
    const r0 = run({ id: '01r0', opencodeSessionId: null })
    const r1 = run({ id: '02r1', opencodeSessionId: null, startedAt: 200 })
    renderDrawer({
      nodeRunId: r1.id,
      nodeId: r0.nodeId,
      workflowNodeKind: 'agent-single',
      runs: [r0, r1],
    })
    openCombobox()
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  // Locks the post-grouping chronological sort in SessionTab. Default
  // attempt order (sortNodeRunsForPromptHistory) breaks ties between
  // fan-out shards by shardKey alphabetical, which surprised users when
  // a later-started shard sat above an earlier-started one. Groups now
  // sort by earliest startedAt ascending.
  test('dropdown groups are ordered by earliest startedAt, not shardKey alphabetical', () => {
    const parent = run({ id: 'p', promptText: null, startedAt: 50 })
    // Alphabetically 'a' < 'z', but time-wise z (100) started before a (300).
    const shardZ = run({ id: 'sz', parentNodeRunId: 'p', shardKey: 'src/z.ts', startedAt: 100 })
    const shardA = run({ id: 'sa', parentNodeRunId: 'p', shardKey: 'src/a.ts', startedAt: 300 })
    renderDrawer({
      nodeRunId: shardZ.id,
      nodeId: parent.nodeId,
      workflowNodeKind: 'agent-single',
      runs: [parent, shardA, shardZ],
    })
    openCombobox()
    const options = screen.getAllByRole('option')
    // 3 options (parent + two shards). Parent at 50 first, then z at 100, then a at 300.
    expect(options).toHaveLength(3)
    expect(options[0]!.textContent ?? '').not.toContain('src/')
    expect(options[1]!.textContent ?? '').toContain('src/z.ts')
    expect(options[2]!.textContent ?? '').toContain('src/a.ts')
  })

  test('groups with no startedAt sink to the bottom', () => {
    // RFC-074 PR-C: r0/r1 are failed attempts in a retry chain (so the live
    // retry rows keep round 0 → retry#N labels, not spurious clarify#N).
    const r0 = run({ id: 'r0', retryIndex: 0, startedAt: 100, status: 'failed' })
    const r1 = run({ id: 'r1', retryIndex: 1, startedAt: 200, status: 'failed' })
    // Not-yet-started attempt — should land last regardless of retryIndex.
    const pending = run({
      id: 'rp',
      retryIndex: 2,
      startedAt: null as unknown as number,
      status: 'pending',
    })
    renderDrawer({
      nodeRunId: r0.id,
      nodeId: r0.nodeId,
      workflowNodeKind: 'agent-single',
      runs: [r0, r1, pending],
    })
    openCombobox()
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(options[0]!.textContent ?? '').toMatch(/initial/i)
    expect(options[1]!.textContent ?? '').toMatch(/retry#1/i)
    expect(options[2]!.textContent ?? '').toMatch(/retry#2/i)
  })

  test('mixed: an inline group + a follow-on isolated retry render as 2 options', () => {
    const r0 = run({
      id: 'r0',
      opencodeSessionId: 'opc_inline_B',
      startedAt: 100,
    })
    const r1 = run({
      id: 'r1',
      opencodeSessionId: 'opc_inline_B',
      startedAt: 200,
    })
    // A subsequent retry that started a fresh opencode session.
    const r2 = run({
      id: 'r2',
      retryIndex: 1,
      opencodeSessionId: null,
      startedAt: 300,
    })
    renderDrawer({
      nodeRunId: r2.id,
      nodeId: r0.nodeId,
      workflowNodeKind: 'agent-single',
      runs: [r0, r1, r2],
    })
    openCombobox()
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0]!.textContent ?? '').toMatch(/rounds/i)
    expect(options[1]!.textContent ?? '').not.toMatch(/rounds/i)
  })
})
