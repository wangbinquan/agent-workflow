// RFC-349 T2/T5/T6 — provider cutover is a production architecture contract,
// not a collection of PostgreSQL adapter unit tests.  The migration is not
// source-complete while business/application/transport code still imports the
// SQLite DB surface or while a compiled daemon bypasses the verified generation
// pointer and opens db.sqlite directly.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, importEdges, moduleLocation, sourceUnit, type SourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const units = backendUnits(REPO_ROOT)

/**
 * Exact legacy debt at the provider-neutral boundary.
 *
 * These entries are not approved examples. They pin every remaining place
 * where application/public/transport code names a concrete provider adapter,
 * so the inventory can only shrink. New code must accept an owner-defined
 * port from bootstrap instead of importing another SQLite/PostgreSQL factory.
 */
const PROVIDER_SPECIFIC_BUSINESS_DEPENDENCY_DEBT = [
  'packages/backend/src/auth/loginPolicy.ts -> ./infrastructure/legacySqliteLoginPolicy :: export:*',
  'packages/backend/src/auth/patStore.ts -> ./infrastructure/legacySqlitePatStore :: export:*',
  'packages/backend/src/auth/session.ts -> @/auth/infrastructure/legacySqliteAuthRuntime :: LegacySqliteAuthRuntimeBinding,LegacySqliteAuthRuntimeInput,legacySqliteAuthRuntimeOf',
  'packages/backend/src/auth/sessionStore.ts -> ./infrastructure/legacySqliteSessionStore :: export:*',
  'packages/backend/src/modules/identity-access/public/operations.ts -> ../infrastructure/postgresqlOidcProviderRepository :: export:PostgresqlOidcProviderRepository',
  'packages/backend/src/modules/identity-access/public/operations.ts -> ../infrastructure/sqliteOidcProviderRepository :: export:SqliteOidcProviderRepository',
  'packages/backend/src/modules/system-operations/application/databaseMigrationRunner.ts -> @/platform/persistence/postgresqlLogicalTarget :: PostgresqlLogicalTarget',
  'packages/backend/src/modules/system-operations/application/databaseMigrationRunner.ts -> @/platform/persistence/postgresqlPreflight :: preflightPostgresqlTarget',
  'packages/backend/src/modules/system-operations/application/databaseMigrationRunner.ts -> @/platform/persistence/postgresqlRuntime :: PostgresqlDatabaseRuntime',
  'packages/backend/src/modules/system-operations/application/databaseMigrationRunner.ts -> @/platform/persistence/sqliteLogicalSource :: SqliteLogicalSource,SqliteLogicalSourceSnapshot',
  'packages/backend/src/modules/task-execution/public/operations.ts -> ../composition/sqliteOwnedTaskMutation :: export:withTaskExecutionMutation',
  'packages/backend/src/modules/task-execution/public/participants.ts -> ../composition/sqliteOwnedTaskMutation :: withCurrentTaskExecutionMutation,withCurrentTaskExecutionTransaction,withTaskExecutionMutation,withTaskExecutionTransaction',
  'packages/backend/src/modules/task-execution/public/participants.ts -> ../composition/sqliteTaskExecutionContext :: assertTaskExecutionContext,createTaskExecutionContext,currentTaskExecutionContext,runWithTaskExecutionContext',
  'packages/backend/src/modules/task-execution/public/participants.ts -> ../composition/sqliteTaskExecutionRecovery :: finalizeTaskExecutionRecovery,prepareTaskExecutionRecovery',
  'packages/backend/src/modules/task-execution/public/participants.ts -> ../composition/sqliteTerminalMaintenance :: RecoverableTerminalMaintenanceClaim',
  'packages/backend/src/services/backupVacuumWorker.ts -> @/platform/persistence/sqlite/systemBackupVacuum :: vacuumSqliteInto',
  'packages/backend/src/services/bundle/legacyResourcePackageMutationDependencies.ts -> @/modules/code-capability/infrastructure/capabilityTemplatePackageCommit :: createSqliteCapabilityTemplatePackageCommitSync',
  'packages/backend/src/services/bundle/legacyResourcePackageMutationDependencies.ts -> @/modules/code-capability/infrastructure/sqliteCapabilityTemplatePersistence :: createSqliteCapabilityTemplatePersistence',
  'packages/backend/src/services/bundle/legacyResourcePackageMutationDependencies.ts -> @/modules/resource-catalog/infrastructure/sqliteAclReadRepository :: getAclResourceOwnerInTx',
  'packages/backend/src/services/bundle/postgresqlApply.ts -> @/platform/persistence/postgresqlResourcePackageAtomicApply :: export:*',
  'packages/backend/src/services/clarify/rounds.ts -> @/modules/collaboration/infrastructure/legacySqliteClarifyRounds :: export:*',
  'packages/backend/src/services/clarifyDecision.ts -> @/modules/collaboration/infrastructure/legacySqliteClarifyDecision :: export:*',
  'packages/backend/src/services/clarifyDecisionComposition.ts -> @/modules/collaboration/infrastructure/legacySqliteClarifyDecisionComposition :: export:*',
  'packages/backend/src/services/execution/childBudget.ts -> @/modules/task-execution/infrastructure/sqliteChildTaskBudgetQueries :: SqliteChildTaskBudgetQueries',
  'packages/backend/src/services/execution/executionWatch.ts -> @/modules/task-execution/infrastructure/sqliteTaskExecutionReadModels :: createSqliteTaskExecutionReadModels',
  'packages/backend/src/services/execution/outcome.ts -> @/modules/task-execution/infrastructure/sqliteTaskExecutionReadModels :: createSqliteTaskExecutionReadModels',
  'packages/backend/src/services/execution/startupVerificationRead.ts -> @/modules/task-execution/infrastructure/sqliteTaskExecutionReadModels :: createSqliteTaskExecutionReadModels',
  'packages/backend/src/services/execution/taskExecutionResources.ts -> @/modules/task-execution/infrastructure/postgresqlTaskExecutionResourceSnapshots :: export:createPostgresqlTaskExecutionResourceBinding',
  'packages/backend/src/services/execution/taskExecutionResources.ts -> @/modules/task-execution/infrastructure/sqliteTaskExecutionResourceSnapshots :: export:createSqliteTaskExecutionResourceBinding',
  'packages/backend/src/services/humanGateComposition.ts -> @/modules/collaboration/composition :: SqliteHumanGateOperationStore',
  'packages/backend/src/services/intent/applyChangeset.ts -> @/modules/intent/infrastructure/sqliteIntentApplyArtifactLifecycle :: createSqliteIntentApplyArtifactLifecycle',
  'packages/backend/src/services/intent/applyChangeset.ts -> @/modules/intent/infrastructure/sqliteIntentApplyOperations :: ApplyIntentDeps,applyIntentChangeset,convergeIntentApplyJournal',
  'packages/backend/src/services/intent/applyChangeset.ts -> @/modules/intent/infrastructure/sqliteIntentApplyOperations :: export:ApplyIntentFaults,export:IntentApplyReceipt,export:IntentApplyResourceBinding,export:IntentApplyResourceSession',
  'packages/backend/src/services/intent/applyChangeset.ts -> @/modules/intent/infrastructure/sqliteIntentApplyOperations :: export:__intentApplyLockCountForTests,export:__withSessionApplyLockForTests',
  'packages/backend/src/services/intent/postgresqlApplyChangeset.ts -> @/modules/intent/infrastructure/postgresqlIntentApplyOperations :: export:PostgresqlIntentApplyArtifactLifecycle,export:PostgresqlIntentApplyDependencies,export:PostgresqlIntentApplyOperations,export:PostgresqlIntentApplyRequest,export:PostgresqlIntentApplyResourceBinding,export:createPostgresqlIntentApplyOperations',
  'packages/backend/src/services/limits.ts -> @/modules/system-operations/composition/resourceLimits :: composeLegacySqliteResourceLimitOperations',
  'packages/backend/src/services/memory.ts -> @/modules/memory/infrastructure/sqliteMemoryCatalog :: export:*',
  'packages/backend/src/services/nodeRollback.ts -> @/modules/task-execution/infrastructure/legacySqliteNodeRollback :: LegacySqliteRollbackDatabase,createLegacySqliteRollbackEffectObserver,loadLegacySqliteRollbackTarget',
  'packages/backend/src/services/nodeRunMint.ts -> @/modules/task-execution/infrastructure/legacySqliteNodeRunOperations :: LegacySqliteNodeRunDatabase,LegacySqliteNodeRunTransaction,createLegacySqliteNodeRunOperations,mintLegacySqliteNodeRunInTx',
  'packages/backend/src/services/oidcProviders.ts -> @/modules/identity-access/public/operations :: SqliteOidcProviderRepository',
  'packages/backend/src/services/ownerIdentity.ts -> @/modules/identity-access/composition/providerOperations :: composeSqliteOwnerIdentityQueries',
  'packages/backend/src/services/pendingRestore.ts -> @/platform/persistence/sqlite/systemProviderRestore :: SqlitePostRestoreRecovery',
  'packages/backend/src/services/questionDispatchComposition.ts -> @/modules/collaboration/infrastructure/legacySqliteQuestionDispatchComposition :: export:*',
  'packages/backend/src/services/resourceAcl.ts -> @/modules/resource-catalog/infrastructure/sqliteAclReadRepository :: export:getAclResourceAccessRow,export:getAclResourceAccessRowInTx,export:getAclResourceIdentityRowInTx,export:getAclResourceOwner,export:getAclResourceOwnerInTx,export:listAclResourceIdentityRowsByIds,export:listAclResourceIdentityRowsByIdsInTx,export:listAclResourceIdentityRowsByNames,export:listAclResourceIdentityRowsByNamesInTx,export:listOwnedAclResourceNames,export:loadAclResourceNamesByIds',
  'packages/backend/src/services/resourceAcl.ts -> @/modules/resource-catalog/infrastructure/sqliteResourceGrantRepository :: export:AclColumnRef,export:grantsOfResourceWhere,export:listGrantedResourceIds,export:listGrantedResourceIdsInTx,export:listResourceGrantUserIdsInTx,export:listResourceGrants,export:listWritableGrantedResourceIds,export:loadGrantLevel,export:visibleRowsCondition',
  'packages/backend/src/services/review.ts -> @/modules/collaboration/infrastructure/legacySqliteReview :: export:*',
  'packages/backend/src/services/reviewDecisionComposition.ts -> @/modules/collaboration/infrastructure/legacySqliteReviewDecisionComposition :: export:*',
  'packages/backend/src/services/reviewMutationCoordinator.ts -> @/modules/collaboration/infrastructure/sqliteReviewMutationScope :: SqliteReviewMutationScopeResolver',
  'packages/backend/src/services/runtime/opencode/distillSessionCapture.ts -> @/platform/persistence/sqlite/readonlySqliteDatabase :: ReadonlySqliteDatabase,openReadonlySqliteDatabase',
  'packages/backend/src/services/runtime/opencode/sessionCapture.ts -> @/platform/persistence/sqlite/readonlySqliteDatabase :: ReadonlySqliteDatabase,openReadonlySqliteDatabase',
  'packages/backend/src/services/runtime/opencode/sessionWalk.ts -> @/platform/persistence/sqlite/readonlySqliteDatabase :: ReadonlySqliteDatabase',
  'packages/backend/src/services/runtime/opencode/subagentLiveCapture.ts -> @/platform/persistence/sqlite/readonlySqliteDatabase :: ReadonlySqliteDatabase,openReadonlySqliteDatabase',
  'packages/backend/src/services/scheduleLaunch.ts -> @/modules/task-execution/infrastructure/legacySqliteTaskDatabase :: LegacySqliteTaskDatabase',
  'packages/backend/src/services/startTaskDeps.ts -> @/modules/source-control/composition :: composeSqliteRepositoryWorkspaceStore',
  'packages/backend/src/services/startTaskDeps.ts -> @/modules/task-execution/infrastructure/legacySqliteTaskDatabase :: LegacySqliteTaskDatabase',
  'packages/backend/src/services/startTaskDeps.ts -> @/modules/task-execution/infrastructure/sqliteRuntimeSessionLeaseOperations :: createSqliteRuntimeSessionLeaseOperations',
  'packages/backend/src/services/task.ts -> @/modules/source-control/composition :: composeSqliteRepositoryWorkspaceStore',
  'packages/backend/src/services/task.ts -> @/modules/task-execution/composition/sqliteGateContinuationPreDrive :: createSqliteGateContinuationPreDriveStep',
  'packages/backend/src/services/task.ts -> @/modules/task-execution/infrastructure/legacySqliteTransportMechanisms :: LegacySqliteTaskDatabase,LegacySqliteTaskTransaction,SQL,agents,and,asc,cachedRepos,clarifyRounds,count,dbTxSync,desc,docVersions,eq,gt,inArray,isNotNull,isNull,lifecycleAlerts,nodeRunEvents,nodeRunOutputs,nodeRuns,runtimeSessionLeases,sql,taskCollaborators,taskExecutionIntents,taskExecutionOwners,taskRepos,taskSpaceNodes,tasks,users,workflows',
  'packages/backend/src/services/task.ts -> @/modules/task-execution/infrastructure/sqliteBranchTraceSnapshotReader :: SqliteBranchTraceSnapshotReader',
  'packages/backend/src/services/taskArchive.ts -> @/modules/task-execution/infrastructure/legacySqliteTransportMechanisms :: LegacySqliteTaskDatabase,and,asc,clarifyRounds,collaborationGateArtifacts,collaborationGateOperations,dbTxSync,docVersions,eq,inArray,isNull,lifecycleAlerts,lte,nodeRunEvents,nodeRunOutputs,nodeRuns,or,recoveryEvents,reviewComments,reviewNodeReviewers,sql,taskArchiveAudit,taskCollaborators,taskExecutionEffectAttempts,taskExecutionEffectFences,taskExecutionEffects,taskExecutionIntents,taskExecutionLineageOperationRecords,taskExecutionMaintenanceClaims,taskExecutionMaintenanceMembers,taskExecutionOwners,taskFeedback,taskNodeClarifyDirectives,taskQuestions,taskRepos,taskSpaceNodes,tasks,workgroupAssignments,workgroupMemberCursors,workgroupMessages,workgroupTaskState',
  'packages/backend/src/services/taskAuthorization.ts -> @/modules/task-execution/infrastructure/legacySqliteTaskAuthorization :: export:LegacySqliteTaskAuthorizationRef,export:LegacyTaskOwnershipScope',
  'packages/backend/src/services/taskAuthorization.ts -> @/modules/task-execution/infrastructure/legacySqliteTaskAuthorization :: legacySqliteDefaultTaskAuthorizationRef,legacySqliteTaskAuthorizationCondition,legacySqliteTaskOwnershipScopeCondition,legacySqliteVisibleTaskIdsOf',
  'packages/backend/src/services/taskClarifyDirective.ts -> @/modules/collaboration/infrastructure/legacySqliteTaskClarifyDirective :: export:getNodeClarifyDirective,export:getNodeClarifyDirectiveRow,export:isAskingNodeInSnapshot,export:listNodeClarifyDirectives,export:setNodeClarifyDirective,export:setNodeClarifyDirectiveTx',
  'packages/backend/src/services/taskCollab.ts -> @/modules/collaboration/infrastructure/legacySqliteTaskCollab :: export:*',
  'packages/backend/src/services/taskDelete.ts -> @/modules/task-execution/infrastructure/legacySqliteTransportMechanisms :: LegacySqliteTaskDatabase,dbTxSync,eq,inArray,sql,taskCollaborators,taskFeedback,taskRepos,tasks',
  'packages/backend/src/services/taskLaunchGate.ts -> @/modules/task-execution/infrastructure/legacySqliteTaskDatabase :: LegacySqliteTaskDatabase',
  'packages/backend/src/services/taskOperations.ts -> @/modules/task-execution/infrastructure/legacySqliteTransportMechanisms :: LegacySqliteTaskDatabase,SQL,and,eq,inArray,sql,tasks',
  'packages/backend/src/services/taskQuestionDispatch.ts -> @/modules/collaboration/infrastructure/legacySqliteTaskQuestionDispatch :: export:*',
  'packages/backend/src/services/taskQuestions.ts -> @/modules/collaboration/infrastructure/legacySqliteTaskQuestions :: export:*',
  'packages/backend/src/services/tokenAudit.ts -> @/auth/composition :: legacySqliteTokenCallAudit',
  'packages/backend/src/services/userIdentities.ts -> @/modules/identity-access/composition/providerOperations :: composeSqliteOidcIdentityOperations',
  'packages/backend/src/services/users.ts -> @/modules/identity-access/composition/legacySqliteUserService :: legacySqliteUserService',
] as const

