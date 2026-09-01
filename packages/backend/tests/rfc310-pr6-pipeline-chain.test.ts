// RFC-310 PR-6 T68 —— pipeline evidence 编排链（redispatch + collect/trigger/rerun）。
//
// 锁：①redispatch 只在「MR 已建 + policy 配 gates + 静止态」接管；进度全绑
// head（MR head 漂移/超龄/触发后强制 recollect）；②两次 head fence：漂移丢弃
// 快照 + backoff 重采（不 block、不打 provider 风暴）；③trigger/rerun 走 effect
// 台账（idempotencyKey + intent digest），预算封顶后诚实 wait/block；④「在跑」
// 永远 wait，不交 repair；⑤全过放行（readiness/PR-7 的输入）。多轮推进收单
// test 防 --randomize。

import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'

import {
  PIPELINE_EFFECT_KINDS,
  redispatchPipeline,
} from '../src/modules/development-automation/application/pipelineEvidenceChain'
import { runMissionReconcile } from '../src/modules/development-automation/application/missionReconciler'
import type { MissionRow } from '../src/modules/development-automation/application/ports/missionStore'
import type {
  MrEffectsPort,
  PipelineCollectEnvelopeDto,
  PipelineEvidencePort,
  ReconcilerPorts,
} from '../src/modules/development-automation/application/ports/reconcilerPorts'
import {
  defaultAutomationPolicyContent,
  type AutomationPolicyContent,
} from '../src/modules/development-automation/domain/automationPolicy'
import {
  canonicalDigest,
  canonicalStringify,
} from '../src/modules/development-automation/domain/canonicalJson'
import type { NextDecision } from '../src/modules/development-automation/domain/decision'
import type { FactCellValue } from '../src/modules/development-automation/domain/facts'
import type { FactCell } from '../src/modules/development-automation/domain/factCell'
import type { PipelineEvidenceManifestV1 } from '../src/modules/development-automation/domain/pipelineManifest'
import {
  createAutomationPolicy,
  publishAutomationPolicy,
} from '../src/modules/development-automation/infrastructure/sqliteDigitalEmployeeStore'
import { createAttemptContextStore } from '../src/modules/development-automation/infrastructure/attemptSupport'
import { buildPr3Fixture, type Pr3Fixture } from './helpers/rfc310Pr3Fixture'

setDefaultTimeout(120_000)

const MR_HEAD = 'ad'.repeat(20)
const TARGET = 'main'

function cell(value: FactCellValue): FactCell<FactCellValue> {
  return { state: 'known', value, sourceRevision: 'test' }
}

function pipelinePolicy(
  overrides: Partial<AutomationPolicyContent['pipeline']['gates'][number]> = {},
): AutomationPolicyContent {
  const base = defaultAutomationPolicyContent()
  return {
    ...base,
    actionPriority: {
      rules: [
        {
          ruleId: 'never',
          when: [{ kind: 'boolean-is', fact: 'requirement.bundleComplete', value: false }],
          capabilityId: 'change.implement',
        },
      ],
    },
    pipeline: {
      evidenceStaleAfterMs: 60 * 60 * 1000,
      gates: [
        {
          gateKey: 'unit',
          required: true,
          missingRunDisposition: 'trigger-if-missing',
          rerunnableCategories: ['infrastructure-transient'],
          maxReruns: 1,
          maxTriggers: 1,
          ...overrides,
        },
      ],
    },
  }
}

const WAIT_MR_CARE: NextDecision = {
  kind: 'wait',
  reason: 'mr-care-not-wired',
  resumeAt: null,
  wakeSources: ['webhook', 'manual'],
  attemptOrdinal: 0,
}

function watchingCells(extra: Record<string, FactCell<FactCellValue>> = {}) {
  return {
    'requirement.bundleComplete': cell(true),
    '__mr.ref': cell('7'),
    '__mr.headSha': cell(MR_HEAD),
    // PR-7 care 链在 pipeline 链之前保 MR facts 新鲜：测试聚焦 pipeline 面，
    // 预置新鲜标记让 care 放行（care 自身的采集链由 pr7 测试锁）。
    '__mr.factsCollectedAt': cell(String(Date.now() + 60 * 60 * 1000)),
    ...extra,
  }
}

