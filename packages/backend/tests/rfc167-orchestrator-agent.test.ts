// RFC-167 PR-2 — orchestrator agent + prompt + layer-two validation. Locks:
//  1. buildOrchestratorAgent: internal shape (name, single `workflow` output,
//     no skills/deps, v1-constraint protocol in bodyMd).
//  2. buildOrchestratorPrompt: goal + charter + pool capability cards + rejection
//     feedback; prompt-isolation (no user id).
//  3. validateDynamicWorkflowDef matrix: empty / forbidden-kind / agent-outside-pool
//     / orphan node / valid chain; error severity drives `ok`.

import { describe, expect, test } from 'bun:test'
import type { CapabilitySource, WorkflowDefinition } from '@agent-workflow/shared'
import { DW_VALIDATION_CODES, dwGeneratedToWorkflowDef } from '@agent-workflow/shared'
import {
  DW_ORCHESTRATOR_NODE_ID,
  DW_PHASES,
  ORCHESTRATOR_AGENT_NAME,
  ORCHESTRATOR_WORKFLOW_PORT,
  buildDynamicWorkflowGenerateSnapshot,
  buildOrchestratorAgent,
  buildOrchestratorPrompt,
  validateDynamicWorkflowDef,
} from '../src/services/orchestratorAgent'

describe('buildOrchestratorAgent', () => {
  test('internal shape: single workflow output, no skills/deps, v1 protocol', () => {
    const a = buildOrchestratorAgent()
    expect(a.name).toBe(ORCHESTRATOR_AGENT_NAME)
    expect(a.outputs).toEqual([ORCHESTRATOR_WORKFLOW_PORT])
    expect(a.inputs).toEqual([])
    expect(a.skills).toEqual([])
    expect(a.dependsOn).toEqual([])
    // v1 constraint stated in the protocol
    expect(a.bodyMd).toContain('agent nodes only')
    expect(a.bodyMd).toContain(`<port name="${ORCHESTRATOR_WORKFLOW_PORT}">`)
  })
})

describe('buildDynamicWorkflowGenerateSnapshot + phases', () => {
  test('generation snapshot is a single orchestrator agent-single node', () => {
    const snap = buildDynamicWorkflowGenerateSnapshot()
    expect(snap.$schema_version).toBe(4)
    expect(snap.nodes).toEqual([
      { id: DW_ORCHESTRATOR_NODE_ID, kind: 'agent-single', agentName: ORCHESTRATOR_AGENT_NAME },
    ])
    expect(snap.edges).toEqual([])
  })

  test('DW_PHASES lists the four lifecycle phases', () => {
    expect(DW_PHASES).toEqual(['generating', 'awaiting_confirm', 'executing', 'rejected'])
  })
})

const POOL: CapabilitySource[] = [
  { name: 'coder', description: 'writes code', inputs: [], outputs: ['patch'], role: 'normal' },
  { name: 'auditor', description: 'reviews', inputs: [], outputs: ['report'], role: 'normal' },
]

describe('buildOrchestratorPrompt', () => {
  test('includes charter, goal, capability cards; no user id', () => {
    const p = buildOrchestratorPrompt({
      charter: 'be careful',
      goal: 'refactor payments',
      pool: POOL,
    })
    expect(p).toContain('be careful')
    expect(p).toContain('refactor payments')
    expect(p).toContain('### coder')
    expect(p).toContain('writes code')
    expect(p).not.toContain('user_')
  })

  test('rejection feedback is injected on a regeneration round', () => {
    const p = buildOrchestratorPrompt({
      charter: '',
      goal: 'g',
      pool: POOL,
      rejectionComment: 'the auditor should run last',
    })
    expect(p).toContain('REJECTED')
    expect(p).toContain('the auditor should run last')
  })

  test('64 pool cards stay present while input-description additions stay within 4,800 chars', () => {
    const verbosePool: CapabilitySource[] = Array.from({ length: 64 }, (_, index) => ({
      name: `agent-${index}`,
      description: `agent ${index}`,
      inputs: [
        {
          name: 'request',
          kind: 'string',
          description: 'long capability detail '.repeat(100),
        },
      ],
      outputs: ['result'],
      role: 'normal',
    }))
    const compactPool: CapabilitySource[] = verbosePool.map((agent) => ({
      ...agent,
      inputs: agent.inputs?.map(({ description: _drop, ...port }) => port),
    }))
    const withDescriptions = buildOrchestratorPrompt({ charter: '', goal: 'g', pool: verbosePool })
    const withoutDescriptions = buildOrchestratorPrompt({
      charter: '',
      goal: 'g',
      pool: compactPool,
    })

    for (let index = 0; index < 64; index += 1) {
      expect(withDescriptions).toContain(`### agent-${index}`)
      expect(withDescriptions).toContain('request (string)')
    }
    expect(withDescriptions.length - withoutDescriptions.length).toBeGreaterThan(0)
    expect(withDescriptions.length - withoutDescriptions.length).toBeLessThanOrEqual(4_800)
  })
})

