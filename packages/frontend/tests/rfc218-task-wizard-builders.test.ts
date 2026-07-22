// LOCKS: RFC-218 — pure wizard builders for the port-driven agent launch.
//
//   B1 buildAgentStartBody is a whitelist: stamps EXACTLY the shape chosen
//      (description XOR inputs) — the RFC-125 lesson is that anything not
//      stamped silently falls off the wire.
//   B2 buildAgentStartFormData: payload blob + files[<key>][] parts + OCC
//      guard merged AFTER the whitelist (it would be dropped inside it).
//   B3 snapshotIsPortedAgentHost: the legacy zero-port node id
//      `__agent_input__` shares the `__agent_input_` prefix — the EXACT
//      indexed form is the only safe discriminator (design-gate P1-1; a
//      prefix test would misclassify every RFC-165 task and relaunch would
//      drop the saved description).
//   B4 taskToLaunchPayload agent arm: ported → `inputs` minus upload-port
//      keys (stale worktree paths force a re-pick); legacy → `description`.

import { describe, expect, test } from 'vitest'
import type { Task } from '@agent-workflow/shared'
import {
  buildAgentStartBody,
  buildAgentStartFormData,
  snapshotIsPortedAgentHost,
  snapshotUploadInputKeys,
  taskToLaunchPayload,
} from '../src/lib/task-wizard'

const LEGACY_SNAPSHOT = {
  inputs: [{ kind: 'text', key: 'description', label: 'Task description' }],
  nodes: [
    { id: '__agent_input__', kind: 'input' },
    { id: '__agent_main__', kind: 'agent-single' },
  ],
}
const PORTED_SNAPSHOT = {
  inputs: [
    { kind: 'text', key: 'report', label: 'report' },
    { kind: 'upload', key: 'docs', label: 'docs', targetDir: '.agent-inputs/docs' },
  ],
  nodes: [
    { id: '__agent_input_0__', kind: 'input' },
    { id: '__agent_input_1__', kind: 'input' },
    { id: '__agent_main__', kind: 'agent-single' },
  ],
}

function agentTask(overrides: Partial<Task>): Task {
  return {
    id: 't1',
    name: 'run',
    status: 'done',
    spaceKind: 'scratch',
    repos: [],
    repoCount: 1,
    inputs: {},
    sourceAgentName: 'a',
    workflowId: null,
    workflowSnapshot: LEGACY_SNAPSHOT,
    goal: null,
    workgroupId: null,
    workgroupName: null,
    gitUserName: null,
    gitUserEmail: null,
    workingBranch: null,
    autoCommitPush: false,
    maxDurationMs: null,
    maxTotalTokens: null,
    ...overrides,
  } as unknown as Task
}

describe('B1 buildAgentStartBody whitelist shapes', () => {
  test('description shape: no inputs key on the wire', () => {
    const body = buildAgentStartBody(
      { kind: 'scratch' },
      { name: 't', description: 'fix it', allowClarify: true },
    )
    expect(body.description).toBe('fix it')
    expect('inputs' in body).toBe(false)
    expect(body.scratch).toBe(true)
  })

  test('inputs shape: no description key on the wire', () => {
    const body = buildAgentStartBody(
      { kind: 'scratch' },
      { name: 't', inputs: { report: 'x' }, allowClarify: false },
    )
    expect(body.inputs).toEqual({ report: 'x' })
    expect('description' in body).toBe(false)
    expect(body.allowClarify).toBe(false)
  })
})

describe('B2 buildAgentStartFormData', () => {
  test('payload blob carries the whitelisted body + merged guard; files bind per key', async () => {
    const file = new File(['# doc'], 'a.md', { type: 'text/markdown' })
    const fd = buildAgentStartFormData(
      { kind: 'scratch' },
      { name: 't', inputs: { brief: 'b' }, allowClarify: true },
      { docs: [file] },
      { expectedAgentId: 'agent-1' },
    )
    const payload = JSON.parse(await (fd.get('payload') as Blob).text()) as Record<string, unknown>
    expect(payload.inputs).toEqual({ brief: 'b' })
    expect(payload.expectedAgentId).toBe('agent-1')
    const bound = fd.getAll('files[docs][]')
    expect(bound).toHaveLength(1)
    expect((bound[0] as File).name).toBe('a.md')
  })
})

describe('B3 ported-host discriminator (design P1-1)', () => {
  test('legacy `__agent_input__` is NOT ported despite sharing the prefix', () => {
    expect(snapshotIsPortedAgentHost(LEGACY_SNAPSHOT)).toBe(false)
  })
  test('indexed `__agent_input_0__` is ported; garbage is not', () => {
    expect(snapshotIsPortedAgentHost(PORTED_SNAPSHOT)).toBe(true)
    expect(snapshotIsPortedAgentHost(null)).toBe(false)
    expect(snapshotIsPortedAgentHost({ nodes: 'nope' })).toBe(false)
  })
  test('upload keys are read from the snapshot inputs', () => {
    expect([...snapshotUploadInputKeys(PORTED_SNAPSHOT)]).toEqual(['docs'])
  })
})

describe('B4 taskToLaunchPayload agent arm', () => {
  test('legacy task → description stamped, no inputs', () => {
    const { payload } = taskToLaunchPayload(
      agentTask({ inputs: { description: 'audit the auth module' } }),
    )
    expect(payload.description).toBe('audit the auth module')
    expect('inputs' in payload).toBe(false)
  })

  test('ported task → inputs minus upload keys, no description', () => {
    const { payload } = taskToLaunchPayload(
      agentTask({
        workflowSnapshot: PORTED_SNAPSHOT,
        inputs: { report: 'old body', docs: '.agent-inputs/docs/a.md' },
      }),
    )
    expect(payload.inputs).toEqual({ report: 'old body' })
    expect('description' in payload).toBe(false)
  })
})
