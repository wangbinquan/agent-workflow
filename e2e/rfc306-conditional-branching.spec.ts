// RFC-306 T37 — conditional branching, end to end against a real daemon.
//
// Why this spec exists (and what only it can prove):
//
// The backend suites already lock the judgment table, the envelope parsing and
// the scheduler propagation. What they cannot show is that the three surfaces a
// USER touches agree with each other on one real run:
//
//   1. the agent CONFIG surface — a port declared as a branch port through the
//      public API survives the round trip and actually licenses the marker
//      (a mismatch here fails the run as `branch-port-not-declared`, which the
//      unit tests reach only through hand-seeded rows);
//   2. the EXECUTION surface — the daemon runs one chain, records the other as
//      `skipped`, and still finishes the task `done` (pre-RFC-306 that same
//      graph ended `failed` with "scheduler stalled");
//   3. the READ surface — `node-runs` carries the branch trace, so the task
//      detail canvas can grey out the path that was not taken, and the closed
//      port's text is presented as a REASON rather than as a result.
//
// The model is replaced by the `branch` stub (packages/system-mocks/src/runtime/
// mode-branch.ts) and nothing else is: scheduler, DB, worktrees, envelope parser
// and trace query are the production ones.
//
// Shape: judge → { fix chain → output_fix, ok chain → output_ok }. It is the
// smallest graph where "the wrong branch ran" is observable rather than inferred.

import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle
let repoDir: string
// RFC-223: agent-single nodes are referenced by canonical id, never by name —
// a name-only definition is rejected at save time (`workflow-agent-id-required`).
let judgeAgentId: string
let workerAgentId: string

test.setTimeout(180_000)

