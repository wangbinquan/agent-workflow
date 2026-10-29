import { estimateEpochCapacity } from '../../domain/epochSwitch/capacity'
import { epochDeploymentCapabilities } from '@/modules/system-operations/domain/epochSwitch/deploymentCapabilities'
import { persistenceDialect } from '@/platform/persistence/nativeDialect'
import { epochArtifactPath } from '@/platform/persistence/migration/run/paths'
import { contentManifestDigest } from '@/platform/content/inventory/manifest'
import type { ConversionSummary } from '@/platform/persistence/migration/conversion/sink'
import {
  CONVERTER_VERSION,
  type ConversionPlanSection,
} from '@/platform/persistence/migration/conversion/plan'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  createBootUpgradeFacts,
  type BootUpgradeFacts,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { executionClass } from '@/platform/persistence/migration/conversion/lookups/keys'
import {
  OperatorDecisionSchema,
  type ConversionBlock,
  type OperatorDecision,
} from '@/platform/persistence/migration/conversion/types'
import type {
  ConversionRunRequest,
  EpochSourceLocation,
  FrozenSourceHandle,
  FreezeContentManifest,
  SwitchBackupReceipt,
} from '@/platform/persistence/migration/run/types'
import type { EpochSwitchApplication } from '../../public/commands'
import type { EpochSwitchPlanInput, EpochSwitchPlanView } from '../../public/types'
import {
  createEpochSwitchJournal,
  parseEpochSwitchJournal,
  canonicalOperatorDecisions,
  EpochSwitchError,
  type EpochSwitchJournal,
  type EpochSwitchInputs,
} from '../../domain/epochSwitch/model'
import {
  assertEpochSwitchSupported,
  environmentProfile,
} from '../../domain/epochSwitch/supportMatrix'
import { epochRunIdentity, phaseIndex } from '../../domain/epochSwitch/transitions'
import {
  buildEpochPlan,
  renderEpochPlan,
  epochPlanGuidance,
} from '../../domain/epochSwitch/planDocument'
import {
  parseMigrationPlanDocument,
  type MigrationPlanDocument,
  type RestoreFileChange,
} from '../../domain/epochSwitch/documents'
import {
  pointerEvidence,
  readEpochPlan,
  runArtifact,
  sourcePort,
  sourceRequest,
  type EpochSwitchDependencies,
  type EpochSwitchSession,
  type EpochSwitchWithdrawalInput,
  epochContentRoot,
  epochLocalPath,
  relocateEpochPath,
} from './session'