function manifestOf(
  gates: readonly Partial<PipelineEvidenceManifestV1['gates'][number]>[],
): PipelineEvidenceManifestV1 {
  const core = {
    schemaVersion: 1 as const,
    bundleId: 'bundle-1',
    providerKey: 'mock',
    headSha: MR_HEAD,
    targetSha: 'be'.repeat(20),
    completeness: 'complete' as const,
    gates: gates.map((g) => ({
      gateKey: 'unit',
      required: true,
      status: 'fail' as const,
      runRef: 'run-1',
      attempt: 1,
      finishedAt: null,
      retryability: 'safe' as const,
      failureCategories: ['infrastructure-transient'],
      evidenceFileIds: [],
      ...g,
    })),
    files: [],
    totals: { files: 0, bytes: 0 },
    redaction: 'complete' as const,
  }
  return { ...core, manifestDigest: canonicalDigest(core) }
}

describe('rfc310 pr6 — pipeline redispatch (pure)', () => {
  const mission = { mrClaimId: 'claim-1' } as MissionRow
  const policy = pipelinePolicy()
  const now = 1_000_000
  const ctx = (manifest: PipelineEvidenceManifestV1 | null = null) => ({ now, manifest })

  test('takeover conditions, staleness, fence backoff, running/missing/failing dispatch', () => {
    // 无 claim / 无 gates / 非静止态 → 不接管。
    expect(
      redispatchPipeline(
        { mrClaimId: null } as MissionRow,
        watchingCells(),
        policy,
        WAIT_MR_CARE,
        ctx(),
      ),
    ).toEqual(WAIT_MR_CARE)
    expect(
      redispatchPipeline(
        mission,
        watchingCells(),
        defaultAutomationPolicyContent(),
        WAIT_MR_CARE,
        ctx(),
      ),
    ).toEqual(WAIT_MR_CARE)
    const action: NextDecision = {
      kind: 'run-agent-action',
      capabilityId: 'pipeline.repair',
      templateRef: 't@1',
      workSetRef: 'none',
    }
    expect(redispatchPipeline(mission, watchingCells(), policy, action, ctx())).toEqual(action)

    // evidence 缺 → collect。
    expect(redispatchPipeline(mission, watchingCells(), policy, WAIT_MR_CARE, ctx())).toEqual({
      kind: 'collect-pipeline-evidence',
      gateKeys: ['unit'],
    })
    // head 漂移 → collect（旧 evidence 自动失效）。
    expect(
      redispatchPipeline(
        mission,
        watchingCells({
          '__pipeline.headSha': cell('99'.repeat(20)),
          '__pipeline.collectedAt': cell(String(now)),
        }),
        policy,
        WAIT_MR_CARE,
        ctx(),
      ),
    ).toMatchObject({ kind: 'collect-pipeline-evidence' })
    // 超龄 → collect。
    expect(
      redispatchPipeline(
        mission,
        watchingCells({
          '__pipeline.headSha': cell(MR_HEAD),
          '__pipeline.collectedAt': cell(String(now - 2 * 60 * 60 * 1000)),
        }),
        policy,
        WAIT_MR_CARE,
        ctx(),
      ),
    ).toMatchObject({ kind: 'collect-pipeline-evidence' })
    // fence backoff 未到 → 诚实 wait 不打 provider。
    expect(
      redispatchPipeline(
        mission,
        watchingCells({ '__pipeline.fenceRetryAt': cell(String(now + 10_000)) }),
        policy,
        WAIT_MR_CARE,
        ctx(),
      ),
    ).toMatchObject({ kind: 'wait', reason: 'pipeline-fence-backoff' })

    const fresh = {
      '__pipeline.headSha': cell(MR_HEAD),
      '__pipeline.collectedAt': cell(String(now)),
    }
    // 在跑 → wait（绝不交 repair）。
    expect(
      redispatchPipeline(
        mission,
        watchingCells({ ...fresh, 'pipeline.anyRunning': cell(true) }),
        policy,
        WAIT_MR_CARE,
        ctx(),
      ),
    ).toMatchObject({ kind: 'wait', reason: 'pipeline-running' })
    // 全过 → 放行原静止态。
    expect(
      redispatchPipeline(
        mission,
        watchingCells({
          ...fresh,
          'pipeline.requiredGatesAllPass': cell(true),
          'pipeline.anyRunning': cell(false),
        }),
        policy,
        WAIT_MR_CARE,
        ctx(),
      ),
    ).toEqual(WAIT_MR_CARE)
    // missing + trigger-if-missing → trigger；预算耗尽 → wait。
    const missingCells = watchingCells({
      ...fresh,
      'pipeline.anyRunning': cell(false),
      'pipeline.requiredGatesAllPass': cell(false),
      'pipeline.missingRequiredGateKeys': cell(['unit']),
      'pipeline.failingRequiredGateKeys': cell([]),
    })
    expect(redispatchPipeline(mission, missingCells, policy, WAIT_MR_CARE, ctx())).toEqual({
      kind: 'trigger-pipeline',
      gateKeys: ['unit'],
    })
    expect(
      redispatchPipeline(
        mission,
        { ...missingCells, '__pipeline.triggerCounts': cell('{"unit":1}') },
        policy,
        WAIT_MR_CARE,
        ctx(),
      ),
    ).toMatchObject({ kind: 'wait', reason: 'pipeline-gate-missing' })
    // observe-only → wait（不触发）。
    expect(
      redispatchPipeline(
        mission,
        missingCells,
        pipelinePolicy({ missingRunDisposition: 'observe-only' }),
        WAIT_MR_CARE,
        ctx(),
      ),
    ).toMatchObject({ kind: 'wait', reason: 'pipeline-gate-missing' })

    // failing + safe + 类别在白名单 → rerun exact runRef；否则 block 改写 reason。
    const failingCells = watchingCells({
      ...fresh,
      'pipeline.anyRunning': cell(false),
      'pipeline.requiredGatesAllPass': cell(false),
      'pipeline.missingRequiredGateKeys': cell([]),
      'pipeline.failingRequiredGateKeys': cell(['unit']),
    })
    expect(
      redispatchPipeline(mission, failingCells, policy, WAIT_MR_CARE, ctx(manifestOf([{}]))),
    ).toEqual({ kind: 'rerun-pipeline', gateKey: 'unit', runRef: 'run-1' })
    // unsafe retryability → 不 rerun；block 静止态改写为可读 reason。
    expect(
      redispatchPipeline(
        mission,
        failingCells,
        policy,
        { kind: 'block', reason: 'no-rule-matched' },
        ctx(manifestOf([{ retryability: 'unsafe' }])),
      ),
    ).toEqual({ kind: 'block', reason: 'pipeline-gates-failing:unit' })
    // 类别出白名单 → 不 rerun。
    expect(
      redispatchPipeline(
        mission,
        failingCells,
        policy,
        WAIT_MR_CARE,
        ctx(manifestOf([{ failureCategories: ['compile'] }])),
      ),
    ).toEqual(WAIT_MR_CARE)
    // rerun 预算耗尽 → 不 rerun。
    expect(
      redispatchPipeline(
        mission,
        { ...failingCells, '__pipeline.rerunCounts': cell('{"unit":1}') },
        policy,
        WAIT_MR_CARE,
        ctx(manifestOf([{}])),
      ),
    ).toEqual(WAIT_MR_CARE)
  })
})

