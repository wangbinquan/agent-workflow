import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { epochDeploymentCapabilities } from '@/modules/system-operations/domain/epochSwitch/deploymentCapabilities'
import { persistenceDialect } from '@/platform/persistence/nativeDialect'
import type { ConversionSummary } from '@/platform/persistence/migration/conversion/sink'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  bootUpgradeEffectsFromRecords,
  createBootUpgradeFacts,
  type BootUpgradeFacts,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import type { ConversionBlock } from '@/platform/persistence/migration/conversion/types'
import { decodeMigrationKey } from '@/platform/persistence/migration/conversion/migrationKey'
import type {
  FrozenSourceHandle,
  FreezeContentManifest,
  SwitchBackupReceipt,
  ValidationReport,
} from '@/platform/persistence/migration/run/types'
import {
  createMigrationPlanDocument,
  type MigrationPlanDocument,
  type MigrationPlanDocumentPayload,
  type RestoreFileChange,
} from './documents'
import { EpochSwitchError, type EpochSwitchJournal } from './model'
import { describeEpochBlock, executableTaskForBlock } from './remediation'

export function buildEpochPlan(input: {
  journal: EpochSwitchJournal
  source: FrozenSourceHandle
  manifest: FreezeContentManifest
  summary: ConversionSummary
  bootUpgradeFacts?: BootUpgradeFacts
  targetPlanDigest: string
  backup: SwitchBackupReceipt | null
  backupDestination: string | null
  estimates: MigrationPlanDocumentPayload['estimates']
  unfinishedTasks: MigrationPlanDocumentPayload['unfinishedTasks']
  restoreFiles: readonly RestoreFileChange[]
  blocks?: readonly ConversionBlock[]
  validation?: ValidationReport | null
  now: number
}): MigrationPlanDocument {
  const {
    journal: { payload: p },
    source,
    summary,
  } = input
  if (!p.target.generationId || !p.target.location || !p.inputs.contentRoot)
    throw new EpochSwitchError('v3-plan-input-incomplete')
  const blocks = [...summary.blocks, ...(input.blocks ?? [])]
  if (summary.plan.coverage !== 'complete')
    blocks.push({
      code: 'v3-partial-conversion',
      scope: 'global',
      sourceTable: null,
      sourceKey: null,
      taskId: null,
      runId: null,
      missingFields: [],
      detail: null,
    })
  return createMigrationPlanDocument({
    version: 1,
    operationId: p.operationId,
    kind: p.kind,
    deployment: p.deployment,
    role: p.role,
    source: {
      location: p.source.location,
      provider: p.source.provider,
      epoch: 1,
      generationId: source.preflight.sourceGenerationId,
      fingerprintDigest: source.preflight.fingerprint.digest,
      sourceVersion: source.preflight.sourceVersion,
      watermark: source.watermark,
      preUpgradeWatermark: source.preUpgrade?.preflight.watermark ?? null,
    },
    target: {
      ...p.target,
      generationId: p.target.generationId,
      location: p.target.location,
      contractDigest: summary.plan.targetContractDigest,
      planDigest: input.targetPlanDigest,
    },
    candidateBuild: summary.plan.candidateBuild,
    converterVersion: summary.plan.converterVersion,
    sourceBackupId: input.backup?.id ?? null,
    contentManifestDigest: input.manifest.digest,
    bootUpgradeEffects: bootUpgradeEffectsFromRecords(summary.records),
    bootUpgradeEnvironmentDigest:
      input.bootUpgradeFacts?.environmentDigest ??
      summary.plan.bootUpgradeEnvironmentDigest ??
      createBootUpgradeFacts([]).environmentDigest,
    bootUpgradeFactsDigest: valueDigest(input.bootUpgradeFacts ?? createBootUpgradeFacts([])),
    conversionPlan: summary.plan,
    emptyTables: p.inputs.emptyTables,
    operatorDecisions: p.inputs.operatorDecisions,
    restrictions: summary.historyOnly,
    blocks: [
      ...new Map(
        blocks.map((block) => {
          const item = describeEpochBlock(block)
          return [item.id, item]
        }),
      ).values(),
    ],
    unfinishedTasks: input.unfinishedTasks,
    estimates: input.estimates,
    backup: {
      destination: input.backupDestination,
      kind:
        input.backup?.kind ??
        (p.kind === 'old-epoch-restore'
          ? 'immutable-backup-source'
          : persistenceDialect(p.source.provider).switchBackupKind),
      receipt: input.backup,
    },
    content: p.inputs.contentRoot,
    scratchProfileRef: p.inputs.scratchProfileRef,
    requiresOfflineUpgrade: source.preflight.requiresOfflineUpgrade || source.preUpgrade !== null,
    validation: input.validation ?? null,
    switchMethod: epochDeploymentCapabilities(p.deployment).externalSwitch
      ? 'platform-switch'
      : 'pointer-v2',
    recoveryMethod: 'retained-source-until-first-write',
    retention: { automaticDeletion: false, compactRequiresVerifiedExport: true },
    restoreFiles: input.restoreFiles,
    createdAt: input.now,
  })
}