export async function discoverEpochOperation(
  deps: EpochSwitchDependencies,
  input: EpochSwitchPlanInput,
  restore?: {
    operationId: string
    location: EpochSourceLocation
    contentRoot: EpochSwitchInputs['contentRoot']
    restoreConfig: boolean
    artifacts?: EpochSwitchJournal['payload']['artifacts']
    materializedRoot?: string
  },
): Promise<string> {
  const discoveryLock = await deps.journal.lockOperation('dbm_e2_discovery')
  try {
    const installation = await deps.installation()
    if (installation.facts.rfc349Operation)
      throw new EpochSwitchError(`v3-rfc349-in-flight:${installation.facts.rfc349Operation}`, {
        category: 'operation-conflict',
      })
    const operations = await deps.journal.list()
    const open = operations
      .filter((j) => !['completed', 'rolled-back', 'abandoned'].includes(j.payload.status))
      .sort((a, b) => a.payload.operationId.localeCompare(b.payload.operationId))
    if (open.length)
      throw new EpochSwitchError(
        `v3-another-operation-active: ${open
          .map(
            ({ payload: p }) =>
              `${p.operationId} (${p.status}, ${p.phase}); continue with db migration plan ${p.operationId} or discard with db migration discard ${p.operationId} --confirm`,
          )
          .join('; ')}`,
        { category: 'operation-conflict' },
      )
    if (!restore && installation.facts.pointer?.payload.version === 2)
      throw new EpochSwitchError('v3-installation-already-epoch2', {
        category: 'unsupported-source',
      })
    const operationId =
      restore?.operationId ??
      deps.newOperationId?.() ??
      `dbm_e2_${crypto.randomUUID().replaceAll('-', '')}`
    const now = (deps.now ?? Date.now)()
    const identity = epochRunIdentity(operationId, 0)
    const source = restore?.location ?? installation.source
    const root = deps.journal.operationRoot(operationId)
    const emptyTables = input.emptyTables?.length
      ? await deps.resolveEmptyTables?.({
          source,
          decisions: input.emptyTables,
          operationRoot: root,
        })
      : []
    if (!emptyTables)
      throw new EpochSwitchError('v3-empty-table-catalog-required', { category: 'source-blocked' })
    const targetProvider = input.target?.provider ?? installation.facts.provider
    const location = persistenceDialect(targetProvider).target(
      identity.generationId,
      input.target?.urlEnv
        ? environmentProfile(input.target.urlEnv)
        : installation.source.kind === 'postgresql-database' &&
            installation.source.profileRef === 'crewstation:source'
          ? 'crewstation:target'
          : '',
    )
    if (location.kind === 'postgresql-target' && !location.profileRef)
      throw new EpochSwitchError('v3-target-url-env-required', { category: 'unsupported-path' })
    let sourceProvider = installation.facts.provider
    if (restore) {
      const handle = await deps.source.discover({
        scratchOwner: operationId,
        scratchProfileRef: input.scratchUrlEnv
          ? environmentProfile(input.scratchUrlEnv)
          : undefined,
        location:
          source.kind === 'backup' && deps.defaultContentRoot.objects !== 'none'
            ? {
                ...source,
                root: restore.materializedRoot ?? relocateEpochPath(source.root, operationId, root),
              }
            : source,
        emptyTables,
        operationRoot: epochArtifactPath(root, `runs/${identity.runId}/source`),
      })
      try {
        sourceProvider = handle.preflight.fingerprint.provider
      } finally {
        await handle.close()
      }
    }
    assertEpochSwitchSupported({ sourceProvider, targetProvider, sourceEpoch: 1, targetEpoch: 2 })
    const checked = await deps.target.preflight({
      provider: targetProvider,
      location,
      sourceFingerprint: null,
    })
    if (!checked.empty || !checked.canCreate || checked.blocks.length)
      throw new EpochSwitchError('v3-target-not-empty-or-incompatible', {
        category: 'target-not-empty',
      })
    let journal = createEpochSwitchJournal({
      version: 1,
      revision: 0,
      previousDigest: null,
      operationId,
      kind: restore ? 'old-epoch-restore' : 'epoch-conversion',
      deployment: deps.defaultContentRoot.objects !== 'none' ? 'crewstation' : 'standalone',
      role: restore ? 'restored' : 'converted',
      phase: 'discovered',
      status: 'running',
      owner: {
        id: deps.ownerId ?? `${process.pid}:${crypto.randomUUID()}`,
        fence: 0,
        leaseExpiresAt: now + 60_000,
      },
      inputs: {
        emptyTables,
        operatorDecisions: [],
        chunkLimit: input.chunkLimit ?? 500,
        scratchProfileRef: input.scratchUrlEnv ? environmentProfile(input.scratchUrlEnv) : null,
        contentRoot: restore?.contentRoot ?? deps.defaultContentRoot,
        restoreConfig: restore?.restoreConfig ?? false,
      },
      source: {
        location: source,
        provider: sourceProvider,
        epoch: 1,
        generationId: null,
        fingerprintDigest: null,
        sourceVersion: null,
        pointer: pointerEvidence(installation.pointerBytes),
      },
      target: { provider: targetProvider, epoch: 2, generationId: identity.generationId, location },
      plan: null,
      backup: null,
      frozen: null,
      run: {
        runId: identity.runId,
        ordinal: 0,
        bindingDigest: null,
        summaryDigest: null,
        validationDigest: null,
        receiptExportDigest: null,
      },
      activation: null,
      firstLiveWriteAt: null,
      rollback: null,
      completion: null,
      checkpoints: [],
      artifacts: restore?.artifacts ?? [],
      approvals: [],
      failure: null,
      createdAt: now,
      updatedAt: now,
    })
    const prior = await deps.journal.readArtifact(operationId, 'discovery.json')
    if (prior) {
      const discovered = parseEpochSwitchJournal(Buffer.from(prior).toString('utf8'))
      if (
        valueDigest({
          source: discovered.payload.source.location,
          target: discovered.payload.target,
          inputs: discovered.payload.inputs,
        }) !==
        valueDigest({
          source: journal.payload.source.location,
          target: journal.payload.target,
          inputs: journal.payload.inputs,
        })
      )
        throw new EpochSwitchError('v3-discovery-input-conflict')
      journal = discovered
    } else
      await deps.journal.writeOnce(
        operationId,
        'discovery.json',
        Buffer.from(JSON.stringify(journal)),
      )
    await deps.journal.create(journal)
    return operationId
  } finally {
    await discoveryLock.release()
  }
}

