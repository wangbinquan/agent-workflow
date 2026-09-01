// RFC-349 — real PostgreSQL adapter for RFC-310 legacy asset migration.

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import {
  actionTemplates,
  automationPolicies,
  capabilityTemplates,
  digitalEmployees,
  maintenanceState,
  repoCapabilityConfig,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createActionTemplate } from '../application/commands/actionTemplateCommands'
import {
  analyzeLegacyAssets,
  type AnalyzeLegacyInput,
  type MigrationReport,
  type MigrationTargetResource,
} from '../application/migrationAnalyzer'
import type {
  DevelopmentMigrationPersistence,
  MaterializeMigrationResult,
  PersistedMigrationRun,
} from '../application/ports/migrationPersistence'
import { createPostgresqlDevelopmentConfigPersistence } from './developmentConfigPersistence'
import { MIGRATION_REPORT_KEY } from './migrationAssets'
import { createPostgresqlActionTemplatePersistence } from './postgresqlConfigResourceStore'

async function collectLegacyAssets(db: PostgresqlDatabaseClient): Promise<AnalyzeLegacyInput> {
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
    .all()
  const matrix = await db
    .select({
      repoId: repoCapabilityConfig.repoId,
      capability: repoCapabilityConfig.capability,
      templateId: repoCapabilityConfig.templateId,
      enabled: repoCapabilityConfig.enabled,
      triggerConfigJson: repoCapabilityConfig.triggerConfigJson,
    })
    .from(repoCapabilityConfig)
    .all()
  return { templates, matrix }
}

async function nameExists(
  db: PostgresqlDatabaseClient,
  resource: Extract<
    MigrationTargetResource,
    'action-template' | 'digital-employee' | 'automation-policy'
  >,
  ownerUserId: string | null,
  name: string,
): Promise<boolean> {
  const owners =
    resource === 'action-template'
      ? await db
          .select({ ownerUserId: actionTemplates.ownerUserId })
          .from(actionTemplates)
          .where(eq(actionTemplates.name, name))
          .all()
      : resource === 'digital-employee'
        ? await db
            .select({ ownerUserId: digitalEmployees.ownerUserId })
            .from(digitalEmployees)
            .where(eq(digitalEmployees.name, name))
            .all()
        : await db
            .select({ ownerUserId: automationPolicies.ownerUserId })
            .from(automationPolicies)
            .where(eq(automationPolicies.name, name))
            .all()
  return owners.some((row) => row.ownerUserId === ownerUserId)
}

async function restoreVisibility(
  db: PostgresqlDatabaseClient,
  resource: Extract<
    MigrationTargetResource,
    'action-template' | 'digital-employee' | 'automation-policy'
  >,
  id: string,
  visibility: 'private' | 'public',
): Promise<void> {
  if (visibility !== 'public') return
  if (resource === 'action-template') {
    await db
      .update(actionTemplates)
      .set({ visibility: 'public' })
      .where(eq(actionTemplates.id, id))
      .run()
    return
  }
  if (resource === 'digital-employee') {
    await db
      .update(digitalEmployees)
      .set({ visibility: 'public' })
      .where(eq(digitalEmployees.id, id))
      .run()
    return
  }
  await db
    .update(automationPolicies)
    .set({ visibility: 'public' })
    .where(eq(automationPolicies.id, id))
    .run()
}

async function materialize(
  db: PostgresqlDatabaseClient,
  report: MigrationReport,
  now: () => number,
): Promise<MaterializeMigrationResult> {
  const created: MaterializeMigrationResult['created'][number][] = []
  const skipped: MaterializeMigrationResult['skipped'][number][] = []
  const templates = createPostgresqlActionTemplatePersistence(db)
  const config = createPostgresqlDevelopmentConfigPersistence(db)

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
      if (await nameExists(db, target.resource, item.ownerUserId, target.proposedName)) {
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
        const createdAt = now()
        const record = await store.create({
          id: ulid(),
          name: target.proposedName,
          ownerUserId: item.ownerUserId,
          draftJson: JSON.stringify(target.draft),
          now: createdAt,
        })
        resourceId = record.id
      }
      await restoreVisibility(db, target.resource, resourceId, item.visibility)
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
    .run()
  return { created, skipped }
}

async function readPersisted(db: PostgresqlDatabaseClient): Promise<PersistedMigrationRun | null> {
  const row = await db
    .select({ value: maintenanceState.value })
    .from(maintenanceState)
    .where(eq(maintenanceState.key, MIGRATION_REPORT_KEY))
    .limit(1)
    .get()
  if (row === undefined) return null
  try {
    return JSON.parse(row.value) as PersistedMigrationRun
  } catch {
    return null
  }
}

export function createPostgresqlDevelopmentMigrationPersistence(
  db: PostgresqlDatabaseClient,
  options: { readonly now?: () => number } = {},
): DevelopmentMigrationPersistence {
  const now = options.now ?? (() => Date.now())
  return {
    async analyze(generatedAt) {
      return analyzeLegacyAssets(await collectLegacyAssets(db), generatedAt)
    },
    materialize: (report) => materialize(db, report, now),
    readPersisted: () => readPersisted(db),
  }
}
