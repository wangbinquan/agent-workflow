// RFC-199 T5.5 — validator issues must carry strict, non-guessing semantic
// targets. In particular, output binding rows belong to the output node's own
// input port, loop rows stay on loop semantic fields, and duplicate workflow
// declarations must never pick an arbitrary row.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { WorkflowValidationTargetSchema } from '@agent-workflow/shared'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  validateAgentClarifyMultiplicity,
  validateWorkflowDef,
} from '../src/services/workflow.validator'

const EMPTY_CONTEXT = { agents: [], skills: [] }

function definition(parts: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [],
    edges: [],
    ...parts,
  }
}

function issue(def: WorkflowDefinition, code: string) {
  const found = validateWorkflowDef(def, EMPTY_CONTEXT).issues.find((entry) => entry.code === code)
  expect(found, `expected validator issue ${code}`).toBeDefined()
  return found!
}

describe('RFC-199 strict workflow validation targets', () => {
  test('output port rows are inbound edges: a broken source focuses the edge row', () => {
    // RFC-354: an output node declares no ports of its own — each inbound edge
    // IS one port, so its issues anchor on the edge (the canvas row).
    const found = issue(
      definition({
        nodes: [{ id: 'publish', kind: 'output' }],
        edges: [
          {
            id: 'artifact-edge',
            source: { nodeId: 'missing', portName: 'wrong' },
            target: { nodeId: 'publish', portName: 'artifact' },
          },
        ],
      }),
      'edge-source-node-missing',
    )

    expect(found.target).toEqual({ kind: 'edge', edgeId: 'artifact-edge' })
  })

  test('loop return edges and exitCondition failures focus their semantic rows', () => {
    // RFC-354: a loop returns through `wrapper-output` edges and its exit
    // condition names one of its OWN return ports.
    const def = definition({
      $schema_version: 6,
      nodes: [
        { id: 'input', kind: 'input', inputKey: 'request' },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['input'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', portName: 'done' },
        },
      ],
      edges: [
        {
          id: 'final-edge',
          source: { nodeId: 'missing-output', portName: 'result' },
          target: { nodeId: 'loop', portName: 'final' },
          boundary: 'wrapper-output',
        },
      ],
    })

    expect(issue(def, 'edge-source-node-missing').target).toEqual({
      kind: 'edge',
      edgeId: 'final-edge',
    })
    expect(issue(def, 'wrapper-loop-exit-port-missing').target).toEqual({
      kind: 'node-field',
      nodeId: 'loop',
      field: 'loop-exit-condition',
    })
  })

  test('ordinary missing node ports use the compound node-port identity', () => {
    const found = issue(
      definition({
        inputs: [{ kind: 'text', key: 'request', label: 'Request' }],
        nodes: [
          { id: 'input', kind: 'input', inputKey: 'request' },
          { id: 'output', kind: 'output', ports: [] },
        ],
        edges: [
          {
            id: 'bad-port',
            source: { nodeId: 'input', portName: 'typo' },
            target: { nodeId: 'output', portName: 'result' },
          },
        ],
      }),
      'edge-source-port-missing',
    )

    expect(found.target).toEqual({
      kind: 'node-port',
      nodeId: 'input',
      direction: 'output',
      portName: 'typo',
    })
  })

  test('duplicate workflow input identities fall back to workflow for every affected row', () => {
    const result = validateWorkflowDef(
      definition({
        inputs: [
          { kind: 'upload', key: 'files', label: 'First', targetDir: '' },
          { kind: 'upload', key: 'files', label: 'Second', targetDir: '' },
        ],
      }),
      EMPTY_CONTEXT,
    )

    const affected = result.issues.filter(
      (entry) =>
        entry.code === 'input-key-duplicate' ||
        entry.code === 'upload-input-target-dir-missing' ||
        entry.code === 'input-orphan-declared',
    )
    expect(affected.length).toBeGreaterThan(0)
    expect(affected.every((entry) => entry.target?.kind === 'workflow')).toBe(true)
  })

  test('fanout shard-source issues focus the wrapper shard port row', () => {
    // RFC-354: the fan-out's parameters are its inbound edges and
    // `shardSourcePort` names the one that is split — an unfed shard port
    // anchors on that port row, never on an arbitrary edge.
    const found = issue(
      definition({
        $schema_version: 6,
        nodes: [{ id: 'fan', kind: 'wrapper-fanout', nodeIds: [], shardSourcePort: 'docs' }],
      }),
      'wrapper-fanout-shard-source-missing',
    )

    expect(found.target).toEqual({
      kind: 'node-port',
      nodeId: 'fan',
      direction: 'input',
      portName: 'docs',
    })
  })

  test('multi-object clarify multiplicity does not preserve the arbitrary legacy pointer as target', () => {
    const issues = validateAgentClarifyMultiplicity({
      nodes: [
        { id: 'asker', kind: 'agent-single', agentName: 'asker-agent' },
        { id: 'clarify-a', kind: 'clarify' },
        { id: 'clarify-b', kind: 'clarify' },
      ],
      edges: [
        {
          id: 'ask-a',
          source: { nodeId: 'asker', portName: '__clarify__' },
          target: { nodeId: 'clarify-a', portName: 'questions' },
        },
        {
          id: 'ask-b',
          source: { nodeId: 'asker', portName: '__clarify__' },
          target: { nodeId: 'clarify-b', portName: 'questions' },
        },
      ],
    })

    expect(
      issues.find((entry) => entry.code === 'clarify-multiple-clarify-on-same-agent'),
    ).toMatchObject({
      pointer: 'clarify-a',
      target: { kind: 'workflow' },
    })
  })

  test('source ratchet: every emitted issue has a strict target and all targets parse', () => {
    const source = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'resource-catalog',
        'infrastructure',
        'legacy',
        'workflow.validator.ts',
      ),
      'utf8',
    )
    // RFC-282 B3: two plugin-disabled emissions now spell their code via the
    // policy-table constant — count identifier-shaped codes as emissions too.
    const emissions = [...source.matchAll(/^\s+code: (?:'[^']+'|[A-Z][A-Z0-9_]*),/gm)]
    // Release hardening adds duplicate-node-id plus malformed loop-condition
    // emissions; RFC-199 B5 adds the fixed review-input port, conflict and
    // mirror-mismatch emissions; RFC-228 adds MCP closure failures; RFC-236
    // adds the loop continuation-policy type failure; Intent Builder hardening
    // adds the fanout wrapper-input-to-aggregator failure; RFC-243 §5.4 adds
    // the nine call-workflow emissions (rule-2 call edge branch + 4f family:
    // fanout containment, self/graph cycles, ref-missing ×2, upload, output
    // collision, input unwired). Every new site must still carry a strict
    // navigation target.
    // RFC-253 adds twelve script-node emissions (strict-schema violation,
    // language, empty body, fan-out placement, duplicate/path output kinds,
    // port→env collision, bash-with-dependencies, dependency grammar ×2, env
    // key invalid/reserved) — each with a strict node or node-field target.
    //
    // The dependency pair used to be ONE push with a ternary `code:`, which this
    // ratchet cannot see (it scans literal `code:` values) — the only such site
    // in the validator. Split into two literal pushes so the count is real.
    // RFC-262 adds one upload emission (`upload-input-on-conflict-invalid`,
    // strict workflow-input target — same family as the targetDir pair).
    // RFC-253 T43 adds one more script emission
    // (`script-output-name-unquotable`: a port name holding both quote
    // characters fits in neither `<port name="…">` nor `<port name='…'>`, so
    // the node could only ever fail at run time) — strict `script-outputs`
    // node-field target, same family as the duplicate/path-kind pair.
    // RFC-269 显式改判：代码平台调用节点新增 12 条 issue emission（provider /
    // action / 支持性 / 必填 / 枚举 / 自定义请求四条 / 变量域 / strict schema），
    // 全部带 node 级 strict target ⇒ 130 → 142。RFC-292 再为 agent/workgroup
    // 与 review template 的 invalid-ref 分支增加 2 条 strict emission ⇒ 144。
    // RFC-304 增加 1 条 `code-round-not-authorable`（合成节点出现在用户提交的
    // 定义里即拒），node 级 strict target ⇒ 145。它是 SYNTHESIZED_ONLY_NODE_KINDS
    // 全表共用的一条 emission，**将来再加合成 kind 不会再涨这个数**——这正是
    // 用列表而非逐 kind 硬编码分支的收益。
    // RFC-306 增加 1 条 `exit-condition-port-not-branch`（`port-inactive` 退出条件指向
    // 非分支端口 ⇒ 该条件永不成立，循环只会跑到 max_iterations 才失败），锚在
    // loop-exit-condition 字段上 ⇒ 146。
    // RFC-354 retires two emissions (`wrapper-loop-nested` — nesting is legal
    // now that node_runs carries a frame axis; the loop/git "does not accept
    // inbound edges" branch — an inbound edge is a wrapper parameter) and adds
    // one (`wrapper-fanout-unsupported-inner-kind`, the schema-time mirror of
    // the runtime fan-out body rejection) ⇒ 145.
    // RFC-354 PR-2 (schema v6: every node-level PortRef is an edge) retires the
    // whole implicit-binding family — `binding-node-missing` ×2 and
    // `binding-port-missing` ×2 (output ports / loop bindings are edges now and
    // fall under the ordinary edge-source-* rules), `wrapper-loop-exit-node-missing`
    // and `wrapper-loop-exit-node-out-of-scope` (the exit condition names the
    // loop's own return port), `review-input-edge-mismatch` and two of the three
    // `review-input-source-missing` sites (the review input IS its edge),
    // `wrapper-fanout-shard-source-duplicate` (one `shardSourcePort` string
    // cannot duplicate), two of the four `edge-target-port-missing` sites (the
    // output / fan-out target branches: their ports are edge-declared), and two
    // of the four `wrapper-output-boundary-missing` sites (output / review reads
    // are edges, covered once by the generic edge rule): 14 retired, plus one
    // new `wrapper-fanout-shard-source-missing` site (the named shard port has
    // no feeding edge) ⇒ 145 − 14 + 1 = 132.
    expect(emissions).toHaveLength(132)
    for (const emission of emissions) {
      const start = emission.index ?? 0
      const nextPush = source.indexOf('issues.push({', start)
      const block = source.slice(start, nextPush === -1 ? source.length : nextPush)
      expect(block).toContain('target:')
    }

    const sampleIssues = validateWorkflowDef(
      definition({
        inputs: [{ kind: 'text', key: 'orphan', label: 'Orphan' }],
        nodes: [
          { id: 'missing-agent', kind: 'agent-single', agentName: 'ghost' },
          { id: 'empty-loop', kind: 'wrapper-loop', nodeIds: [] },
        ],
      }),
      EMPTY_CONTEXT,
    ).issues
    expect(sampleIssues.length).toBeGreaterThan(0)
    for (const entry of sampleIssues) {
      expect(() => WorkflowValidationTargetSchema.parse(entry.target)).not.toThrow()
    }
  })
})