export function conversionRequest(
  session: EpochSwitchSession,
  source: FrozenSourceHandle,
  content: ConversionRunRequest['content'],
  manifestDigest: string,
  planTime: number,
  backup: SwitchBackupReceipt | null,
  bootUpgradeFacts?: BootUpgradeFacts,
): ConversionRunRequest {
  const p = session.journal.payload
  if (!p.target.generationId) throw new EpochSwitchError('v3-target-missing')
  return {
    source,
    content,
    progress: session.deps.progress,
    scratchRoot: epochArtifactPath(
      session.deps.journal.operationRoot(p.operationId),
      runArtifact(session.journal, 'scratch'),
    ),
    planTime,
    chunkLimit: p.inputs.chunkLimit,
    targetGeneration: p.target.generationId,
    candidateBuild: session.deps.candidateBuild,
    sourceBackupId: backup?.id ?? null,
    contentManifestDigest: manifestDigest,
    bootUpgradeFacts,
    operatorDecisions: p.inputs.operatorDecisions,
  }
}

export async function captureBootUpgradeFacts(
  session: EpochSwitchSession,
  source: FrozenSourceHandle,
  content: ConversionRunRequest['content'],
  manifest: FreezeContentManifest,
  stage: 'plan' | 'freeze' | 'run',
): Promise<BootUpgradeFacts> {
  const port = session.deps.conversion.bootUpgradeEnvironment
  if (!port) {
    if (
      source.preflight.tables.some((table) =>
        ['cached_repos', 'skills', 'skill_versions', 'scheduled_tasks', 'runtimes'].includes(
          table.table,
        ),
      )
    )
      throw new EpochSwitchError('v3-boot-environment-capability-required', {
        category: 'source-blocked',
      })
    return createBootUpgradeFacts([])
  }
  const operationId = session.journal.payload.operationId
  const captured = await port.capture({
    stage,
    source,
    content,
    manifest,
    root: epochContentRoot(session),
    readArtifact: (name) =>
      session.deps.journal.readArtifact(operationId, runArtifact(session.journal, name)),
    async writeArtifact(name, bytes) {
      await session.deps.journal.writeOnce(operationId, runArtifact(session.journal, name), bytes)
    },
  })
  const normalized = createBootUpgradeFacts(captured.facts)
  if (normalized.environmentDigest !== captured.environmentDigest)
    throw new EpochSwitchError('v3-boot-environment-digest-mismatch')
  await session.write(
    runArtifact(session.journal, `boot-facts/${valueDigest(normalized).slice(7)}.json`),
    normalized,
  )
  return normalized
}

export async function unfinishedTasks(
  source: FrozenSourceHandle,
): Promise<readonly { status: string; count: number }[]> {
  if (!source.preflight.tables.some((t) => t.table === 'tasks')) return []
  const counts = new Map<string, number>()
  let after = null
  for (;;) {
    const chunk = await source.reader.readChunk('tasks', after, 1000)
    for (const row of chunk.decodedRows) {
      const status = String(row.status)
      if (executionClass(status) === 'executable') counts.set(status, (counts.get(status) ?? 0) + 1)
    }
    if (chunk.lastKey === null || chunk.rows.length === 0) break
    after = chunk.lastKey
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => ({ status, count }))
}

export async function planFileChanges(
  session: EpochSwitchSession,
): Promise<readonly RestoreFileChange[]> {
  const p = session.journal.payload
  if (p.kind !== 'old-epoch-restore' || epochDeploymentCapabilities(p.deployment).externalSwitch)
    return []
  if (!session.deps.restoreFiles || p.source.location.kind !== 'backup')
    throw new EpochSwitchError('v3-restore-files-adapter-required')
  return session.deps.restoreFiles.plan({
    operationRoot: session.deps.journal.operationRoot(p.operationId),
    sourceRoot: epochLocalPath(session, p.source.location.root),
    restoreConfig: p.inputs.restoreConfig,
  })
}