// ---------------------------------------------------- 集成：真 reconcile 多轮

async function seedWatchingMission(fx: Pr3Fixture, policyId: string): Promise<string> {
  const now = Date.now()
  const missionId = ulid()
  fx.store.createMission({
    id: missionId,
    revision: 0,
    epoch: 0,
    status: 'watching',
    automationMode: 'active',
    transitionFence: 'none',
    repositoryId: 'repo-pc',
    sourceKind: 'direct',
    sourceContentDigest: 'a'.repeat(64),
    requestedSourceKey: null,
    externalId: null,
    resolvedSourceKey: null,
    resolvedAdapterId: null,
    resolvedAdapterRevision: null,
    deliveryKind: 'create-merge-request',
    deliveryTargetRef: null,
    deliverySourceBranch: 'aw/mission/x',
    adoptedMrRef: null,
    assignmentId: null,
    employeeId: fx.employeeId,
    employeeRevision: 1,
    policyId,
    policyRevision: 1,
    requirementBundleRef: null,
    repositoryFactsRef: null,
    uploadPlanRef: null,
    uploadPlacementRef: null,
    uploadPublicationRef: null,
    mrClaimId: 'claim-pc',
    currentActionRunId: null,
    readinessJson: null,
    blockCode: null,
    blockDetail: null,
    terminalKind: null,
    terminalUploadFulfillment: null,
    terminalAt: null,
    launchIdempotencyKey: `idem-${missionId}`,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  })
  const cells = watchingCells()
  const id = ulid()
  fx.store.insertFactSnapshot({
    id,
    missionId,
    missionRevision: 0,
    capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
    cellsJson: canonicalStringify(cells),
    refsJson: '{}',
    digest: canonicalDigest(cells),
    now,
  })
  const mission = fx.store.getMission(missionId)!
  fx.store.occUpdate(missionId, mission.revision, mission.epoch, { requirementBundleRef: id })
  return missionId
}

