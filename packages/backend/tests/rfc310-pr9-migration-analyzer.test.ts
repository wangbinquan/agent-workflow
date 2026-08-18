// RFC-310 PR-9 T94/T95/T96 —— legacy 资产迁移分析器 + candidates 落库锁。
//
// 锁定 design §13.2 映射表的判定语义：
//   - agent/prompt 可机械迁 → 对应 capability 的 ActionTemplate draft；
//   - arbitrate/select 脚本、hooks 绝不被翻译成等价规则（typed blockedReasons）；
//   - mr-review 双候选 + 'mr-review-purpose-choice'（必须人工二选一）；
//   - requirement 按 analyst/implementer 双 slot 拆分，缺 slot 显式记账；
//   - 矩阵五格闭包才生成 DigitalEmployee draft + assignment proposal，缺格
//     'matrix-incomplete:<capability>'；
//   - materialize 只建 draft（publishedRevision null）、幂等（重跑 skipped）、
//     owner/visibility 沿 legacy 行；adapter/assignment 目标只提案不落库。
// sourceDigest 复跑稳定是 cutover preflight 对账的前提，一并锁住。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb } from '../src/db/client'
import type { DbClient } from '../src/db/client'
import {
  actionTemplates,
  automationPolicies,
  capabilityTemplates,
  digitalEmployees,
  maintenanceState,
  repoCapabilityConfig,
} from '../src/db/schema'
import {
  analyzeLegacyAssets,
  legacyTemplateSourceDigest,
  printMigrationReport,
  type LegacyMatrixRow,
  type LegacyTemplateRow,
} from '../src/modules/development-automation/application/migrationAnalyzer'
import {
  collectLegacyAssets,
  materializeMigrationCandidates,
  MIGRATION_REPORT_KEY,
  readPersistedMigrationRun,
} from '../src/modules/development-automation/infrastructure/migrationAssets'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function legacyRow(overrides: Partial<LegacyTemplateRow> & { id: string }): LegacyTemplateRow {
  return {
    name: overrides.id,
    capability: 'mr-comment-fix',
    scriptsJson: '{}',
    hooksJson: '[]',
    paramSchemaJson: '[]',
    paramDefaultsJson: '{}',
    agentBySlotJson: '{}',
    promptBySlotJson: '{}',
    paramsJson: '{}',
    upstreamId: null,
    upstreamVersion: null,
    baseDigest: null,
    ownerUserId: null,
    visibility: 'public',
    builtin: false,
    ...overrides,
  }
}

function analyze(templates: LegacyTemplateRow[], matrix: LegacyMatrixRow[] = []) {
  return analyzeLegacyAssets({ templates, matrix }, 1_700_000_000_000)
}