const POOL_NAMES = ['coder', 'auditor']

describe('validateDynamicWorkflowDef — v1 constraint matrix', () => {
  test('a valid agent-single chain passes', () => {
    const def = dwGeneratedToWorkflowDef({
      nodes: [
        { id: 'a', agentName: 'coder', promptTemplate: 'write', inputs: [] },
        {
          id: 'b',
          agentName: 'auditor',
          promptTemplate: 'review {{patch}}',
          inputs: [{ port: 'patch', from: { nodeId: 'a', portName: 'patch' } }],
        },
      ],
      edges: [],
    })
    const r = validateDynamicWorkflowDef(def, POOL_NAMES)
    expect(r.ok).toBe(true)
    expect(r.issues).toEqual([])
  })

  test('single node (no edges) passes — no orphan false-positive', () => {
    const def = dwGeneratedToWorkflowDef({
      nodes: [{ id: 'a', agentName: 'coder', promptTemplate: 'do it', inputs: [] }],
      edges: [],
    })
    expect(validateDynamicWorkflowDef(def, POOL_NAMES).ok).toBe(true)
  })

  test('empty → dw-empty', () => {
    const r = validateDynamicWorkflowDef(
      { $schema_version: 4, inputs: [], nodes: [], edges: [] },
      POOL_NAMES,
    )
    expect(r.ok).toBe(false)
    expect(r.issues.map((i) => i.code)).toContain(DW_VALIDATION_CODES.empty)
  })

  test('a non-agent-single node → dw-node-kind-forbidden', () => {
    const def: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'coder' } as never,
        { id: 'w', kind: 'wrapper-git' } as never,
      ],
      edges: [
        { id: 'e', source: { nodeId: 'a', portName: 'x' }, target: { nodeId: 'w', portName: 'y' } },
      ],
    }
    const codes = validateDynamicWorkflowDef(def, POOL_NAMES).issues.map((i) => i.code)
    expect(codes).toContain(DW_VALIDATION_CODES.nodeKindForbidden)
  })

  test('an agent outside the pool → dw-agent-outside-pool', () => {
    const def = dwGeneratedToWorkflowDef({
      nodes: [{ id: 'a', agentName: 'ghost', promptTemplate: 'x', inputs: [] }],
      edges: [],
    })
    const codes = validateDynamicWorkflowDef(def, POOL_NAMES).issues.map((i) => i.code)
    expect(codes).toContain(DW_VALIDATION_CODES.agentOutsidePool)
  })

  test('a disconnected node in a multi-node graph → dw-orphan-node', () => {
    const def = dwGeneratedToWorkflowDef({
      nodes: [
        { id: 'a', agentName: 'coder', promptTemplate: 'w', inputs: [] },
        { id: 'b', agentName: 'auditor', promptTemplate: 'r', inputs: [] }, // no edge → orphan
      ],
      edges: [],
    })
    const codes = validateDynamicWorkflowDef(def, POOL_NAMES).issues.map((i) => i.code)
    expect(codes).toContain(DW_VALIDATION_CODES.orphanNode)
  })
})