export function planView(
  journal: EpochSwitchJournal,
  plan: MigrationPlanDocument,
  root: string,
): EpochSwitchPlanView {
  return {
    operationId: journal.payload.operationId,
    plan,
    jsonPath: epochDeploymentCapabilities(journal.payload.deployment).localPaths
      ? epochArtifactPath(root, `plans/${plan.digest}.json`)
      : null,
    markdownPath: epochDeploymentCapabilities(journal.payload.deployment).localPaths
      ? epochArtifactPath(root, `plans/${plan.digest}.md`)
      : null,
    acknowledgeable: plan.payload.blocks.filter(
      (item) => item.remediation.action === 'acknowledge',
    ),
    requiresApproval: journal.payload.plan?.approvedDigest !== plan.approvalDigest,
    guidance: epochPlanGuidance(plan),
  }
}

export async function persistEpochPlan(
  session: EpochSwitchSession,
  plan: MigrationPlanDocument,
  phase: 'planned' | 'frozen' | 'converting' | 'validated',
  preserveApproval: boolean,
): Promise<EpochSwitchPlanView> {
  const op = session.journal.payload.operationId
  const json = await session.write(`plans/${plan.digest}.json`, plan)
  await session.deps.journal.writeOnce(
    op,
    `plans/${plan.digest}.md`,
    Buffer.from(renderEpochPlan(plan)),
  )
  session.deps.faults?.('after-plan-file')
  const previous = session.journal.payload.plan
  const approved = preserveApproval && previous?.approvedDigest === plan.approvalDigest
  await session.save({
    phase,
    plan: {
      digest: plan.digest,
      approvalDigest: plan.approvalDigest,
      approvedDigest: approved ? plan.approvalDigest : null,
      approvedAt: approved ? previous.approvedAt : null,
      path: json.path ?? `plans/${plan.digest}.json`,
    },
    status: approved ? 'running' : 'awaiting-approval',
    failure: null,
  })
  if (session.deps.journal.prunePlanContent) {
    const protectedPlans = new Set([
      plan.digest,
      ...(session.journal.payload.approvals ?? []).map((approval) => approval.payload.planDigest),
    ])
    const references: { path?: string; digest: string }[] = []
    for (const digest of protectedPlans) {
      const bytes = await session.deps.journal.readArtifact(op, `plans/${digest}.json`)
      // Incomplete retained evidence is not a reason to delete a manifest.
      if (!bytes) return planView(session.journal, plan, session.deps.journal.operationRoot(op))
      const retained = parseMigrationPlanDocument(Buffer.from(bytes).toString('utf8'))
      references.push({
        path: retained.payload.contentManifestPath,
        digest: retained.payload.contentManifestDigest,
      })
    }
    await session.deps.journal.prunePlanContent(op, references)
  }
  return planView(session.journal, plan, session.deps.journal.operationRoot(op))
}