describe('rfc310 pr9 migration analyzer (T94)', () => {
  test('clean mr-comment-fix template maps to a mr.feedback.apply draft with agent/prompt carried over', () => {
    const report = analyze([
      legacyRow({
        id: 'tpl-fix',
        name: 'comment-fixer',
        capability: 'mr-comment-fix',
        agentBySlotJson: JSON.stringify({ fixer: 'agent-alpha' }),
        promptBySlotJson: JSON.stringify({ fixer: 'fix politely' }),
        ownerUserId: 'user-a',
        visibility: 'private',
      }),
    ])
    expect(report.summary).toEqual({ total: 1, mappable: 1, partial: 0, blocked: 0 })
    const item = report.items[0]!
    expect(item.disposition).toBe('mappable')
    expect(item.blockedReasons).toEqual([])
    expect(item.targets).toHaveLength(1)
    const target = item.targets[0]!
    expect(target.resource).toBe('action-template')
    expect(target.proposedName).toBe('comment-fixer')
    expect(target.capabilityId).toBe('mr.feedback.apply')
    const draft = target.draft as Record<string, unknown>
    expect(draft.capabilityId).toBe('mr.feedback.apply')
    expect(draft.executor).toEqual({ kind: 'agent', agentRef: 'agent-alpha' })
    expect(draft.promptSupplement).toBe('fix politely')
  })

  test('arbitrate/select scripts are blocked reasons, never translated into targets', () => {
    const report = analyze([
      legacyRow({
        id: 'tpl-ci',
        name: 'ci-fixer-tpl',
        capability: 'ci-fix',
        scriptsJson: JSON.stringify({
          arbitrate: { language: 'node', script: 'decide()' },
          select: { language: 'node', script: 'pick()' },
        }),
        // 故意不配 agent slot：该模板没有任何可机械迁移面 → 整体 blocked。
      }),
    ])
    const item = report.items[0]!
    expect(item.disposition).toBe('blocked')
    expect(item.targets).toEqual([])
    expect(item.blockedReasons).toContain('arbitrate-script')
    expect(item.blockedReasons).toContain('select-script')
    expect(item.blockedReasons).toContain('slot-unassigned:ci-fixer')
  })

  test('hooks are blocked per hook with typed reasons (default-deny, §13.2 last row)', () => {
    const report = analyze([
      legacyRow({
        id: 'tpl-hooked',
        name: 'hooked',
        capability: 'mr-comment-fix',
        hooksJson: JSON.stringify([
          { stage: 'fix', phase: 'pre', language: 'bash', script: 'echo hi', blocking: true },
          {
            stage: 'publish',
            phase: 'post',
            language: 'node',
            script: 'notify()',
            blocking: false,
          },
        ]),
        agentBySlotJson: JSON.stringify({ fixer: 'agent-a' }),
      }),
    ])
    const item = report.items[0]!
    // agent 面仍可迁（target 存在），hooks 逐条挡在 blockedReasons → partial。
    expect(item.disposition).toBe('partial')
    expect(item.blockedReasons).toContain('hook:fix:pre')
    expect(item.blockedReasons).toContain('hook:publish:post')
  })

  test('mr-review yields both candidate drafts as partial with the purpose-choice reason', () => {
    const report = analyze([
      legacyRow({
        id: 'tpl-review',
        name: 'reviewer-tpl',
        capability: 'mr-review',
        agentBySlotJson: JSON.stringify({ reviewer: 'agent-r' }),
        promptBySlotJson: JSON.stringify({ reviewer: 'review carefully' }),
      }),
    ])
    const item = report.items[0]!
    expect(item.disposition).toBe('partial')
    expect(item.blockedReasons).toContain('mr-review-purpose-choice')
    const caps = item.targets.map((t) => t.capabilityId).sort()
    expect(caps).toEqual(['change.review', 'mr.review.external'])
    for (const target of item.targets) {
      expect((target.draft as Record<string, unknown>).promptSupplement).toBe('review carefully')
    }
  })

  test('requirement splits into analyze/implement drafts by slot; a missing slot is ledgered', () => {
    const full = analyze([
      legacyRow({
        id: 'tpl-req',
        name: 'req-tpl',
        capability: 'requirement',
        agentBySlotJson: JSON.stringify({ analyst: 'agent-an', implementer: 'agent-im' }),
        promptBySlotJson: JSON.stringify({ analyst: 'think', implementer: 'build' }),
      }),
    ]).items[0]!
    expect(full.disposition).toBe('mappable')
    expect(full.targets.map((t) => t.capabilityId).sort()).toEqual([
      'change.implement',
      'requirement.analyze',
    ])
    const implement = full.targets.find((t) => t.capabilityId === 'change.implement')!
    expect((implement.draft as Record<string, unknown>).executor).toEqual({
      kind: 'agent',
      agentRef: 'agent-im',
    })
    expect((implement.draft as Record<string, unknown>).promptSupplement).toBe('build')

    const half = analyze([
      legacyRow({
        id: 'tpl-req2',
        name: 'req-tpl2',
        capability: 'requirement',
        agentBySlotJson: JSON.stringify({ analyst: 'agent-an' }),
      }),
    ]).items[0]!
    expect(half.disposition).toBe('partial')
    expect(half.targets.map((t) => t.capabilityId)).toEqual(['requirement.analyze'])
    expect(half.blockedReasons).toContain('slot-unassigned:implementer')
  })

  test('entry/collect/classify scripts become report-only adapter candidates with fixed purposes', () => {
    const item = analyze([
      legacyRow({
        id: 'tpl-scripts',
        name: 'scripted',
        capability: 'mr-monitor',
        scriptsJson: JSON.stringify({
          collect: { language: 'node', script: 'collect()' },
          classify: { language: 'node', script: 'classify()' },
        }),
      }),
    ]).items[0]!
    const adapters = item.targets.filter((t) => t.resource === 'development-adapter')
    expect(adapters.map((t) => (t.draft as { purpose: string }).purpose).sort()).toEqual([
      'pipeline-classifier',
      'pipeline-gate',
    ])
    // monitor 模板本身 → policy draft（fixed-3 机械迁入）。
    const policy = item.targets.find((t) => t.resource === 'automation-policy')!
    expect(
      (policy.draft as { retry: { freshSessionReruns: number } }).retry.freshSessionReruns,
    ).toBe(3)
  })

  test('sourceDigest is reproducible across repeated analysis of the same row', () => {
    const row = legacyRow({
      id: 'tpl-digest',
      name: 'digest-tpl',
      agentBySlotJson: JSON.stringify({ fixer: 'agent-a' }),
    })
    expect(legacyTemplateSourceDigest(row)).toBe(legacyTemplateSourceDigest({ ...row }))
    const a = analyze([row]).items[0]!
    const b = analyze([row]).items[0]!
    expect(a.sourceDigest).toBe(b.sourceDigest)
    expect(a.sourceDigest).not.toBe(
      legacyTemplateSourceDigest(legacyRow({ ...row, name: 'renamed' })),
    )
  })

  test('matrix: five-cell closure yields employee draft + assignment proposal; a missing cell is matrix-incomplete', () => {
    const templates = [
      legacyRow({
        id: 't-req',
        name: 'm-req',
        capability: 'requirement',
        agentBySlotJson: JSON.stringify({ analyst: 'a1', implementer: 'a2' }),
      }),
      legacyRow({
        id: 't-fix',
        name: 'm-fix',
        capability: 'mr-comment-fix',
        agentBySlotJson: JSON.stringify({ fixer: 'a3' }),
      }),
      legacyRow({
        id: 't-ci',
        name: 'm-ci',
        capability: 'ci-fix',
        agentBySlotJson: JSON.stringify({ 'ci-fixer': 'a4' }),
      }),
      legacyRow({
        id: 't-rev',
        name: 'm-rev',
        capability: 'mr-review',
        agentBySlotJson: JSON.stringify({ reviewer: 'a5' }),
      }),
      legacyRow({ id: 't-mon', name: 'm-mon', capability: 'mr-monitor' }),
    ]
    const cell = (capability: string, templateId: string): LegacyMatrixRow => ({
      repoId: 'repo-1',
      capability,
      templateId,
      enabled: true,
      triggerConfigJson: '{}',
    })
    const closed = analyze(templates, [
      cell('requirement', 't-req'),
      cell('mr-comment-fix', 't-fix'),
      cell('ci-fix', 't-ci'),
      cell('mr-review', 't-rev'),
      cell('mr-monitor', 't-mon'),
    ])
    const matrixItem = closed.items.find((i) => i.legacyKind === 'repo-capability-config')!
    expect(matrixItem.disposition).toBe('mappable')
    const employee = matrixItem.targets.find((t) => t.resource === 'digital-employee')!
    const draft = employee.draft as {
      capabilityRoutes: Array<{ capabilityId: string; fallbackTemplateRef: { id: string } }>
      defaultPolicyRef: { id: string; revision: number }
    }
    expect(draft.capabilityRoutes.map((r) => r.capabilityId).sort()).toEqual([
      'change.implement',
      'change.review',
      'mr.feedback.apply',
      'pipeline.repair',
      'requirement.analyze',
    ])
    // 占位 ref 指向 proposedName、revision 0（显式「未发布」标记）。
    expect(draft.defaultPolicyRef).toEqual({ id: 'migration:m-mon', revision: 0 })
    expect(
      draft.capabilityRoutes.find((r) => r.capabilityId === 'mr.feedback.apply')!
        .fallbackTemplateRef.id,
    ).toBe('migration:m-fix')
    expect(matrixItem.targets.some((t) => t.resource === 'repository-assignment')).toBe(true)

    const open = analyze(templates, [
      cell('requirement', 't-req'),
      cell('mr-comment-fix', 't-fix'),
      cell('ci-fix', 't-ci'),
      cell('mr-review', 't-rev'),
      // mr-monitor 格缺失。
    ])
    const openItem = open.items.find((i) => i.legacyKind === 'repo-capability-config')!
    expect(openItem.disposition).toBe('blocked')
    expect(openItem.targets).toEqual([])
    expect(openItem.blockedReasons).toContain('matrix-incomplete:mr-monitor')
  })

  test('printMigrationReport renders dispositions, targets and blocked reasons', () => {
    const report = analyze([
      legacyRow({
        id: 'tpl-print',
        name: 'printable',
        agentBySlotJson: JSON.stringify({ fixer: 'agent-a' }),
      }),
      legacyRow({ id: 'tpl-blocked', name: 'stuck', capability: 'weird-cap' }),
    ])
    const text = printMigrationReport(report)
    expect(text).toContain('MAPPABLE')
    expect(text).toContain('printable')
    expect(text).toContain('BLOCKED')
    expect(text).toContain('unknown-capability:weird-cap')
    expect(text).toContain('→ action-template')
  })
})