function fakeObserve(): MrEffectsPort {
  return {
    async reply() {
      return { ok: true, noteRef: 'note-1' }
    },
    async observe() {
      return {
        ok: true,
        observation: {
          mrRef: '7',
          state: 'opened',
          sourceSha: MR_HEAD,
          targetBranch: TARGET,
          webUrl: null,
        },
      }
    },
    async ensure() {
      throw new Error('not used')
    },
  }
}

function collectEnvelope(gates: PipelineCollectEnvelopeDto['gates']): PipelineCollectEnvelopeDto {
  return {
    providerKey: 'mock',
    providerHeadSha: MR_HEAD,
    targetSha: null,
    completeness: 'complete',
    gates,
    redaction: 'complete',
  }
}

function fakePipeline(script: {
  readonly envelopes: PipelineCollectEnvelopeDto[]
  readonly triggers?: unknown[]
  readonly reruns?: unknown[]
}): PipelineEvidencePort {
  return {
    async collect() {
      const envelope = script.envelopes.shift()
      if (envelope === undefined) throw new Error('unexpected collect')
      const parent = mkdtempSync(join(tmpdir(), 'rfc310-pc-sink-'))
      for (const gate of envelope.gates) {
        for (const f of gate.files) {
          const abs = join(parent, f.relativePath)
          mkdirSync(join(abs, '..'), { recursive: true })
          writeFileSync(abs, `log for ${gate.gateKey}\n`)
        }
      }
      return {
        ok: true,
        envelope,
        stagedRoot: parent,
        outputBudget: {
          maxFiles: 100,
          maxFileBytes: 8 * 1024 * 1024,
          maxTotalBytes: 32 * 1024 * 1024,
        },
        cleanup: () => rmSync(parent, { recursive: true, force: true }),
      }
    },
    async trigger(input) {
      script.triggers?.push(input)
      return { ok: true, runRef: 'run-new', providerReceiptRef: 'rc-1', adopted: false }
    },
    async rerun(input) {
      script.reruns?.push(input)
      return { ok: true, runRef: input.runRef, attempt: 2, providerReceiptRef: 'rc-2' }
    },
  }
}

/** fixture 员工无 pipeline provider 绑定：lookup 包一层注入（fake port 不消费 ref 本身）。 */
function withPipelineProvider<
  T extends {
    lookup: { getEmployeeRevisionContent(id: string, revision: number): Promise<unknown | null> }
  },
>(deps: T): T {
  return {
    ...deps,
    lookup: {
      ...deps.lookup,
      getEmployeeRevisionContent: async (id: string, revision: number) => {
        const content = await deps.lookup.getEmployeeRevisionContent(id, revision)
        if (content === null || typeof content !== 'object') return content
        return {
          ...content,
          pipelineProviders: [{ providerKey: 'mock', adapterRef: 'adapter-x@1' }],
        }
      },
    },
  }
}