export async function planEpochOperation(
  session: EpochSwitchSession,
  input: EpochSwitchPlanInput = {},
  preserveApproval = false,
): Promise<EpochSwitchPlanView> {
  let p = session.journal.payload
  if (phaseIndex(p.phase) > phaseIndex('planned'))
    throw new EpochSwitchError('v3-replan-requires-new-run')
  if (input.target || input.scratchUrlEnv || input.emptyTables || input.chunkLimit) {
    const provider = input.target?.provider ?? p.target.provider
    if (!p.target.generationId) throw new EpochSwitchError('v3-target-generation-missing')
    const location = persistenceDialect(provider).target(
      p.target.generationId,
      input.target?.urlEnv
        ? environmentProfile(input.target.urlEnv)
        : p.target.location?.kind === 'postgresql-target'
          ? p.target.location.profileRef
          : '',
    )
    const emptyTables = input.emptyTables
      ? await session.deps.resolveEmptyTables?.({
          source: p.source.location,
          decisions: input.emptyTables,
          operationRoot: session.deps.journal.operationRoot(p.operationId),
        })
      : p.inputs.emptyTables
    if (!emptyTables) throw new EpochSwitchError('v3-empty-table-catalog-required')
    await session.save({
      target: { ...p.target, provider, location },
      inputs: {
        ...p.inputs,
        emptyTables,
        chunkLimit: input.chunkLimit ?? p.inputs.chunkLimit,
        scratchProfileRef: input.scratchUrlEnv
          ? environmentProfile(input.scratchUrlEnv)
          : p.inputs.scratchProfileRef,
      },
    })
    p = session.journal.payload
  }
  const sourceInput = sourceRequest(session)
  const source = await sourcePort(session).discover(sourceInput)
  try {
    const provider = source.preflight.fingerprint.provider
    assertEpochSwitchSupported({
      sourceProvider: provider,
      targetProvider: p.target.provider,
      sourceEpoch: 1,
      targetEpoch: 2,
    })
    await session.save({
      source: {
        ...p.source,
        provider,
        generationId: source.preflight.sourceGenerationId,
        fingerprintDigest: source.preflight.fingerprint.digest,
        sourceVersion: source.preflight.sourceVersion,
      },
    })
    p = session.journal.payload
    if (!p.target.location || !p.inputs.contentRoot)
      throw new EpochSwitchError('v3-plan-input-incomplete')
    const target = await session.deps.target.preflight({
      provider: p.target.provider,
      location: p.target.location,
      sourceFingerprint: p.source.fingerprintDigest,
    })
    const extraBlocks: ConversionBlock[] = [...target.blocks]
    if (!target.empty) extraBlocks.push(globalBlock('v3-target-not-empty'))
    if (!target.canCreate) extraBlocks.push(globalBlock('v3-target-permission'))
    if (
      source.preflight.requiresOfflineUpgrade &&
      persistenceDialect(provider).requiresScratchProfile &&
      !p.inputs.scratchProfileRef
    )
      extraBlocks.push(globalBlock('v3-scratch-required'))
    const started = session.now()
    let manifest: FreezeContentManifest
    let summary: ConversionSummary
    let stagingPeakBytes: number | null = null
    let contentManifestPath: string | undefined
    let bootUpgradeFacts = createBootUpgradeFacts([])
    if (source.preflight.requiresOfflineUpgrade) {
      const payload = {
        version: 1 as const,
        roots: [epochContentRoot(session).root],
        files: [],
        objects: [],
        databaseTrees: [],
      }
      manifest = { ...payload, digest: contentManifestDigest(payload) }
      summary = pendingUpgradeSummary(session, source, manifest.digest, started)
    } else {
      contentManifestPath = runArtifact(session.journal, `plan-content/${started}.json`)
      manifest = await session.deps.content.capture({
        progress: session.deps.progress,
        source,
        root: epochContentRoot(session),
        destination: epochArtifactPath(
          session.deps.journal.operationRoot(p.operationId),
          contentManifestPath,
        ),
      })
      const content = await session.deps.content.open({
        source,
        root: epochContentRoot(session),
        manifest,
      })
      bootUpgradeFacts = await captureBootUpgradeFacts(session, source, content, manifest, 'plan')
      const request = conversionRequest(
        session,
        source,
        content,
        manifest.digest,
        started,
        null,
        bootUpgradeFacts,
      )
      const rehearsal = await session.deps.conversion.dryRun(request)
      summary = rehearsal.summary
      stagingPeakBytes = rehearsal.stagingPeakBytes ?? null
    }
    const measured = await session.deps.measureCapacity?.(
      sourceInput.location,
      session.deps.journal.operationRoot(p.operationId),
    )
    const capacity = estimateEpochCapacity({
      sourceBytes: measured?.sourceBytes ?? null,
      operationBytes: measured?.operationBytes ?? null,
      stagingPeakBytes,
      availableBytes: measured?.availableBytes ?? target.availableBytes,
      targetOnOperationFilesystem: p.target.location.kind === 'sqlite-file',
      // Hosted artifacts also maintain a local cache; budget ordinary copies in both entries.
      localArtifactMirrors: session.deps.journal.artifacts !== undefined,
    })
    if (
      capacity.requiredBytes !== null &&
      capacity.availableBytes !== null &&
      capacity.availableBytes < capacity.requiredBytes
    )
      extraBlocks.push(
        globalBlock('v3-capacity', {
          requiredBytes: capacity.requiredBytes,
          availableBytes: capacity.availableBytes,
        }),
      )
    const elapsed = Math.max(0, session.now() - started)
    const plan = buildEpochPlan({
      journal: session.journal,
      source,
      manifest,
      contentManifestPath,
      summary,
      bootUpgradeFacts,
      targetPlanDigest: session.deps.targetPlanDigest(p.target.provider),
      backup: null,
      backupDestination: epochArtifactPath(
        session.deps.journal.operationRoot(p.operationId),
        `backup/${p.run?.ordinal ?? 0}`,
      ),
      estimates: {
        ...capacity,
        rehearsalMs: elapsed,
        maintenanceMs: input.rehearse ? elapsed : null,
      },
      unfinishedTasks: source.preflight.requiresOfflineUpgrade ? [] : await unfinishedTasks(source),
      restoreFiles: await planFileChanges(session),
      blocks: extraBlocks,
      now: started,
    })
    return await persistEpochPlan(session, plan, 'planned', preserveApproval)
  } finally {
    await source.close()
  }
}