// ---------------------------------------------------------------------------
// T95：真 sqlite 落库（读 legacy 表 → 分析 → materialize draft）。
// ---------------------------------------------------------------------------

async function seedLegacy(db: DbClient): Promise<void> {
  const now = 1_700_000_000_000
  await db.insert(capabilityTemplates).values([
    {
      id: 't-fix',
      name: 'm-fix',
      capability: 'mr-comment-fix',
      agentBySlotJson: JSON.stringify({ fixer: 'agent-a' }),
      promptBySlotJson: JSON.stringify({ fixer: 'be kind' }),
      ownerUserId: 'user-a',
      visibility: 'public',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 't-mon',
      name: 'm-mon',
      capability: 'mr-monitor',
      ownerUserId: 'user-b',
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 't-blocked',
      name: 'm-blocked',
      capability: 'ci-fix',
      scriptsJson: JSON.stringify({ arbitrate: { language: 'node', script: 'x' } }),
      createdAt: now,
      updatedAt: now,
    },
  ])
}

describe('rfc310 pr9 migration materialize (T95)', () => {
  test('creates drafts only (never published), preserves owner/visibility, skips proposals, idempotent on rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedLegacy(db)
    let tick = 1_700_000_100_000
    const now = () => tick++

    const report = analyzeLegacyAssets(await collectLegacyAssets(db), now())
    const first = await materializeMigrationCandidates(db, report, { now })

    // t-fix → action-template；t-mon → automation-policy；t-blocked → 无产物。
    expect(first.created.map((c) => `${c.resource}:${c.proposedName}`).sort()).toEqual([
      'action-template:m-fix',
      'automation-policy:m-mon',
    ])
    const templateRow = (
      await db.select().from(actionTemplates).where(eq(actionTemplates.name, 'm-fix'))
    )[0]!
    expect(templateRow.publishedRevision).toBeNull()
    expect(templateRow.ownerUserId).toBe('user-a')
    // legacy public 行的 visibility 随迁移保留（RFC-099 新建默认 private 被
    // migration-only 直写恢复为 public——§13.2 保留 ACL 事实）。
    expect(templateRow.visibility).toBe('public')
    expect(templateRow.capabilityId).toBe('mr.feedback.apply')
    const draft = JSON.parse(templateRow.draftJson) as Record<string, unknown>
    expect(draft.executor).toEqual({ kind: 'agent', agentRef: 'agent-a' })

    const policyRow = (
      await db.select().from(automationPolicies).where(eq(automationPolicies.name, 'm-mon'))
    )[0]!
    expect(policyRow.publishedRevision).toBeNull()
    expect(policyRow.ownerUserId).toBe('user-b')
    expect(policyRow.visibility).toBe('private')
    expect(
      (JSON.parse(policyRow.draftJson) as { retry: { freshSessionReruns: number } }).retry
        .freshSessionReruns,
    ).toBe(3)

    // 报告 + 结果持久化到 maintenance_state（cutover preflight 的对账物料）。
    const persisted = await readPersistedMigrationRun(db)
    expect(persisted).not.toBeNull()
    expect(persisted!.created).toHaveLength(2)
    expect(persisted!.report.summary.total).toBe(report.summary.total)
    const kv = (
      await db.select().from(maintenanceState).where(eq(maintenanceState.key, MIGRATION_REPORT_KEY))
    )[0]!
    expect(kv.value).toContain('m-fix')

    // 幂等：重跑全部 skipped（name-exists），不重复建行。
    const second = await materializeMigrationCandidates(db, report, { now })
    expect(second.created).toEqual([])
    expect(
      second.skipped
        .filter((s) => s.reason === 'name-exists')
        .map((s) => s.proposedName)
        .sort(),
    ).toEqual(['m-fix', 'm-mon'])
    expect((await db.select().from(actionTemplates)).length).toBe(1)
    expect((await db.select().from(automationPolicies)).length).toBe(1)
  })

  test('five-cell matrix closure materializes the employee draft; adapter/assignment targets stay proposals', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const now0 = 1_700_000_000_000
    await db.insert(capabilityTemplates).values(
      [
        {
          id: 't-req',
          name: 'm-req',
          capability: 'requirement',
          agentBySlotJson: JSON.stringify({ analyst: 'a1', implementer: 'a2' }),
        },
        {
          id: 't-fix',
          name: 'm-fix',
          capability: 'mr-comment-fix',
          agentBySlotJson: JSON.stringify({ fixer: 'a3' }),
        },
        {
          id: 't-ci',
          name: 'm-ci',
          capability: 'ci-fix',
          agentBySlotJson: JSON.stringify({ 'ci-fixer': 'a4' }),
          // entry 脚本 → adapter candidate（proposal-only 的验证对象）。
          scriptsJson: JSON.stringify({ entry: { language: 'node', script: 'run()' } }),
        },
        {
          id: 't-rev',
          name: 'm-rev',
          capability: 'mr-review',
          agentBySlotJson: JSON.stringify({ reviewer: 'a5' }),
        },
        { id: 't-mon', name: 'm-mon', capability: 'mr-monitor' },
      ].map((row) => ({ ...row, createdAt: now0, updatedAt: now0 })),
    )
    await db.insert(repoCapabilityConfig).values(
      ['requirement', 'mr-comment-fix', 'ci-fix', 'mr-review', 'mr-monitor'].map(
        (capability, i) => ({
          id: `cell-${i}`,
          repoId: 'repo-1',
          capability,
          templateId: ['t-req', 't-fix', 't-ci', 't-rev', 't-mon'][i]!,
          enabled: true,
          createdAt: now0,
          updatedAt: now0,
        }),
      ),
    )

    let tick = 1_700_000_100_000
    const now = () => tick++
    const report = analyzeLegacyAssets(await collectLegacyAssets(db), now())
    const result = await materializeMigrationCandidates(db, report, { now })

    const employeeRow = (
      await db
        .select()
        .from(digitalEmployees)
        .where(eq(digitalEmployees.name, 'migrated-employee-repo-1'))
    )[0]!
    expect(employeeRow.publishedRevision).toBeNull()
    const employeeDraft = JSON.parse(employeeRow.draftJson) as {
      capabilityRoutes: Array<{ capabilityId: string }>
    }
    expect(employeeDraft.capabilityRoutes.map((r) => r.capabilityId)).toContain('mr.feedback.apply')

    // adapter 与 assignment 目标不落库，带 typed skip 理由。
    const reasons = new Map(
      result.skipped.map((s) => [`${s.resource}:${s.proposedName}`, s.reason]),
    )
    expect(reasons.get('development-adapter:m-ci-entry-adapter')).toBe('manual-authoring-required')
    expect(reasons.get('repository-assignment:assignment-repo-1')).toBe('proposal-only')
    // mr-review 双候选都以 draft 落库（人工二选一后删另一份/不发布即可）。
    const reviewRows = await db.select({ name: actionTemplates.name }).from(actionTemplates)
    expect(reviewRows.map((r) => r.name).sort()).toContain('m-rev-change-review')
    expect(reviewRows.map((r) => r.name).sort()).toContain('m-rev-mr-review-external')
  })
})
