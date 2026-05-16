// RFC-011 — drawer Prompt tab attempts switcher.
//
// Locks the user-visible contract:
//   - With one attempt the picker renders one option and the pre shows that
//     attempt's promptText.
//   - With multiple attempts the picker exposes all of them; changing the
//     selected option swaps the rendered prompt.
//   - For multi-process fan-out parents, the parent option labels itself
//     "fan-out parent" and showing the parent renders the "pick a shard"
//     hint instead of an empty pre. Picking a shard renders its prompt.
//   - For non-agent kinds (input/output/wrappers/review) the tab shows the
//     N/A muted message — no picker / no pre.
//   - Re-anchoring: when the canvas-selected nodeRunId changes (parent
//     re-renders with a new selectedRunId prop), the picker re-anchors to
//     that new attempt instead of holding the user's previous pick.
//   - Retry button is independent from picker switches (selectedRunId
//     drives retry, picker drives prompt display only).

import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { NodeRun } from '@agent-workflow/shared'
import i18n from '../src/i18n'
import { NodeDetailDrawer } from '../src/components/NodeDetailDrawer'

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
    clarifyIteration: partial.clarifyIteration ?? 0,
    status: partial.status ?? 'done',
    startedAt: partial.startedAt ?? 1700_000_000_000,
    finishedAt: partial.finishedAt ?? 1700_000_001_000,
    pid: partial.pid ?? null,
    exitCode: partial.exitCode ?? null,
    errorMessage: partial.errorMessage ?? null,
    promptText: partial.promptText ?? null,
    tokInput: partial.tokInput ?? null,
    tokOutput: partial.tokOutput ?? null,
    tokTotal: partial.tokTotal ?? null,
    tokCacheCreate: partial.tokCacheCreate ?? null,
    tokCacheRead: partial.tokCacheRead ?? null,
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

afterEach(() => {
  document.body.innerHTML = ''
})

describe('RFC-011 NodeDetailDrawer Prompt tab', () => {
  test('single attempt: picker has one option and pre renders promptText', () => {
    const r = run({ id: 'r1', promptText: 'first prompt' })
    renderDrawer({
      nodeRunId: r.id,
      nodeId: r.nodeId,
      workflowNodeKind: 'agent-single',
      runs: [r],
    })
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.options.length).toBe(1)
    expect(screen.getByText('first prompt')).toBeTruthy()
  })

  test('multiple attempts: switching select swaps the displayed prompt', () => {
    const r0 = run({ id: 'r0', retryIndex: 0, promptText: 'PROMPT_V1', startedAt: 100 })
    const r1 = run({ id: 'r1', retryIndex: 1, promptText: 'PROMPT_V2', startedAt: 200 })
    renderDrawer({
      nodeRunId: r1.id,
      nodeId: r0.nodeId,
      workflowNodeKind: 'agent-single',
      runs: [r0, r1],
    })
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.options.length).toBe(2)
    // Defaults to selectedRunId = r1.id.
    expect(select.value).toBe('r1')
    expect(screen.getByText('PROMPT_V2')).toBeTruthy()

    fireEvent.change(select, { target: { value: 'r0' } })
    expect(screen.getByText('PROMPT_V1')).toBeTruthy()
    expect(screen.queryByText('PROMPT_V2')).toBeNull()
  })

  test('fan-out parent: picker labels parent + pick-a-shard hint; switching to a shard reveals its prompt', () => {
    const parent = run({ id: 'p', promptText: null })
    const shard = run({
      id: 's1',
      parentNodeRunId: 'p',
      shardKey: 'src/foo.ts',
      promptText: 'SHARD_PROMPT',
    })
    renderDrawer({
      nodeRunId: parent.id,
      nodeId: parent.nodeId,
      workflowNodeKind: 'agent-multi',
      runs: [parent, shard],
    })
    // The picker option labels itself as "fan-out parent" AND the body
    // shows the muted "pick a shard" hint — use the unique hint text.
    expect(screen.getByText(/pick a shard/i)).toBeTruthy()
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.options.length).toBe(2)
    fireEvent.change(select, { target: { value: 's1' } })
    expect(screen.getByText('SHARD_PROMPT')).toBeTruthy()
  })

  test('non-agent kind: shows the N/A hint, no picker or pre', () => {
    const r = run({ id: 'r', promptText: null })
    renderDrawer({
      nodeRunId: r.id,
      nodeId: r.nodeId,
      workflowNodeKind: 'input',
      runs: [r],
    })
    expect(screen.getByText(/does not run an opencode prompt/i)).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  test('re-anchors picker when canvas selectedRunId changes', () => {
    const r0 = run({ id: 'r0', retryIndex: 0, promptText: 'V1' })
    const r1 = run({ id: 'r1', retryIndex: 1, promptText: 'V2' })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <I18nextProvider i18n={i18n}>
          <NodeDetailDrawer
            taskId="t1"
            taskStatus="done"
            nodeRunId={r0.id}
            nodeId={r0.nodeId}
            workflowNodeKind="agent-single"
            agentName={null}
            runs={[r0, r1]}
            outputs={[]}
            onClose={vi.fn()}
          />
        </I18nextProvider>
      </QueryClientProvider>,
    )
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('r0')
    rerender(
      <QueryClientProvider client={qc}>
        <I18nextProvider i18n={i18n}>
          <NodeDetailDrawer
            taskId="t1"
            taskStatus="done"
            nodeRunId={r1.id}
            nodeId={r1.nodeId}
            workflowNodeKind="agent-single"
            agentName={null}
            runs={[r0, r1]}
            outputs={[]}
            onClose={vi.fn()}
          />
        </I18nextProvider>
      </QueryClientProvider>,
    )
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('r1')
  })

  test('empty promptText for the currently-picked attempt shows the empty hint', () => {
    const r0 = run({ id: 'r0', retryIndex: 0, promptText: null, status: 'pending' })
    renderDrawer({
      nodeRunId: r0.id,
      nodeId: r0.nodeId,
      workflowNodeKind: 'agent-single',
      runs: [r0],
    })
    expect(screen.getByText(/No prompt recorded/i)).toBeTruthy()
  })
})