/** Only these roots may resolve the durable provider generation. */
const PROVIDER_SELECTION_SITES = [
  'packages/backend/src/cli/dbCompact.ts',
  'packages/backend/src/cli/doctor.ts',
  'packages/backend/src/cli/migrate.ts',
  'packages/backend/src/cli/start.ts',
  'packages/backend/src/main.ts',
  'packages/backend/src/modules/system-operations/composition.ts',
] as const

function isBusinessOrTransport(unit: SourceUnit): boolean {
  const location = moduleLocation(unit.path)
  if (location !== null) {
    const layer = location.rest.split('/')[0]
    return layer === 'application' || layer === 'domain' || layer === 'engine' || layer === 'public'
  }
  // `auth` predates the bounded-context module layout. Its provider adapters
  // and root composition are infrastructure even though the directory itself
  // sits beside the transport folders. Keep the application and compatibility
  // facades in the negative corpus; only the explicit provider-owning surfaces
  // are exempt from the transport rule.
  if (/\/src\/auth\/infrastructure\//.test(unit.path)) return false
  if (/\/src\/auth\/composition\.ts$/.test(unit.path)) return false
  return /\/src\/(?:auth|mcp|routes|services|ws)\//.test(unit.path)
}

function isDatabaseMechanism(specifier: string): boolean {
  return (
    /^@\/db(?:\/|$)/.test(specifier) ||
    specifier === 'bun:sqlite' ||
    specifier === 'drizzle-orm' ||
    specifier.startsWith('drizzle-orm/')
  )
}

/**
 * Exact mechanism edges that crossed into a provider-neutral layer. Keeping
 * syntax and value/type kind in the finding makes static imports, type-only
 * aliases, re-exports, dynamic imports and require() independently auditable.
 */
function databaseMechanismDependencies(source: SourceUnit): string[] {
  if (!isBusinessOrTransport(source)) return []
  return importEdges(source)
    .filter((edge) => isDatabaseMechanism(edge.specifier))
    .map(
      (edge) =>
        `${source.path} -> ${edge.specifier} :: ${edge.syntax}:${edge.kind}`,
    )
    .sort()
}

function isProviderSpecificSpecifier(specifier: string): boolean {
  const basename = specifier.split('/').at(-1) ?? ''
  return /sqlite|postgresql/i.test(basename)
}

/**
 * Provider-specific import declarations in layers that must consume closed
 * ports. Infrastructure/composition/bootstrap are deliberately outside this
 * matcher: explicit adapter names are correct at the mechanism boundary.
 */
function providerSpecificDependencies(source: SourceUnit): string[] {
  if (!isBusinessOrTransport(source)) return []
  const findings: string[] = []
  for (const statement of source.source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text
      const specifierIsSpecific = isProviderSpecificSpecifier(specifier)
      const bindings: string[] = []
      const clause = statement.importClause
      if (clause === undefined) {
        if (specifierIsSpecific) bindings.push('side-effect')
      } else {
        if (
          clause.name !== undefined &&
          (specifierIsSpecific || /Sqlite|Postgresql/.test(clause.name.text))
        ) {
          bindings.push(`default:${clause.name.text}`)
        }
        const named = clause.namedBindings
        if (named !== undefined && ts.isNamespaceImport(named)) {
          if (specifierIsSpecific || /Sqlite|Postgresql/.test(named.name.text)) {
            bindings.push(`*:${named.name.text}`)
          }
        } else if (named !== undefined) {
          for (const element of named.elements) {
            const imported = (element.propertyName ?? element.name).text
            if (specifierIsSpecific || /Sqlite|Postgresql/.test(imported)) {
              bindings.push(imported)
            }
          }
        }
      }
      if (bindings.length > 0) {
        findings.push(`${source.path} -> ${specifier} :: ${bindings.sort().join(',')}`)
      }
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text
      const specifierIsSpecific = isProviderSpecificSpecifier(specifier)
      const bindings: string[] = []
      if (statement.exportClause === undefined) {
        if (specifierIsSpecific) bindings.push('export:*')
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        if (specifierIsSpecific || /Sqlite|Postgresql/.test(statement.exportClause.name.text)) {
          bindings.push(`export:*:${statement.exportClause.name.text}`)
        }
      } else {
        for (const element of statement.exportClause.elements) {
          const imported = (element.propertyName ?? element.name).text
          if (specifierIsSpecific || /Sqlite|Postgresql/.test(imported)) {
            bindings.push(`export:${imported}`)
          }
        }
      }
      if (bindings.length > 0) {
        findings.push(`${source.path} -> ${specifier} :: ${bindings.sort().join(',')}`)
      }
    }

    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(statement.moduleReference.expression)
    ) {
      const specifier = statement.moduleReference.expression.text
      if (isProviderSpecificSpecifier(specifier) || /Sqlite|Postgresql/.test(statement.name.text)) {
        findings.push(`${source.path} -> ${specifier} :: import-equals:${statement.name.text}`)
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]!) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const specifier = node.arguments[0]!.text
      if (isProviderSpecificSpecifier(specifier)) {
        findings.push(
          `${source.path} -> ${specifier} :: ${
            node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require'
          }`,
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source.source)
  return [...new Set(findings)].sort()
}

function importsProviderSelector(source: SourceUnit): boolean {
  for (const statement of source.source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.endsWith('platform/persistence/databaseProviderRuntime')
    ) {
      continue
    }
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || ts.isNamespaceImport(bindings)) continue
    if (
      bindings.elements.some((element) =>
        /^resolveDatabaseProvider(?:Runtime|Selection)$/.test(
          (element.propertyName ?? element.name).text,
        ),
      )
    ) {
      return true
    }
  }
  return false
}

