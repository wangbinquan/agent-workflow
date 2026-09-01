// RFC-310 PR-6 T68 —— pipeline evidence 的采集/触发/重跑编排（design §6.2/§6.5）。
//
// MR 建立后（mrClaimId 非空）且 policy 配置了 pipeline gates 时，本链接管
// 发布链落下的静止态（block / wait(mr-care-not-wired)）：
//   evidence 缺/陈旧/head 漂移 → collect-pipeline-evidence（两次 head fence）
//   required gate 无 run 且 trigger-if-missing → trigger-pipeline（effect 台账）
//   failing gate 可安全重跑 → rerun-pipeline（exact runRef + 预算 + effect 台账）
//   在跑 → 诚实 wait；全过 → 放行（readiness/PR-7）；不可重跑的失败 → 规则可
//   路由 pipeline.repair（catalog facts 可见），无规则则 typed block。
// trigger/rerun 是外发副作用：走 effects 台账（intent digest 对拍 + 悬挂行按
// idempotencyKey 幂等重放，missionDeliveryChain 同一套 claim 逻辑）；trigger
// 响应丢失由 adapter 的 adopt 语义兜底（同 key 查回已存在 run，不造第二个）。
// collect 是读，不走 effect；fence 失败丢弃快照并带 backoff 重采（不打 provider
// 风暴）。「还没跑完」永远不交给 repair Agent（anyRunning → wait）。

import type { AutomationPolicyContent } from '../domain/automationPolicy'
import type { NextDecision } from '../domain/decision'
import type { FactCellValue } from '../domain/facts'
import type { FactCell } from '../domain/factCell'
import { judgePipelineFence, projectPipelineCells } from '../domain/pipelineFacts'
import {
  pipelineEvidenceManifestV1Schema,
  type PipelineEvidenceManifestV1,
} from '../domain/pipelineManifest'
import { claimDeliveryEffect, type DeliveryChainDeps } from './missionDeliveryChain'
import type { MissionRow } from './ports/missionStore'

/** trigger/rerun 的 effect kinds：与发布链同享「链自身是结算者」的 guard 豁免。 */
export const PIPELINE_EFFECT_KINDS: ReadonlySet<string> = new Set([
  'pipeline-trigger',
  'pipeline-rerun',
])

/** fence 失败后的重采退避（30s sweep 粒度的下一拍）。 */
const FENCE_RETRY_BACKOFF_MS = 30_000

type Cells = Readonly<Record<string, FactCell<FactCellValue>>>

function knownString(cells: Cells, id: string): string | null {
  const cell = cells[id]
  return cell !== undefined && cell.state === 'known' && typeof cell.value === 'string'
    ? cell.value
    : null
}

function knownStringSet(cells: Cells, id: string): readonly string[] | null {
  const cell = cells[id]
  return cell !== undefined && cell.state === 'known' && Array.isArray(cell.value)
    ? (cell.value as readonly string[])
    : null
}

function knownBoolean(cells: Cells, id: string): boolean | null {
  const cell = cells[id]
  return cell !== undefined && cell.state === 'known' && typeof cell.value === 'boolean'
    ? cell.value
    : null
}

function knownCell(value: FactCellValue, sourceRevision: string): FactCell<FactCellValue> {
  return { state: 'known', value, sourceRevision }
}

