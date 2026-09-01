// RFC-310 PR-9 T94/T95 —— 迁移分析的读侧 + candidates 落库（design §13.1/§13.2）。
//
// 读侧只读 legacy 表（capability_templates / repo_capability_config 是被
// PR-10 退役的只读历史，本文件绝不写它们）；落库侧把 mappable/partial 的
// targets 通过**既有创建命令**建为 draft——绝不 publish、绝不写 assignment
// 路由面。幂等：同 (owner, name) 已存在即 skipped，重跑不重复建。
//
// 呈报过的两个判定（fork Y 契约判断点，详见 migrationAnalyzer.ts 文件头）：
//   - development-adapter targets 不落库（create 强制 strict content +
//     scripts:author，伪造 executableRef 会产出说谎的资源）→ skipped
//     'manual-authoring-required'；
//   - repository-assignment targets 不落库（写 assignment = 实时翻路由）→
//     skipped 'proposal-only'。
//
// 迁移元信息（sourceDigest/blockedReasons/notes）不塞进资源 draft——各资源
// content schema 是 strict 的，未知键会在 publish 时被拒，逼人工删注记是
// 反目标。整份报告 + materialize 结果持久化到 maintenance_state
// （key 'rfc310-migration-report'）供 CLI/UI/cutover preflight 对账；删掉后
// 重跑分析即可重建（可推导，符合该表「维护缓存」定位）。
//
// visibility 沿 legacy 行：创建命令按 RFC-099 统一落 private，这里在创建后
// 对 legacy 'public' 行做一次 migration-only 直写恢复——这不是新建路径放宽，
// 是既有资源的 ACL 事实随迁移保留（§13.2「id、owner、visibility、ACL、
// upstream provenance 尽可能保留」）。

import { and, eq, sql } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  actionTemplates,
  automationPolicies,
  capabilityTemplates,
  digitalEmployees,
  maintenanceState,
  repoCapabilityConfig,
} from '@/db/schema'
import { createActionTemplate } from '../application/commands/actionTemplateCommands'
import {
  analyzeLegacyAssets,
  type AnalyzeLegacyInput,
  type MigrationReport,
  type MigrationTargetResource,
} from '../application/migrationAnalyzer'
import { createSqliteActionTemplatePersistence } from './sqliteConfigResourceStore'
import { createAutomationPolicy, createDigitalEmployee } from './sqliteDigitalEmployeeStore'
import type { DevelopmentMigrationPersistence } from '../application/ports/migrationPersistence'

export const MIGRATION_REPORT_KEY = 'rfc310-migration-report'

// ---------------------------------------------------------------------------
// T94 读侧
// ---------------------------------------------------------------------------

export async function collectLegacyAssets(db: DbClient): Promise<AnalyzeLegacyInput> {
  const templates = await db
    .select({
      id: capabilityTemplates.id,
      name: capabilityTemplates.name,
      capability: capabilityTemplates.capability,
      scriptsJson: capabilityTemplates.scriptsJson,
      hooksJson: capabilityTemplates.hooksJson,
      paramSchemaJson: capabilityTemplates.paramSchemaJson,
      paramDefaultsJson: capabilityTemplates.paramDefaultsJson,
      agentBySlotJson: capabilityTemplates.agentBySlotJson,
      promptBySlotJson: capabilityTemplates.promptBySlotJson,
      paramsJson: capabilityTemplates.paramsJson,
      upstreamId: capabilityTemplates.upstreamId,
      upstreamVersion: capabilityTemplates.upstreamVersion,
      baseDigest: capabilityTemplates.baseDigest,
      ownerUserId: capabilityTemplates.ownerUserId,
      visibility: capabilityTemplates.visibility,
      builtin: capabilityTemplates.builtin,
    })
    .from(capabilityTemplates)
  const matrix = await db
    .select({
      repoId: repoCapabilityConfig.repoId,
      capability: repoCapabilityConfig.capability,
      templateId: repoCapabilityConfig.templateId,
      enabled: repoCapabilityConfig.enabled,
      triggerConfigJson: repoCapabilityConfig.triggerConfigJson,
    })
    .from(repoCapabilityConfig)
  return { templates, matrix }
}

export async function runMigrationAnalysis(
  db: DbClient,
  generatedAt: number,
): Promise<MigrationReport> {
  return analyzeLegacyAssets(await collectLegacyAssets(db), generatedAt)
}

// ---------------------------------------------------------------------------
// T95 落库
// ---------------------------------------------------------------------------

export interface MaterializedCandidate {
  readonly resource: MigrationTargetResource
  readonly proposedName: string
  readonly resourceId: string
  readonly sourceDigest: string
}