function pendingUpgradeSummary(
  session: EpochSwitchSession,
  source: FrozenSourceHandle,
  manifestDigest: string,
  planTime: number,
): ConversionSummary {
  const preflight = source.preflight
  const p = session.journal.payload
  const blocks = [globalBlock('v3-scratch-required')]
  const payload: Omit<ConversionPlanSection, 'digest'> = {
    version: 1,
    converterVersion: CONVERTER_VERSION,
    ruleSetDigest: valueDigest({
      pending: 'offline-source-upgrade',
      version: preflight.sourceVersion,
    }),
    sourceFingerprint: preflight.fingerprint.digest,
    sourceVersion: preflight.sourceVersion,
    sourceGenerationId: preflight.sourceGenerationId,
    sourceWatermark: source.watermark,
    targetContractDigest: session.deps.targetContractDigest,
    targetGeneration: p.target.generationId!,
    candidateBuild: session.deps.candidateBuild,
    sourceBackupId: null,
    contentManifestDigest: manifestDigest,
    planTime: planTime,
    coverage: 'partial',
    chunkLimit: p.inputs.chunkLimit,
    preUpgradeWatermark: null,
    operatorDecisions: canonicalOperatorDecisions(p.inputs.operatorDecisions),
    tables: preflight.tables.map((table) => ({
      table: table.table,
      phase: 'current',
      rows: table.rows,
      rule: null,
      targets: [],
    })),
    topology: { order: [], selfReferences: [], deferredForeignKeys: [] },
    deferredChecks: [],
    blocks,
  }
  return {
    status: 'blocked',
    plan: { ...payload, digest: valueDigest(payload) },
    tableReceipts: [],
    blocks,
    records: [],
    historyOnly: [],
    stagingDigest: valueDigest({ pending: 'offline-source-upgrade' }),
  }
}

export function globalBlock(
  code: string,
  detail: ConversionBlock['detail'] = null,
): ConversionBlock {
  return {
    code,
    scope: 'global',
    sourceTable: null,
    sourceKey: null,
    taskId: null,
    runId: null,
    missingFields: [],
    detail,
  }
}

/**
 * A decision change is saved with `plan: null` before the replacement plan is built. Unchanged
 * decisions return the current plan, or rebuild it when it is missing or the last attempt failed,
 * so a retried request never leaves the operation failed. The rebuilt plan keeps an approval whose
 * material is unchanged, as a re-plan inside `run` does.
 */
async function replanWithDecisions(
  session: EpochSwitchSession,
  decisions: readonly OperatorDecision[],
): Promise<EpochSwitchPlanView> {
  const p = session.journal.payload
  const next = canonicalOperatorDecisions(decisions)
  if (valueDigest(canonicalOperatorDecisions(p.inputs.operatorDecisions)) !== valueDigest(next)) {
    await session.save({ inputs: { ...p.inputs, operatorDecisions: next }, plan: null })
    return planEpochOperation(session)
  }
  if (p.plan && p.status !== 'failed')
    return planView(
      session.journal,
      await readEpochPlan(session),
      session.deps.journal.operationRoot(p.operationId),
    )
  return planEpochOperation(session, {}, true)
}