function singleLine(value: unknown): string {
  return (typeof value === 'string' ? value : (JSON.stringify(value) ?? 'none')).replace(
    /\s+/g,
    ' ',
  )
}

function tableCell(value: unknown): string {
  return singleLine(value).replaceAll('|', '\\|')
}

function compactKey(table: string | null, key: string | null): string {
  if (key === null) return table ?? 'global'
  const decoded = decodeMigrationKey(key)
  return `${decoded.table}(${decoded.key
    .map((cell) => (cell.type === 'null' ? 'null' : singleLine(cell.value)))
    .join(', ')})`
}

const rawDetailFields = new Set([
  'raw',
  'cells',
  'canonical',
  'source',
  'sourceValues',
  'sourceReferences',
  'codecTakeovers',
])

function detailSummary(value: unknown): string {
  const rendered =
    JSON.stringify(value, (key, item: unknown) => {
      if (rawDetailFields.has(key)) return '[see JSON plan]'
      if (item && typeof item === 'object' && 'type' in item && 'value' in item)
        return '[cell in JSON plan]'
      return item
    }) ?? 'none'
  const line = singleLine(rendered)
  return line.length > 300 ? `${line.slice(0, 297)}...` : line
}

export function tasksToSettle(plan: MigrationPlanDocument): readonly {
  taskId: string
  status: string
  blockedRows: number
  codes: readonly string[]
}[] {
  const tasks = new Map<
    string,
    {
      taskId: string
      status: string
      rows: Set<string>
      codes: Set<string>
    }
  >()
  for (const { block } of plan.payload.blocks) {
    const task = executableTaskForBlock(block)
    if (!task) continue
    const entry = tasks.get(task.taskId) ?? {
      ...task,
      rows: new Set<string>(),
      codes: new Set<string>(),
    }
    entry.rows.add(
      JSON.stringify([block.sourcePhase ?? 'current', block.sourceTable, block.sourceKey]),
    )
    entry.codes.add(block.code)
    tasks.set(task.taskId, entry)
  }
  return [...tasks.values()]
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
    .map(({ taskId, status, rows, codes }) => ({
      taskId,
      status,
      blockedRows: rows.size,
      codes: [...codes].sort(),
    }))
}

