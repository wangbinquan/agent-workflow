// LOCKS: RFC-243 PR-3 — call-workflow static validation
// (design/RFC-243-unified-executor/design.md §5.4).
//
// WHY: the validator's 4f rules are the ADVISORY twin of the launch-time
// closure freeze (services/execution/closure.ts) — validate-draft shows these
// issues, the launch gate enforces them. These tests pin:
//   - the lazy closure loader (loadWorkflowValidationContext(db, candidate)
//     resolves referenced workflows by NAME, transitively, never full-table);
//   - the 4f error family (ref-missing / upload / output collision / input
//     unwired / fanout containment / cross-definition + self cycles);
//   - id-only cycle messages (RFC-099 echo discipline — no names);
//   - resolver-unavailable degradation: rule-2 edge/binding checks over call
//     ports fall to WARNING instead of killing legal wiring;
//   - the dw admission guard: a generated definition may never contain call
//     nodes (workgroups are closure leaves — design §5.4-7).

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb } from '../src/db/client'
import type { DbClient } from '../src/db/client'
import { workflows } from '../src/db/schema'
import { dwCallNodeRejections } from '../src/services/dynamicWorkflowRunner'
import {
  loadWorkflowValidationContext,
  validateWorkflowDef,
} from '../src/services/workflow.validator'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')

type Node = WorkflowDefinition['nodes'][number]
type Edge = WorkflowDefinition['edges'][number]

const node = (fields: Record<string, unknown>): Node => fields as unknown as Node
const edge = (id: string, source: [string, string], target: [string, string]): Edge => ({
  id,
  source: { nodeId: source[0], portName: source[1] },
  target: { nodeId: target[0], portName: target[1] },
})
const def = (partial: Partial<WorkflowDefinition>): WorkflowDefinition => ({
  $schema_version: 4,
  inputs: [],
  nodes: [],
  edges: [],
  ...partial,
})

async function seedWorkflow(
  db: DbClient,
  id: string,
  name: string,
  definition: WorkflowDefinition,
): Promise<void> {
  await db.insert(workflows).values({ id, name, definition: JSON.stringify(definition) })
}

/** Child with one text input `topic` and one output port `result`. */
const CHILD_OK = def({
  inputs: [{ kind: 'text', key: 'topic', label: 'Topic' }],
  nodes: [
    node({ id: 'c_in', kind: 'input', inputKey: 'topic' }),
    node({
      id: 'c_out',
      kind: 'output',
      ports: [{ name: 'result', bind: { nodeId: 'c_in', portName: 'topic' } }],
    }),
  ],
  edges: [edge('c_e1', ['c_in', 'topic'], ['c_out', 'result'])],
})

const callNode = (over: Record<string, unknown> = {}): Node =>
  node({ id: 'call1', kind: 'call-workflow', workflowName: 'child-ok', ...over })

/** Fully wired legal parent: input → call(child-ok) → output. */
const PARENT_LEGAL = def({
  inputs: [{ kind: 'text', key: 'topic', label: 'Topic' }],
  nodes: [
    node({ id: 'p_in', kind: 'input', inputKey: 'topic' }),
    callNode(),
    node({
      id: 'p_out',
      kind: 'output',
      ports: [{ name: 'final', bind: { nodeId: 'call1', portName: 'result' } }],
    }),
  ],
  edges: [
    edge('p_e1', ['p_in', 'topic'], ['call1', 'topic']),
    edge('p_e2', ['call1', 'result'], ['p_out', 'final']),
  ],
})

const codesOf = (r: { issues: Array<{ code: string }> }): string[] => r.issues.map((i) => i.code)
const errorsOf = (r: { issues: Array<{ code: string; severity?: string }> }) =>
  r.issues.filter((i) => (i.severity ?? 'error') === 'error')