function acknowledgementDecision(
  block: ConversionBlock,
  input: { by: string; reason: string },
  acknowledgedAt: number,
): OperatorDecision {
  if (
    block.code !== 'v2-code-history-unfinished' ||
    !block.acknowledgeable ||
    !block.sourceTable ||
    !block.sourceKey
  )
    throw new EpochSwitchError('v3-item-not-acknowledgeable')
  const detail = block.detail as { rowDigest?: unknown } | null
  return OperatorDecisionSchema.parse({
    kind: 'acknowledge-unfinished-legacy-work',
    sourceTable: block.sourceTable,
    sourceKey: block.sourceKey,
    sourcePhase: block.sourcePhase ?? 'current',
    rowDigest: detail?.rowDigest,
    blockCode: 'v2-code-history-unfinished',
    acknowledgedBy: input.by,
    acknowledgedAt,
    reason: input.reason,
  })
}

/**
 * Before the journal changes, a request records the decision it made for each item, keyed by its
 * items, operator and reason. A retry with the same input resumes from that record: an item counts
 * as done only while its recorded decision is still current, and any other item must still be in
 * the plan. A late replay therefore cannot override a newer decision for the same row.
 */
export async function acknowledgeEpochPlan(
  session: EpochSwitchSession,
  input: Parameters<EpochSwitchApplication['acknowledge']>[0],
): Promise<EpochSwitchPlanView> {
  if (phaseIndex(session.journal.payload.phase) > phaseIndex('planned'))
    throw new EpochSwitchError('v3-acknowledge-requires-new-run')
  const items = [...new Set(input.items)].sort()
  if (items.length === 0) throw new EpochSwitchError('v3-acknowledgement-empty')
  const name = `acknowledgements/${valueDigest({ items, by: input.by, reason: input.reason })}.json`
  const record = await session.artifact<{ decisions: { item: string; decision: unknown }[] }>(name)
  const recorded = new Map(
    (record?.decisions ?? []).map((entry) => [
      entry.item,
      OperatorDecisionSchema.parse(entry.decision),
    ]),
  )
  const current = session.journal.payload.inputs.operatorDecisions
  const pending = items.filter((item) => {
    const decision = recorded.get(item)
    return !decision || !current.some((d) => valueDigest(d) === valueDigest(decision))
  })
  const decisions = new Map<string, OperatorDecision>()
  if (pending.length) {
    const plan = session.journal.payload.plan
      ? await readEpochPlan(session)
      : (await planEpochOperation(session)).plan
    for (const item of pending) {
      const block = plan.payload.blocks.find((entry) => entry.id === item)?.block
      if (!block) throw new EpochSwitchError('v3-acknowledgement-item-not-found')
      decisions.set(
        item,
        recorded.get(item) ?? acknowledgementDecision(block, input, session.now()),
      )
    }
  }
  if (!record)
    await session.write(name, {
      decisions: items.map((item) => ({ item, decision: decisions.get(item) })),
    })
  const merged = new Map(
    [...session.journal.payload.inputs.operatorDecisions, ...decisions.values()].map((d) => [
      valueDigest({ table: d.sourceTable, key: d.sourceKey, phase: d.sourcePhase }),
      d,
    ]),
  )
  return replanWithDecisions(session, [...merged.values()])
}

export async function withdrawEpochAcknowledgements(
  session: EpochSwitchSession,
  input: EpochSwitchWithdrawalInput,
): Promise<EpochSwitchPlanView> {
  if (phaseIndex(session.journal.payload.phase) > phaseIndex('planned'))
    throw new EpochSwitchError('v3-acknowledge-requires-new-run')
  const prior = session.journal.payload.inputs.operatorDecisions
  // `all` is idempotent without a record, and a record keyed by it would capture an older set.
  if (input.decisions === 'all') return replanWithDecisions(session, [])
  if (!input.decisions.length) throw new EpochSwitchError('v3-acknowledgement-item-not-found')
  // Recorded before the journal changes, so a retry no longer needs the decisions to be present.
  const record = `acknowledgement-withdrawals/${valueDigest([...new Set(input.decisions)].sort())}.json`
  if (!(await session.artifact(record))) {
    if (input.decisions.some((id) => !prior.some((d) => valueDigest(d) === id)))
      throw new EpochSwitchError('v3-acknowledgement-item-not-found')
    await session.write(record, { decisions: input.decisions })
  }
  return replanWithDecisions(
    session,
    prior.filter((d) => !input.decisions.includes(valueDigest(d))),
  )
}