interface NodeRunRow {
  id: string
  nodeId: string
  status: string
  parentNodeRunId: string | null
}
interface NodeRunsResponse {
  runs: NodeRunRow[]
  outputs: Array<{ nodeRunId: string; port: string; value: string; active?: boolean }>
  branchTrace?: {
    skippedNodes: Array<{ nodeId: string; reason: string }>
    inactiveEdges: Array<{ edgeId: string; sourceNodeId: string; targetNodeId: string }>
    decisions: Array<{ nodeId: string; portName: string; reason: string }>
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok)
    throw new Error(`${init?.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

/** The judge closes `closePort`; the other branch runs. */
function definitionFor(closePort: 'all_clear' | 'need_fix') {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      {
        id: 'judge',
        kind: 'agent-single',
        agentName: 'rfc306-judge',
        agentId: judgeAgentId,
        // The stub reads this marker; the framework passes the template through.
        promptTemplate: `Judge the repo. RFC306_CLOSE:${closePort}`,
      },
      { id: 'fixer', kind: 'agent-single', agentName: 'rfc306-worker', agentId: workerAgentId },
      { id: 'greeter', kind: 'agent-single', agentName: 'rfc306-worker', agentId: workerAgentId },
      {
        id: 'out_fix',
        kind: 'output',
        ports: [{ name: 'fix_result', bind: { nodeId: 'fixer', portName: 'summary' } }],
      },
      {
        id: 'out_ok',
        kind: 'output',
        ports: [{ name: 'ok_result', bind: { nodeId: 'greeter', portName: 'summary' } }],
      },
    ],
    edges: [
      {
        id: 'e_fix',
        source: { nodeId: 'judge', portName: 'need_fix' },
        target: { nodeId: 'fixer', portName: 'findings' },
      },
      {
        id: 'e_ok',
        source: { nodeId: 'judge', portName: 'all_clear' },
        target: { nodeId: 'greeter', portName: 'note' },
      },
    ],
  }
}

async function runTaskToTerminal(workflowId: string): Promise<{ taskId: string; status: string }> {
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      workflowId,
      repoUrl: repoRemoteUrl(repoDir),
      inputs: {},
      name: 'rfc306-e2e',
    }),
  })
  const deadline = Date.now() + 150_000
  let status = 'pending'
  while (Date.now() < deadline) {
    const row = await api<{ status: string }>(`/api/tasks/${task.id}`)
    status = row.status
    if (['done', 'failed', 'canceled', 'interrupted'].includes(status)) break
    await new Promise((r) => setTimeout(r, 500))
  }
  return { taskId: task.id, status }
}

/** Freshest top-level row per node → status. */
function statusByNode(runs: NodeRunRow[]): Map<string, string> {
  const freshest = new Map<string, NodeRunRow>()
  for (const r of runs) {
    if (r.parentNodeRunId !== null) continue
    const cur = freshest.get(r.nodeId)
    if (cur === undefined || r.id > cur.id) freshest.set(r.nodeId, r)
  }
  return new Map([...freshest].map(([k, v]) => [k, v.status]))
}

test.beforeAll(async () => {
  daemon = await startDaemon({ stubMode: 'branch' })

  repoDir = mkdtempSync(join(tmpdir(), 'aw-e2e-rfc306-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc306 e2e fixture repo\n', 'utf-8')
  initGitRepo(repoDir)

  // The judge DECLARES both ports as branch ports; the worker declares none.
  // That asymmetry is load-bearing: it is what licenses the marker on one agent
  // and would reject it on the other.
  judgeAgentId = (
    await api<{ id: string }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc306-judge',
        description: 'RFC-306 e2e judge',
        outputs: ['need_fix', 'all_clear'],
        branchPorts: ['need_fix', 'all_clear'],
        bodyMd: 'judge',
      }),
    })
  ).id
  workerAgentId = (
    await api<{ id: string }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc306-worker',
        description: 'RFC-306 e2e worker',
        outputs: ['summary'],
        bodyMd: 'worker',
      }),
    })
  ).id
})

test.afterAll(async () => {
  try {
    rmSync(repoDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  if (daemon !== undefined) await daemon.stop()
})

test('closing a branch skips its chain, keeps the task done, and records the trace', async () => {
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc306-close-ok',
      description: 'RFC-306 e2e — judge closes the all_clear branch',
      definition: definitionFor('all_clear'),
    }),
  })

  const { taskId, status } = await runTaskToTerminal(wf.id)
  expect(status).toBe('done')

  const nodeRuns = await api<NodeRunsResponse>(`/api/tasks/${taskId}/node-runs`)
  const byNode = statusByNode(nodeRuns.runs)
  expect(byNode.get('judge')).toBe('done')
  expect(byNode.get('fixer')).toBe('done')
  expect(byNode.get('out_fix')).toBe('done')
  // The closed branch — agent AND its output node.
  expect(byNode.get('greeter')).toBe('skipped')
  expect(byNode.get('out_ok')).toBe('skipped')

  // The closed port kept its reason, and it is flagged as not-a-result.
  const judgeRun = nodeRuns.runs.find((r) => r.nodeId === 'judge')
  const allClear = nodeRuns.outputs.find(
    (o) => o.nodeRunId === judgeRun?.id && o.port === 'all_clear',
  )
  expect(allClear?.active).toBe(false)
  expect(allClear?.value).toContain('stub decided not to run all_clear')

  // The trace the canvas renders.
  const trace = nodeRuns.branchTrace
  expect(trace).toBeDefined()
  expect(trace!.skippedNodes.map((n) => n.nodeId).sort()).toEqual(['greeter', 'out_ok'])
  expect(trace!.inactiveEdges.map((e) => e.edgeId)).toContain('e_ok')
  expect(trace!.inactiveEdges.map((e) => e.edgeId)).not.toContain('e_fix')
  expect(trace!.decisions.some((d) => d.portName === 'all_clear')).toBe(true)
})

test('closing the OTHER branch flips which chain runs', async () => {
  // Same graph, opposite decision. Without this the first test would pass just
  // as well if the platform always skipped `greeter` for an unrelated reason.
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc306-close-fix',
      description: 'RFC-306 e2e — judge closes the need_fix branch',
      definition: definitionFor('need_fix'),
    }),
  })

  const { taskId, status } = await runTaskToTerminal(wf.id)
  expect(status).toBe('done')

  const nodeRuns = await api<NodeRunsResponse>(`/api/tasks/${taskId}/node-runs`)
  const byNode = statusByNode(nodeRuns.runs)
  expect(byNode.get('greeter')).toBe('done')
  expect(byNode.get('out_ok')).toBe('done')
  expect(byNode.get('fixer')).toBe('skipped')
  expect(byNode.get('out_fix')).toBe('skipped')
})

test('the task detail canvas greys out the path that was not taken', async ({
  page,
}: {
  page: Page
}) => {
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc306-canvas',
      description: 'RFC-306 e2e — canvas trace',
      definition: definitionFor('all_clear'),
    }),
  })
  const { taskId, status } = await runTaskToTerminal(wf.id)
  expect(status).toBe('done')

  await page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
  await page.goto(`${daemon.baseUrl}/tasks/${taskId}`)

  // The skipped node is rendered as such…
  const skipped = page.locator('.canvas-node[data-status="skipped"]')
  await expect(skipped).toHaveCount(2, { timeout: 30_000 })
  // …and the edge feeding it is drawn as an inactive line.
  await expect(page.locator('.react-flow__edge.canvas-edge--inactive')).toHaveCount(1)
})
