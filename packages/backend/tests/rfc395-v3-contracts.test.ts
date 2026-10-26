import { createBootUpgradeFacts } from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
// V3 fix phase 1 locks approval history, canonical acknowledgements and dormant port contracts.
import { describe, expect, expectTypeOf, test } from 'bun:test'
import { canonicalSchemaJson, digestSchemaContract } from '@/platform/persistence/schema/canonical'
import { compileMetaTables, HISTORY_META_TABLES } from '@/platform/persistence/schema/history/meta'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type { ConversionPlanSection } from '@/platform/persistence/migration/conversion/plan'
import type { OperatorDecision } from '@/platform/persistence/migration/conversion/types'
import {
  EPOCH_SWITCH_PHASES,
  EPOCH_SWITCH_STATUSES,
  EPOCH_SWITCH_FAULT_POINTS,
  EpochSwitchJournalPayloadSchema,
  createEpochSwitchJournal,
  parseEpochSwitchJournal,
  canonicalOperatorDecisions,
  ContentRootSpecSchema,
  EpochSwitchArtifactReferenceSchema,
  SourceArchiveInputSchema,
  MigrationApprovalHistorySchema,
  type EpochSwitchFaults,
  type EpochSwitchJournalPayload,
} from '@/modules/system-operations/domain/epochSwitch/model'
import {
  createMigrationPlanDocument,
  parseMigrationPlanDocument,
  MigrationPlanDocumentSchema,
  migrationPlanApprovalDigest,
  createActivationReceipt,
  parseActivationReceipt,
  createSwitchReceipt,
  parseSwitchReceipt,
  createRollbackReceipt,
  parseRollbackReceipt,
  createMigrationApproval,
  approveMigrationPlan,
  appendMigrationApproval,
  latestMigrationApproval,
  assertActivationApproval,
  ConversionBlockSchema,
  HistoryRestrictionSchema,
  type MigrationPlanDocumentPayload,
  type ActivationReceiptPayload,
  type SwitchReceiptPayload,
  type RollbackReceiptPayload,
} from '@/modules/system-operations/domain/epochSwitch/documents'
import {
  MIGRATION_META_TABLES,
  EPOCH2_META_TABLES,
} from '@/modules/system-operations/infrastructure/persistence/migrationMetaTables'
import type {
  EpochBackupPort,
  EpochSwitchJournalPort,
  SourceSnapshotRequest,
  TargetGenerationPort,
  TargetGenerationHandle,
  MigrationMetaReadPort,
} from '@/modules/system-operations/application/ports/epochSwitch'
import type {
  ContentRootSpec,
  EpochSwitchArtifactPort,
  SourceArchiveInput,
  MigrationApproval,
} from '@/platform/persistence/migration/run/types'
import type { EpochSwitchApprovalRequest } from '@/modules/system-operations/public/types'
import { describeV3Providers, describeV3CrossProvider } from './helpers/rfc395V3Harness'