function providerSelectionSites(corpus: readonly SourceUnit[]): string[] {
  return corpus
    .filter(importsProviderSelector)
    .map((source) => source.path)
    .sort()
}

function topLevelFunctionText(source: SourceUnit, name: string): string {
  const declaration = source.source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  )
  if (declaration === undefined) throw new Error(`missing top-level function ${name}`)
  return declaration.getText(source.source)
}

function unit(path: string): SourceUnit {
  const found = units.find((candidate) => candidate.path === path)
  if (found === undefined) throw new Error(`missing production source ${path}`)
  return found
}

describe('RFC-349 provider cutover', () => {
  test('production source corpus stays non-empty', () => {
    expect(units.length).toBeGreaterThanOrEqual(1_500)
  })

  test('business, application, public and transport surfaces own ports instead of DB mechanisms', () => {
    const violations = units.flatMap(databaseMechanismDependencies).sort()

    expect(violations).toEqual([])
  })

  test('negative fixture: every DB import syntax is rejected outside infrastructure', () => {
    const service = sourceUnit(
      'packages/backend/src/services/orders.ts',
      [
        "import type { DbClient } from '@/db/client'",
        "export { orders } from '@/db/schema'",
        "const dialect = await import('drizzle-orm/pg-core')",
        "const sqlite = require('bun:sqlite')",
      ].join('\n'),
    )
    expect(databaseMechanismDependencies(service)).toEqual([
      'packages/backend/src/services/orders.ts -> @/db/client :: static-import:type',
      'packages/backend/src/services/orders.ts -> @/db/schema :: export:value',
      'packages/backend/src/services/orders.ts -> bun:sqlite :: require:value',
      'packages/backend/src/services/orders.ts -> drizzle-orm/pg-core :: dynamic-import:value',
    ])

    const adapter = sourceUnit(
      'packages/backend/src/modules/orders/infrastructure/sqliteOrders.ts',
      "import type { DbClient } from '@/db/client'\n",
    )
    expect(databaseMechanismDependencies(adapter)).toEqual([])
  })

  test('provider-specific business dependencies are exact legacy debt and cannot grow', () => {
    const observed = units.flatMap(providerSpecificDependencies).sort()
    expect(observed).toEqual([...PROVIDER_SPECIFIC_BUSINESS_DEPENDENCY_DEBT].sort())
  })

  test('the durable database provider is selected only at bootstrap and system-operation roots', () => {
    expect(providerSelectionSites(units)).toEqual([...PROVIDER_SELECTION_SITES].sort())
  })

  test('the HTTP application boundary mounts closed ports without selecting a provider', () => {
    const server = unit('packages/backend/src/server.ts')
    const assembly = topLevelFunctionText(server, 'composeProviderAppDeps')

    expect(assembly).not.toMatch(/\b(?:compose|create)(?:Sqlite|Postgresql)/)
    expect(assembly).not.toMatch(/\b(?:DbClient|PostgresqlDatabaseClient)\b/)
    expect(assembly).not.toMatch(/input\.core\.provider\s*(?:===|!==|==|!=)/)
    expect(assembly).toContain('core: input.core')
  })

  test('negative fixture: a business provider factory and a second selector are both rejected', () => {
    const hardcoded = sourceUnit(
      'packages/backend/src/services/orders.ts',
      "import { composePostgresqlOrders } from '@/modules/orders/composition'\n",
    )
    expect(providerSpecificDependencies(hardcoded)).toEqual([
      'packages/backend/src/services/orders.ts -> @/modules/orders/composition :: composePostgresqlOrders',
    ])

    const reexport = sourceUnit(
      'packages/backend/src/modules/orders/public/operations.ts',
      "export { createSqliteOrders } from '../infrastructure/sqliteOrders'\n",
    )
    expect(providerSpecificDependencies(reexport)).toEqual([
      'packages/backend/src/modules/orders/public/operations.ts -> ../infrastructure/sqliteOrders :: export:createSqliteOrders',
    ])

    const dynamic = sourceUnit(
      'packages/backend/src/services/orderArchive.ts',
      "const adapter = await import('@/modules/orders/infrastructure/postgresqlOrders')\n",
    )
    expect(providerSpecificDependencies(dynamic)).toEqual([
      'packages/backend/src/services/orderArchive.ts -> @/modules/orders/infrastructure/postgresqlOrders :: dynamic-import',
    ])

    const selector = sourceUnit(
      'packages/backend/src/routes/orders.ts',
      "import { resolveDatabaseProviderRuntime } from '@/platform/persistence/databaseProviderRuntime'\n",
    )
    expect(providerSelectionSites([selector])).toEqual(['packages/backend/src/routes/orders.ts'])
  })

  test('daemon bootstrap selects the verified provider and mounts live migration admission', () => {
    const source = unit('packages/backend/src/cli/start.ts').text

    expect(source).not.toMatch(/from\s+['"]@\/db\/client['"]/) // provider factory owns SQLite
    expect(source).toContain('resolveDatabaseProviderRuntime')
    expect(source).toContain('createDatabaseMigrationDaemonAdmission')
    expect(source).toContain('databaseMigration:')
    expect(source).toContain('taskRouteLaunch: taskExecutionProvider.routeLaunch')
    expect(source).toContain('.runBusinessRequest(')
  })

  test('standalone CLI bootstraps do not silently reopen SQLite after PostgreSQL cutover', () => {
    const source = unit('packages/backend/src/main.ts').text

    expect(source).not.toMatch(/from\s+['"]\.\/db\/client['"]/) // user/package/ops share provider bootstrap
    expect(source).not.toMatch(/\bopenDb\s*\(/)
    expect(source).toContain('resolveDatabaseProviderRuntime')
  })

  /**
   * The SQLite twin of every one of these adapters is synchronous (`dbTxSync`),
   * so a dropped `await` changes nothing there and everything here: the caller
   * resolves while the PostgreSQL transaction is still open, later reads race
   * it, and a failure surfaces as an unhandled rejection instead of the
   * operation's error. Two runtime-test persistence writers
   * (`markCaptureTerminal`, `failBeforeRun`) shipped exactly that shape.
   */
  test('every PostgreSQL transaction is awaited or returned, never fired and forgotten', () => {
    const floating: string[] = []
    for (const candidate of units) {
      if (!candidate.path.startsWith('packages/backend/src/')) continue
      const lines = candidate.text.split('\n')
      lines.forEach((line, index) => {
        if (!/^\s*runPostgresql[A-Za-z]*Transaction\s*\(/.test(line)) return
        // A concise arrow body (`… =>` on the line above) is a return.
        const previous = lines
          .slice(0, index)
          .reverse()
          .find((candidateLine) => candidateLine.trim().length > 0)
        if (previous !== undefined && /=>\s*$/.test(previous)) return
        floating.push(`${candidate.path}:${index + 1}`)
      })
    }
    expect(floating).toEqual([])
  })
})
