// RFC-310 PR-0 T3 —— strict codec 合同：round-trip + 每层 unknown-key 全拒。
//
// 锁三件事：①每个 codec 对合法 fixture round-trip（parse→canonical→parse
// 结果 byte-identical）；②对 fixture 每个对象层注入 unknown key 一律拒绝
// （unknownKeySurvivors === []，AC-9 的 schema 半边）；③伪平台事实字段
// （changedPaths/commitSha/pushed/testsPassed/mergeable）在 envelope 顶层被
// 点名拒绝——它们正是 Agent 冒充平台事实的高危键（design §7.4）。

import { describe, expect, test } from 'bun:test'

import {
  agentOutcomeEnvelopeSchema,
  AGENT_RESULT_PORT,
} from '@/modules/development-automation/domain/agentEnvelope'
import {
  canonicalDigest,
  canonicalStringify,
} from '@/modules/development-automation/domain/canonicalJson'
import { nextDecisionSchema } from '@/modules/development-automation/domain/decision'
import { evaluateCell, factCellSchema } from '@/modules/development-automation/domain/factCell'
import {
  checkPredicateBudget,
  factPredicateSchema,
  PREDICATE_MAX_DEPTH,
} from '@/modules/development-automation/domain/predicate'
import {
  developmentMissionRef,
  missionRevisionRefSchema,
} from '@/modules/development-automation/domain/refs'
import { pipelineEvidenceManifestV1Schema } from '@/modules/development-automation/domain/pipelineManifest'
import { requirementBundleManifestV1Schema } from '@/modules/development-automation/domain/requirementManifest'
import { parseOk, unknownKeySurvivors } from './helpers/rfc310UnknownKeyHarness'
import { z } from 'zod'

const SHA = 'a'.repeat(64)
const GIT_SHA = 'b'.repeat(40)

const envelopeFixture = {
  protocolVersion: 1,
  nonce: '0123456789abcdef0123',
  port: AGENT_RESULT_PORT,
  actionRunRef: 'run-1',
  inputDigest: SHA,
  capabilityId: 'mr.feedback.apply',
  outcome: 'changed',
  result: {
    capabilityId: 'mr.feedback.apply',
    summary: 'addressed both review threads',
    feedback: [
      { threadRef: 't-1', revision: 'r-3', disposition: 'addressed' },
      { threadRef: 't-2', revision: 'r-1', disposition: 'needs-human' },
    ],
  },
} as const

const decisionFixtures: unknown[] = [
  { kind: 'collect-mr-facts' },
  { kind: 'seed-repository-uploads', uploadPlanRef: 'plan-1' },
  {
    kind: 'run-agent-action',
    capabilityId: 'change.implement',
    templateRef: 'tpl-1',
    workSetRef: 'ws-1',
  },
  {
    kind: 'wait',
    reason: 'pipeline-running',
    resumeAt: null,
    wakeSources: ['pipeline'],
    attemptOrdinal: 2,
  },
  { kind: 'mark-terminal', terminal: 'completed-no-change' },
]

const requirementManifestFixture = {
  schemaVersion: 1,
  bundleId: 'bundle-1',
  source: { kind: 'external', sourceKey: 'req-sys', externalId: 'REQ-1042', sourceRevision: '7' },
  title: 'Add retry budget to importer',
  fetchedAt: '2026-08-18T10:00:00+00:00',
  complete: true,
  files: [
    {
      fileId: 'f-1',
      ordinal: 0,
      relativePath: 'requirement.md',
      role: 'body',
      mediaType: 'text/markdown',
      bytes: 120,
      sha256: SHA,
      redaction: 'none',
      repositoryPlacement: null,
    },
    {
      fileId: 'f-2',
      ordinal: 1,
      relativePath: 'uploads/0/spec.md',
      role: 'upload',
      mediaType: 'text/markdown',
      bytes: 64,
      sha256: SHA,
      redaction: 'none',
      repositoryPlacement: { targetPath: 'docs/spec.md', contentPolicy: 'preserve-upload' },
    },
  ],
  totals: { files: 2, bytes: 184 },
  writebackRef: null,
  manifestDigest: SHA,
} as const