const digest = valueDigest('contract-fixture')
const operationId = 'dbm_e2_contract_fixture'
const generationId = 'dbg_contract_fixture'
const sourceKey = encodeMigrationKey('code_work_items', [canonicalValue('work')])
const decision: OperatorDecision = {
  kind: 'acknowledge-unfinished-legacy-work',
  sourceTable: 'code_work_items',
  sourceKey,
  sourcePhase: 'current',
  rowDigest: digest,
  blockCode: 'v2-code-history-unfinished',
  acknowledgedBy: 'operator',
  acknowledgedAt: 123,
  reason: 'Keep the retired work as history.',
}
function conversionPlan(decisions: readonly OperatorDecision[] = []): ConversionPlanSection {
  const payload: Omit<ConversionPlanSection, 'digest'> = {
    version: 1,
    converterVersion: 'rfc395-v2@2',
    ruleSetDigest: digest,
    sourceFingerprint: digest,
    sourceVersion: 'epoch1-fixture',
    sourceGenerationId: 'source-fixture',
    sourceWatermark: digest,
    targetContractDigest: digest,
    targetGeneration: generationId,
    candidateBuild: 'candidate',
    sourceBackupId: null,
    contentManifestDigest: digest,
    planTime: 123,
    coverage: 'complete',
    chunkLimit: 1000,
    preUpgradeWatermark: null,
    operatorDecisions: decisions,
    tables: [
      {
        table: 'code_work_items',
        phase: 'current',
        rows: 1,
        rule: 'history/code_work_items',
        targets: ['code_history_archives'],
      },
    ],
    topology: { order: ['code_history_archives'], selfReferences: [], deferredForeignKeys: [] },
    deferredChecks: [],
    blocks: [],
  }
  return { ...payload, digest: valueDigest(payload) }
}
function planPayload(): MigrationPlanDocumentPayload {
  return {
    version: 1,
    operationId,
    kind: 'epoch-conversion',
    deployment: 'standalone',
    role: 'converted',
    source: {
      location: {
        kind: 'sqlite-file',
        path: '/app/db.sqlite',
        pointerPath: '/app/database-generation.json',
      },
      provider: 'sqlite',
      epoch: 1,
      generationId: 'source-fixture',
      fingerprintDigest: digest,
      sourceVersion: 'epoch1-fixture',
      watermark: digest,
      preUpgradeWatermark: null,
    },
    target: {
      provider: 'sqlite',
      epoch: 2,
      generationId,
      location: { kind: 'sqlite-file', relativePath: `databases/${generationId}/db.sqlite` },
      contractDigest: digest,
      planDigest: digest,
    },
    candidateBuild: 'candidate',
    converterVersion: 'rfc395-v2@2',
    sourceBackupId: null,
    contentManifestDigest: digest,
    bootUpgradeEffects: [],
    bootUpgradeEnvironmentDigest: createBootUpgradeFacts([]).environmentDigest,
    bootUpgradeFactsDigest: valueDigest(createBootUpgradeFacts([])),
    conversionPlan: conversionPlan(),
    emptyTables: [],
    operatorDecisions: [],
    restrictions: [],
    blocks: [],
    unfinishedTasks: [{ status: 'interrupted', count: 2 }],
    estimates: {
      sourceBytes: 10,
      targetBytes: 20,
      backupBytes: 10,
      stagingBytes: 10,
      requiredBytes: 50,
      availableBytes: null,
      rehearsalMs: null,
      maintenanceMs: null,
    },
    backup: { destination: '/op/backup', kind: 'sqlite-vacuum', receipt: null },
    content: { kind: 'app-home', root: '/app', runsSupplied: true, objects: 'none' },
    scratchProfileRef: null,
    requiresOfflineUpgrade: false,
    validation: null,
    switchMethod: 'pointer-v2',
    recoveryMethod: 'retained-source-until-first-write',
    retention: { automaticDeletion: false, compactRequiresVerifiedExport: true },
    restoreFiles: [],
    createdAt: 123,
  }
}
function journalPayload(): EpochSwitchJournalPayload {
  const p = planPayload()
  return {
    version: 1,
    revision: 0,
    previousDigest: null,
    operationId,
    kind: p.kind,
    deployment: p.deployment,
    role: p.role,
    phase: 'discovered',
    status: 'running',
    owner: { id: 'owner', fence: 1, leaseExpiresAt: 1000 },
    inputs: {
      emptyTables: [],
      operatorDecisions: [],
      chunkLimit: 1000,
      scratchProfileRef: null,
      contentRoot: p.content,
      restoreConfig: false,
    },
    source: {
      location: p.source.location,
      provider: p.source.provider,
      epoch: 1,
      generationId: p.source.generationId,
      fingerprintDigest: digest,
      sourceVersion: p.source.sourceVersion,
      pointer: { bytesBase64: null, digest: null },
    },
    target: { provider: p.target.provider, epoch: 2, generationId, location: p.target.location },
    plan: null,
    backup: null,
    frozen: null,
    run: null,
    activation: null,
    firstLiveWriteAt: null,
    rollback: null,
    completion: null,
    checkpoints: [],
    failure: null,
    createdAt: 123,
    updatedAt: 123,
  }
}
function activationPayload(): ActivationReceiptPayload {
  const plan = createMigrationPlanDocument(planPayload())
  return {
    version: 1,
    operationId,
    runId: 'run-1',
    kind: 'epoch-conversion',
    deployment: 'standalone',
    role: 'converted',
    source: plan.payload.source,
    target: plan.payload.target,
    migrationPlanDigest: plan.digest,
    approvalDigest: plan.approvalDigest,
    conversionPlanDigest: plan.payload.conversionPlan.digest,
    bindingDigest: digest,
    summaryDigest: digest,
    validationDigest: digest,
    receiptExportDigest: digest,
    backup: {
      version: 1,
      id: 'backup-1',
      kind: 'sqlite-vacuum',
      path: '/op/backup',
      digest,
      sourceWatermark: digest,
      contentManifestDigest: digest,
      createdAt: 123,
    },
    contentManifestDigest: digest,
    writerDrain: [],
    familyCutoverSource: [],
    lineage: [],
    identityHighWater: [],
    historyRestrictionsDigest: valueDigest([]),
    operatorDecisions: [],
    acknowledgementsDigest: valueDigest([]),
    candidateBuild: 'candidate',
    previousPointer: { bytesBase64: null, digest: null, generationId: null },
    restoreFiles: [],
    preparedAt: 123,
  }
}
function switchPayload(): SwitchReceiptPayload {
  return {
    version: 1,
    kind: 'verified',
    operationId,
    runId: 'run-1',
    generationId,
    activationReceiptDigest: digest,
    pointerDigest: digest,
    firstLiveWriteAt: null,
    health: { version: 1, checkedAt: 124, catalogAdmitted: true, probes: [], passed: true, digest },
    retained: ['/op/backup'],
    recordedAt: 124,
  }
}
function rollbackPayload(): RollbackReceiptPayload {
  return {
    version: 1,
    kind: 'rolled-back',
    operationId,
    runId: 'run-1',
    generationId,
    activationReceiptDigest: digest,
    previousPointerDigest: null,
    restoredPointerDigest: null,
    firstLiveWriteAt: null,
    targetState: 'retired',
    restoredFiles: [],
    recordedAt: 124,
  }
}