describe('RFC-243 §5.4 — call-workflow validator (4f + rule-2 degradation)', () => {
  test('call-workflow-ref-missing: unresolvable workflowName is an error', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const definition = def({ nodes: [callNode({ workflowName: 'ghost' })] })
    const r = validateWorkflowDef(
      definition,
      await loadWorkflowValidationContext(db, { definition }),
    )
    const issue = r.issues.find((i) => i.code === 'call-workflow-ref-missing')
    expect(issue).toBeDefined()
    expect(issue?.severity ?? 'error').toBe('error')
    expect(r.ok).toBe(false)
  })

  test('call-workflow-upload-input-unsupported: child upload inputs are rejected (and not double-reported as unwired)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedWorkflow(
      db,
      'wfu01',
      'child-upload',
      def({
        inputs: [
          {
            kind: 'upload',
            key: 'files',
            label: 'Files',
            targetDir: 'uploads',
          } as unknown as WorkflowDefinition['inputs'][number],
        ],
      }),
    )
    const definition = def({ nodes: [callNode({ workflowName: 'child-upload' })] })
    const r = validateWorkflowDef(
      definition,
      await loadWorkflowValidationContext(db, { definition }),
    )
    const issue = r.issues.find((i) => i.code === 'call-workflow-upload-input-unsupported')
    expect(issue).toBeDefined()
    expect(issue?.severity ?? 'error').toBe('error')
    // upload inputs are rejected wholesale, not also flagged as unwired.
    expect(codesOf(r)).not.toContain('call-workflow-input-unwired')
    expect(r.ok).toBe(false)
  })

  test('call-workflow-output-port-collision: duplicate port name across child output nodes', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedWorkflow(
      db,
      'wfc01',
      'child-collide',
      def({
        inputs: [{ kind: 'text', key: 'seed', label: 'Seed' }],
        nodes: [
          node({ id: 'c_in', kind: 'input', inputKey: 'seed' }),
          node({
            id: 'c_out1',
            kind: 'output',
            ports: [{ name: 'result', bind: { nodeId: 'c_in', portName: 'seed' } }],
          }),
          node({
            id: 'c_out2',
            kind: 'output',
            ports: [{ name: 'result', bind: { nodeId: 'c_in', portName: 'seed' } }],
          }),
        ],
      }),
    )
    const definition = def({
      inputs: [{ kind: 'text', key: 'seed', label: 'Seed' }],
      nodes: [
        node({ id: 'p_in', kind: 'input', inputKey: 'seed' }),
        callNode({ workflowName: 'child-collide' }),
      ],
      edges: [edge('p_e1', ['p_in', 'seed'], ['call1', 'seed'])],
    })
    const r = validateWorkflowDef(
      definition,
      await loadWorkflowValidationContext(db, { definition }),
    )
    const issue = r.issues.find((i) => i.code === 'call-workflow-output-port-collision')
    expect(issue).toBeDefined()
    expect(issue?.message).toContain("'result'")
    expect(codesOf(r)).not.toContain('call-workflow-input-unwired')
    expect(r.ok).toBe(false)
  })

  test('call-workflow-input-unwired: every non-upload child input needs ≥1 inbound edge', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedWorkflow(db, 'wfok1', 'child-ok', CHILD_OK)
    const definition = def({ nodes: [callNode()] }) // no inbound edge on 'topic'
    const r = validateWorkflowDef(
      definition,
      await loadWorkflowValidationContext(db, { definition }),
    )
    const issue = r.issues.find((i) => i.code === 'call-workflow-input-unwired')
    expect(issue).toBeDefined()
    expect(issue?.message).toContain("'topic'")
    expect(r.ok).toBe(false)
  })

  test('call-workflow-in-fanout-unsupported: direct AND transitive fanout containment; loop containment stays legal', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedWorkflow(db, 'wfok1', 'child-ok', CHILD_OK)

    // Direct: fanout(nodeIds:[call1]). Structural rule — fires regardless of
    // whether the call's child resolves.
    const direct = def({
      nodes: [
        node({
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['call1'],
          inputs: [{ name: 'docs', kind: 'list<text>', isShardSource: true }],
        }),
        callNode(),
      ],
    })
    const rDirect = validateWorkflowDef(
      direct,
      await loadWorkflowValidationContext(db, { definition: direct }),
    )
    expect(codesOf(rDirect)).toContain('call-workflow-in-fanout-unsupported')

    // Transitive: fanout(nodeIds:[loop]) → loop(nodeIds:[call1]).
    const transitive = def({
      nodes: [
        node({
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['loop1'],
          inputs: [{ name: 'docs', kind: 'list<text>', isShardSource: true }],
        }),
        node({
          id: 'loop1',
          kind: 'wrapper-loop',
          nodeIds: ['call1'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', nodeId: 'call1', portName: 'result' },
        }),
        callNode(),
      ],
    })
    const rTransitive = validateWorkflowDef(
      transitive,
      await loadWorkflowValidationContext(db, { definition: transitive }),
    )
    expect(codesOf(rTransitive)).toContain('call-workflow-in-fanout-unsupported')

    // wrapper-loop containment alone is a designed composition ("loop the
    // call until the audit is clean") — no fanout issue, and the loop's
    // exitCondition may reference the call's resolved output port.
    const loopOnly = def({
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic' }],
      nodes: [
        node({ id: 'p_in', kind: 'input', inputKey: 'topic' }),
        node({
          id: 'loop1',
          kind: 'wrapper-loop',
          nodeIds: ['call1'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', nodeId: 'call1', portName: 'result' },
        }),
        callNode(),
      ],
      edges: [edge('p_e1', ['p_in', 'topic'], ['call1', 'topic'])],
    })
    const rLoop = validateWorkflowDef(
      loopOnly,
      await loadWorkflowValidationContext(db, { definition: loopOnly }),
    )
    expect(codesOf(rLoop)).not.toContain('call-workflow-in-fanout-unsupported')
    expect(codesOf(rLoop)).not.toContain('wrapper-loop-exit-port-missing')
    expect(errorsOf(rLoop)).toEqual([])
  })

  test('workflow-call-cycle: A→B→A over stored rows — message carries ids only, never names', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const defA = def({
      nodes: [node({ id: 'a_call', kind: 'call-workflow', workflowName: 'cycle-b-name' })],
    })
    const defB = def({
      nodes: [node({ id: 'b_call', kind: 'call-workflow', workflowName: 'cycle-a-name' })],
    })
    await seedWorkflow(db, 'wfa01HZX', 'cycle-a-name', defA)
    await seedWorkflow(db, 'wfb01HZX', 'cycle-b-name', defB)
    const r = validateWorkflowDef(
      defA,
      await loadWorkflowValidationContext(db, {
        definition: defA,
        currentWorkflow: { id: 'wfa01HZX', name: 'cycle-a-name' },
      }),
    )
    const cycles = r.issues.filter((i) => i.code === 'workflow-call-cycle')
    expect(cycles.length).toBe(1)
    expect(cycles[0]?.severity ?? 'error').toBe('error')
    // RFC-099 echo discipline: resource IDS only, no display names.
    expect(cycles[0]?.message).toContain('wfa01HZX')
    expect(cycles[0]?.message).toContain('wfb01HZX')
    expect(cycles[0]?.message).not.toContain('cycle-a-name')
    expect(cycles[0]?.message).not.toContain('cycle-b-name')
    expect(r.ok).toBe(false)
  })

  test('workflow-call-cycle: draft-only back-edge closes against stored rows (root = real id)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    // Stored A has NO call nodes; stored B calls A. The DRAFT of A newly adds
    // A→B — only rooting the walk on A's real id can close this loop.
    await seedWorkflow(db, 'wfa02HZX', 'draft-a-name', def({}))
    await seedWorkflow(
      db,
      'wfb02HZX',
      'draft-b-name',
      def({ nodes: [node({ id: 'b_call', kind: 'call-workflow', workflowName: 'draft-a-name' })] }),
    )
    const draftA = def({
      nodes: [node({ id: 'a_call', kind: 'call-workflow', workflowName: 'draft-b-name' })],
    })
    const r = validateWorkflowDef(
      draftA,
      await loadWorkflowValidationContext(db, {
        definition: draftA,
        currentWorkflow: { id: 'wfa02HZX', name: 'draft-a-name' },
      }),
    )
    expect(codesOf(r)).toContain('workflow-call-cycle')
    expect(r.ok).toBe(false)
  })

  test('workflow-call-cycle: self-reference reports exactly ONE node-anchored issue (walk duplicate suppressed)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const selfDef = def({
      nodes: [node({ id: 'me_call', kind: 'call-workflow', workflowName: 'self-name' })],
    })
    await seedWorkflow(db, 'wfs01HZX', 'self-name', selfDef)
    const r = validateWorkflowDef(
      selfDef,
      await loadWorkflowValidationContext(db, {
        definition: selfDef,
        currentWorkflow: { id: 'wfs01HZX', name: 'self-name' },
      }),
    )
    const cycles = r.issues.filter((i) => i.code === 'workflow-call-cycle')
    expect(cycles.length).toBe(1)
    expect(cycles[0]?.target).toEqual({ kind: 'node-field', nodeId: 'me_call', field: 'call-ref' })
    expect(cycles[0]?.message).not.toContain('self-name')
    expect(r.ok).toBe(false)
  })

  test('legal definition: resolved child, wired input, bound output — zero issues', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedWorkflow(db, 'wfok1', 'child-ok', CHILD_OK)
    const r = validateWorkflowDef(
      PARENT_LEGAL,
      await loadWorkflowValidationContext(db, { definition: PARENT_LEGAL }),
    )
    expect(r.issues).toEqual([])
    expect(r.ok).toBe(true)
  })

  test('resolver present + wrong port: edge-target-port-missing stays a hard error', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedWorkflow(db, 'wfok1', 'child-ok', CHILD_OK)
    const definition = def({
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic' }],
      nodes: [node({ id: 'p_in', kind: 'input', inputKey: 'topic' }), callNode()],
      edges: [edge('p_e1', ['p_in', 'topic'], ['call1', 'oops'])],
    })
    const r = validateWorkflowDef(
      definition,
      await loadWorkflowValidationContext(db, { definition }),
    )
    const issue = r.issues.find((i) => i.code === 'edge-target-port-missing')
    expect(issue).toBeDefined()
    expect(issue?.severity ?? 'error').toBe('error')
    expect(r.ok).toBe(false)
  })

  test('resolver unavailable: edge/binding checks over call ports degrade to warnings, not errors', () => {
    // Legacy pure ctx (no candidate → no callWorkflows): the same fully-legal
    // definition must not be killed — its call-port wirings surface as
    // warnings only.
    const r = validateWorkflowDef(PARENT_LEGAL, { agents: [], skills: [] })
    expect(errorsOf(r)).toEqual([])
    expect(r.ok).toBe(true)
    const bySeverity = (code: string) =>
      r.issues.filter((i) => i.code === code).map((i) => i.severity)
    expect(bySeverity('edge-target-port-missing')).toEqual(['warning']) // p_e1 → call1.topic
    expect(bySeverity('edge-source-port-missing')).toEqual(['warning']) // p_e2 ← call1.result
    expect(bySeverity('binding-port-missing')).toEqual(['warning']) // p_out.final ← call1.result
    // 4f ref/shape/cycle checks need the resolver — silently skipped here.
    expect(codesOf(r)).not.toContain('call-workflow-ref-missing')
  })
})