export function epochPlanGuidance(plan: MigrationPlanDocument): readonly string[] {
  const p = plan.payload
  if (p.blocks.length) {
    const tasks = tasksToSettle(plan)
    const groups = new Map<string, Set<string>>()
    const acknowledgements: string[] = []
    for (const item of p.blocks) {
      if (executableTaskForBlock(item.block)) continue
      if (item.remediation.action === 'acknowledge') {
        acknowledgements.push(
          `db migration acknowledge ${p.operationId} --item ${item.id} --reason TEXT`,
        )
        continue
      }
      const messages = groups.get(item.remediation.action) ?? new Set<string>()
      messages.add(item.remediation.message)
      groups.set(item.remediation.action, messages)
    }
    return [
      `Run is blocked by ${p.blocks.length} block(s).`,
      ...(tasks.length
        ? [
            `Tasks to settle before switching: ${tasks.length}. Finish or cancel them in the current version; see the task list in the plan.`,
          ]
        : []),
      ...acknowledgements.sort(),
      ...[...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([action, messages]) => `${action}: ${[...messages].sort().join(' ')}`),
      `Re-plan with: db migration plan ${p.operationId}`,
    ]
  }
  return [
    `db migration run ${p.operationId} --approve ${plan.approvalDigest}`,
    ...(p.target.location.kind === 'postgresql-target'
      ? [
          `Keep ${p.target.location.profileRef} available after activation; config.json is unchanged.`,
        ]
      : []),
    'run stops at activated. Keep the daemon down to preserve rollback until its first business write.',
  ]
}

function renderBlocks(plan: MigrationPlanDocument): readonly string[] {
  if (!plan.payload.blocks.length) return []
  const groups = new Map<
    string,
    { code: string; table: string; count: number; remediation: Set<string> }
  >()
  for (const item of plan.payload.blocks) {
    const code = item.block.code
    const table = item.block.sourceTable ?? 'global'
    const key = JSON.stringify([code, table])
    const group = groups.get(key) ?? { code, table, count: 0, remediation: new Set<string>() }
    group.count++
    group.remediation.add(
      executableTaskForBlock(item.block)
        ? 'repair-source: finish or cancel the listed task in the current version, then re-plan; affected runs become history-only'
        : `${item.remediation.action}: ${item.remediation.message}`,
    )
    groups.set(key, group)
  }
  const tasks = tasksToSettle(plan)
  return [
    '## Blocks',
    '',
    '| Code | Source table | Count | Remediation |',
    '| --- | --- | ---: | --- |',
    ...[...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([, group]) =>
          `| ${[group.code, group.table, group.count, [...group.remediation].sort().join('; ')].map(tableCell).join(' | ')} |`,
      ),
    '',
    ...(tasks.length
      ? [
          '### Tasks to settle before switching',
          '',
          '| Task id | Epoch-1 status | Blocked rows | Codes |',
          '| --- | --- | ---: | --- |',
          ...tasks.map(
            (task) =>
              `| ${[task.taskId, task.status, task.blockedRows, task.codes.join(', ')].map(tableCell).join(' | ')} |`,
          ),
          '',
        ]
      : []),
    ...plan.payload.blocks.map(
      ({ id, block }) =>
        `- ${singleLine(compactKey(block.sourceTable, block.sourceKey))}: ${block.code}; missing: ${singleLine(block.missingFields.join(', ') || 'none')}; detail: ${detailSummary(block.detail)}; item: ${id}`,
    ),
    '',
  ]
}

function restrictionExecution(item: MigrationPlanDocumentPayload['restrictions'][number]): string {
  if (!item.history) return 'none'
  return item.history.execution === 'executable'
    ? `${item.history.execution} / ${item.history.reason}`
    : item.history.execution
}