describe('RFC-395 V3 durable contracts', () => {
  test('journal round trips with canonical digest and carries every phase/status and input', () => {
    const payload = journalPayload()
    const journal = createEpochSwitchJournal(payload)
    expect(parseEpochSwitchJournal(canonicalSchemaJson(journal))).toEqual(journal)
    expect(createEpochSwitchJournal({ ...payload, source: { ...payload.source } })).toEqual(journal)
    for (const phase of EPOCH_SWITCH_PHASES)
      for (const status of EPOCH_SWITCH_STATUSES)
        expect(
          EpochSwitchJournalPayloadSchema.safeParse({ ...payload, phase, status }).success,
        ).toBe(true)
    expect(new Set(EPOCH_SWITCH_FAULT_POINTS).size).toBe(EPOCH_SWITCH_FAULT_POINTS.length)
    for (const point of [
      'after-journal-cas',
      'after-rows',
      'before-ack',
      'renamed',
      'after-retire',
      'rollback-renamed',
    ])
      expect(EPOCH_SWITCH_FAULT_POINTS as readonly string[]).toContain(point)
  })
  test('journal refuses unknown fields, inconsistent bindings and corrupt digests', () => {
    const p = journalPayload()
    for (const patch of [
      { extra: 1 },
      { source: { ...p.source, extra: 1 } },
      { phase: 'accepting-writes' },
      { owner: { ...p.owner, extra: 1 } },
      { inputs: { ...p.inputs, silentCancel: true } },
      { role: 'restored' },
      { target: { ...p.target, provider: 'postgresql' } },
      { source: { ...p.source, pointer: { bytesBase64: 'e30=', digest: null } } },
      {
        plan: {
          digest,
          approvalDigest: digest,
          approvedDigest: digest,
          approvedAt: null,
          path: '/plan',
        },
      },
    ])
      expect(EpochSwitchJournalPayloadSchema.safeParse({ ...p, ...patch }).success).toBe(false)
    const journal = createEpochSwitchJournal(p)
    expect(() =>
      parseEpochSwitchJournal(JSON.stringify({ ...journal, payload: { ...p, revision: 1 } })),
    ).toThrow('v3-journal-digest-mismatch')
  })
  test('plan, activation, switch and rollback documents round trip and reject digest/unknown-field changes', () => {
    const documents = [
      { value: createMigrationPlanDocument(planPayload()), parse: parseMigrationPlanDocument },
      { value: createActivationReceipt(activationPayload()), parse: parseActivationReceipt },
      { value: createSwitchReceipt(switchPayload()), parse: parseSwitchReceipt },
      { value: createRollbackReceipt(rollbackPayload()), parse: parseRollbackReceipt },
    ]
    for (const { value, parse } of documents) {
      expect(parse(canonicalSchemaJson(value))).toEqual(value)
      expect(() => parse(JSON.stringify({ ...value, extra: true }))).toThrow()
      expect(() =>
        parse(JSON.stringify({ ...value, payload: { ...value.payload, extra: true } })),
      ).toThrow()
      expect(() => parse(JSON.stringify({ ...value, digest: valueDigest('other') }))).toThrow()
    }
    const plan = createMigrationPlanDocument(planPayload())
    expect(
      MigrationPlanDocumentSchema.safeParse({
        ...plan,
        payload: { ...plan.payload, target: { ...plan.payload.target, unknown: true } },
      }).success,
    ).toBe(false)
    expect(() =>
      createActivationReceipt({ ...activationPayload(), operatorDecisions: [decision] }),
    ).toThrow('v3-acknowledgements-digest-mismatch')
  })
  test('full digest binds numeric evidence while approval digest is stable across numeric-only changes', () => {
    const original = planPayload()
    const changed = structuredClone(original)
    changed.createdAt++
    changed.bootUpgradeFactsDigest = valueDigest('changed observational facts')
    changed.contentManifestDigest = valueDigest('changed unused file metadata')
    changed.estimates.sourceBytes = 100
    changed.estimates.maintenanceMs = 999
    changed.unfinishedTasks = [{ status: 'interrupted', count: 89 }]
    changed.source.watermark = valueDigest('new watermark')
    changed.source.fingerprintDigest = valueDigest('new census')
    const { digest: _digest, ...conversion } = changed.conversionPlan
    const next = {
      ...conversion,
      tables: conversion.tables.map((entry) => ({ ...entry, rows: 89 })),
    }
    changed.conversionPlan = { ...next, digest: valueDigest(next) }
    expect(createMigrationPlanDocument(changed).digest).not.toBe(
      createMigrationPlanDocument(original).digest,
    )
    expect(migrationPlanApprovalDigest(changed)).toBe(migrationPlanApprovalDigest(original))
    const reversed = Object.fromEntries(
      Object.entries(original).reverse(),
    ) as MigrationPlanDocumentPayload
    expect(createMigrationPlanDocument(reversed)).toEqual(createMigrationPlanDocument(original))
  })
  test('acknowledgements, restrictions, blocks and target changes each require fresh approval', () => {
    const original = planPayload()
    const variants: MigrationPlanDocumentPayload[] = [
      { ...original, operatorDecisions: [decision], conversionPlan: conversionPlan([decision]) },
      {
        ...original,
        restrictions: [
          {
            sourceTable: 'code_work_items',
            sourceKey,
            sourcePhase: 'current',
            class: 'converted',
            kind: 'history-only',
            targets: [],
            archive: null,
            rule: { id: 'fixture', version: 1 },
            history: {
              taskId: 'task',
              runId: null,
              execution: 'retryable-history',
              missingFields: ['input'],
            },
            decision: { code: 'missing-input', detail: null },
          },
        ],
      },
      {
        ...original,
        blocks: [
          {
            id: 'block-1',
            block: {
              code: 'conversion-blocked',
              scope: 'global',
              sourceTable: null,
              sourceKey: null,
              taskId: null,
              runId: null,
              missingFields: [],
              detail: null,
            },
            remediation: { action: 'new-run', message: 'Re-plan after repairing the source.' },
          },
        ],
      },
      {
        ...original,
        target: {
          ...original.target,
          provider: 'postgresql',
          location: { kind: 'postgresql-target', profileRef: 'env:TARGET_DATABASE' },
        },
      },
    ]
    for (const variant of variants)
      expect(createMigrationPlanDocument(variant).approvalDigest).not.toBe(
        createMigrationPlanDocument(original).approvalDigest,
      )
    expect(() =>
      createMigrationPlanDocument({ ...original, operatorDecisions: [decision] }),
    ).toThrow('v3-plan-operator-decisions-mismatch')
  })
  test('K-1 three shuffled decisions have one V2 order in plans, journals and activation receipts', () => {
    const decisions = ['first', 'second', 'third'].map((id) => ({
      ...decision,
      sourceKey: encodeMigrationKey('code_work_items', [canonicalValue(id)]),
      rowDigest: valueDigest(id),
    }))
    const canonical = canonicalOperatorDecisions(decisions)
    const orders = [
      canonical,
      [canonical[2]!, canonical[0]!, canonical[1]!],
      [...canonical].reverse(),
    ]
    const plans = orders.map((operatorDecisions) =>
      createMigrationPlanDocument({
        ...planPayload(),
        operatorDecisions,
        conversionPlan: conversionPlan(operatorDecisions),
      }),
    )
    for (const plan of plans) {
      expect(plan).toEqual(plans[0]!)
      expect(plan.payload.operatorDecisions).toEqual(canonical)
      expect(plan.payload.conversionPlan.operatorDecisions).toEqual(canonical)
      const { digest: conversionDigest, ...payload } = plan.payload.conversionPlan
      expect(conversionDigest).toBe(valueDigest(payload))
      expect(parseMigrationPlanDocument(canonicalSchemaJson(plan))).toEqual(plan)
    }
    const receipts = orders.map((operatorDecisions) =>
      createActivationReceipt({
        ...activationPayload(),
        operatorDecisions,
        acknowledgementsDigest: valueDigest(operatorDecisions),
      }),
    )
    for (const receipt of receipts) {
      expect(receipt).toEqual(receipts[0]!)
      expect(receipt.payload.operatorDecisions).toEqual(canonical)
      expect(receipt.payload.acknowledgementsDigest).toBe(valueDigest(canonical))
      expect(parseActivationReceipt(canonicalSchemaJson(receipt))).toEqual(receipt)
    }
    const journals = orders.map((operatorDecisions) => {
      const p = journalPayload()
      return createEpochSwitchJournal({ ...p, inputs: { ...p.inputs, operatorDecisions } })
    })
    for (const journal of journals) {
      expect(journal).toEqual(journals[0]!)
      expect(parseEpochSwitchJournal(canonicalSchemaJson(journal))).toEqual(journal)
    }
    expect(
      createActivationReceipt({
        ...activationPayload(),
        operatorDecisions: orders[1]!,
        acknowledgementsDigest: valueDigest(canonical),
      }),
    ).toEqual(receipts[0]!)
  })
  test('K-2 approval binds material facts, survives re-rendering and activation uses the latest run approval', () => {
    const plan = createMigrationPlanDocument(planPayload())
    const first = approveMigrationPlan({
      plan,
      approve: plan.approvalDigest,
      runId: 'run-1',
      approvedAt: 124,
      history: [],
    })
    let history = appendMigrationApproval([], first)
    expect(appendMigrationApproval(history, first)).toEqual(history)
    expect(() =>
      approveMigrationPlan({
        plan,
        approve: plan.digest,
        runId: 'run-1',
        approvedAt: 124,
        history,
      }),
    ).toThrow('v3-approval-digest-mismatch')
    const numeric = createMigrationPlanDocument({
      ...plan.payload,
      createdAt: 125,
      unfinishedTasks: [{ status: 'interrupted', count: 100 }],
    })
    expect(numeric.digest).not.toBe(plan.digest)
    expect(
      approveMigrationPlan({
        plan: numeric,
        approve: plan.approvalDigest,
        runId: 'run-1',
        approvedAt: 125,
        history,
      }),
    ).toEqual(first)
    const numericActivation = createActivationReceipt({
      ...activationPayload(),
      migrationPlanDigest: numeric.digest,
      approvalRecordDigest: first.digest,
    })
    expect(assertActivationApproval(numericActivation, history)).toEqual(first)
    const material = createMigrationPlanDocument({
      ...numeric.payload,
      operatorDecisions: [decision],
      conversionPlan: conversionPlan([decision]),
    })
    expect(() =>
      approveMigrationPlan({
        plan: material,
        approve: plan.approvalDigest,
        runId: 'run-1',
        approvedAt: 126,
        history,
      }),
    ).toThrow('v3-approval-digest-mismatch')
    const second = approveMigrationPlan({
      plan: material,
      approve: material.approvalDigest,
      runId: 'run-1',
      approvedAt: 126,
      history,
    })
    expect(second.payload).toMatchObject({
      sequence: 1,
      previousApprovalDigest: first.digest,
      planDigest: material.digest,
    })
    history = appendMigrationApproval(history, second)
    expect(latestMigrationApproval(history, 'run-1')).toEqual(second)
    expect(latestMigrationApproval(history, 'other-run')).toBeNull()
    expect(() => assertActivationApproval(numericActivation, history)).toThrow(
      'v3-activation-approval-mismatch',
    )
    const activated = createActivationReceipt({
      ...numericActivation.payload,
      migrationPlanDigest: material.digest,
      approvalDigest: material.approvalDigest,
      approvalRecordDigest: second.digest,
      operatorDecisions: [decision],
      acknowledgementsDigest: valueDigest([decision]),
    })
    expect(assertActivationApproval(activated, history)).toEqual(second)
    const journal = createEpochSwitchJournal({ ...journalPayload(), approvals: history })
    expect(parseEpochSwitchJournal(canonicalSchemaJson(journal)).payload.approvals).toEqual(history)
    const request: EpochSwitchApprovalRequest = {
      operationId,
      runId: 'run-1',
      planDigest: material.digest,
      approvalDigest: material.approvalDigest,
      planPath: null,
    }
    expect(JSON.parse(JSON.stringify(request))).toEqual(request)
    const conflict = createMigrationApproval({ ...second.payload, approvedAt: 127 })
    expect(() => appendMigrationApproval(history, conflict)).toThrow('v3-approval-history-conflict')
    for (const invalid of [
      [second],
      [second, first],
      [first, createMigrationApproval({ ...second.payload, sequence: 2 })],
      [first, createMigrationApproval({ ...second.payload, previousApprovalDigest: digest })],
      [
        first,
        createMigrationApproval({ ...second.payload, operationId: 'dbm_e2_other_operation' }),
      ],
      [{ ...first, digest }],
    ])
      expect(MigrationApprovalHistorySchema.safeParse(invalid).success).toBe(false)
    const nextRun = approveMigrationPlan({
      plan: material,
      approve: material.approvalDigest,
      runId: 'run-2',
      approvedAt: 127,
      history,
    })
    expect(nextRun.payload).toMatchObject({ sequence: 0, previousApprovalDigest: null })
    expect(appendMigrationApproval(history, nextRun)).toHaveLength(3)
  })
  test('K-3 rollback accepts an unrecorded activation and still refuses a first business write', () => {
    for (const targetState of ['retired', 'not-created'] as const) {
      const receipt = createRollbackReceipt({
        ...rollbackPayload(),
        targetState,
        runId: targetState === 'not-created' ? null : 'run-1',
        generationId: targetState === 'not-created' ? null : generationId,
        activationReceiptDigest: null,
      })
      expect(parseRollbackReceipt(canonicalSchemaJson(receipt))).toEqual(receipt)
      expect(() =>
        parseRollbackReceipt(
          JSON.stringify({ ...receipt, payload: { ...receipt.payload, firstLiveWriteAt: 1 } }),
        ),
      ).toThrow()
    }
  })
  test('K-4 block and history schemas continue to refuse empty task/run identities', () => {
    const block = {
      code: 'invalid-source',
      scope: 'row',
      sourceTable: 'tasks',
      sourceKey,
      taskId: null,
      runId: null,
      missingFields: [],
      detail: null,
    }
    expect(ConversionBlockSchema.safeParse(block).success).toBe(true)
    for (const field of ['taskId', 'runId'])
      expect(ConversionBlockSchema.safeParse({ ...block, [field]: '' }).success).toBe(false)
    const history = {
      taskId: 'task',
      runId: null,
      execution: 'retryable-history',
      missingFields: [],
    }
    expect(HistoryRestrictionSchema.safeParse(history).success).toBe(true)
    for (const field of ['taskId', 'runId'])
      expect(HistoryRestrictionSchema.safeParse({ ...history, [field]: '' }).success).toBe(false)
  })
  test('K-5 separate run content root is durable and material while source skills root stays fixed', () => {
    const content: ContentRootSpec = {
      kind: 'backup',
      root: '/backup',
      runContentRoot: '/supplied',
      runsSupplied: true,
      objects: 'none',
    }
    expect(ContentRootSpecSchema.parse(content)).toEqual(content)
    expect(ContentRootSpecSchema.safeParse({ ...content, runContentRoot: '' }).success).toBe(false)
    const p = journalPayload()
    const journal = createEpochSwitchJournal({
      ...p,
      inputs: { ...p.inputs, contentRoot: content },
    })
    expect(
      parseEpochSwitchJournal(canonicalSchemaJson(journal)).payload.inputs.contentRoot,
    ).toEqual(content)
    const plan = createMigrationPlanDocument({ ...planPayload(), content })
    const changed = createMigrationPlanDocument({
      ...plan.payload,
      content: { ...content, runContentRoot: '/other-runs' },
    })
    expect(changed.payload.content.root).toBe('/backup')
    expect(changed.approvalDigest).not.toBe(plan.approvalDigest)
  })
  test('K-6 every cross-Job evidence class has a digest-bound journal reference and streaming port', () => {
    const names = [
      'backup/payload',
      'restore/unpacked',
      'source-access/binding.json',
      'frozen/pre-upgrade/evidence',
      'plans/plan.json',
    ]
    const artifacts = names.map((name) => ({ name, digest: valueDigest(name) }))
    const journal = createEpochSwitchJournal({ ...journalPayload(), artifacts })
    expect(parseEpochSwitchJournal(canonicalSchemaJson(journal)).payload.artifacts).toEqual(
      artifacts,
    )
    expect(EpochSwitchArtifactReferenceSchema.safeParse({ name: '', digest }).success).toBe(false)
    expect(
      EpochSwitchArtifactReferenceSchema.safeParse({ name: 'backup/payload', digest: 'unknown' })
        .success,
    ).toBe(false)
    expectTypeOf<Parameters<EpochSwitchArtifactPort['put']>>().toEqualTypeOf<
      [string, Uint8Array | AsyncIterable<Uint8Array>]
    >()
    expectTypeOf<Parameters<EpochSwitchArtifactPort['get']>>().toEqualTypeOf<[string, string]>()
    expectTypeOf<SourceSnapshotRequest['artifacts']>().toEqualTypeOf<
      EpochSwitchArtifactPort | undefined
    >()
    expectTypeOf<
      ReturnType<NonNullable<EpochSwitchJournalPort['artifacts']>>
    >().toEqualTypeOf<EpochSwitchArtifactPort>()
  })
  test('K-7 PostgreSQL archive inputs distinguish retained bytes from born-PostgreSQL catalog evidence', () => {
    const inputs: SourceArchiveInput[] = [
      { kind: 'retained-epoch1-archive', path: '/retained/archive', digest },
      {
        kind: 'never-installed',
        evidence: {
          sourceBornOn: 'postgresql',
          sourceGenerationId: 'source-fixture',
          sourceWatermark: digest,
          catalogDigest: digest,
          expectedAbsent: [
            'code_artifacts',
            'code_fix_attempts',
            'code_mr_leases',
            'code_produced_mrs',
            'code_publish_intents',
            'code_work_observations',
          ],
        },
      },
    ]
    for (const input of inputs) expect(SourceArchiveInputSchema.parse(input)).toEqual(input)
    for (const input of [
      { kind: 'retained-epoch1-archive', path: '/archive' },
      { kind: 'never-installed' },
      { kind: 'never-installed', evidence: 'assumed empty' },
      { ...inputs[1], evidence: { sourceBornOn: 'sqlite' } },
    ])
      expect(SourceArchiveInputSchema.safeParse(input).success).toBe(false)
    expectTypeOf<Parameters<EpochBackupPort['create']>[0]['postgresqlArchive']>().toEqualTypeOf<
      SourceArchiveInput | undefined
    >()
  })
  test('K-8 target create/open accept the same fault callback; phase-2 approval ports share one record', () => {
    expectTypeOf<Parameters<TargetGenerationPort['create']>[0]['faults']>().toEqualTypeOf<
      EpochSwitchFaults | undefined
    >()
    expectTypeOf<Parameters<TargetGenerationPort['open']>[0]['faults']>().toEqualTypeOf<
      EpochSwitchFaults | undefined
    >()
    expectTypeOf<Parameters<NonNullable<TargetGenerationHandle['recordApproval']>>>().toEqualTypeOf<
      [MigrationApproval]
    >()
    expectTypeOf<
      Awaited<ReturnType<NonNullable<MigrationMetaReadPort['approvals']>>>
    >().toEqualTypeOf<readonly MigrationApproval[]>()
  })
  test('old-epoch restore and hosted receipts preserve original pointer bytes and nullable hosted paths', () => {
    const originalBytes = Buffer.from(' { "oldPointer": true }\r\n')
    const payload = activationPayload()
    const receipt = createActivationReceipt({
      ...payload,
      kind: 'old-epoch-restore',
      role: 'restored',
      deployment: 'crewstation',
      source: {
        ...payload.source,
        location: {
          kind: 'backup',
          sourceKind: 'hosted-backup',
          artifact: 'backup-object',
          root: '/restore',
        },
      },
      target: {
        ...payload.target,
        provider: 'postgresql',
        location: { kind: 'postgresql-target', profileRef: 'crewstation:target' },
      },
      backup: { ...payload.backup, kind: 'immutable-backup-source', path: null },
      previousPointer: {
        bytesBase64: originalBytes.toString('base64'),
        digest,
        generationId: 'old-active-generation',
      },
      restoreFiles: [
        {
          kind: 'skills',
          sourcePath: '/restore/skills',
          destinationPath: '/app/skills',
          replacedPath: '/op/replaced/skills',
        },
      ],
    })
    const parsed = parseActivationReceipt(canonicalSchemaJson(receipt))
    expect(Buffer.from(parsed.payload.previousPointer.bytesBase64!, 'base64')).toEqual(
      originalBytes,
    )
    expect(parsed.payload.backup.path).toBeNull()
    expect(parsed.payload.restoreFiles).toEqual(receipt.payload.restoreFiles)
    expect(() =>
      createRollbackReceipt({
        ...rollbackPayload(),
        firstLiveWriteAt: 123,
      } as unknown as RollbackReceiptPayload),
    ).toThrow()
  })
})

