// RFC-310 PR-9 T94/T95 —— 迁移分析的读侧 + candidates 落库（design §13.1/§13.2）。RFC-359 W4-D6b 起一份
// 实现，两个 provider 共用。
//
// 读侧只读 legacy 表（capability_templates / repo_capability_config 是被
// PR-10 退役的只读历史，本文件绝不写它们）；落库侧把 mappable/partial 的
// targets 通过**既有创建路径**建为 draft——绝不 publish、绝不写 assignment
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
// visibility 沿 legacy 行：创建路径按 RFC-099 统一落 private，这里在创建后
// 对 legacy 'public' 行做一次 migration-only 直写恢复——这不是新建路径放宽，
// 是既有资源的 ACL 事实随迁移保留（§13.2「id、owner、visibility、ACL、
// upstream provenance 尽可能保留」）。

import { and, eq, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
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
import type {
  DevelopmentMigrationPersistence,
  MaterializedMigrationCandidate,
  MaterializeMigrationResult,
  PersistedMigrationRun,
  SkippedMigrationCandidate,
} from '../application/ports/migrationPersistence'
import { createActionTemplatePersistence } from './configResourceStore'
import { createDevelopmentConfigPersistence } from './developmentConfigPersistence'

export const MIGRATION_REPORT_KEY = 'rfc310-migration-report'

// ---------------------------------------------------------------------------
// T94 读侧
// ---------------------------------------------------------------------------

export async function collectLegacyAssets(
  db: ProviderNeutralDatabase,
): Promise<AnalyzeLegacyInput> {
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
  db: ProviderNeutralDatabase,
  generatedAt: number,
): Promise<MigrationReport> {
  return analyzeLegacyAssets(await collectLegacyAssets(db), generatedAt)
}

// ---------------------------------------------------------------------------
// T95 落库
// ---------------------------------------------------------------------------

type MaterializableResource = Extract<
  MigrationTargetResource,
  'action-template' | 'digital-employee' | 'automation-policy'
>

type IdentityTable = typeof actionTemplates | typeof digitalEmployees | typeof automationPolicies

function identityTableOf(resource: MaterializableResource): IdentityTable {
  return resource === 'action-template'
    ? actionTemplates
    : resource === 'digital-employee'
      ? digitalEmployees
      : automationPolicies
}

/** 幂等键 (owner, name)：owner 为 NULL 的 legacy 行按 IS NULL 命中，两个引擎同一条谓词。 */
async function nameExists(
  db: ProviderNeutralDatabase,
  table: IdentityTable,
  ownerUserId: string | null,
  name: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        eq(table.name, name),
        ownerUserId === null ? isNull(table.ownerUserId) : eq(table.ownerUserId, ownerUserId),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/** migration-only：把 legacy 'public' 的 ACL 事实带到 candidate 上（见文件头）。 */
async function restoreVisibility(
  db: ProviderNeutralDatabase,
  table: IdentityTable,
  id: string,
  visibility: 'public' | 'private',
): Promise<void> {
  if (visibility !== 'public') return
  await db.update(table).set({ visibility: 'public' }).where(eq(table.id, id))
}

export async function materializeMigrationCandidates(
  db: ProviderNeutralDatabase,
  report: MigrationReport,
  opts: { readonly now?: () => number } = {},
): Promise<MaterializeMigrationResult> {
  const now = opts.now ?? (() => Date.now())
  const created: MaterializedMigrationCandidate[] = []
  const skipped: SkippedMigrationCandidate[] = []
  const templates = createActionTemplatePersistence(db)
  const config = createDevelopmentConfigPersistence(db)

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
      const table = identityTableOf(target.resource)
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
          { store: templates, now },
          {
            actorUserId: item.ownerUserId,
            name: target.proposedName,
            capabilityId: target.capabilityId ?? '',
            draft: target.draft,
          },
        )
        resourceId = record.id
      } else {
        const store = target.resource === 'digital-employee' ? config.employees : config.policies
        const record = await store.create({
          id: ulid(),
          name: target.proposedName,
          ownerUserId: item.ownerUserId,
          draftJson: JSON.stringify(target.draft ?? {}),
          now: now(),
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

  const materializedAt = now()
  const value = JSON.stringify({ report, materializedAt, created, skipped })
  await db
    .insert(maintenanceState)
    .values({ key: MIGRATION_REPORT_KEY, value, updatedAt: materializedAt })
    .onConflictDoUpdate({
      target: maintenanceState.key,
      set: { value, updatedAt: materializedAt },
    })

  return { created, skipped }
}

export async function readPersistedMigrationRun(
  db: ProviderNeutralDatabase,
): Promise<PersistedMigrationRun | null> {
  const row = (
    await db
      .select({ value: maintenanceState.value })
      .from(maintenanceState)
      .where(eq(maintenanceState.key, MIGRATION_REPORT_KEY))
      .limit(1)
  )[0]
  if (row === undefined) return null
  try {
    return JSON.parse(row.value) as PersistedMigrationRun
  } catch {
    return null
  }
}

export function createDevelopmentMigrationPersistence(
  db: ProviderNeutralDatabase,
  options: { readonly now?: () => number } = {},
): DevelopmentMigrationPersistence {
  const now = options.now ?? (() => Date.now())
  return {
    analyze: (generatedAt) => runMigrationAnalysis(db, generatedAt),
    materialize: (report) => materializeMigrationCandidates(db, report, { now }),
    readPersisted: () => readPersistedMigrationRun(db),
  }
}