export interface SkippedCandidate {
  readonly resource: MigrationTargetResource
  readonly proposedName: string
  readonly reason: 'name-exists' | 'manual-authoring-required' | 'proposal-only'
}

export interface MaterializeResult {
  readonly created: readonly MaterializedCandidate[]
  readonly skipped: readonly SkippedCandidate[]
}

type IdentityTable = typeof actionTemplates | typeof digitalEmployees | typeof automationPolicies

async function nameExists(
  db: DbClient,
  table: IdentityTable,
  ownerUserId: string | null,
  name: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(
      and(eq(table.name, name), eq(sql`COALESCE(${table.ownerUserId}, '')`, ownerUserId ?? '')),
    )
    .limit(1)
  return rows.length > 0
}

/** migration-only：把 legacy 'public' 的 ACL 事实带到 candidate 上（见文件头）。 */
async function restoreVisibility(
  db: DbClient,
  table: IdentityTable,
  id: string,
  visibility: 'public' | 'private',
): Promise<void> {
  if (visibility !== 'public') return
  await db.update(table).set({ visibility: 'public' }).where(eq(table.id, id))
}

export async function materializeMigrationCandidates(
  db: DbClient,
  report: MigrationReport,
  opts: { readonly now?: () => number } = {},
): Promise<MaterializeResult> {
  const now = opts.now ?? (() => Date.now())
  const created: MaterializedCandidate[] = []
  const skipped: SkippedCandidate[] = []
  const templateStore = createSqliteActionTemplatePersistence(db)

  for (const item of report.items) {
    if (item.disposition === 'blocked') continue
    for (const target of item.targets) {
      if (target.resource === 'development-adapter') {
        skipped.push({
          resource: target.resource,
          proposedName: target.proposedName,
          reason: 'manual-authoring-required',
        })
        continue
      }
      if (target.resource === 'repository-assignment') {
        skipped.push({
          resource: target.resource,
          proposedName: target.proposedName,
          reason: 'proposal-only',
        })
        continue
      }
      const table =
        target.resource === 'action-template'
          ? actionTemplates
          : target.resource === 'digital-employee'
            ? digitalEmployees
            : automationPolicies
      if (await nameExists(db, table, item.ownerUserId, target.proposedName)) {
        skipped.push({
          resource: target.resource,
          proposedName: target.proposedName,
          reason: 'name-exists',
        })
        continue
      }
      let resourceId: string
      if (target.resource === 'action-template') {
        const record = await createActionTemplate(
          { store: templateStore, now },
          {
            actorUserId: item.ownerUserId,
            name: target.proposedName,
            capabilityId: target.capabilityId ?? '',
            draft: target.draft,
          },
        )
        resourceId = record.id
      } else if (target.resource === 'digital-employee') {
        const record = await createDigitalEmployee(db, {
          name: target.proposedName,
          ownerUserId: item.ownerUserId,
          draft: target.draft,
        })
        resourceId = record.id
      } else {
        const record = await createAutomationPolicy(db, {
          name: target.proposedName,
          ownerUserId: item.ownerUserId,
          draft: target.draft,
        })
        resourceId = record.id
      }
      await restoreVisibility(db, table, resourceId, item.visibility)
      created.push({
        resource: target.resource,
        proposedName: target.proposedName,
        resourceId,
        sourceDigest: item.sourceDigest,
      })
    }
  }

  const payload = JSON.stringify({ report, materializedAt: now(), created, skipped })
  await db
    .insert(maintenanceState)
    .values({ key: MIGRATION_REPORT_KEY, value: payload, updatedAt: now() })
    .onConflictDoUpdate({
      target: maintenanceState.key,
      set: { value: payload, updatedAt: now() },
    })

  return { created, skipped }
}

export interface PersistedMigrationRun {
  readonly report: MigrationReport
  readonly materializedAt: number
  readonly created: readonly MaterializedCandidate[]
  readonly skipped: readonly SkippedCandidate[]
}

export async function readPersistedMigrationRun(
  db: DbClient,
): Promise<PersistedMigrationRun | null> {
  const rows = await db
    .select({ value: maintenanceState.value })
    .from(maintenanceState)
    .where(eq(maintenanceState.key, MIGRATION_REPORT_KEY))
    .limit(1)
  const row = rows[0]
  if (row === undefined) return null
  try {
    return JSON.parse(row.value) as PersistedMigrationRun
  } catch {
    return null
  }
}

export function createSqliteDevelopmentMigrationPersistence(
  db: DbClient,
): DevelopmentMigrationPersistence {
  return {
    analyze: (generatedAt) => runMigrationAnalysis(db, generatedAt),
    materialize: (report) => materializeMigrationCandidates(db, report),
    readPersisted: () => readPersistedMigrationRun(db),
  }
}