const expectedKeys: Readonly<Record<string, readonly string[]>> = {
  generations: ['generation_id'],
  migration_operations: ['operation_id'],
  migration_runs: ['run_id'],
  migration_approvals: ['run_id', 'sequence'],
  migration_units: ['run_id', 'unit_id'],
  migration_unit_sources: ['run_id', 'source_table', 'source_phase', 'unit_id'],
  migration_table_receipts: ['run_id', 'source_table', 'source_phase'],
  migration_row_dispositions: ['run_id', 'source_table', 'source_phase', 'source_key', 'ordinal'],
  migration_history_restrictions: [
    'task_id',
    'source_table',
    'source_phase',
    'source_key',
    'run_id',
    'ordinal',
  ],
  migration_artifact_receipts: ['run_id', 'source_table', 'source_key', 'source_column', 'ordinal'],
  migration_archives: ['run_id', 'archive_ref'],
  migration_records: ['run_id', 'unit_id', 'ordinal'],
  migration_identity_high_water: ['run_id', 'table_name', 'column_name'],
  migration_blocks: ['run_id', 'origin', 'unit_id', 'ordinal'],
  migration_operator_inputs: ['run_id', 'kind', 'ordinal'],
  migration_receipt_exports: ['run_id'],
  activation_receipts: ['generation_id'],
  switch_receipts: ['generation_id', 'kind'],
}
test('meta roster is exactly 18 PK-only migration tables plus the three R2 tables, with paired SQL columns', () => {
  expect(MIGRATION_META_TABLES.map((table) => table.name).sort()).toEqual(
    Object.keys(expectedKeys).sort(),
  )
  expect(EPOCH2_META_TABLES.slice(0, 3)).toEqual([...HISTORY_META_TABLES])
  expect(EPOCH2_META_TABLES).toHaveLength(21)
  for (const table of MIGRATION_META_TABLES) {
    expect(table.owner).toBe('system-operations')
    expect(table.implementation).toBe('platform')
    expect(table.primaryKey).toEqual(expectedKeys[table.name]!)
    const expected = Object.values(table.columns).map((column) => column.name)
    const statements = ['sqlite', 'postgresql'].map(
      (provider) => compileMetaTables(provider as 'sqlite' | 'postgresql', [table]).at(-1)!,
    )
    for (const statement of statements) {
      const columns = [
        ...statement.matchAll(
          /(?:\(|, )"([a-z_][a-z0-9_]*)" (?:TEXT|INTEGER|BIGINT|BOOLEAN|BLOB|BYTEA)/g,
        ),
      ].map((match) => match[1]!)
      expect(columns).toEqual(expected)
      expect(statement).not.toMatch(/FOREIGN KEY|CHECK|CREATE INDEX/)
    }
    for (const name of table.primaryKey)
      expect(Object.values(table.columns).find((column) => column.name === name)!.nullable).toBe(
        false,
      )
  }
  const ranges = MIGRATION_META_TABLES.find((table) => table.name === 'migration_unit_sources')!
  expect(ranges.columns.firstKey!.nullable).toBe(true)
  expect(ranges.columns.lastKey!.nullable).toBe(true)
})

describeV3Providers('RFC-395 V3 meta catalog contract', (h) => {
  test('head plus the complete meta area and sentinel admits; real catalog columns match declarations', async () => {
    await h.installHead()
    expect((await h.admit()).contract.digest).toBe(h.head.contract.digest)
    for (const table of EPOCH2_META_TABLES) {
      const rows =
        h.targetProvider === 'sqlite'
          ? await h.target.execute(`PRAGMA table_info("aw_meta_${table.name}")`)
          : await h.target.execute(
              'SELECT column_name AS name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
              ['agent_workflow_meta', table.name],
            )
      expect(rows.map((row) => row.name)).toEqual(
        Object.values(table.columns).map((column) => column.name),
      )
    }
    if (h.targetProvider === 'postgresql')
      expect((await h.catalog()).metaDigest).toBe(digestSchemaContract(EPOCH2_META_TABLES))
  }, 90000)
  test('source and target are independent and the source input uses the full V2 bootstrap assembly', async () => {
    await h.source.install()
    const input = await h.input()
    expect(input.sourceScope).toBeUndefined()
    expect(input.targetGeneration).toBe(h.generationId)
    expect(input.preflight.fingerprint.provider).toBe(h.sourceProvider)
    expect(h.operationRoot.startsWith(h.appHome)).toBe(true)
    expect(h.pointerPath).not.toBe(h.daemonLockPath)
    expect(h.operationLockPath).not.toBe(h.daemonLockPath)
    const before = input.preflight.watermark
    await h.installHead()
    await input.source.assertUnchanged(input.preflight)
    expect((await input.source.preflight()).watermark).toBe(before)
  }, 90000)
})
describeV3CrossProvider('RFC-395 V3 cross-provider contract', (h) => {
  test('a frozen SQLite source remains unchanged while a separate PostgreSQL target admits', async () => {
    expect(h.sourceProvider).toBe('sqlite')
    expect(h.targetProvider).toBe('postgresql')
    await h.source.install()
    const input = await h.input()
    expect(input.preflight.fingerprint.provider).toBe('sqlite')
    await h.installHead()
    expect((await h.admit()).contract.digest).toBe(h.head.contract.digest)
    await input.source.assertUnchanged(input.preflight)
  }, 90000)
})