describe('RFC-243 §5.4(7) — dw generated definitions reject call nodes', () => {
  test('dwCallNodeRejections flags every call-workflow node with the layer-2 code', () => {
    const generated = def({
      nodes: [
        node({ id: 'n1', kind: 'agent-single', agentId: 'a1', agentName: 'worker' }),
        node({ id: 'n2', kind: 'call-workflow', workflowName: 'child-ok' }),
      ],
    })
    const errors = dwCallNodeRejections(generated)
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain('dw-node-kind-forbidden')
    expect(errors[0]).toContain("'n2'")
    // Clean generated DAGs pass untouched.
    expect(
      dwCallNodeRejections(def({ nodes: [node({ id: 'n1', kind: 'agent-single' })] })),
    ).toEqual([])
  })

  test('source lock: evaluateGeneratedWorkflow wires the guard ahead of the generic layers', () => {
    // The token schema cannot express a call node today, so the wiring cannot
    // be exercised through evaluateGeneratedWorkflow's inputs — pin it at the
    // source level instead (same doctrine as other unreachable-by-input
    // guards; see CLAUDE.md test rules).
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'services', 'dynamicWorkflowRunner.ts'),
      'utf8',
    )
    const callSite = src.indexOf('dwCallNodeRejections(def)')
    const layer1Site = src.indexOf('validateWorkflowDef(def, layer1Ctx)')
    expect(callSite).toBeGreaterThan(-1)
    expect(layer1Site).toBeGreaterThan(-1)
    expect(callSite).toBeLessThan(layer1Site)
  })
})