function renderRestrictions(plan: MigrationPlanDocument): readonly string[] {
  const groups = new Map<string, { labels: readonly string[]; count: number }>()
  for (const item of plan.payload.restrictions) {
    const labels = [item.sourceTable, item.decision?.code ?? 'none', restrictionExecution(item)]
    const key = JSON.stringify(labels)
    const group = groups.get(key) ?? { labels, count: 0 }
    group.count++
    groups.set(key, group)
  }
  return [
    '## Restrictions and acknowledgements',
    '',
    '| Source table | Decision code | Execution class / reason | Count |',
    '| --- | --- | --- | ---: |',
    ...[...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, group]) => `| ${[...group.labels, group.count].map(tableCell).join(' | ')} |`),
    '',
    ...plan.payload.restrictions.map(
      (item) =>
        `- ${compactKey(item.sourceTable, item.sourceKey)}: ${item.decision?.code ?? 'none'}; ${restrictionExecution(item)}; task: ${item.history?.taskId ?? 'none'}; run: ${item.history?.runId ?? 'none'}; missing: ${item.history?.missingFields.join(', ') || 'none'}; detail: ${detailSummary(item.decision?.detail)}`,
    ),
    ...plan.payload.operatorDecisions.map(
      (item) =>
        `- Acknowledged: ${compactKey(item.sourceTable, item.sourceKey)}; ${item.blockCode}; by: ${item.acknowledgedBy}; reason: ${singleLine(item.reason)}`,
    ),
    '',
  ]
}

export function renderEpochPlan(plan: MigrationPlanDocument): string {
  // A plan digest is canonical; its write-once Markdown must use the same key order.
  const stable = JSON.parse(canonicalSchemaJson(plan)) as MigrationPlanDocument
  const p = stable.payload
  return [
    `# Epoch switch ${p.operationId}`,
    '',
    `Plan: ${plan.digest}`,
    `Approval: ${plan.approvalDigest}`,
    `Source: ${p.source.provider} / ${p.source.sourceVersion} / ${p.source.generationId}`,
    `Source watermark: ${p.source.watermark}`,
    `Target: ${p.target.provider} / ${JSON.stringify(p.target.location)} / ${p.target.generationId}`,
    `Contract: ${p.target.contractDigest}`,
    `Backup: ${p.backup.kind} / ${p.backup.destination ?? 'platform retained'}`,
    `Content: ${JSON.stringify(p.content)}`,
    `Scratch profile: ${p.scratchProfileRef ?? 'none'}; offline upgrade: ${p.requiresOfflineUpgrade}`,
    `Estimates: ${JSON.stringify(p.estimates)} (null means not measured)`,
    p.requiresOfflineUpgrade && p.conversionPlan.coverage === 'partial'
      ? 'Conversion and unfinished-task inventory await the offline source upgrade; counts and dispositions have not been evaluated.'
      : `Unfinished tasks: ${JSON.stringify(p.unfinishedTasks)}`,
    'Pending work remains pending; running work follows checkpoint/interrupted recovery; interrupted work follows interrupted recovery; awaiting_human and awaiting_review retain their gates. Failed/canceled history remains retryable only where conversion proves it.',
    '',
    ...renderBlocks(stable),
    ...renderRestrictions(stable),
    '## Legacy boot conversions',
    '',
    `Boot environment: ${p.bootUpgradeEnvironmentDigest}`,
    `Boot observation evidence: ${p.bootUpgradeFactsDigest}`,
    `Content manifest: ${p.contentManifestDigest}`,
    '| Rule | Source | Disposition | Before | After | Reason | Facts |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...p.bootUpgradeEffects.map(
      (effect) =>
        `| ${[
          `${effect.rule.id}@${effect.rule.version}`,
          compactKey(effect.sourceTable, effect.sourceKey),
          effect.disposition,
          effect.before,
          effect.after,
          effect.reason,
          effect.factIds.join(', '),
        ]
          .map(tableCell)
          .join(' | ')} |`,
    ),
    '',
    `Validation: ${p.validation ? JSON.stringify(p.validation) : 'pending frozen target validation'}`,
    `Switch: ${p.switchMethod}; run stops at activated with the daemon down.`,
    'Rollback is available only before the first target business write. Verify records acceptance; complete retains the source.',
    'No source, backup or migration metadata is deleted automatically.',
    ...epochPlanGuidance(stable),
    '',
  ]
    .map(singleLine)
    .join('\n')
}