function countsOf(cells: Cells, id: string): Record<string, number> {
  const raw = knownString(cells, id)
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** cells 里的 pinned manifest（repair 闭集 / rerun 判定共用）。 */
export function loadPipelineManifest(
  deps: Pick<DeliveryChainDeps, 'ports'>,
  cells: Cells,
): PipelineEvidenceManifestV1 | null {
  const manifestRef = knownString(cells, '__pipeline.manifestRef')
  if (manifestRef === null || deps.ports.attemptContext === undefined) return null
  const raw = deps.ports.attemptContext.load(manifestRef)
  if (raw === null) return null
  try {
    const parsed = pipelineEvidenceManifestV1Schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ redispatch

export function redispatchPipeline(
  mission: MissionRow,
  cells: Cells,
  policy: AutomationPolicyContent,
  selected: NextDecision,
  context: { readonly now: number; readonly manifest: PipelineEvidenceManifestV1 | null },
): NextDecision {
  const gates = policy.pipeline.gates
  if (gates.length === 0) return selected
  if (mission.mrClaimId === null) return selected
  const takeover =
    selected.kind === 'block' ||
    (selected.kind === 'wait' && selected.reason === 'mr-care-not-wired')
  if (!takeover) return selected

  const requiredKeys = gates.filter((g) => g.required).map((g) => g.gateKey)
  if (requiredKeys.length === 0) return selected

  // ---- 1) evidence 缺 / head 漂移 / 超龄 → collect（fence backoff 除外）。
  const mrHead = knownString(cells, '__mr.headSha')
  const pipelineHead = knownString(cells, '__pipeline.headSha')
  const collectedAtRaw = knownString(cells, '__pipeline.collectedAt')
  const collectedAt = collectedAtRaw === null ? null : Number.parseInt(collectedAtRaw, 10)
  const staleAfter = policy.pipeline.evidenceStaleAfterMs
  const stale =
    pipelineHead === null ||
    (mrHead !== null && pipelineHead !== mrHead) ||
    collectedAt === null ||
    !Number.isFinite(collectedAt) ||
    (staleAfter > 0 && context.now - collectedAt > staleAfter)
  if (stale) {
    const retryAtRaw = knownString(cells, '__pipeline.fenceRetryAt')
    const retryAt = retryAtRaw === null ? null : Number.parseInt(retryAtRaw, 10)
    if (retryAt !== null && Number.isFinite(retryAt) && context.now < retryAt) {
      return {
        kind: 'wait',
        reason: 'pipeline-fence-backoff',
        resumeAt: new Date(retryAt).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
        wakeSources: ['webhook', 'timer', 'manual'],
        attemptOrdinal: 0,
      }
    }
    return { kind: 'collect-pipeline-evidence', gateKeys: requiredKeys }
  }

  // ---- 2) 已有当前 head 的 evidence：按投影 facts 分派。
  if (knownBoolean(cells, 'pipeline.requiredGatesAllPass') === true) return selected
  if (knownBoolean(cells, 'pipeline.anyRunning') === true) {
    return {
      kind: 'wait',
      reason: 'pipeline-running',
      resumeAt: null,
      wakeSources: ['webhook', 'manual'],
      attemptOrdinal: 0,
    }
  }
  const missing = knownStringSet(cells, 'pipeline.missingRequiredGateKeys') ?? []
  if (missing.length > 0) {
    const triggerCounts = countsOf(cells, '__pipeline.triggerCounts')
    const triggerable = missing.filter((key) => {
      const cfg = gates.find((g) => g.gateKey === key)
      return (
        cfg !== undefined &&
        cfg.missingRunDisposition === 'trigger-if-missing' &&
        (triggerCounts[key] ?? 0) < cfg.maxTriggers
      )
    })
    if (triggerable.length > 0) return { kind: 'trigger-pipeline', gateKeys: triggerable }
    // observe-only（或触发预算耗尽）：按 deadline 语义等外部世界，不谎报故障。
    return {
      kind: 'wait',
      reason: 'pipeline-gate-missing',
      resumeAt: null,
      wakeSources: ['webhook', 'manual'],
      attemptOrdinal: 0,
    }
  }
  const failing = knownStringSet(cells, 'pipeline.failingRequiredGateKeys') ?? []
  if (failing.length > 0 && context.manifest !== null) {
    const rerunCounts = countsOf(cells, '__pipeline.rerunCounts')
    for (const key of failing) {
      const gate = context.manifest.gates.find((g) => g.gateKey === key)
      const cfg = gates.find((g) => g.gateKey === key)
      if (gate === undefined || cfg === undefined) continue
      const categoriesRerunnable =
        gate.failureCategories.length > 0 &&
        gate.failureCategories.every((c) => cfg.rerunnableCategories.includes(c))
      if (
        gate.retryability === 'safe' &&
        categoriesRerunnable &&
        (rerunCounts[key] ?? 0) < cfg.maxReruns
      ) {
        return { kind: 'rerun-pipeline', gateKey: key, runRef: gate.runRef }
      }
    }
    // 不可安全重跑：规则可按 catalog facts 路由 pipeline.repair；无规则时的
    // block 改写为可读原因（unknown retryability / 非白名单类别 / 预算耗尽）。
    if (selected.kind === 'block') {
      return { kind: 'block', reason: `pipeline-gates-failing:${[...failing].sort().join(',')}` }
    }
  }
  return selected
}

// -------------------------------------------------------- adapter 绑定解析

async function pipelineAdapterBindingRef(
  deps: DeliveryChainDeps,
  lookup: {
    getEmployeeRevisionContent(id: string, revision: number): Promise<unknown | null>
  },
  mission: MissionRow,
): Promise<string | null> {
  if (mission.employeeId === null || mission.employeeRevision === null) return null
  const content = (await lookup.getEmployeeRevisionContent(
    mission.employeeId,
    mission.employeeRevision,
  )) as { pipelineProviders?: readonly { readonly adapterRef?: unknown }[] } | null
  const ref = content?.pipelineProviders?.[0]?.adapterRef
  return typeof ref === 'string' ? ref : null
}

// ----------------------------------------------------------------- arm 1/3：
// collect-pipeline-evidence —— 两次 head fence + safe import + facts 投影。

export async function handleCollectPipelineEvidence(
  deps: DeliveryChainDeps,
  lookup: { getEmployeeRevisionContent(id: string, revision: number): Promise<unknown | null> },
  mission: MissionRow,
  cells: Cells,
  gateKeys: readonly string[],
): Promise<'collected' | 'blocked'> {
  const ports = deps.ports
  if (ports.pipelineEvidence === undefined || ports.pipelineImport === undefined) {
    await deps.block(mission.id, 'pipeline-port-missing:evidence', null)
    return 'blocked'
  }
  if (ports.mrEffects === undefined) {
    await deps.block(mission.id, 'pipeline-port-missing:mrEffects', null)
    return 'blocked'
  }
  const mrRef = knownString(cells, '__mr.ref')
  if (mrRef === null) {
    await deps.block(mission.id, 'pipeline-mr-ref-missing', null)
    return 'blocked'
  }
  const adapterBindingRef = await pipelineAdapterBindingRef(deps, lookup, mission)
  if (adapterBindingRef === null) {
    await deps.block(mission.id, 'pipeline-adapter-unbound', null)
    return 'blocked'
  }

  // fence 前读（H1/T1）：mission 侧当前 MR 真相；target 无 sha 读面时以分支名
  // 对拍「target 引用未变」（PR-7 T72 的 MR facts collector 落地后升级为 sha）。
  const before = await ports.mrEffects.observe(mission.repositoryId, mrRef)
  if (!before.ok) {
    await deps.block(mission.id, before.code, before.detail)
    return 'blocked'
  }
  const h1 = before.observation.sourceSha
  const t1 = before.observation.targetBranch ?? ''
  if (h1 === null) {
    await deps.block(mission.id, 'pipeline-mr-head-unknown', mrRef)
    return 'blocked'
  }

  const collected = await ports.pipelineEvidence.collect({
    adapterBindingRef,
    headSha: h1,
    targetSha: t1,
    gateKeys,
  })
  if (!collected.ok) {
    await deps.block(mission.id, collected.failure.code, collected.failure.remediation)
    return 'blocked'
  }

  try {
    // fence 后读（H2/T2）+ 判定：漂移 ⇒ 丢弃快照 + backoff 重采（§6.2）。
    const after = await ports.mrEffects.observe(mission.repositoryId, mrRef)
    if (!after.ok) {
      await deps.block(mission.id, after.code, after.detail)
      return 'blocked'
    }
    // provider 无 head 绑定（null）⇒ completeness 视为 partial：fence 跳过
    // providerHead 对拍（facts 面 requiredGatesAllPass 恒 false 兜底不判 pass）。
    const effectiveCompleteness =
      collected.envelope.providerHeadSha === null ? 'partial' : collected.envelope.completeness
    const fence = judgePipelineFence({
      h1,
      t1,
      h2: after.observation.sourceSha ?? '',
      t2: after.observation.targetBranch ?? '',
      providerHeadSha: collected.envelope.providerHeadSha ?? '',
      expectedHeadSha: h1,
      completeness: effectiveCompleteness,
    })
    const now = deps.now()
    if (!fence.ok) {
      await deps.persistCells(
        mission.id,
        { '__pipeline.fenceRetryAt': knownCell(String(now + FENCE_RETRY_BACKOFF_MS), 'fence') },
        { kind: 'pipeline-fence-discard', code: fence.code },
      )
      return 'collected' // 快照已丢弃；backoff 后 sweep 重采，不是故障。
    }

    // target 的 sha 读面属 PR-7 T72（MR facts collector）：当前 t1 是分支名，
    // 只用于 fence 的「引用未变」对拍；manifest.targetSha 需要 40hex，缺真值
    // 时以显式全零哨兵占位（不伪造）。
    const targetShaFallback = /^[0-9a-f]{40}$/.test(t1) ? t1 : '0'.repeat(40)
    const imported = await ports.pipelineImport.import({
      stagedRoot: collected.stagedRoot,
      envelope: collected.envelope,
      expectedHeadSha: h1,
      expectedTargetSha: targetShaFallback,
    })
    if (!imported.ok) {
      await deps.block(mission.id, imported.code, imported.detail)
      return 'blocked'
    }
    const manifest = pipelineEvidenceManifestV1Schema.parse(JSON.parse(imported.manifestJson))
    const requiredKeys = gateKeys
    const projected = projectPipelineCells(manifest, requiredKeys, manifest.bundleId)
    await deps.persistCells(
      mission.id,
      {
        ...projected,
        '__pipeline.manifestRef': knownCell(imported.manifestRef, manifest.bundleId),
        '__pipeline.collectedAt': knownCell(String(now), manifest.bundleId),
        '__pipeline.fenceRetryAt': knownCell('0', manifest.bundleId),
      },
      { kind: 'pipeline-collect', bundleId: manifest.bundleId, headSha: manifest.headSha },
    )
    return 'collected'
  } finally {
    collected.cleanup()
  }
}

// ----------------------------------------------------------------- arm 2/3：
// trigger-pipeline —— effect 台账 + adapter 幂等（响应丢失由 adopt 兜底）。

export async function handleTriggerPipeline(
  deps: DeliveryChainDeps,
  lookup: { getEmployeeRevisionContent(id: string, revision: number): Promise<unknown | null> },
  mission: MissionRow,
  cells: Cells,
  gateKeys: readonly string[],
): Promise<'collected' | 'blocked'> {
  const ports = deps.ports
  if (ports.pipelineEvidence === undefined) {
    await deps.block(mission.id, 'pipeline-port-missing:evidence', null)
    return 'blocked'
  }
  const adapterBindingRef = await pipelineAdapterBindingRef(deps, lookup, mission)
  if (adapterBindingRef === null) {
    await deps.block(mission.id, 'pipeline-adapter-unbound', null)
    return 'blocked'
  }
  const headSha = knownString(cells, '__pipeline.headSha') ?? knownString(cells, '__mr.headSha')
  if (headSha === null) {
    await deps.block(mission.id, 'pipeline-mr-head-unknown', null)
    return 'blocked'
  }
  const sortedKeys = [...gateKeys].sort()
  const idempotencyKey = `ptrig:${mission.id}:${headSha}:${sortedKeys.join(',')}`
  const claim = await claimDeliveryEffect(deps, mission, {
    actionRunId: null,
    effectKind: 'pipeline-trigger',
    idempotencyKey,
    intent: { kind: 'pipeline-trigger', missionId: mission.id, headSha, gateKeys: sortedKeys },
  })
  if (claim.disposition === 'refused') {
    await deps.block(mission.id, claim.code, null)
    return 'blocked'
  }
  if (claim.disposition === 'execute') {
    const out = await ports.pipelineEvidence.trigger({
      adapterBindingRef,
      headSha,
      gateKeys: sortedKeys,
      idempotencyKey,
    })
    const now = deps.now()
    if (!out.ok) {
      await deps.store.failEffect(
        claim.effectId,
        JSON.stringify({ code: out.failure.code, detail: out.failure.remediation }),
        now,
      )
      await deps.block(mission.id, out.failure.code, out.failure.remediation)
      return 'blocked'
    }
    await deps.store.confirmEffect(claim.effectId, out.runRef, now)
  }
  const counts = countsOf(cells, '__pipeline.triggerCounts')
  for (const key of sortedKeys) counts[key] = (counts[key] ?? 0) + 1
  await deps.persistCells(
    mission.id,
    {
      '__pipeline.triggerCounts': knownCell(JSON.stringify(counts), idempotencyKey),
      // 触发后 evidence 立即视为陈旧：下一轮强制 recollect 采新 run 状态。
      '__pipeline.collectedAt': knownCell('0', idempotencyKey),
    },
    { kind: 'pipeline-trigger', gateKeys: sortedKeys },
  )
  return 'collected'
}

// ----------------------------------------------------------------- arm 3/3：
// rerun-pipeline —— exact runRef + gate 预算 + effect 台账。

export async function handleRerunPipeline(
  deps: DeliveryChainDeps,
  lookup: { getEmployeeRevisionContent(id: string, revision: number): Promise<unknown | null> },
  mission: MissionRow,
  cells: Cells,
  input: { readonly gateKey: string; readonly runRef: string },
): Promise<'collected' | 'blocked'> {
  const ports = deps.ports
  if (ports.pipelineEvidence === undefined) {
    await deps.block(mission.id, 'pipeline-port-missing:evidence', null)
    return 'blocked'
  }
  const adapterBindingRef = await pipelineAdapterBindingRef(deps, lookup, mission)
  if (adapterBindingRef === null) {
    await deps.block(mission.id, 'pipeline-adapter-unbound', null)
    return 'blocked'
  }
  const headSha = knownString(cells, '__pipeline.headSha')
  if (headSha === null) {
    await deps.block(mission.id, 'pipeline-mr-head-unknown', null)
    return 'blocked'
  }
  const idempotencyKey = `prerun:${mission.id}:${input.runRef}:${input.gateKey}`
  const claim = await claimDeliveryEffect(deps, mission, {
    actionRunId: null,
    effectKind: 'pipeline-rerun',
    idempotencyKey,
    intent: {
      kind: 'pipeline-rerun',
      missionId: mission.id,
      runRef: input.runRef,
      gateKey: input.gateKey,
      headSha,
    },
  })
  if (claim.disposition === 'refused') {
    await deps.block(mission.id, claim.code, null)
    return 'blocked'
  }
  if (claim.disposition === 'execute') {
    const out = await ports.pipelineEvidence.rerun({
      adapterBindingRef,
      runRef: input.runRef,
      gateKey: input.gateKey,
      headSha,
      idempotencyKey,
    })
    const now = deps.now()
    if (!out.ok) {
      await deps.store.failEffect(
        claim.effectId,
        JSON.stringify({ code: out.failure.code, detail: out.failure.remediation }),
        now,
      )
      await deps.block(mission.id, out.failure.code, out.failure.remediation)
      return 'blocked'
    }
    await deps.store.confirmEffect(claim.effectId, out.runRef, now)
  }
  const counts = countsOf(cells, '__pipeline.rerunCounts')
  counts[input.gateKey] = (counts[input.gateKey] ?? 0) + 1
  await deps.persistCells(
    mission.id,
    {
      '__pipeline.rerunCounts': knownCell(JSON.stringify(counts), idempotencyKey),
      '__pipeline.collectedAt': knownCell('0', idempotencyKey),
    },
    { kind: 'pipeline-rerun', gateKey: input.gateKey, runRef: input.runRef },
  )
  return 'collected'
}
