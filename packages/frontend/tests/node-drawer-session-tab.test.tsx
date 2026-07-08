// RFC-027 T5 — locks the NodeDetailDrawer Session tab visibility +
// default selection + placeholder branches. Mirrors the structure of
// `node-drawer-prompt-history.test.tsx` so future refactors of the
// drawer touch both at the same time.

import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { NodeRun, SessionViewResponse } from '@agent-workflow/shared'
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
    sessionId: 'root',
    parentSessionId: null,
    agentName: 'coder',
    messages: [
      { kind: 'user', text: 'hello root', ts: 1 },
      { kind: 'assistant-text', text: 'OK ROOT REPLY', ts: 2, messageId: 'm1' },
    ],
    captureComplete: true,
  },
}

const originalFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/session')) {
      return new Response(JSON.stringify(SAMPLE_SESSION), { status: 200 })
    }
    return new Response(JSON.stringify({ events: [], cursor: null }), { status: 200 })
  }) as unknown as typeof globalThis.fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
  document.body.innerHTML = ''
})

describe('RFC-027 NodeDetailDrawer Session tab', () => {
  test('tab list contains "Session" (renamed from "Prompt") as the first tab', () => {
    const r = run({ id: 'r1', promptText: 'hi' })
    renderDrawer({ nodeRunId: r.id, nodeId: r.nodeId, workflowNodeKind: 'agent-single', runs: [r] })
    const tabButtons = screen.getAllByRole('button').map((b) => b.textContent ?? '')
    expect(tabButtons.find((s) => s === 'Session')).toBeDefined()
    expect(tabButtons.find((s) => s === 'Prompt')).toBeUndefined()
  })

  test('Session is the default selected tab and the attempts dropdown picker renders', () => {
    const r = run({ id: 'r1', promptText: 'hi' })
    renderDrawer({ nodeRunId: r.id, nodeId: r.nodeId, workflowNodeKind: 'agent-single', runs: [r] })
    // The attempts picker is the Select-based combobox (replaced the
    // earlier chip-row, which itself replaced a bare <select>).
    // Confirms SessionTab is mounted by default (vs PromptTab or empty
    // placeholder).
    const trigger = screen.getByRole('combobox', { name: /attempt/i })
    expect(trigger).toBeTruthy()
    // Picked value is shown directly on the closed trigger.
    expect(trigger.textContent ?? '').toMatch(/initial/i)
  })

  test('non-agent kind (wrapper-git) shows the "not applicable" hint', () => {
    const r = run({ id: 'r1' })
    renderDrawer({
      nodeRunId: r.id,
      nodeId: r.nodeId,
      workflowNodeKind: 'wrapper-git',
      runs: [r],
    })
    expect(screen.getByText(/no opencode session/i)).toBeTruthy()
  })

  test('pending attempt (no matching node_run for nodeId) shows the "not yet captured" hint', () => {
    const r = run({ id: 'r1' })
    // Pass a nodeId that has no matching run in the runs array → attempts is empty.
    renderDrawer({
      nodeRunId: r.id,
      nodeId: 'unrelated-node-id',
      workflowNodeKind: 'agent-single',
      runs: [r],
    })
    expect(screen.getByText(/not yet captured/i)).toBeTruthy()
  })

  test('fan-out parent (no own session) shows the "pick a shard" hint', () => {
    // RFC-060 PR-E: fan-out parent rows are now wrapper-fanout containers.
    // The drawer still drives the "pick a shard" branch when the row has no
    // promptText and at least one parentNodeRunId-keyed shard child.
    const parent = run({ id: 'p', promptText: null })
    const shard = run({ id: 's1', parentNodeRunId: 'p', shardKey: 'src/foo.ts' })
    renderDrawer({
      nodeRunId: parent.id,
      nodeId: parent.nodeId,
      workflowNodeKind: 'wrapper-fanout',
      runs: [parent, shard],
    })
    expect(screen.getByText(/pick a shard/i)).toBeTruthy()
  })
})