const pipelineManifestFixture = {
  schemaVersion: 1,
  bundleId: 'pipe-1',
  providerKey: 'inhouse-ci',
  headSha: GIT_SHA,
  targetSha: GIT_SHA,
  completeness: 'complete',
  gates: [
    {
      gateKey: 'compile',
      required: true,
      status: 'fail',
      runRef: 'run-9',
      attempt: 1,
      finishedAt: '2026-08-18T10:05:00+00:00',
      retryability: 'unsafe',
      failureCategories: ['compile'],
      evidenceFileIds: ['log-1'],
    },
  ],
  files: [
    {
      fileId: 'log-1',
      relativePath: 'logs/compile/stdout.log',
      mediaType: 'text/plain',
      bytes: 2048,
      sha256: SHA,
      redaction: 'applied',
    },
  ],
  totals: { files: 1, bytes: 2048 },
  redaction: 'complete',
  manifestDigest: SHA,
} as const

describe('rfc310 pr0 codecs', () => {
  test('opaque refs mint/validate and reject non-ulids', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    expect(developmentMissionRef.mint(id)).toBe(id as ReturnType<typeof developmentMissionRef.mint>)
    expect(() => developmentMissionRef.mint('not-a-ulid')).toThrow()
    expect(developmentMissionRef.schema.safeParse('lowercase-bad').success).toBe(false)
    expect(unknownKeySurvivors(missionRevisionRefSchema, { missionId: id, revision: 3 })).toEqual(
      [],
    )
  })

  test('canonical stringify is key-order independent and digest-stable', () => {
    const a = { z: 1, a: [{ b: 2, a: 3 }], m: 'x' }
    const b = { m: 'x', a: [{ a: 3, b: 2 }], z: 1 }
    expect(canonicalStringify(a)).toBe(canonicalStringify(b))
    expect(canonicalDigest(a)).toBe(canonicalDigest(b))
    expect(() => canonicalStringify({ bad: Number.NaN })).toThrow()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => canonicalStringify(cyclic)).toThrow()
  })

  test('fact cell: four states round-trip, unknown/stale evaluate indeterminate', () => {
    const schema = factCellSchema(z.string())
    const known = parseOk(schema, { state: 'known', value: 'java', sourceRevision: 'r1' })
    expect(evaluateCell(known, (v) => v === 'java')).toBe(true)
    const unknown = parseOk(schema, {
      state: 'unknown',
      reason: 'provider-outage',
      collectable: true,
    })
    expect(evaluateCell(unknown, () => true)).toBe('indeterminate')
    const stale = parseOk(schema, { state: 'stale', previousRevision: 'r0', collectable: true })
    expect(evaluateCell(stale, () => true)).toBe('indeterminate')
    for (const fixture of [
      { state: 'known', value: 'java', sourceRevision: 'r1' },
      { state: 'not-applicable', reason: 'no-mr-yet' },
      { state: 'unknown', reason: 'outage', collectable: false },
      { state: 'stale', previousRevision: 'r0', collectable: true },
    ]) {
      expect(unknownKeySurvivors(schema, fixture)).toEqual([])
    }
  })

  test('predicate AST parses, rejects unknown keys at every level, and enforces budget', () => {
    const fixture = {
      kind: 'all',
      predicates: [
        { kind: 'enum-equals', fact: 'repository.language', value: 'java' },
        {
          kind: 'any',
          predicates: [
            { kind: 'set-contains-any', fact: 'repository.buildSystems', values: ['maven'] },
            { kind: 'not', predicate: { kind: 'boolean-is', fact: 'mr.draft', value: true } },
          ],
        },
      ],
    }
    const parsed = parseOk(factPredicateSchema, fixture)
    expect(checkPredicateBudget(parsed)).toEqual([])
    expect(unknownKeySurvivors(factPredicateSchema, fixture)).toEqual([])

    let deep: Record<string, unknown> = { kind: 'boolean-is', fact: 'f', value: true }
    for (let i = 0; i < PREDICATE_MAX_DEPTH + 2; i += 1) deep = { kind: 'not', predicate: deep }
    const deepParsed = parseOk(factPredicateSchema, deep)
    expect(checkPredicateBudget(deepParsed).map((v) => v.code)).toContain('max-depth-exceeded')
  })

  test('next decision union round-trips and rejects unknown keys and unlisted kinds', () => {
    for (const fixture of decisionFixtures) {
      const parsed = parseOk(nextDecisionSchema, fixture)
      expect(parseOk(nextDecisionSchema, JSON.parse(canonicalStringify(parsed)))).toEqual(parsed)
      expect(unknownKeySurvivors(nextDecisionSchema, fixture)).toEqual([])
    }
    expect(nextDecisionSchema.safeParse({ kind: 'merge-mr' }).success).toBe(false)
    expect(nextDecisionSchema.safeParse({ kind: 'approve-mr' }).success).toBe(false)
    expect(
      nextDecisionSchema.safeParse({
        kind: 'wait',
        reason: 'forever',
        resumeAt: null,
        wakeSources: [],
        attemptOrdinal: 0,
      }).success,
    ).toBe(false)
  })

  test('agent envelope round-trips; unknown keys and fake platform facts are rejected everywhere', () => {
    const parsed = parseOk(agentOutcomeEnvelopeSchema, envelopeFixture)
    expect(parseOk(agentOutcomeEnvelopeSchema, JSON.parse(canonicalStringify(parsed)))).toEqual(
      parsed,
    )
    expect(unknownKeySurvivors(agentOutcomeEnvelopeSchema, envelopeFixture)).toEqual([])
    for (const fake of ['changedPaths', 'commitSha', 'pushed', 'testsPassed', 'mergeable']) {
      const mutated = { ...envelopeFixture, [fake]: 'anything' }
      expect(agentOutcomeEnvelopeSchema.safeParse(mutated).success).toBe(false)
    }
    const mismatched = structuredClone(envelopeFixture) as Record<string, unknown>
    mismatched.capabilityId = 'change.implement'
    expect(agentOutcomeEnvelopeSchema.safeParse(mismatched).success).toBe(false)
  })

  test('requirement manifest: ordering, totals and placement contract enforced', () => {
    const parsed = parseOk(requirementBundleManifestV1Schema, requirementManifestFixture)
    expect(parsed.files).toHaveLength(2)
    expect(
      unknownKeySurvivors(requirementBundleManifestV1Schema, requirementManifestFixture),
    ).toEqual([])
    const outOfOrder = structuredClone(requirementManifestFixture) as unknown as {
      files: { ordinal: number }[]
    }
    outOfOrder.files.reverse()
    expect(requirementBundleManifestV1Schema.safeParse(outOfOrder).success).toBe(false)
    const badTotals = structuredClone(requirementManifestFixture) as {
      totals: { files: number }
    }
    badTotals.totals.files = 5
    expect(requirementBundleManifestV1Schema.safeParse(badTotals).success).toBe(false)
    const traversal = structuredClone(requirementManifestFixture) as unknown as {
      files: { repositoryPlacement: { targetPath: string } | null }[]
    }
    traversal.files[1]!.repositoryPlacement = {
      targetPath: '../escape.md',
      contentPolicy: 'preserve-upload',
    } as never
    expect(requirementBundleManifestV1Schema.safeParse(traversal).success).toBe(false)
  })

  test('pipeline manifest: gate/file cross refs enforced; only explicit pass counts', () => {
    const parsed = parseOk(pipelineEvidenceManifestV1Schema, pipelineManifestFixture)
    expect(parsed.gates[0]!.status).toBe('fail')
    expect(unknownKeySurvivors(pipelineEvidenceManifestV1Schema, pipelineManifestFixture)).toEqual(
      [],
    )
    const danglingRef = structuredClone(pipelineManifestFixture) as unknown as {
      gates: { evidenceFileIds: string[] }[]
    }
    danglingRef.gates[0]!.evidenceFileIds = ['missing-file']
    expect(pipelineEvidenceManifestV1Schema.safeParse(danglingRef).success).toBe(false)
  })
})