describe('rfc310 pr6 — pipeline chain through reconcile rounds', () => {
  async function fixtureWithPipelinePolicy(): Promise<{ fx: Pr3Fixture; policyId: string }> {
    const fx = await buildPr3Fixture()
    const policy = await createAutomationPolicy(fx.db, {
      name: 'pol-pr6-chain',
      ownerUserId: 'admin',
      draft: pipelinePolicy(),
    })
    await publishAutomationPolicy(fx.db, { id: policy.id, publishedBy: 'admin' })
    return { fx, policyId: policy.id }
  }

  test('collect projects facts; missing gate triggers once (effect ledger); recollect passes; all-pass releases', async () => {
    const { fx, policyId } = await fixtureWithPipelinePolicy()
    const missionId = await seedWatchingMission(fx, policyId)
    const triggers: unknown[] = []
    const pipeline = fakePipeline({
      envelopes: [
        // 轮 1 collect：required gate 无 run。
        collectEnvelope([]),
        // 轮 3 collect（触发后强制 recollect）：全过。
        collectEnvelope([
          {
            gateKey: 'unit',
            required: true,
            status: 'pass',
            runRef: 'run-new',
            attempt: 1,
            finishedAt: '2026-08-18T00:00:00+00:00',
            retryability: 'safe',
            failureCategories: [],
            files: [{ fileId: 'log-1', relativePath: 'logs/unit/run.log' }],
          },
        ]),
      ],
      triggers,
    })
    const ports: Omit<ReconcilerPorts, 'requirementMaterialize'> = {
      attemptContext: createAttemptContextStore(fx.evidence),
      mrEffects: fakeObserve(),
      pipelineEvidence: pipeline,
      pipelineImport: {
        import: async (input) => {
          const { importPipelineEvidence } =
            await import('../src/modules/development-automation/infrastructure/pipelineEvidenceImport')
          const out = await importPipelineEvidence(
            { evidence: fx.evidence },
            {
              ...input,
              budget: { maxFiles: 100, maxFileBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 },
            },
          )
          if (!out.ok) return out
          return {
            ok: true,
            manifestJson: canonicalStringify(out.manifest),
            manifestRef: out.manifestRef,
          }
        },
      },
    }
    const deps = withPipelineProvider(fx.deps(ports))

    // 轮 1：collect → facts 落 cells（missing=['unit']）。
    const r1 = await runMissionReconcile(deps, missionId)
    expect(r1).toMatchObject({ kind: 'decided', handled: 'collected' })
    expect((r1 as { selected: NextDecision }).selected).toMatchObject({
      kind: 'collect-pipeline-evidence',
    })
    let cells = (await fx.snapshots.getCells(
      fx.store.getMission(missionId)!.requirementBundleRef!,
    ))!
    expect(cells['pipeline.missingRequiredGateKeys']).toMatchObject({ value: ['unit'] })
    expect(cells['__pipeline.manifestRef']).toMatchObject({ state: 'known' })

    // 轮 2：trigger（effect 台账 + 计数 + 强制 recollect）。
    const r2 = await runMissionReconcile(deps, missionId)
    expect((r2 as { selected: NextDecision }).selected).toEqual({
      kind: 'trigger-pipeline',
      gateKeys: ['unit'],
    })
    expect(triggers).toHaveLength(1)
    expect(fx.store.listUnsettledEffects(missionId)).toEqual([])
    cells = (await fx.snapshots.getCells(fx.store.getMission(missionId)!.requirementBundleRef!))!
    expect(cells['__pipeline.triggerCounts']).toMatchObject({ value: '{"unit":1}' })

    // 轮 3：recollect → 全过。
    const r3 = await runMissionReconcile(deps, missionId)
    expect((r3 as { selected: NextDecision }).selected).toMatchObject({
      kind: 'collect-pipeline-evidence',
    })
    cells = (await fx.snapshots.getCells(fx.store.getMission(missionId)!.requirementBundleRef!))!
    expect(cells['pipeline.requiredGatesAllPass']).toMatchObject({ value: true })

    // 轮 4：全过 → PR-7 care 链推进 readiness（machine holds 清零）。
    const r4 = await runMissionReconcile(deps, missionId)
    expect((r4 as { selected: NextDecision }).selected).toMatchObject({
      kind: 'publish-readiness',
    })
    expect(PIPELINE_EFFECT_KINDS.has('pipeline-trigger')).toBe(true)
  })

  test('head race between the two fence reads discards the snapshot and backs off, never blocks', async () => {
    const { fx, policyId } = await fixtureWithPipelinePolicy()
    const missionId = await seedWatchingMission(fx, policyId)
    let observeCount = 0
    const racingMr: MrEffectsPort = {
      async reply() {
        return { ok: true, noteRef: 'note-1' }
      },
      async observe() {
        observeCount += 1
        return {
          ok: true,
          observation: {
            mrRef: '7',
            state: 'opened',
            // 第二次读 head 变了（人推了新 commit）。
            sourceSha: observeCount >= 2 ? 'ff'.repeat(20) : MR_HEAD,
            targetBranch: TARGET,
            webUrl: null,
          },
        }
      },
      async ensure() {
        throw new Error('not used')
      },
    }
    const deps = withPipelineProvider(
      fx.deps({
        attemptContext: createAttemptContextStore(fx.evidence),
        mrEffects: racingMr,
        pipelineEvidence: fakePipeline({ envelopes: [collectEnvelope([])] }),
        pipelineImport: {
          import: async () => {
            throw new Error('must not import a discarded snapshot')
          },
        },
      }),
    )
    const r = await runMissionReconcile(deps, missionId)
    expect(r).toMatchObject({ kind: 'decided', handled: 'collected' })
    const mission = fx.store.getMission(missionId)!
    expect(mission.status).toBe('watching') // 不 block
    const cells = (await fx.snapshots.getCells(mission.requirementBundleRef!))!
    expect(cells['__pipeline.manifestRef']).toBeUndefined()
    expect(
      Number(String((cells['__pipeline.fenceRetryAt'] as { value: unknown }).value)),
    ).toBeGreaterThan(Date.now() - 60_000)
    // backoff 生效：下一轮不再立即 collect。
    const r2 = await runMissionReconcile(deps, missionId)
    expect((r2 as { selected: NextDecision }).selected).toMatchObject({
      kind: 'wait',
      reason: 'pipeline-fence-backoff',
    })
  })
})