// RFC-243 PR-4 —— 4g call-workgroup 规则（fanout 内层拒绝 / advisory 存在性）。
import { validateWorkflowDef as validateDef4g } from '../src/services/workflow.validator'
describe('RFC-243 4g — call-workgroup rules', () => {
  const baseCtx = { agents: [], skills: [], mcps: [], plugins: [] }
  const wgNode = (over: Record<string, unknown> = {}) => ({
    id: 'cw',
    kind: 'call-workgroup',
    workgroupName: 'g1',
    goalTemplate: 'do it',
    ...over,
  })
  const defOf = (nodes: unknown[], edges: unknown[] = []) =>
    ({ $schema_version: 4, inputs: [], nodes, edges }) as never

  test('fanout 传递内层的 call-workgroup 被拒；loop 内层合法', () => {
    const def = defOf([
      {
        id: 'fan',
        kind: 'wrapper-fanout',
        nodeIds: ['cw'],
        inputs: [{ name: 'items', kind: 'list<string>', isShardSource: true }],
      },
      wgNode(),
    ])
    const r = validateDef4g(def, baseCtx as never)
    expect(r.issues.some((i) => i.code === 'call-workgroup-in-fanout-unsupported')).toBe(true)

    const loopDef = defOf([
      {
        id: 'loop',
        kind: 'wrapper-loop',
        nodeIds: ['cw'],
        maxIterations: 2,
        exitCondition: { kind: 'port-empty', portRef: { nodeId: 'cw', portName: 'result' } },
      },
      wgNode(),
    ])
    const r2 = validateDef4g(loopDef, baseCtx as never)
    expect(r2.issues.some((i) => i.code === 'call-workgroup-in-fanout-unsupported')).toBe(false)
  })

  test('advisory 存在性：context 带 callWorkgroupNames 时报 ref-missing；缺选择器恒报', () => {
    const withNames = { ...baseCtx, callWorkgroupNames: new Set<string>() }
    const r = validateDef4g(defOf([wgNode()]), withNames as never)
    expect(r.issues.some((i) => i.code === 'call-workgroup-ref-missing')).toBe(true)
    const known = { ...baseCtx, callWorkgroupNames: new Set(['g1']) }
    const r2 = validateDef4g(defOf([wgNode()]), known as never)
    expect(r2.issues.some((i) => i.code === 'call-workgroup-ref-missing')).toBe(false)
    const r3 = validateDef4g(defOf([wgNode({ workgroupName: undefined })]), baseCtx as never)
    expect(r3.issues.some((i) => i.code === 'call-workgroup-ref-missing')).toBe(true)
  })
})
