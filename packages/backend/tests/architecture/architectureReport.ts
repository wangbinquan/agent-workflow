// RFC-376 T6: on-demand inventory. Source comes only from immutable Git objects.
// Inventory builders are copied from RFC-294, without projection/provenance governance.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { posix } from 'node:path'
import ts from 'typescript'
import {
  importEdges,
  BOOTSTRAP_FILES,
  moduleLocation,
  layerOf,
  portable,
  sourceUnit,
  type EdgeKind,
  type EdgeSyntax,
  type SourceUnit,
} from './census'
import {
  TARGET_CONTEXT_EDGES,
  TARGET_PUBLIC_CONTEXTS,
  OFFERED_CONTEXT_PAIRS,
  type TargetContext,
  type ContextEdgeRole,
  type TargetOwner as RegisteredTargetOwner,
} from './rfc294Target'
import {
  buildTaskExecutionAuthorityEntries,
  buildTaskExecutionControlGateways,
  buildTaskOwnedEffectEntries,
  buildCodeHostRecoveryBindingManifest,
  dataLiteral,
  declarationInitializer,
} from './rfc328TaskExecutionLedger'
import {
  BACKEND_PREFIX,
  createGateCorpus,
  gateViolationSets,
  publicSurfaceViolations,
  stronglyConnected,
  siteRecorder,
  walk,
  enclosingSymbol,
  calleeName,
  literal,
  unique,
  type GateCorpus,
} from './rfc294Gates'
import { readCommittedArchitectureSource } from '../../../../scripts/lib/committed-architecture-source'
type TargetOwner = RegisteredTargetOwner | 'unregistered'
const EXACT_PUBLIC = new Set([
  'commands',
  'events',
  'operations',
  'participants',
  'queries',
  'types',
])
const GOVERNED_EXTERNAL_SPECIFIERS = new Set(['drizzle-orm'])
export const PUBLIC_SURFACE_OPAQUE_TYPE_ALLOWLIST = [
  'AbortSignal',
  // RFC-359 W4-D28b：`ProviderNeutralDatabase` 的别名目标。名字里的 SQLite 是 drizzle 的历史
  // 命名，它恰恰是**两个引擎共用**的那一层（`BaseSQLiteDatabase<'sync' | 'async', …>`），
  // 随任务执行写事务网关（`withTaskExecutionWrite`）进入 public 面。
  'BaseSQLiteDatabase',
  'Blob',
  'Exclude',
  'Extract',
  'Omit',
  'Pick',
  'ReadableStream',
  'ReadonlyMap',
  'Record',
  'RegExp',
  'Uint8Array',
  'extends:Error',
  'z.infer',
] as const

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    )
  }
  return value
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(stable(value), null, 2)}\n`
}

function digestText(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  )
}

function declarationName(node: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)) &&
    node.name !== undefined
  ) {
    return node.name.text
  }
  if (
    (ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node)) &&
    node.name !== undefined
  ) {
    return node.name.getText()
  }
  return null
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
        false)
    : false
}

interface NamedNode {
  readonly name: string
  readonly node: ts.Node
  readonly exported: boolean
}

function topLevelNamedNodes(unit: SourceUnit): NamedNode[] {
  const out: NamedNode[] = []
  for (const statement of unit.source.statements) {
    const name = declarationName(statement)
    if (name !== null) {
      out.push({ name, node: statement, exported: hasExportModifier(statement) })
      continue
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const binding of bindingNames(declaration.name)) {
          out.push({ name: binding, node: declaration, exported: hasExportModifier(statement) })
        }
      }
    }
  }
  return out.sort((left, right) => left.name.localeCompare(right.name))
}

function physicalLayer(unit: SourceUnit): string {
  const place = layerOf(unit)
  if (place !== null) return place.layer.replace(/\.ts$/, '')
  if (unit.path.startsWith('packages/frontend/src/')) {
    return unit.path.slice('packages/frontend/src/'.length).split('/')[0] ?? 'frontend'
  }
  if (unit.path.startsWith('packages/shared/src/')) return 'contracts'
  const relative = unit.path.slice(BACKEND_PREFIX.length)
  return relative.split('/')[0] ?? 'legacy'
}

// Historical owner attribution; new files are reported as unregistered.
const LEGACY_BACKEND_FILE_OWNERS: Readonly<Record<string, TargetOwner>> = {
  'packages/backend/src/bootstrap/crewstation.ts': 'bootstrap',
  'packages/backend/src/bootstrap/crewstationMaintenance.ts': 'bootstrap',
  'packages/backend/src/bootstrap/executionInitialization.ts': 'bootstrap',
  // RFC-370 §9.2 V9: the maintenance Worker's process entry; bootstrap registers
  // its effect modules so the platform layer imports no bootstrap or module code.
  'packages/backend/src/bootstrap/maintenanceWorkerEntry.ts': 'bootstrap',
  'packages/backend/src/bootstrap/workspaceTaskImage.ts': 'bootstrap',
  'packages/backend/src/auth/actor.ts': 'identity-access',
  'packages/backend/src/auth/application/authPersistence.ts': 'identity-access',
  'packages/backend/src/auth/application/authRuntime.ts': 'identity-access',
  'packages/backend/src/auth/application/patPolicy.ts': 'identity-access',
  'packages/backend/src/auth/application/tokenCallAudit.ts': 'identity-access',
  'packages/backend/src/auth/application/tokenSnapshotRedaction.ts': 'identity-access',
  'packages/backend/src/auth/composition.ts': 'identity-access',
  'packages/backend/src/auth/infrastructure/authPersistence.ts': 'identity-access',
  'packages/backend/src/auth/infrastructure/compatibleAuthRuntime.ts': 'identity-access',
  'packages/backend/src/auth/infrastructure/tokenCallAudit.ts': 'identity-access',
  'packages/backend/src/auth/oidc/discovery.ts': 'identity-access',
  'packages/backend/src/auth/oidc/endpoints.ts': 'identity-access',
  'packages/backend/src/auth/oidc/flow.ts': 'identity-access',
  'packages/backend/src/auth/oidc/identity.ts': 'identity-access',
  'packages/backend/src/auth/oidc/tokens.ts': 'identity-access',
  'packages/backend/src/auth/passwords.ts': 'identity-access',
  'packages/backend/src/auth/secretBox.ts': 'identity-access',
  'packages/backend/src/auth/session.ts': 'identity-access',
  'packages/backend/src/auth/systemIdentity.ts': 'identity-access',
  'packages/backend/src/auth/token.ts': 'identity-access',
  'packages/backend/src/cli/auth.ts': 'identity-access',
  'packages/backend/src/cli/backup.ts': 'system-operations',
  'packages/backend/src/cli/config-cli.ts': 'bootstrap',
  'packages/backend/src/cli/daemonProviderBootstrap.ts': 'bootstrap',
  'packages/backend/src/cli/daemonProviderMigrationAdmission.ts': 'bootstrap',
  'packages/backend/src/cli/daemonProviderRuntimeHandles.ts': 'runtime-management',
  'packages/backend/src/cli/daemonProviderRuntimeRouter.ts': 'runtime-management',
  'packages/backend/src/cli/daemonProviderRuntimeSession.ts': 'runtime-management',
  'packages/backend/src/cli/daemonProviderSession.ts': 'bootstrap',
  'packages/backend/src/cli/daemonRealtimePolicy.ts': 'bootstrap',
  'packages/backend/src/cli/database.ts': 'bootstrap',
  'packages/backend/src/cli/dbCompact.ts': 'bootstrap',
  'packages/backend/src/cli/deployment.ts': 'bootstrap',
  'packages/backend/src/cli/dev.ts': 'bootstrap',
  'packages/backend/src/cli/doctor.ts': 'bootstrap',
  'packages/backend/src/cli/executionActivation.ts': 'bootstrap',
  'packages/backend/src/cli/frameBackfill.ts': 'bootstrap',
  'packages/backend/src/cli/migrate.ts': 'bootstrap',
  'packages/backend/src/cli/migrationReport.ts': 'bootstrap',
  'packages/backend/src/cli/package.ts': 'resource-catalog',
  'packages/backend/src/cli/postgresqlDaemonApplication.ts': 'bootstrap',
  'packages/backend/src/cli/restore.ts': 'system-operations',
  'packages/backend/src/cli/rfc295-downgrade-audit.ts': 'bootstrap',
  'packages/backend/src/cli/start.ts': 'bootstrap',
  'packages/backend/src/cli/status.ts': 'bootstrap',
  'packages/backend/src/cli/stop.ts': 'bootstrap',
  'packages/backend/src/cli/user.ts': 'identity-access',
  'packages/backend/src/cli/userBootstrap.ts': 'identity-access',
  'packages/backend/src/config/index.ts': 'platform',
  'packages/backend/src/embed.generated.ts': 'platform',
  'packages/backend/src/embed.ts': 'platform',
  'packages/backend/src/main.ts': 'bootstrap',
  'packages/backend/src/mcp/operationBindings.ts': 'platform',
  'packages/backend/src/mcp/operationClient.ts': 'platform',
  'packages/backend/src/mcp/resourceSchemas.ts': 'platform',
  'packages/backend/src/mcp/server.ts': 'platform',
  'packages/backend/src/mcp/tools.ts': 'platform',
  'packages/backend/src/mcp/watch.ts': 'platform',
  'packages/backend/src/routes/accountRepositoryTransportCredentials.ts': 'source-control',
  'packages/backend/src/routes/agents.ts': 'resource-catalog',
  'packages/backend/src/routes/auth.ts': 'identity-access',
  'packages/backend/src/routes/backup.ts': 'system-operations',
  'packages/backend/src/routes/cached-repos.ts': 'source-control',
  'packages/backend/src/routes/capabilityTemplates.ts': 'development-automation',
  'packages/backend/src/routes/clarify.ts': 'collaboration',
  'packages/backend/src/routes/code.ts': 'development-automation',
  'packages/backend/src/routes/codeHosts.ts': 'integration',
  'packages/backend/src/routes/config.ts': 'platform',
  'packages/backend/src/routes/daemon.ts': 'platform',
  'packages/backend/src/routes/databaseMigrations.ts': 'system-operations',
  'packages/backend/src/routes/developmentConfig.ts': 'development-automation',
  'packages/backend/src/routes/developmentMissions.ts': 'development-automation',
  'packages/backend/src/routes/digitalEmployees.ts': 'digital-employee',
  'packages/backend/src/routes/docs.ts': 'platform',
  'packages/backend/src/routes/eventCenter.ts': 'event-center',
  'packages/backend/src/routes/executionContracts.ts': 'execution-contract',
  'packages/backend/src/routes/health.ts': 'platform',
  'packages/backend/src/routes/maintenance.ts': 'platform',
  'packages/backend/src/routes/maintenanceDisk.ts': 'platform',
  'packages/backend/src/routes/mcps.ts': 'resource-catalog',
  'packages/backend/src/routes/memories.ts': 'memory',
  'packages/backend/src/routes/memoryDistillJobs.ts': 'memory',
  'packages/backend/src/routes/missionInputUploads.ts': 'development-automation',
  'packages/backend/src/routes/oidc-auth.ts': 'identity-access',
  'packages/backend/src/routes/oidc.ts': 'identity-access',
  'packages/backend/src/routes/operationAuthority.ts': 'identity-access',
  'packages/backend/src/routes/operationRoute.ts': 'platform',
  'packages/backend/src/routes/overview.ts': 'system-operations',
  'packages/backend/src/routes/plantuml.ts': 'platform',
  'packages/backend/src/routes/plugins.ts': 'resource-catalog',
  'packages/backend/src/routes/port-artifacts.ts': 'task-execution',
  'packages/backend/src/routes/publicOrigin.ts': 'platform',
  'packages/backend/src/routes/registry.ts': 'platform',
  'packages/backend/src/routes/repoGroups.ts': 'source-control',
  'packages/backend/src/routes/repos.ts': 'source-control',
  'packages/backend/src/routes/resourceAcl.ts': 'resource-catalog',
  'packages/backend/src/routes/resourcePackages.ts': 'resource-catalog',
  'packages/backend/src/routes/restore.ts': 'system-operations',
  'packages/backend/src/routes/reviews.ts': 'collaboration',
  'packages/backend/src/routes/scheduledTasks.ts': 'integration',
  'packages/backend/src/routes/skills.ts': 'resource-catalog',
  'packages/backend/src/routes/taskArchive.ts': 'task-execution',
  'packages/backend/src/routes/taskCatalog.ts': 'task-catalog',
  'packages/backend/src/routes/taskClarifyDirective.ts': 'collaboration',
  'packages/backend/src/routes/taskFeedback.ts': 'task-execution',
  'packages/backend/src/routes/taskQuestions.ts': 'collaboration',
  'packages/backend/src/routes/tasks.ts': 'task-execution',
  'packages/backend/src/routes/users.ts': 'identity-access',
  'packages/backend/src/routes/verifiedBodyLimit.ts': 'platform',
  'packages/backend/src/routes/webhookDeliveries.ts': 'integration',
  'packages/backend/src/routes/webhookEndpoints.ts': 'integration',
  'packages/backend/src/routes/webhooks.ts': 'integration',
  'packages/backend/src/routes/webhookTriggers.ts': 'integration',
  'packages/backend/src/routes/workflows.ts': 'resource-catalog',
  'packages/backend/src/routes/workgroups.ts': 'resource-catalog',
  'packages/backend/src/routes/workgroupTasks.ts': 'resource-catalog',
  'packages/backend/src/routes/worktree-files.ts': 'task-execution',
  'packages/backend/src/server.ts': 'bootstrap',
  'packages/backend/src/services/accountAuthPolicy.ts': 'identity-access',
  'packages/backend/src/services/agent.ts': 'resource-catalog',
  'packages/backend/src/services/agentDeps.ts': 'resource-catalog',
  'packages/backend/src/services/agentLaunch.ts': 'task-execution',
  'packages/backend/src/services/agentLaunchReservation.ts': 'task-execution',
  'packages/backend/src/services/apiDocs.ts': 'platform',
  'packages/backend/src/services/autoKill.ts': 'task-execution',
  'packages/backend/src/services/autoRepair.ts': 'task-execution',
  'packages/backend/src/services/autoResume.ts': 'task-execution',
  'packages/backend/src/services/backup.ts': 'platform',
  'packages/backend/src/services/backupManifest.ts': 'platform',
  'packages/backend/src/services/backupScheduler.ts': 'platform',
  'packages/backend/src/services/backupVacuumWorker.ts': 'platform',
  'packages/backend/src/services/bundle/provider.ts': 'platform',
  'packages/backend/src/services/capabilityTemplates.ts': 'development-automation',
  'packages/backend/src/services/changeNarrative.ts': 'workspace-insight',
  'packages/backend/src/services/clarify/autoDispatch.ts': 'collaboration',
  'packages/backend/src/services/clarify/queue.ts': 'collaboration',
  'packages/backend/src/services/clarify/rerunLedger.ts': 'collaboration',
  'packages/backend/src/services/clarify/rounds.ts': 'collaboration',
  'packages/backend/src/services/clarify/seal.ts': 'collaboration',
  'packages/backend/src/services/clarify/service.ts': 'collaboration',
  'packages/backend/src/services/clarifyAutoDispatch.ts': 'collaboration',
  'packages/backend/src/services/clarifyDecision.ts': 'collaboration',
  'packages/backend/src/services/clarifyDecisionComposition.ts': 'collaboration',
  'packages/backend/src/services/clarifyQueue.ts': 'collaboration',
  'packages/backend/src/services/clarifyRerunLedger.ts': 'collaboration',
  'packages/backend/src/services/clarifyRounds.ts': 'collaboration',
  'packages/backend/src/services/clarifySeal.ts': 'collaboration',
  'packages/backend/src/services/codeCapabilityParams.ts': 'development-automation',
  'packages/backend/src/services/codeHost/call.ts': 'integration',
  'packages/backend/src/services/codeHost/connections.ts': 'integration',
  'packages/backend/src/services/codeHost/project.ts': 'integration',
  'packages/backend/src/services/codeHost/recoveryProbe.ts': 'integration',
  'packages/backend/src/services/codeHost/url.ts': 'integration',
  'packages/backend/src/services/codeHostAuthorGate.ts': 'integration',
  'packages/backend/src/services/codeIntel/codeIntel.ts': 'workspace-insight',
  'packages/backend/src/services/codeIntel/fileSymbols.ts': 'workspace-insight',
  'packages/backend/src/services/codeIntel/snapshot.ts': 'workspace-insight',
  'packages/backend/src/services/codeReviewAgentCaller.ts': 'development-automation',
  'packages/backend/src/services/codeRoundContract.ts': 'development-automation',
  'packages/backend/src/services/commitPush.ts': 'source-control',
  'packages/backend/src/services/commitPushRunner.ts': 'source-control',
  'packages/backend/src/services/configAppliedListeners.ts': 'platform',
  'packages/backend/src/services/controlListener.ts': 'bootstrap',
  'packages/backend/src/services/daemonCadence.ts': 'platform',
  'packages/backend/src/services/daemonGeneration.ts': 'platform',
  'packages/backend/src/services/deleteConfirm.ts': 'platform',
  'packages/backend/src/services/demoSeed.ts': 'bootstrap',
  'packages/backend/src/services/developmentDeliveryDeps.ts': 'development-automation',
  'packages/backend/src/services/digitalEmployeeAgentTemplates.ts': 'digital-employee',
  'packages/backend/src/services/dispatchFrontier.ts': 'task-execution',
  'packages/backend/src/services/driverLease.ts': 'runtime-management',
  'packages/backend/src/services/dynamicWorkflowRunner.ts': 'task-execution',
  'packages/backend/src/services/employeeCaseMembers.ts': 'digital-employee',
  'packages/backend/src/services/envelope.ts': 'task-execution',
  'packages/backend/src/services/eventsArchive.ts': 'system-operations',
  'packages/backend/src/services/execution/agentInjection.ts': 'runtime-management',
  'packages/backend/src/services/execution/agentProcess.ts': 'platform',
  'packages/backend/src/services/execution/callRefTarget.ts': 'task-execution',
  'packages/backend/src/services/execution/childBudget.ts': 'task-execution',
  'packages/backend/src/services/execution/closure.ts': 'task-execution',
  'packages/backend/src/services/execution/executionWatch.ts': 'task-execution',
  'packages/backend/src/services/execution/inventoryObservation.ts': 'task-execution',
  'packages/backend/src/services/execution/inventoryRead.ts': 'task-execution',
  'packages/backend/src/services/execution/managedProcess.ts': 'platform',
  'packages/backend/src/services/execution/managedProcessLauncher.ts': 'platform',
  'packages/backend/src/services/execution/outcome.ts': 'task-execution',
  'packages/backend/src/services/execution/resolveInjection.ts': 'task-execution',
  'packages/backend/src/services/execution/resourcePolicy.ts': 'task-execution',
  'packages/backend/src/services/execution/runtimeConfigFreeze.ts': 'runtime-management',
  'packages/backend/src/services/execution/startupVerification.ts': 'task-execution',
  'packages/backend/src/services/execution/startupVerificationRead.ts': 'task-execution',
  'packages/backend/src/services/execution/taskEngineRuntimeOptions.ts': 'task-execution',
  'packages/backend/src/services/execution/taskExecutionCallClosure.ts': 'task-execution',
  'packages/backend/src/services/execution/taskExecutionResourceDependencies.ts': 'task-execution',
  'packages/backend/src/services/execution/taskExecutionResources.ts': 'task-execution',
  'packages/backend/src/services/execution/taskMechanicsState.ts': 'task-execution',
  'packages/backend/src/services/execution/triggerPreflight.ts': 'task-execution',
  'packages/backend/src/services/execution/types.ts': 'task-execution',
  'packages/backend/src/services/execution/workspaceBoundary.ts': 'task-execution',
  'packages/backend/src/services/freshness.ts': 'task-execution',
  'packages/backend/src/services/gc.ts': 'system-operations',
  'packages/backend/src/services/gitRepoCache.ts': 'source-control',
  'packages/backend/src/services/gitSubmodule.ts': 'source-control',
  'packages/backend/src/services/gitVersion.ts': 'source-control',
  'packages/backend/src/services/humanGateComposition.ts': 'collaboration',
  'packages/backend/src/services/humanGateContinuationEffects.ts': 'collaboration',
  'packages/backend/src/services/humanGateContinuationRecovery.ts': 'collaboration',
  'packages/backend/src/services/humanGateDecisionE2eBarrier.ts': 'collaboration',
  'packages/backend/src/services/isolatedAgentRun.ts': 'platform',
  'packages/backend/src/services/launchMultipart.ts': 'task-execution',
  'packages/backend/src/services/lifecycle.ts': 'task-execution',
  'packages/backend/src/services/lifecycleInvariants.ts': 'task-execution',
  'packages/backend/src/services/limits.ts': 'task-execution',
  'packages/backend/src/services/maintenanceDisk.ts': 'platform',
  'packages/backend/src/services/maintenanceRetention.ts': 'platform',
  'packages/backend/src/services/maintenanceState.ts': 'platform',
  'packages/backend/src/services/maintenanceTicker.ts': 'platform',
  'packages/backend/src/services/managedPeriodicJob.ts': 'platform',
  'packages/backend/src/services/mcpClosure.ts': 'resource-catalog',
  'packages/backend/src/services/mcpOperationRevision.ts': 'resource-catalog',
  'packages/backend/src/services/mcpProbe.ts': 'resource-catalog',
  'packages/backend/src/services/mcpProbeStore.ts': 'resource-catalog',
  'packages/backend/src/services/mcpSurface.ts': 'resource-catalog',
  'packages/backend/src/services/mergeAgent.ts': 'source-control',
  'packages/backend/src/services/nodeIsolation.ts': 'platform',
  'packages/backend/src/services/nodeRollback.ts': 'task-execution',
  'packages/backend/src/services/nodeRunMint.ts': 'task-execution',
  'packages/backend/src/services/nodeRunPrompt.ts': 'task-execution',
  'packages/backend/src/services/oidc/provisioning.ts': 'identity-access',
  'packages/backend/src/services/oidcProviders.ts': 'identity-access',
  'packages/backend/src/services/orchestratorAgent.ts': 'task-execution',
  'packages/backend/src/services/orphanReconcile.ts': 'task-execution',
  'packages/backend/src/services/orphans.ts': 'task-execution',
  'packages/backend/src/services/ownerIdentity.ts': 'identity-access',
  'packages/backend/src/services/ownerScopedName.ts': 'identity-access',
  'packages/backend/src/services/pendingRestore.ts': 'platform',
  'packages/backend/src/services/plantuml.ts': 'platform',
  'packages/backend/src/services/pluginClosure.ts': 'resource-catalog',
  'packages/backend/src/services/pluginGenerationGc.ts': 'resource-catalog',
  'packages/backend/src/services/pluginInstaller.ts': 'resource-catalog',
  'packages/backend/src/services/pluginOperationRevision.ts': 'resource-catalog',
  'packages/backend/src/services/portableBackupArchive.ts': 'system-operations',
  'packages/backend/src/services/portArtifacts.ts': 'task-execution',
  'packages/backend/src/services/processNodeConcurrency.ts': 'task-execution',
  'packages/backend/src/services/protocol.ts': 'task-execution',
  'packages/backend/src/services/questionDispatchComposition.ts': 'collaboration',
  'packages/backend/src/services/rawDbSnapshot.ts': 'platform',
  'packages/backend/src/services/recovery.ts': 'task-execution',
  'packages/backend/src/services/recoveryBreaker.ts': 'task-execution',
  'packages/backend/src/services/ref/runtimeRef.ts': 'runtime-management',
  'packages/backend/src/services/repo.ts': 'source-control',
  'packages/backend/src/services/repoBatchImport.ts': 'source-control',
  'packages/backend/src/services/repoCredentials.ts': 'source-control',
  'packages/backend/src/services/repoGroup.ts': 'source-control',
  'packages/backend/src/services/repoLabels.ts': 'source-control',
  'packages/backend/src/services/resourceAcl.ts': 'resource-catalog',
  'packages/backend/src/services/resourceCopyName.ts': 'resource-catalog',
  'packages/backend/src/services/resourceOperationCoordinator.ts': 'resource-catalog',
  'packages/backend/src/services/resourcePackage/closure.ts': 'resource-catalog',
  'packages/backend/src/services/resourcePackage/commit.ts': 'resource-catalog',
  'packages/backend/src/services/resourcePackage/executionAdapter.ts': 'resource-catalog',
  'packages/backend/src/services/resourcePackage/export.ts': 'resource-catalog',
  'packages/backend/src/services/resourcePackage/importPermissions.ts': 'resource-catalog',
  'packages/backend/src/services/resourcePackage/parse.ts': 'resource-catalog',
  'packages/backend/src/services/resourcePackage/pluginInstallerAdapter.ts': 'resource-catalog',
  'packages/backend/src/services/resourcePackage/preview.ts': 'resource-catalog',
  'packages/backend/src/services/resourcePackage/providerReadPort.ts': 'resource-catalog',
  'packages/backend/src/services/resourcePackage/requirements.ts': 'resource-catalog',
  'packages/backend/src/services/resourcePackage/secretInputs.ts': 'resource-catalog',
  'packages/backend/src/services/resourcePackage/serialize.ts': 'resource-catalog',
  'packages/backend/src/services/resourcePackage/skillTree.ts': 'resource-catalog',
  'packages/backend/src/services/resourceRefs.ts': 'resource-catalog',
  'packages/backend/src/services/restore.ts': 'platform',
  'packages/backend/src/services/review.ts': 'collaboration',
  'packages/backend/src/services/reviewDecisionComposition.ts': 'collaboration',
  'packages/backend/src/services/reviewMutationCoordinator.ts': 'collaboration',
  'packages/backend/src/services/reviewRoundStart.ts': 'collaboration',
  'packages/backend/src/services/rfc295DowngradeAudit.ts': 'bootstrap',
  'packages/backend/src/services/runLiveness.ts': 'task-execution',
  'packages/backend/src/services/runner.ts': 'platform',
  'packages/backend/src/services/runtime/claudeCode/boundary.ts': 'runtime-management',
  'packages/backend/src/services/runtime/claudeCode/config.ts': 'runtime-management',
  'packages/backend/src/services/runtime/claudeCode/driver.ts': 'runtime-management',
  'packages/backend/src/services/runtime/claudeCode/events.ts': 'runtime-management',
  'packages/backend/src/services/runtime/claudeCode/inject.ts': 'runtime-management',
  'packages/backend/src/services/runtime/claudeCode/models.ts': 'runtime-management',
  'packages/backend/src/services/runtime/claudeCode/permissionMap.ts': 'runtime-management',
  'packages/backend/src/services/runtime/claudeCode/probe.ts': 'runtime-management',
  'packages/backend/src/services/runtime/claudeCode/sessionCapture.ts': 'runtime-management',
  'packages/backend/src/services/runtime/claudeCode/spawn.ts': 'runtime-management',
  'packages/backend/src/services/runtime/claudeCode/usage.ts': 'runtime-management',
  'packages/backend/src/services/runtime/head.ts': 'runtime-management',
  'packages/backend/src/services/runtime/index.ts': 'runtime-management',
  'packages/backend/src/services/runtime/injectionIdentity.ts': 'runtime-management',
  'packages/backend/src/services/runtime/opencode/boundary.ts': 'runtime-management',
  'packages/backend/src/services/runtime/opencode/driver.ts': 'runtime-management',
  'packages/backend/src/services/runtime/opencode/events.ts': 'runtime-management',
  'packages/backend/src/services/runtime/opencode/inlineConfig.ts': 'runtime-management',
  'packages/backend/src/services/runtime/opencode/inventory.ts': 'runtime-management',
  'packages/backend/src/services/runtime/opencode/models.ts': 'runtime-management',
  'packages/backend/src/services/runtime/opencode/plugin/index.ts': 'runtime-management',
  'packages/backend/src/services/runtime/opencode/plugin/transcoder.ts': 'runtime-management',
  'packages/backend/src/services/runtime/opencode/pluginSpec.ts': 'runtime-management',
  'packages/backend/src/services/runtime/opencode/sessionCapture.ts': 'runtime-management',
  'packages/backend/src/services/runtime/opencode/sessionWalk.ts': 'runtime-management',
  'packages/backend/src/services/runtime/opencode/spawn.ts': 'runtime-management',
  'packages/backend/src/services/runtime/opencode/subagentLiveCapture.ts': 'runtime-management',
  'packages/backend/src/services/runtime/opencode/util.ts': 'runtime-management',
  'packages/backend/src/services/runtime/opencode/usage.ts': 'runtime-management',
  'packages/backend/src/services/runtime/opencode/nativeUsage.ts': 'runtime-management',
  'packages/backend/src/services/runtime/opencode/versionRegistry.ts': 'runtime-management',
  'packages/backend/src/services/runtime/selfCheck.ts': 'runtime-management',
  'packages/backend/src/services/runtime/spawnCtx.ts': 'runtime-management',
  'packages/backend/src/services/runtime/stageSkills.ts': 'runtime-management',
  'packages/backend/src/services/runtime/types.ts': 'runtime-management',
  'packages/backend/src/services/runtime/usage.ts': 'runtime-management',
  'packages/backend/src/services/runtimeSessionLease.ts': 'runtime-management',
  'packages/backend/src/services/runtimeSmoke.ts': 'runtime-management',
  'packages/backend/src/services/scheduledTaskRefs.ts': 'integration',
  'packages/backend/src/services/scheduledTasks.ts': 'integration',
  'packages/backend/src/services/scheduledTaskScheduler.ts': 'integration',
  'packages/backend/src/services/scheduler.ts': 'task-execution',
  'packages/backend/src/services/schedulerAssembly.ts': 'task-execution',
  'packages/backend/src/services/scriptAuthorGate.ts': 'resource-catalog',
  'packages/backend/src/services/scriptDepsEnv.ts': 'task-execution',
  'packages/backend/src/services/scriptPorts.ts': 'task-execution',
  'packages/backend/src/services/scriptRun.ts': 'task-execution',
  'packages/backend/src/services/sessionEventSink.ts': 'task-execution',
  'packages/backend/src/services/sessionModeFallback.ts': 'task-execution',
  'packages/backend/src/services/sessionView.ts': 'task-execution',
  'packages/backend/src/services/shutdown.ts': 'bootstrap',
  'packages/backend/src/services/skillBootVerify.ts': 'resource-catalog',
  'packages/backend/src/services/skillIdentityMigration.ts': 'resource-catalog',
  'packages/backend/src/services/skillIdentityPaths.ts': 'resource-catalog',
  'packages/backend/src/services/structuralDiff/assemble.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/baseline.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/bodyDelta.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/callGraph/classIndex.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/callGraph/expandService.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/callGraph/extractCalls.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/callGraph/service.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/classGraph.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/deep/deepImpact.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/deep/indexCache.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/deep/indexers.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/deep/runner.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/deep/scip.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/deep/service.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/deps/diff.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/deps/manifests.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/digest.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/gitBackend.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/impact.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/lang/extract.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/lang/grammars.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/lang/mask.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/lang/parser.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/lang/queries.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/refSelect.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/service.ts': 'workspace-insight',
  'packages/backend/src/services/structuralDiff/store.ts': 'workspace-insight',
  'packages/backend/src/services/stuckTaskDetector.ts': 'task-execution',
  'packages/backend/src/services/submoduleRefresh.ts': 'source-control',
  'packages/backend/src/services/systemAgentRun.ts': 'task-execution',
  'packages/backend/src/services/systemResources.ts': 'resource-catalog',
  'packages/backend/src/services/task.ts': 'task-execution',
  'packages/backend/src/services/taskAlerts.ts': 'task-execution',
  'packages/backend/src/services/taskArchive.ts': 'task-execution',
  'packages/backend/src/services/taskAuthorization.ts': 'task-execution',
  'packages/backend/src/services/taskClarifyDirective.ts': 'collaboration',
  'packages/backend/src/services/taskCollab.ts': 'collaboration',
  'packages/backend/src/services/taskDelete.ts': 'task-execution',
  'packages/backend/src/services/taskExecutionParticipants.ts': 'task-execution',
  'packages/backend/src/services/taskFanoutPools.ts': 'task-execution',
  'packages/backend/src/services/taskFeedback.ts': 'task-execution',
  'packages/backend/src/services/taskLaunchGate.ts': 'task-execution',
  'packages/backend/src/services/taskPlatformInputPaths.ts': 'task-execution',
  'packages/backend/src/services/taskQuestionConflicts.ts': 'collaboration',
  'packages/backend/src/services/taskQuestionDispatch.ts': 'collaboration',
  'packages/backend/src/services/taskQuestions.ts': 'collaboration',
  'packages/backend/src/services/taskWorkspacePhase.ts': 'source-control',
  'packages/backend/src/services/taskWriteLocks.ts': 'task-execution',
  'packages/backend/src/services/terminalSweep.ts': 'task-execution',
  'packages/backend/src/services/tokenAudit.ts': 'identity-access',
  'packages/backend/src/services/tokenRedaction.ts': 'identity-access',
  'packages/backend/src/services/upload.ts': 'task-execution',
  'packages/backend/src/services/userIdentities.ts': 'identity-access',
  'packages/backend/src/services/users.ts': 'identity-access',
  'packages/backend/src/services/webhook/codeHostAdapter.ts': 'integration',
  'packages/backend/src/services/webhook/deliveryStore.ts': 'integration',
  'packages/backend/src/services/webhook/dispatcherTypes.ts': 'integration',
  'packages/backend/src/services/webhook/githubAdapter.ts': 'integration',
  'packages/backend/src/services/webhook/gitlabAdapter.ts': 'integration',
  'packages/backend/src/services/webhook/matching.ts': 'integration',
  'packages/backend/src/services/webhook/rateLimiter.ts': 'integration',
  'packages/backend/src/services/webhook/terminalWorkspaceCleanup.ts': 'integration',
  'packages/backend/src/services/webhook/triggerValidation.ts': 'integration',
  'packages/backend/src/services/webhook/webhookDispatch.ts': 'integration',
  'packages/backend/src/services/webhook/webhookGc.ts': 'integration',
  'packages/backend/src/services/webhookEndpoints.ts': 'integration',
  'packages/backend/src/services/webhookTriggers.ts': 'integration',
  'packages/backend/src/services/workflow.ts': 'resource-catalog',
  'packages/backend/src/services/workflow.validator.ts': 'resource-catalog',
  'packages/backend/src/services/workflow.yaml.ts': 'resource-catalog',
  'packages/backend/src/services/workflowLaunchInputs.ts': 'resource-catalog',
  'packages/backend/src/services/workgroup/askerKey.ts': 'resource-catalog',
  'packages/backend/src/services/workgroup/constants.ts': 'resource-catalog',
  'packages/backend/src/services/workgroup/state.ts': 'resource-catalog',
  'packages/backend/src/services/workgroups.ts': 'resource-catalog',
  'packages/backend/src/services/worktreeBackup.ts': 'source-control',
  'packages/backend/src/services/worktreeFileContent.ts': 'source-control',
  'packages/backend/src/util/archive.ts': 'platform',
  'packages/backend/src/util/daemonInfo.ts': 'platform',
  'packages/backend/src/util/errors.ts': 'platform',
  'packages/backend/src/util/fileTrust.ts': 'platform',
  'packages/backend/src/util/frontmatter.ts': 'platform',
  'packages/backend/src/util/fsReclaim.ts': 'platform',
  'packages/backend/src/util/git.ts': 'source-control',
  'packages/backend/src/util/gitCredentialHelper.ts': 'source-control',
  'packages/backend/src/util/gitCredentialLease.ts': 'source-control',
  'packages/backend/src/util/gitHardening.ts': 'source-control',
  'packages/backend/src/util/gitRef.ts': 'source-control',
  'packages/backend/src/util/hash.ts': 'platform',
  'packages/backend/src/util/http.ts': 'platform',
  'packages/backend/src/util/inFlight.ts': 'platform',
  'packages/backend/src/util/jsonDocument.ts': 'platform',
  'packages/backend/src/util/keyedSerialQueue.ts': 'platform',
  'packages/backend/src/util/lock.ts': 'platform',
  'packages/backend/src/util/log.ts': 'platform',
  'packages/backend/src/util/migrationsFolder.ts': 'platform',
  'packages/backend/src/util/oidcResponse.ts': 'identity-access',
  'packages/backend/src/util/paths.ts': 'platform',
  'packages/backend/src/util/platformExec.ts': 'platform',
  'packages/backend/src/util/process.ts': 'platform',
  'packages/backend/src/util/redact.ts': 'platform',
  'packages/backend/src/util/safePath.ts': 'platform',
  'packages/backend/src/util/semaphore.ts': 'platform',
  'packages/backend/src/util/semver.ts': 'platform',
  'packages/backend/src/util/spawnDiagnostics.ts': 'platform',
  'packages/backend/src/util/sqlChunk.ts': 'platform',
  'packages/backend/src/util/time.ts': 'platform',
  'packages/backend/src/util/timeoutSignal.ts': 'platform',
  'packages/backend/src/util/version.ts': 'platform',
  'packages/backend/src/util/win32Acl.ts': 'platform',
  'packages/backend/src/util/windowsJobObject.ts': 'platform',
  'packages/backend/src/util/zip.ts': 'platform',
  'packages/backend/src/ws/broadcaster.ts': 'platform',
  'packages/backend/src/ws/connections.ts': 'platform',
  'packages/backend/src/ws/registry.ts': 'platform',
  'packages/backend/src/ws/revalidationHook.ts': 'platform',
  'packages/backend/src/ws/server.ts': 'platform',
}

/** 登记表的键，供守卫核对「表里每一行都指向真实存在的文件」（没有幽灵条目）。 */
export const LEGACY_BACKEND_FILE_OWNER_PATHS: readonly string[] = Object.keys(
  LEGACY_BACKEND_FILE_OWNERS,
)

const RFC346_W9_E_COMPATIBILITY_FILES = new Set([
  'packages/backend/src/cli/rfc295-downgrade-audit.ts',
  'packages/backend/src/modules/system-operations/infrastructure/legacyPlatformRecoveryAdapter.ts',
  'packages/backend/src/services/backup.ts',
  'packages/backend/src/services/pendingRestore.ts',
  'packages/backend/src/services/restore.ts',
  'packages/backend/src/services/rfc295DowngradeAudit.ts',
  'packages/backend/src/services/worktreeBackup.ts',
])

export function targetContextFor(path: string): TargetOwner {
  const location = moduleLocation(path)
  if (location !== null) {
    if ((TARGET_PUBLIC_CONTEXTS as readonly string[]).includes(location.context)) {
      return location.context as TargetContext
    }
    // `modules/code-capability/**` 是 RFC-304 的存量物理模块，不是目标架构里的 bounded
    // context：它的归宿是 development-automation 的 ActionTemplate（plan.md §8 E8）。
    // 下面 `targetRemoveAfterWaveFor` 的 physicalContext 特判早就把它钉在 W4-E8 上，这里
    // 只是把 context 也说清楚，免得它掉进已被删掉的兜底里。
    if (location.context === 'code-capability') return 'development-automation'
  }
  if (path.startsWith('packages/frontend/src/')) return 'frontend'
  if (path.startsWith('packages/shared/src/')) return 'shared-contracts'
  if (path.startsWith('packages/backend/src/platform/')) return 'platform'
  if (path.startsWith('packages/backend/src/db/')) return 'platform'
  const registered = LEGACY_BACKEND_FILE_OWNERS[path]
  if (registered !== undefined) return registered
  return 'unregistered'
}

const SCHEDULER_W2_B_SYMBOLS = new Set([
  'buildScopeUpstreams',
  'deriveFrontier',
  'findScopeCycle',
  'runScope',
  'runTaskInner',
  'runTaskWithTopology',
])
const SCHEDULER_W2_D_SYMBOLS = new Set([
  'dispatchFanoutAggregator',
  'dispatchFanoutShard',
  'replayConflictHumanResolutions',
  'replayPendingMerges',
  'runGitWrapperNode',
  'runLoopWrapperNode',
  'runWrapperFanoutNode',
  'runWrapperGitNode',
  'runWrapperLoopNode',
  'runWrapperNode',
])
const SCHEDULER_W3_SYMBOLS = new Set(['cancelTaskRow', 'emitStatus', 'failTask'])
const SCHEDULER_W5_SYMBOLS = new Set(['inspectReadonlyRepos', 'maybeRunCommitPush'])

// RFC-294 账本治理（2026-09-22，用户裁决其二）——**已关闭的波不再承接新债**。
//
// 2026-09-02 的 R4 把「legacy 文件消费模块 public 面」的边改成按**消费者**记账（「修法落在谁
// 的代码里就归谁的波」）。这条规则本身是对的，但它是在 W4-C / E0 / E2 / E3 / E4a / E4b / E7
// 各自宣告 Done **之后**生效的，于是这些已关闭的桶里又被灌进 794 条：`auth/actor.ts` 上的 117
// 条（W4-E0）、`routes/agents.ts` 一类消费者的边（W4-C）……它们记的都是「某个 legacy 文件还
// 没搬进它自己的 context」，而搬迁那件事在对应的波里既没做、也没被它的退出门要求做。
//
// 结果是 `removeAfterWave` 在这些桶上说了假话：波是 Done 的，桶却不空，而且还在长。本次按用户
// 裁决改为**重定到未完成的波**：`plan.md §13 W9-D「Facade/legacy contract」`的退出门逐字就是
// 「cross-context internal import=0」「删除到期旧路径和临时 export」——这批债的终局正是那里。
// 重定只改「谁来销」，不改「债是什么」：每条 exact id、它的 from/to/rule 都原样保留。
//
// 注意这是**全账本一致**的重定，不只是 cross-context 异常表：facade 账本与 owner 账本用的是同一
// 个函数，让其中一份继续写 Done 的波，就会在下一次对账时重新制造同样的假话。
const CLOSED_WAVES: ReadonlySet<string> = new Set([
  'W4-C',
  'W4-E0',
  'W4-E2',
  'W4-E3',
  'W4-E4a',
  'W4-E4b',
  'W4-E7',
])
const CLOSED_WAVE_SUCCESSOR = 'W9-D'

export function targetRemoveAfterWaveFor(
  path: string,
  symbol: string,
  targetContext: TargetOwner = targetContextFor(path),
): string {
  const wave = uncollectedRemoveAfterWaveFor(path, symbol, targetContext)
  return CLOSED_WAVES.has(wave) ? CLOSED_WAVE_SUCCESSOR : wave
}

function uncollectedRemoveAfterWaveFor(
  path: string,
  symbol: string,
  targetContext: TargetOwner,
): string {
  if (RFC346_W9_E_COMPATIBILITY_FILES.has(path)) return 'W9-E'
  if (path === 'packages/backend/src/services/scheduler.ts') {
    if (SCHEDULER_W2_B_SYMBOLS.has(symbol)) return 'W2-B'
    if (SCHEDULER_W2_D_SYMBOLS.has(symbol)) return 'W2-D'
    if (SCHEDULER_W3_SYMBOLS.has(symbol)) return 'W3'
    if (SCHEDULER_W5_SYMBOLS.has(symbol)) return 'W5'
    return 'W2-D/W3/W5'
  }
  const physicalContext = moduleLocation(path)?.context
  if (physicalContext === 'code-capability') return 'W4-E8'
  const waves: Readonly<Record<TargetOwner, string>> = {
    unregistered: 'unregistered',
    bootstrap: 'W9',
    collaboration: 'W4',
    'development-automation': 'W4-E8',
    'digital-employee': 'W4-E9',
    'event-center': 'W4-E9',
    'execution-contract': 'W4-E9',
    frontend: 'W9',
    'identity-access': 'W4-E0',
    integration: 'W4-B',
    intent: 'W4-E4a',
    'knowledge-evolution': 'W4-E3',
    memory: 'W4-E2',
    platform: 'W9',
    'resource-catalog': 'W4-C',
    'run-observability': 'RFC-371',
    'runtime-management': 'W4-E4b',
    'shared-contracts': 'W9',
    'source-control': 'W5',
    'system-operations': 'W4-E7',
    'task-catalog': 'W4-E10',
    'task-execution': 'W4-E1',
    'workspace-insight': 'W4-E5',
  }
  return waves[targetContext]
}

function targetLayerFor(path: string, symbol: string): string {
  const location = moduleLocation(path)
  if (location !== null) {
    if (
      location.rest.startsWith('composition/') &&
      location.rest !== 'composition/required-ports'
    ) {
      return location.context === 'task-execution' ? 'engine' : 'application'
    }
    return location.rest.split('/')[0] ?? 'application'
  }
  if (path.startsWith('packages/frontend/src/')) {
    return path.slice('packages/frontend/src/'.length).split('/')[0] ?? 'frontend'
  }
  if (path.startsWith('packages/shared/src/')) return 'contracts'
  if (path.startsWith('packages/backend/src/platform/')) {
    return path.slice('packages/backend/src/platform/'.length).split('/')[0] ?? 'mechanism'
  }
  const value = `${path}#${symbol}`.toLowerCase()
  if (/schema|model|policy|lifecycle|status|predicate/.test(value)) return 'domain'
  if (/adapter|sqlite|store|repository|client|driver|fs|git/.test(value)) return 'infrastructure'
  if (/scheduler\.ts|executor|wrapper|kernel|frontier|nodeexecutor/.test(value)) return 'engine'
  if (/route|server|ws|mcp|cli/.test(value)) return 'inbound'
  return 'application'
}

function ownerEntryId(path: string, symbol: string): string {
  return `owner:${path}#${symbol}`
}

interface OwnerEntry {
  readonly id: string
  readonly file: string
  readonly symbol: string
  readonly exported: boolean
  readonly currentContext: string
  readonly currentLayer: string
  readonly targetContext: TargetOwner
  readonly targetLayer: string
  readonly status:
    | 'cross-package-contract'
    | 'current-module'
    | 'external-contract'
    | 'legacy-target'
  readonly removeAfterWave: string | null
  readonly signatureDigest?: string
}

function buildOwnerEntries(units: readonly SourceUnit[]): OwnerEntry[] {
  const entries: OwnerEntry[] = []
  for (const unit of units) {
    const location = moduleLocation(unit.path)
    const currentContext =
      location?.context ??
      (unit.path.startsWith('packages/frontend/src/')
        ? 'frontend'
        : unit.path.startsWith('packages/shared/src/')
          ? 'shared'
          : 'legacy')
    const currentLayer = physicalLayer(unit)
    const publicEntry = publicLocation(unit.path)
    const named = topLevelNamedNodes(unit)
    const nodes = [{ name: '$file', node: unit.source as ts.Node, exported: false }, ...named]
    for (const item of nodes) {
      const targetContext = targetContextFor(unit.path)
      const compositionDebt =
        location !== null &&
        location.rest.startsWith('composition/') &&
        location.rest !== 'composition/required-ports'
      entries.push({
        id: ownerEntryId(unit.path, item.name),
        file: unit.path,
        symbol: item.name,
        exported: item.exported,
        currentContext,
        currentLayer,
        targetContext,
        targetLayer: targetLayerFor(unit.path, item.name),
        status:
          unit.path.startsWith('packages/frontend/src/') ||
          unit.path.startsWith('packages/shared/src/')
            ? 'cross-package-contract'
            : location === null
              ? 'legacy-target'
              : 'current-module',
        removeAfterWave:
          unit.path.startsWith(BACKEND_PREFIX) && (location === null || compositionDebt)
            ? targetRemoveAfterWaveFor(unit.path, item.name, targetContext)
            : null,
        ...(publicEntry !== null && item.exported
          ? {
              signatureDigest: digestText(
                item.node.getText(unit.source).replace(/\s+/g, ' ').trim(),
              ),
            }
          : {}),
      })
    }
  }
  // Function overloads and declaration merging can legitimately repeat one
  // top-level symbol.  Ownership is still one row; the source file remains the
  // signature/API authority for all overload declarations.
  const unique = new Map(entries.map((entry) => [entry.id, entry]))
  for (const specifier of GOVERNED_EXTERNAL_SPECIFIERS) {
    const file = `external:${specifier}`
    const symbol = '$package'
    const entry: OwnerEntry = {
      id: ownerEntryId(file, symbol),
      file,
      symbol,
      exported: true,
      currentContext: 'external',
      currentLayer: 'vendor',
      targetContext: 'platform',
      targetLayer: 'persistence-adapter',
      status: 'external-contract',
      removeAfterWave: null,
      signatureDigest: digestText(specifier),
    }
    unique.set(entry.id, entry)
  }
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function attemptsFor(candidate: string): string[] {
  const withoutExtension = candidate.replace(/\.[cm]?tsx?$/, '')
  return [
    candidate,
    `${withoutExtension}.ts`,
    `${withoutExtension}.tsx`,
    `${withoutExtension}/index.ts`,
    `${withoutExtension}/index.tsx`,
  ]
}

function resolveSpecifier(
  allUnits: readonly SourceUnit[],
  fromPath: string,
  specifier: string,
): SourceUnit | null {
  let candidate: string | null = null
  const packageMatch = /^packages\/([^/]+)\/src\//.exec(fromPath)
  if (specifier.startsWith('@/') && packageMatch !== null) {
    candidate = `packages/${packageMatch[1]!}/src/${specifier.slice(2)}`
  } else if (specifier === '@agent-workflow/shared') {
    candidate = 'packages/shared/src/index'
  } else if (specifier.startsWith('@agent-workflow/shared/')) {
    candidate = `packages/shared/src/${specifier.slice('@agent-workflow/shared/'.length)}`
  } else if (specifier.startsWith('.')) {
    candidate = posix.normalize(posix.join(posix.dirname(fromPath), specifier))
  }
  if (candidate === null) return null
  const attempts = new Set(attemptsFor(portable(candidate)))
  return allUnits.find((unit) => attempts.has(unit.path)) ?? null
}

interface SymbolImport {
  readonly fromFile: string
  readonly toFile: string
  readonly importedName: string
  readonly localName: string
  readonly edgeKind: EdgeKind
  readonly syntax: EdgeSyntax
  readonly specifier: string
}

function symbolImports(unit: SourceUnit, allUnits: readonly SourceUnit[]): SymbolImport[] {
  const out: SymbolImport[] = []
  const add = (
    specifier: string,
    importedName: string,
    localName: string,
    edgeKind: EdgeKind,
    syntax: EdgeSyntax,
  ): void => {
    const target = resolveSpecifier(allUnits, unit.path, specifier)
    if (target === null) return
    out.push({
      fromFile: unit.path,
      toFile: target.path,
      importedName,
      localName,
      edgeKind,
      syntax,
      specifier,
    })
  }
  for (const statement of unit.source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text
      const clause = statement.importClause
      if (clause?.name !== undefined) {
        add(
          specifier,
          'default',
          clause.name.text,
          clause.isTypeOnly ? 'type' : 'value',
          'static-import',
        )
      }
      if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          add(
            specifier,
            element.propertyName?.text ?? element.name.text,
            element.name.text,
            clause.isTypeOnly || element.isTypeOnly ? 'type' : 'value',
            'static-import',
          )
        }
      } else if (clause?.namedBindings !== undefined) {
        add(
          specifier,
          '*',
          clause.namedBindings.name.text,
          clause.isTypeOnly ? 'type' : 'value',
          'static-import',
        )
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text
      if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          add(
            specifier,
            element.propertyName?.text ?? element.name.text,
            element.name.text,
            statement.isTypeOnly || element.isTypeOnly ? 'type' : 'value',
            'export',
          )
        }
      } else {
        add(specifier, '*', '*', statement.isTypeOnly ? 'type' : 'value', 'export')
      }
    }
  }
  // Side-effect imports, import(), require() and import('x').T carry a real
  // dependency even when no named binding exists.  Preserve them as a wildcard
  // symbol edge instead of letting the symbol-level inventory hide them.
  for (const edge of importEdges(unit)) {
    if (
      out.some(
        (item) =>
          item.specifier === edge.specifier &&
          item.edgeKind === edge.kind &&
          item.syntax === edge.syntax,
      )
    ) {
      continue
    }
    add(edge.specifier, '*', '*', edge.kind, edge.syntax)
  }
  return out.sort((left, right) =>
    `${left.fromFile}|${left.toFile}|${left.importedName}|${left.edgeKind}`.localeCompare(
      `${right.fromFile}|${right.toFile}|${right.importedName}|${right.edgeKind}`,
    ),
  )
}

function publicLocation(path: string): { context: string; entrypoint: string } | null {
  const location = moduleLocation(path)
  if (location === null) return null
  const match = /^public\/([^/]+)$/.exec(location.rest)
  if (match === null || !EXACT_PUBLIC.has(match[1]!)) return null
  return { context: location.context, entrypoint: match[1]! }
}

/**
 * RFC-352 T9 —— 「这条路径是不是模块**已发布**的面」。
 *
 * 与 `publicLocation` 的区别只有一处、但对记账很关键：那个函数只认 EXACT 入口
 * （commands/queries/participants/events/operations/types），而 `public/` 下还有一批**已登记**的
 * 非 exact 入口（`NON_EXACT_PUBLIC`，例如 memory 的 `catalog.ts` / `fusion.ts`）。
 * 就 R4「legacy 消费模块已发布面 ⇒ 记消费者的波」这条规则而言，两者没有分别：
 * 消费者拿到的都是模块对外承诺的东西，剩下的活都是把**消费者**搬进它自己的 context。
 * 用 EXACT 判会让 `services/fusion.ts` 这样的消费者被错记到被调模块头上
 * （实测：9 条 fusion→memory 的边挂在 W4-E2，而修法全在 knowledge-evolution 的文件里）。
 */
function isPublishedSurface(path: string): boolean {
  const location = moduleLocation(path)
  return location !== null && /^public\/[^/]+$/.test(location.rest)
}

function requiredPortLocation(path: string): { context: string } | null {
  const location = moduleLocation(path)
  if (location === null) return null
  if (location.rest === 'composition/required-ports') return { context: location.context }
  // RFC-362: this application-owned Task port is declared without a production binding.
  if (
    location.context === 'task-execution' &&
    location.rest === 'application/ports/workspaceLaunch'
  ) {
    return { context: location.context }
  }
  if (
    location.context === 'system-operations' &&
    /^application\/ports\/[^/]+$/.test(location.rest)
  ) {
    return { context: location.context }
  }
  return null
}

type ObservedEdgeRole =
  | ContextEdgeRole
  | 'external-layer-debt'
  // infrastructure 层直连受管 external（drizzle 等）：分层规则允许的落点，观察但不计 wave 债。
  | 'infrastructure-external'
  // sqlite/postgresql 双 provider 的精确孪生：同一条逻辑债只在先落地的 provider 上计一次。
  | 'provider-mirror'
  | 'temporary-internal-debt'
  | 'off-dag-offered'
  | 'legacy-inbound'
  | 'legacy-outbound'

interface ObservedContextEdge {
  readonly id: string
  readonly fromFile: string
  readonly fromOwnerEntryId: string
  readonly fromContext: string
  readonly toFile: string
  readonly toOwnerEntryId: string
  readonly toContext: string
  readonly targetSymbol: string
  readonly specifier: string
  readonly edgeKind: EdgeKind
  readonly syntax: EdgeSyntax
  readonly role: ObservedEdgeRole
  readonly owner: string
  readonly removeAfterWave: string | null
}

function offDagOfferedRemoveAfterWave(fromContext: string, toContext: string): string {
  const pair = new Set([fromContext, toContext])
  if (pair.has('collaboration') && pair.has('task-execution')) return 'W4'
  if (pair.has('digital-employee') && pair.has('task-execution')) return 'W4-E9'
  if (pair.has('development-automation') || pair.has('code-capability')) return 'W4-E8'
  return targetRemoveAfterWaveFor(
    `packages/backend/src/modules/${toContext}/public/types.ts`,
    '$file',
    toContext as TargetContext,
  )
}

function observedContextEdges(
  backend: readonly SourceUnit[],
  allUnits: readonly SourceUnit[],
  owners: readonly OwnerEntry[],
): ObservedContextEdge[] {
  const ownerIds = new Set(owners.map((entry) => entry.id))
  const edges: ObservedContextEdge[] = []
  for (const unit of backend) {
    const fromLocation = moduleLocation(unit.path)
    for (const item of symbolImports(unit, allUnits)) {
      // shared/frontend/platform packages are outside the bounded-context
      // module graph.  Their package dependency is governed separately; this
      // manifest owns backend module and legacy-boundary edges only.
      if (!item.toFile.startsWith(BACKEND_PREFIX)) continue
      const toLocation = moduleLocation(item.toFile)
      const sameContextRequiredImplementation =
        fromLocation !== null &&
        fromLocation.context === toLocation?.context &&
        requiredPortLocation(item.toFile) !== null &&
        item.edgeKind === 'type' &&
        fromLocation.rest.startsWith('infrastructure/')
      if (fromLocation?.context === toLocation?.context && !sameContextRequiredImplementation) {
        continue
      }
      if (fromLocation === null && toLocation === null) continue

      let role: ObservedEdgeRole
      let removeAfterWave: string | null = null
      if (fromLocation === null) {
        role = 'legacy-inbound'
        removeAfterWave =
          unit.path === 'packages/backend/src/services/task.ts' &&
          item.toFile ===
            'packages/backend/src/modules/task-execution/composition/taskDriveLegacy.ts'
            ? 'W4'
            : // 用户 2026-09-02 给 RFC-345 T9 定的归属规则（「修法落在谁的代码里就归谁的波」）在此机器化：
              // legacy 调用者消费模块**已发布的 public 面**是目标形态本身，剩下的活是把**调用者**搬进
              // 它自己的 context，因此这条边归消费者所属的波；深入模块内部（composition / infrastructure /
              // application）的 legacy-inbound 才是被调模块自己的债，仍记在被调模块的波上。
              // 不这么记，已经 Done 的波（W4-C / W4-E0 / W4-E7）桶里会永远挂着别人的活。
              isPublishedSurface(item.toFile)
              ? targetRemoveAfterWaveFor(unit.path, '$file')
              : targetRemoveAfterWaveFor(
                  item.toFile,
                  item.importedName,
                  toLocation!.context as TargetContext,
                )
      } else if (toLocation === null) {
        role = 'legacy-outbound'
        removeAfterWave = targetRemoveAfterWaveFor(item.toFile, item.importedName)
      } else {
        const publicEntry = publicLocation(item.toFile)
        const requiredPort = requiredPortLocation(item.toFile)
        if (
          toLocation.context === 'identity-access' &&
          (publicEntry?.entrypoint === 'types' || publicEntry?.entrypoint === 'participants') &&
          item.edgeKind === 'type'
        ) {
          role = 'authority-type-only'
        } else if (
          requiredPort !== null &&
          item.edgeKind === 'type' &&
          (sameContextRequiredImplementation ||
            /^application\/adapters\/[^/]+-adapter$/.test(fromLocation.rest))
        ) {
          role = 'required-implementation'
        } else if (publicEntry !== null) {
          if (OFFERED_CONTEXT_PAIRS.has(`${fromLocation.context}->${toLocation.context}`)) {
            role = 'offered-consumption'
          } else {
            role = 'off-dag-offered'
            removeAfterWave = offDagOfferedRemoveAfterWave(fromLocation.context, toLocation.context)
          }
        } else {
          role = 'temporary-internal-debt'
          removeAfterWave = targetRemoveAfterWaveFor(
            item.fromFile,
            item.importedName,
            fromLocation.context as TargetContext,
          )
        }
      }

      const exactTarget = ownerEntryId(item.toFile, item.importedName)
      const toOwnerEntryId = ownerIds.has(exactTarget)
        ? exactTarget
        : ownerEntryId(item.toFile, '$file')
      const identity = [
        item.fromFile,
        item.toFile,
        item.importedName,
        item.edgeKind,
        item.syntax,
        role,
      ].join('|')
      edges.push({
        id: `import:${digestText(identity).slice('sha256:'.length, 'sha256:'.length + 20)}`,
        fromFile: item.fromFile,
        fromOwnerEntryId: ownerEntryId(item.fromFile, '$file'),
        fromContext: fromLocation?.context ?? 'legacy',
        toFile: item.toFile,
        toOwnerEntryId,
        toContext: toLocation?.context ?? 'legacy',
        targetSymbol: item.importedName,
        specifier: item.specifier,
        edgeKind: item.edgeKind,
        syntax: item.syntax,
        role,
        owner: fromLocation?.context ?? targetContextFor(item.fromFile),
        removeAfterWave,
      })
    }
    if (fromLocation !== null) {
      for (const item of importEdges(unit)) {
        if (!GOVERNED_EXTERNAL_SPECIFIERS.has(item.specifier)) continue
        const toFile = `external:${item.specifier}`
        // 记账裁决的另一半（用户 2026-09-02）：infrastructure 层直连受管 external（drizzle 等）是
        // 分层规则允许的落点——RFC-349 双 provider 之后这类边有 394 条，全部记成「该模块的 wave 债」
        // 会让每个子波替平台买单。这里改记 `infrastructure-external` 观察边、不计债；
        // infrastructure 之外的直连（当前 5 条）仍是真债，照旧记在该模块的波上。
        const externalRole: ObservedEdgeRole = fromLocation.rest.startsWith('infrastructure/')
          ? 'infrastructure-external'
          : 'external-layer-debt'
        const identity = [unit.path, toFile, item.kind, item.syntax, externalRole].join('|')
        edges.push({
          id: `import:${digestText(identity).slice('sha256:'.length, 'sha256:'.length + 20)}`,
          fromFile: unit.path,
          fromOwnerEntryId: ownerEntryId(unit.path, '$file'),
          fromContext: fromLocation.context,
          toFile,
          toOwnerEntryId: ownerEntryId(toFile, '$package'),
          toContext: 'external',
          targetSymbol: '*',
          specifier: item.specifier,
          edgeKind: item.kind,
          syntax: item.syntax,
          role: externalRole,
          owner: fromLocation.context,
          removeAfterWave:
            externalRole === 'infrastructure-external'
              ? null
              : targetRemoveAfterWaveFor(unit.path, '$file', fromLocation.context as TargetContext),
        })
      }
    }
  }
  const unique = new Map(edges.map((edge) => [edge.id, edge]))
  return [...collapseProviderMirrors([...unique.values()])].sort((left, right) =>
    left.id.localeCompare(right.id),
  )
}

/**
 * `modules/<context>/infrastructure/{sqlite,postgresql}<Name>.ts` 的孪生键。
 * 不是 provider adapter 时返回 `null`。
 */
function providerTwinKey(path: string): string | null {
  const match =
    /^(packages\/backend\/src\/modules\/[^/]+\/infrastructure\/)(?:sqlite|postgresql)([A-Z][A-Za-z0-9]*\.ts)$/.exec(
      path,
    )
  return match === null ? null : `${match[1]}@provider-twin/${match[2]}`
}

/**
 * RFC-294 记账裁决（用户 2026-09-02，「孪生只计一次」）：RFC-349 之后同一条逻辑依赖会在
 * SQLite / PostgreSQL 两个 adapter 上各出现一次。两条都计会让 wave 分母凭空翻倍，而一刀切「provider
 * adapter 一律不计」又会把真耦合藏起来（实测：扣掉平台原语后，provider adapter 仍有指向
 * `services/task.ts` / `modules/intent/application/manifest.ts` / `services/lifecycle.ts` 的真实边）。
 * 因此只折叠**精确孪生**——同 target、同符号、同 edgeKind/syntax/role 的那一对：先落地的 SQLite 侧
 * 保留为债，PostgreSQL 侧记 `provider-mirror` 观察边、不计 wave 债。任一侧独有的边不受影响。
 *
 * **只折叠 `legacy-outbound`**（模块 → legacy 实现）。`temporary-internal-debt` 与 `off-dag-offered`
 * 是**逐站点**的边界主张：跨 context 深入模块内部、或消费 DAG 外的 public 面，两个 provider 各违一次
 * 就得各修一次，折叠等于让其中一处失去 exact 覆盖——`rfc294-architecture-preflight` 的
 * 「cross-context internals are covered by exact, expiring canonical exceptions」会当场红（实撞 5 条）。
 */
function collapseProviderMirrors(edges: readonly ObservedContextEdge[]): ObservedContextEdge[] {
  const groups = new Map<string, ObservedContextEdge[]>()
  for (const edge of edges) {
    if (edge.removeAfterWave === null || edge.role !== 'legacy-outbound') continue
    const twin = providerTwinKey(edge.fromFile)
    if (twin === null) continue
    const key = [twin, edge.toFile, edge.targetSymbol, edge.edgeKind, edge.syntax, edge.role].join(
      '|',
    )
    groups.set(key, [...(groups.get(key) ?? []), edge])
  }
  const mirrors = new Set<string>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const primary = group.find((edge) => /\/sqlite[A-Z]/.test(edge.fromFile))
    if (primary === undefined || !group.some((edge) => /\/postgresql[A-Z]/.test(edge.fromFile))) {
      continue
    }
    for (const edge of group) if (edge !== primary) mirrors.add(edge.id)
  }
  if (mirrors.size === 0) return [...edges]
  return edges.map((edge) => {
    if (!mirrors.has(edge.id)) return edge
    const identity = [
      edge.fromFile,
      edge.toFile,
      edge.targetSymbol,
      edge.edgeKind,
      edge.syntax,
      'provider-mirror',
    ].join('|')
    return {
      ...edge,
      id: `import:${digestText(identity).slice('sha256:'.length, 'sha256:'.length + 20)}`,
      role: 'provider-mirror' as const,
      removeAfterWave: null,
    }
  })
}

function memberNames(node: ts.Node): string[] {
  if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
    return node.members
      .map((member) => declarationName(member))
      .filter((name): name is string => name !== null)
      .sort()
  }
  if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
    return node.type.members
      .map((member) => declarationName(member))
      .filter((name): name is string => name !== null)
      .sort()
  }
  return []
}

interface SurfaceMember {
  readonly name: string
  readonly signatureDigest: string
  readonly consumerEdgeIds: readonly string[]
}

interface SurfaceField {
  readonly fieldPath: string
  readonly type: string
  readonly consumerEdgeIds: readonly string[]
}

function propertyName(node: ts.PropertyName | undefined): string | null {
  if (node === undefined) return null
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) {
    return node.text
  }
  if (ts.isNumericLiteral(node)) return node.text
  return null
}

interface ResolvedShapeReference {
  readonly key: string
  readonly node: ts.Node
  readonly source: ts.SourceFile
}

type ShapeResolver = (source: ts.SourceFile, name: string) => ResolvedShapeReference | null

interface MutableShape {
  readonly fields: Array<{ fieldPath: string; type: string }>
  readonly methods: Array<{ name: string; signatureDigest: string }>
  unionVariants: number
  readonly unresolvedRefs: string[]
  readonly resolvedRefs: string[]
}

function shapePath(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix}.${name}`
}

function collectSignatureShape(
  node: ts.SignatureDeclarationBase,
  source: ts.SourceFile,
  shape: MutableShape,
  resolver: ShapeResolver,
  prefix: string,
  visited: ReadonlySet<string>,
  depth: number,
  inheritedTypeParameters: ReadonlySet<string>,
): void {
  const typeParameters = new Set([
    ...inheritedTypeParameters,
    ...(node.typeParameters?.map((parameter) => parameter.name.text) ?? []),
  ])
  for (const parameter of node.parameters) {
    if (parameter.type === undefined) continue
    collectTypeShape(
      parameter.type,
      source,
      shape,
      resolver,
      shapePath(prefix, `$parameter:${parameter.name.getText(source)}`),
      visited,
      depth + 1,
      typeParameters,
    )
  }
  if (node.type !== undefined) {
    collectTypeShape(
      node.type,
      source,
      shape,
      resolver,
      shapePath(prefix, '$return'),
      visited,
      depth + 1,
      typeParameters,
    )
  }
}

function collectNodeShape(
  node: ts.Node,
  source: ts.SourceFile,
  shape: MutableShape,
  resolver: ShapeResolver,
  prefix: string,
  visited: ReadonlySet<string>,
  depth: number,
  inheritedTypeParameters: ReadonlySet<string> = new Set(),
): void {
  const typeParameters = new Set([
    ...inheritedTypeParameters,
    ...((
      node as ts.Node & {
        readonly typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration>
      }
    ).typeParameters?.map((parameter) => parameter.name.text) ?? []),
  ])
  if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
    for (const member of node.members) {
      if (ts.isCallSignatureDeclaration(member)) {
        shape.methods.push({
          name: '$call',
          signatureDigest: digestText(member.getText(source).replace(/\s+/g, ' ').trim()),
        })
        collectSignatureShape(
          member,
          source,
          shape,
          resolver,
          shapePath(prefix, '$call'),
          visited,
          depth + 1,
          typeParameters,
        )
        continue
      }
      const name = propertyName(member.name)
      if (name === null) continue
      if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
        shape.methods.push({
          name,
          signatureDigest: digestText(member.getText(source).replace(/\s+/g, ' ').trim()),
        })
        collectSignatureShape(
          member,
          source,
          shape,
          resolver,
          shapePath(prefix, `$method:${name}`),
          visited,
          depth + 1,
          typeParameters,
        )
      } else if (
        (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) &&
        member.type !== undefined
      ) {
        collectTypeShape(
          member.type,
          source,
          shape,
          resolver,
          shapePath(prefix, name),
          visited,
          depth + 1,
          typeParameters,
        )
      }
    }
    for (const clause of node.heritageClauses ?? []) {
      for (const heritage of clause.types) {
        const name = heritage.expression.getText(source)
        const resolved = ts.isIdentifier(heritage.expression) ? resolver(source, name) : null
        if (resolved !== null) shape.resolvedRefs.push(resolved.key)
        if (resolved !== null && !visited.has(resolved.key)) {
          collectNodeShape(
            resolved.node,
            resolved.source,
            shape,
            resolver,
            prefix,
            new Set([...visited, resolved.key]),
            depth + 1,
          )
        } else if (resolved === null) {
          shape.unresolvedRefs.push(`extends:${name}`)
        }
      }
    }
  } else if (ts.isTypeAliasDeclaration(node)) {
    collectTypeShape(node.type, source, shape, resolver, prefix, visited, depth + 1, typeParameters)
  } else if (ts.isFunctionDeclaration(node)) {
    shape.methods.push({
      name: '$call',
      signatureDigest: digestText(node.getText(source).replace(/\s+/g, ' ').trim()),
    })
    collectSignatureShape(
      node,
      source,
      shape,
      resolver,
      shapePath(prefix, '$call'),
      visited,
      depth + 1,
      typeParameters,
    )
  }
}

function collectTypeShape(
  type: ts.TypeNode,
  source: ts.SourceFile,
  shape: MutableShape,
  resolver: ShapeResolver,
  prefix = '',
  visited: ReadonlySet<string> = new Set(),
  depth = 0,
  typeParameters: ReadonlySet<string> = new Set(),
): void {
  if (depth > 20) {
    shape.unresolvedRefs.push('$depth-limit')
    return
  }
  if (ts.isTypeLiteralNode(type)) {
    for (const member of type.members) {
      if (ts.isCallSignatureDeclaration(member)) {
        shape.methods.push({
          name: '$call',
          signatureDigest: digestText(member.getText(source).replace(/\s+/g, ' ').trim()),
        })
        collectSignatureShape(
          member,
          source,
          shape,
          resolver,
          shapePath(prefix, '$call'),
          visited,
          depth + 1,
          typeParameters,
        )
        continue
      }
      const name = propertyName(member.name)
      if (name === null) continue
      if (ts.isMethodSignature(member)) {
        shape.methods.push({
          name,
          signatureDigest: digestText(member.getText(source).replace(/\s+/g, ' ').trim()),
        })
        collectSignatureShape(
          member,
          source,
          shape,
          resolver,
          shapePath(prefix, `$method:${name}`),
          visited,
          depth + 1,
          typeParameters,
        )
      } else if (ts.isPropertySignature(member) && member.type !== undefined) {
        collectTypeShape(
          member.type,
          source,
          shape,
          resolver,
          shapePath(prefix, name),
          visited,
          depth + 1,
          typeParameters,
        )
      }
    }
    return
  }
  if (ts.isUnionTypeNode(type)) {
    shape.unionVariants += type.types.length
    type.types.forEach((variant, index) =>
      collectTypeShape(
        variant,
        source,
        shape,
        resolver,
        shapePath(prefix, `$variant:${index}`),
        visited,
        depth + 1,
        typeParameters,
      ),
    )
    return
  }
  if (ts.isIntersectionTypeNode(type)) {
    for (const member of type.types) {
      collectTypeShape(member, source, shape, resolver, prefix, visited, depth + 1, typeParameters)
    }
    return
  }
  if (ts.isParenthesizedTypeNode(type)) {
    collectTypeShape(type.type, source, shape, resolver, prefix, visited, depth + 1, typeParameters)
    return
  }
  if (ts.isArrayTypeNode(type)) {
    collectTypeShape(
      type.elementType,
      source,
      shape,
      resolver,
      `${prefix}[]`,
      visited,
      depth + 1,
      typeParameters,
    )
    return
  }
  if (ts.isFunctionTypeNode(type) || ts.isConstructorTypeNode(type)) {
    collectSignatureShape(type, source, shape, resolver, prefix, visited, depth + 1, typeParameters)
    return
  }
  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName.getText(source)
    const argument = type.typeArguments?.[0]
    if (typeParameters.has(name)) {
      shape.fields.push({
        fieldPath: prefix === '' ? '$value' : prefix,
        type: type.getText(source),
      })
      return
    }
    if (argument !== undefined && ['Array', 'ReadonlyArray', 'Set', 'ReadonlySet'].includes(name)) {
      collectTypeShape(
        argument,
        source,
        shape,
        resolver,
        `${prefix}[]`,
        visited,
        depth + 1,
        typeParameters,
      )
      return
    }
    if (
      argument !== undefined &&
      ['Readonly', 'Required', 'Partial', 'Promise', 'Awaited', 'NonNullable'].includes(name)
    ) {
      collectTypeShape(
        argument,
        source,
        shape,
        resolver,
        prefix,
        visited,
        depth + 1,
        typeParameters,
      )
      return
    }
    const resolved = resolver(source, name)
    if (resolved !== null) shape.resolvedRefs.push(resolved.key)
    if (resolved !== null && !visited.has(resolved.key)) {
      collectNodeShape(
        resolved.node,
        resolved.source,
        shape,
        resolver,
        prefix,
        new Set([...visited, resolved.key]),
        depth + 1,
      )
      return
    }
    shape.fields.push({ fieldPath: prefix === '' ? '$value' : prefix, type: type.getText(source) })
    if (resolved === null) shape.unresolvedRefs.push(name)
    return
  }
  shape.fields.push({ fieldPath: prefix === '' ? '$value' : prefix, type: type.getText(source) })
}

function nodeShape(
  node: ts.Node,
  source: ts.SourceFile,
  resolver: ShapeResolver,
): {
  fields: Array<{ fieldPath: string; type: string }>
  methods: Array<{ name: string; signatureDigest: string }>
  unionVariants: number
  unresolvedRefs: string[]
  resolvedRefs: string[]
} {
  const shape: MutableShape = {
    fields: [],
    methods: [],
    unionVariants: 0,
    unresolvedRefs: [],
    resolvedRefs: [],
  }
  collectNodeShape(
    node,
    source,
    shape,
    resolver,
    '',
    new Set([`${source.fileName}#${declarationName(node) ?? '$anonymous'}`]),
    0,
  )
  return {
    fields: [...new Map(shape.fields.map((field) => [field.fieldPath, field])).values()].sort(
      (a, b) => a.fieldPath.localeCompare(b.fieldPath),
    ),
    methods: [...new Map(shape.methods.map((method) => [method.name, method])).values()].sort(
      (a, b) => a.name.localeCompare(b.name),
    ),
    unionVariants: shape.unionVariants,
    unresolvedRefs: [...new Set(shape.unresolvedRefs)].sort(),
    resolvedRefs: [...new Set(shape.resolvedRefs)].sort(),
  }
}

function createShapeResolver(units: readonly SourceUnit[]): ShapeResolver {
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const declarations = new Map(
    units.map((unit) => [
      unit.path,
      new Map(topLevelNamedNodes(unit).map((entry) => [entry.name, entry.node])),
    ]),
  )
  const imports = new Map(units.map((unit) => [unit.path, symbolImports(unit, units)]))
  const resolveExported = (
    unit: SourceUnit,
    name: string,
    visited: ReadonlySet<string> = new Set(),
  ): ResolvedShapeReference | null => {
    const key = `${unit.path}#${name}`
    if (visited.has(key)) return null
    const nextVisited = new Set([...visited, key])
    const local = topLevelNamedNodes(unit).find(
      (entry) => entry.name === name && entry.exported,
    )?.node
    if (local !== undefined) return { key, node: local, source: unit.source }

    for (const statement of unit.source.statements) {
      if (!ts.isExportDeclaration(statement)) continue
      const targetUnit =
        statement.moduleSpecifier !== undefined && ts.isStringLiteralLike(statement.moduleSpecifier)
          ? resolveSpecifier(units, unit.path, statement.moduleSpecifier.text)
          : unit
      if (targetUnit === null) continue
      if (statement.exportClause === undefined) {
        const resolved = resolveExported(targetUnit, name, nextVisited)
        if (resolved !== null) return resolved
        continue
      }
      if (!ts.isNamedExports(statement.exportClause)) continue
      const element = statement.exportClause.elements.find(
        (candidate) => candidate.name.text === name,
      )
      if (element === undefined) continue
      const sourceName = element.propertyName?.text ?? element.name.text
      if (targetUnit === unit) {
        const targetNode = declarations.get(unit.path)?.get(sourceName)
        if (targetNode !== undefined) {
          return { key: `${unit.path}#${sourceName}`, node: targetNode, source: unit.source }
        }
        const imported = imports
          .get(unit.path)
          ?.find((entry) => entry.localName === sourceName && entry.importedName !== '*')
        const importedUnit = imported === undefined ? undefined : byPath.get(imported.toFile)
        if (imported !== undefined && importedUnit !== undefined) {
          const resolved = resolveExported(importedUnit, imported.importedName, nextVisited)
          if (resolved !== null) return resolved
        }
        continue
      }
      const resolved = resolveExported(targetUnit, sourceName, nextVisited)
      if (resolved !== null) return resolved
    }
    return null
  }

  return (source, name) => {
    const local = declarations.get(source.fileName)?.get(name)
    if (local !== undefined) {
      return { key: `${source.fileName}#${name}`, node: local, source }
    }
    const binding = imports
      .get(source.fileName)
      ?.find((entry) => entry.localName === name && entry.importedName !== '*')
    if (binding === undefined) {
      const sourceUnit = byPath.get(source.fileName)
      return sourceUnit === undefined ? null : resolveExported(sourceUnit, name)
    }
    const targetUnit = byPath.get(binding.toFile)
    if (targetUnit === undefined) return null
    return resolveExported(targetUnit, binding.importedName)
  }
}

interface PublicSurfaceEntry {
  readonly id: string
  readonly context: string
  readonly entrypoint: string
  readonly symbol: string
  readonly file: string
  readonly ownerEntryId: string
  readonly signatureDigest: string
  readonly members: readonly string[]
  readonly consumerEdgeIds: readonly string[]
  readonly productionConsumers: readonly {
    readonly edgeId: string
    readonly ownerEntryId: string
    readonly context: string
    readonly file: string
  }[]
  readonly methods: readonly SurfaceMember[]
  readonly fields: readonly SurfaceField[]
  readonly unresolvedTypeRefs: readonly string[]
  readonly publicTypeConsumerIds: readonly string[]
  readonly direction: 'offered'
  readonly authority: 'context-bound' | 'none' | 'request-authority'
  readonly transaction: 'caller-tx' | 'none' | 'own-tx'
  readonly serialization: 'durable' | 'ephemeral' | 'wire'
  readonly dataClass: 'confidential' | 'metadata' | 'secret'
  readonly version: 1
  readonly budget: {
    readonly maxMethods: number
    readonly maxTopLevelFields: number
    readonly maxTransitiveLeafFields: number
    readonly maxUnionVariants: number
  }
  readonly status:
    | 'legacy-context-debt'
    | 'target-context-current-surface'
    | 'declared-contract-debt'
  readonly plannedConsumer?: string
  readonly successorTask?: string
  readonly removeAfterWave: string | null
}

/** RFC-362 preparation only. Remove each exact ID when its approved successor
 * supplies a real production provider/callsite; type references are not cutover credit. */
export const RFC362_DECLARED_PUBLIC_CONTRACT_IDS: readonly string[] = []

function publicSurfaceLifecycle(
  location: {
    context: string
    entrypoint: string
  },
  symbol: string,
): Pick<PublicSurfaceEntry, 'status' | 'removeAfterWave' | 'plannedConsumer' | 'successorTask'> {
  if (
    RFC362_DECLARED_PUBLIC_CONTRACT_IDS.includes(
      `public:${location.context}:${location.entrypoint}:${symbol}`,
    )
  ) {
    return {
      status: 'declared-contract-debt',
      removeAfterWave: 'W4-E1/W5',
      plannedConsumer: 'task-execution',
      successorTask: 'RFC-362-E1-production-cutover',
    }
  }
  const target = (TARGET_PUBLIC_CONTEXTS as readonly string[]).includes(location.context)
  return {
    status: target ? 'target-context-current-surface' : 'legacy-context-debt',
    removeAfterWave: target ? null : 'W9-D',
  }
}

function buildPublicSurfaces(
  backend: readonly SourceUnit[],
  allUnits: readonly SourceUnit[],
  observedEdges: readonly ObservedContextEdge[],
): PublicSurfaceEntry[] {
  const entries: PublicSurfaceEntry[] = []
  const dependencyKeysById = new Map<string, readonly string[]>()
  const declarationKeyById = new Map<string, string>()
  const resolver = createShapeResolver(allUnits)
  const unitsByPath = new Map(backend.map((unit) => [unit.path, unit]))
  const consumersFor = (
    unit: SourceUnit,
    symbol: string,
  ): { edges: ObservedContextEdge[]; memberEdges: (name: string) => string[] } => {
    const edges = observedEdges.filter(
      (edge) =>
        edge.toFile === unit.path && (edge.targetSymbol === symbol || edge.targetSymbol === '*'),
    )
    return {
      edges,
      memberEdges: (name) =>
        edges
          .filter((edge) => {
            const consumer = unitsByPath.get(edge.fromFile)
            return (
              consumer !== undefined &&
              new RegExp(`\\b${name.replace(/[$]/g, '\\$&')}\\b`).test(consumer.text)
            )
          })
          .map((edge) => edge.id)
          .sort(),
    }
  }
  const classification = (
    location: { context: string; entrypoint: string },
    symbol: string,
  ): Pick<PublicSurfaceEntry, 'authority' | 'dataClass' | 'serialization' | 'transaction'> => ({
    authority:
      location.entrypoint === 'commands' ||
      location.entrypoint === 'queries' ||
      location.entrypoint === 'operations'
        ? 'request-authority'
        : location.entrypoint === 'participants'
          ? 'context-bound'
          : 'none',
    transaction:
      location.entrypoint === 'commands' || location.entrypoint === 'operations'
        ? 'own-tx'
        : location.entrypoint === 'participants'
          ? 'caller-tx'
          : 'none',
    serialization:
      location.entrypoint === 'events'
        ? 'durable'
        : location.entrypoint === 'commands' ||
            location.entrypoint === 'queries' ||
            location.entrypoint === 'operations'
          ? 'wire'
          : 'ephemeral',
    dataClass: /secret|credential|token|password/i.test(symbol)
      ? 'secret'
      : /authority|actor|subject|user|repository|workspace|artifact/i.test(symbol)
        ? 'confidential'
        : 'metadata',
  })
  for (const unit of backend) {
    const location = publicLocation(unit.path)
    if (location === null) continue
    for (const item of topLevelNamedNodes(unit).filter((node) => node.exported)) {
      const id = `public:${location.context}:${location.entrypoint}:${item.name}`
      const consumers = consumersFor(unit, item.name)
      const shape = nodeShape(item.node, unit.source, resolver)
      const consumerEdgeIds = consumers.edges.map((edge) => edge.id).sort()
      dependencyKeysById.set(id, shape.resolvedRefs)
      declarationKeyById.set(id, `${unit.path}#${item.name}`)
      entries.push({
        id,
        context: location.context,
        entrypoint: location.entrypoint,
        symbol: item.name,
        file: unit.path,
        ownerEntryId: ownerEntryId(unit.path, item.name),
        signatureDigest: digestText(item.node.getText(unit.source).replace(/\s+/g, ' ').trim()),
        members: memberNames(item.node),
        consumerEdgeIds,
        productionConsumers: consumers.edges.map((edge) => ({
          edgeId: edge.id,
          ownerEntryId: edge.fromOwnerEntryId,
          context: edge.fromContext,
          file: edge.fromFile,
        })),
        methods: shape.methods.map((method) => ({
          ...method,
          consumerEdgeIds: consumers.memberEdges(method.name),
        })),
        fields: shape.fields.map((field) => ({
          ...field,
          consumerEdgeIds: consumers.memberEdges(
            field.fieldPath.split('.').at(-1) ?? field.fieldPath,
          ),
        })),
        unresolvedTypeRefs: shape.unresolvedRefs,
        publicTypeConsumerIds: [],
        direction: 'offered',
        ...classification(location, item.name),
        version: 1,
        budget: {
          maxMethods: Math.max(5, shape.methods.length),
          maxTopLevelFields: Math.max(
            12,
            new Set(shape.fields.map((field) => field.fieldPath.split('.')[0])).size,
          ),
          maxTransitiveLeafFields: Math.max(24, shape.fields.length),
          maxUnionVariants: Math.max(12, shape.unionVariants),
        },
        ...publicSurfaceLifecycle(location, item.name),
      })
    }
    for (const statement of unit.source.statements) {
      if (!ts.isExportDeclaration(statement) || statement.exportClause === undefined) continue
      if (!ts.isNamedExports(statement.exportClause)) continue
      for (const element of statement.exportClause.elements) {
        const symbol = element.name.text
        const id = `public:${location.context}:${location.entrypoint}:${symbol}`
        const sourceSymbol = element.propertyName?.text ?? element.name.text
        const targetUnit =
          statement.moduleSpecifier !== undefined &&
          ts.isStringLiteralLike(statement.moduleSpecifier)
            ? resolveSpecifier(allUnits, unit.path, statement.moduleSpecifier.text)
            : unit
        const targetNode = targetUnit === null ? null : resolver(targetUnit.source, sourceSymbol)
        const shape =
          targetNode !== null
            ? nodeShape(targetNode.node, targetNode.source, resolver)
            : {
                fields: [],
                methods: [],
                unionVariants: 0,
                unresolvedRefs: ['$re-export'],
                resolvedRefs: [],
              }
        const consumers = consumersFor(unit, symbol)
        const consumerEdgeIds = consumers.edges.map((edge) => edge.id).sort()
        dependencyKeysById.set(id, shape.resolvedRefs)
        if (targetNode !== null) declarationKeyById.set(id, targetNode.key)
        entries.push({
          id,
          context: location.context,
          entrypoint: location.entrypoint,
          symbol,
          file: unit.path,
          ownerEntryId: ownerEntryId(unit.path, '$file'),
          signatureDigest: digestText(element.getText(unit.source)),
          members: [],
          consumerEdgeIds,
          productionConsumers: consumers.edges.map((edge) => ({
            edgeId: edge.id,
            ownerEntryId: edge.fromOwnerEntryId,
            context: edge.fromContext,
            file: edge.fromFile,
          })),
          methods: shape.methods.map((method) => ({
            ...method,
            consumerEdgeIds: consumers.memberEdges(method.name),
          })),
          fields: shape.fields.map((field) => ({
            ...field,
            consumerEdgeIds: consumers.memberEdges(
              field.fieldPath.split('.').at(-1) ?? field.fieldPath,
            ),
          })),
          unresolvedTypeRefs: shape.unresolvedRefs,
          publicTypeConsumerIds: [],
          direction: 'offered',
          ...classification(location, symbol),
          version: 1,
          budget: {
            maxMethods: Math.max(5, shape.methods.length),
            maxTopLevelFields: Math.max(
              12,
              new Set(shape.fields.map((field) => field.fieldPath.split('.')[0])).size,
            ),
            maxTransitiveLeafFields: Math.max(24, shape.fields.length),
            maxUnionVariants: Math.max(12, shape.unionVariants),
          },
          ...publicSurfaceLifecycle(location, symbol),
        })
      }
    }
  }
  const unique = new Map(entries.map((entry) => [entry.id, entry]))
  const publicIdsByDeclarationKey = new Map<string, string[]>()
  for (const [id, key] of declarationKeyById) {
    const ids = publicIdsByDeclarationKey.get(key) ?? []
    ids.push(id)
    publicIdsByDeclarationKey.set(key, ids)
  }
  const consumersById = new Map([...unique.keys()].map((id) => [id, new Set<string>()]))
  for (const [consumerId, dependencyKeys] of dependencyKeysById) {
    for (const key of dependencyKeys) {
      for (const targetId of publicIdsByDeclarationKey.get(key) ?? []) {
        if (targetId !== consumerId) consumersById.get(targetId)?.add(consumerId)
      }
    }
  }
  return [...unique.values()]
    .map((entry) => ({
      ...entry,
      publicTypeConsumerIds: [...(consumersById.get(entry.id) ?? [])].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

interface SourceAnchorSpec {
  readonly file: string
  readonly symbol: string
  readonly sourceToken: string
}

interface SourceAnchor extends SourceAnchorSpec {
  readonly ownerEntryId: string
}

interface GovernedFieldSurface {
  readonly id: string
  readonly fieldPath: string
  readonly purpose: string
  readonly dataClass: 'confidential' | 'metadata'
  readonly owner: SourceAnchor
  readonly writers: readonly SourceAnchor[]
  readonly consumers: readonly SourceAnchor[]
  readonly rollback: string
}

const INTERNAL_CATALOG_VISIBILITY_WRITERS: readonly SourceAnchorSpec[] = [
  {
    // RFC-359 W1-T3：agent / script 动作的宿主任务启动合一到 actionExecutionEnvironment.ts
    //（两个 provider 的 launchHostTask 都在这一个文件里写 catalogVisibility: 'internal'）。
    file: 'packages/backend/src/modules/task-execution/composition/actionExecutionEnvironment.ts',
    symbol: '$file',
    sourceToken: "catalogVisibility: 'internal'",
  },
  {
    file: 'packages/backend/src/modules/task-execution/composition/digitalEmployeeExecution.ts',
    symbol: '$file',
    sourceToken: "catalogVisibility: 'internal'",
  },
  {
    file: 'packages/backend/src/modules/development-automation/composition/employeeTypePackage.ts',
    symbol: '$file',
    sourceToken: "catalogVisibility: 'internal'",
  },
]

function buildGovernedFieldSurfaces(allUnits: readonly SourceUnit[]): GovernedFieldSurface[] {
  const byPath = new Map(allUnits.map((unit) => [unit.path, unit]))
  const anchor = (spec: SourceAnchorSpec): SourceAnchor => {
    const unit = byPath.get(spec.file)
    if (unit === undefined || !unit.text.includes(spec.sourceToken)) {
      throw new Error(`missing governed field anchor: ${spec.file}#${spec.sourceToken}`)
    }
    return { ...spec, ownerEntryId: ownerEntryId(spec.file, spec.symbol) }
  }
  const internalWriters = INTERNAL_CATALOG_VISIBILITY_WRITERS.map(anchor)
  return [
    {
      id: 'field:shared.TaskCatalogVisibility',
      fieldPath: 'TaskCatalogVisibility',
      purpose: 'Closed public/internal catalog-membership vocabulary; it is not an ACL grant.',
      dataClass: 'metadata',
      owner: anchor({
        file: 'packages/shared/src/taskOperations.ts',
        symbol: 'TaskCatalogVisibility',
        sourceToken: 'export type TaskCatalogVisibility',
      }),
      writers: [],
      consumers: [
        anchor({
          file: 'packages/backend/src/db/schema.ts',
          symbol: 'tasks',
          sourceToken: "catalogVisibility: text('catalog_visibility'",
        }),
        anchor({
          file: 'packages/backend/src/services/task.ts',
          symbol: 'StartTaskDeps',
          sourceToken: 'catalogVisibility?: TaskCatalogVisibility',
        }),
      ],
      rollback: 'Keep the closed vocabulary and persisted values; disable only new readers.',
    },
    {
      id: 'field:tasks.catalog_visibility',
      fieldPath: 'tasks.catalog_visibility',
      purpose:
        'TaskExecution-owned catalog membership; roots default public and children inherit the persisted parent value.',
      dataClass: 'metadata',
      owner: anchor({
        file: 'packages/backend/src/db/schema.ts',
        symbol: 'tasks',
        sourceToken: "catalogVisibility: text('catalog_visibility'",
      }),
      writers: [
        anchor({
          file: 'packages/backend/src/services/task.ts',
          symbol: 'startTaskImpl',
          sourceToken: 'catalogVisibility = parent.catalogVisibility',
        }),
        ...internalWriters,
      ],
      consumers: [
        anchor({
          // RFC-357：目录源的适配收成两个 provider 共用的一份，`catalogVisibility: 'public'`
          // 这条边界随之只在那里出现一次。
          file: 'packages/backend/src/modules/task-execution/infrastructure/taskExecutionCatalogSources.ts',
          symbol: 'source',
          sourceToken: "catalogVisibility: 'public'",
        }),
        anchor({
          file: 'packages/backend/src/modules/task-execution/infrastructure/taskListPage/filters.ts',
          symbol: '$file',
          sourceToken: "col('catalog_visibility')",
        }),
        anchor({
          file: 'packages/backend/src/routes/tasks.ts',
          symbol: '$file',
          sourceToken: "catalogVisibility: 'public'",
        }),
        anchor({
          // RFC-359 W4-B1：总览计数一份实现，两个 provider 共用。
          file: 'packages/backend/src/modules/task-execution/infrastructure/taskOverviewQuery.ts',
          symbol: 'createTaskOverviewQuery',
          sourceToken: "eq(tasks.catalogVisibility, 'public')",
        }),
      ],
      rollback: 'Stop new internal callers; retain the column, root default and child inheritance.',
    },
    {
      id: 'field:StartTaskDeps.catalogVisibility',
      fieldPath: 'StartTaskDeps.catalogVisibility',
      purpose: 'Trusted internal launch projection into the TaskExecution-owned membership field.',
      dataClass: 'metadata',
      owner: anchor({
        file: 'packages/backend/src/services/task.ts',
        symbol: 'StartTaskDeps',
        sourceToken: 'catalogVisibility?: TaskCatalogVisibility',
      }),
      writers: internalWriters,
      consumers: [
        anchor({
          file: 'packages/backend/src/services/task.ts',
          symbol: 'startTaskImpl',
          sourceToken: "deps.catalogVisibility ?? 'public'",
        }),
      ],
      rollback:
        'Stop passing the internal projection; preserve persisted membership on existing rows.',
    },
    {
      id: 'field:tasks.digital_employee_case_id',
      fieldPath: 'tasks.digital_employee_case_id',
      purpose:
        'TaskExecution-owned immutable provenance ref used to locate an actor-filtered DigitalEmployee projection.',
      dataClass: 'confidential',
      owner: anchor({
        file: 'packages/backend/src/db/schema.ts',
        symbol: 'tasks',
        sourceToken: "digitalEmployeeCaseId: text('digital_employee_case_id')",
      }),
      writers: [
        anchor({
          file: 'packages/backend/src/services/task.ts',
          symbol: 'startTaskImpl',
          sourceToken: 'digitalEmployeeCaseId: deps.digitalEmployeeLaunch?.caseId ?? null',
        }),
      ],
      consumers: [
        anchor({
          file: 'packages/backend/src/services/task.ts',
          symbol: 'rowToTask',
          sourceToken: 'digitalEmployeeCaseId: row.digitalEmployeeCaseId ?? null',
        }),
        anchor({
          file: 'packages/frontend/src/routes/tasks.detail.tsx',
          symbol: '$file',
          sourceToken: 'tk.digitalEmployeeCaseId',
        }),
        anchor({
          file: 'packages/frontend/src/components/tasks/TaskDigitalEmployeeSourceLink.tsx',
          symbol: 'TaskDigitalEmployeeSourceLink',
          sourceToken: '/api/employee-cases/',
        }),
      ],
      rollback:
        'Disable the link reader; never delete or rewrite already persisted provenance refs.',
    },
    {
      id: 'field:employee_cases.name',
      fieldPath: 'employee_cases.name',
      purpose: 'DigitalEmployee-owned operator task name projected out as taskName.',
      dataClass: 'confidential',
      owner: anchor({
        file: 'packages/backend/src/db/schema.ts',
        symbol: 'employeeCases',
        sourceToken: "name: text('name').notNull().default('')",
      }),
      writers: [
        anchor({
          file: 'packages/backend/src/modules/digital-employee/infrastructure/runtimeStore.ts',
          symbol: 'createRuntimePersistence',
          sourceToken: 'name: input.caseRecord.name',
        }),
      ],
      consumers: [
        anchor({
          file: 'packages/backend/src/modules/digital-employee/application/runtimeService.ts',
          symbol: 'DigitalEmployeeRuntimeService',
          sourceToken: 'taskName: caseRecord.name',
        }),
      ],
      rollback:
        'Disable the projection reader; retain the DigitalEmployee-owned value and single writer.',
    },
  ]
}

interface RequiredPortEntry {
  readonly id: string
  readonly context: string
  readonly symbol: string
  readonly ownerEntryId: string
  readonly consumerOwnerEntryIds: readonly string[]
  readonly providerAdapters: readonly {
    readonly edgeId: string
    readonly ownerEntryId: string
    readonly context: string
    readonly file: string
  }[]
  readonly compositionFiles: readonly string[]
  readonly compositionOwnerEntryIds: readonly string[]
  readonly status: 'active' | 'declared-debt'
  readonly removeAfterWave: string | null
}

function buildRequiredPorts(
  backend: readonly SourceUnit[],
  allUnits: readonly SourceUnit[],
  observedEdges: readonly ObservedContextEdge[],
): RequiredPortEntry[] {
  const out: RequiredPortEntry[] = []
  const allImports = backend.flatMap((unit) =>
    symbolImports(unit, allUnits).map((item) => ({ ...item, unit })),
  )
  for (const unit of backend) {
    const location = requiredPortLocation(unit.path)
    if (location === null) continue
    for (const item of topLevelNamedNodes(unit).filter(
      (node) => node.exported && /(?:Port|Participant|Source)(?:V\d+)?$/.test(node.name),
    )) {
      const uses = allImports.filter(
        (entry) => entry.toFile === unit.path && entry.importedName === item.name,
      )
      const consumers = uses
        .filter((entry) => {
          const from = moduleLocation(entry.fromFile)
          if (from?.context !== location.context) return false
          if (location.context !== 'system-operations') return true
          return from.rest.startsWith('application/') && !from.rest.startsWith('application/ports/')
        })
        .map((entry) => ownerEntryId(entry.fromFile, '$file'))
        .sort()
      const providerAdapters = observedEdges
        .filter(
          (edge) =>
            edge.toFile === unit.path &&
            edge.targetSymbol === item.name &&
            edge.role === 'required-implementation',
        )
        .map((edge) => ({
          edgeId: edge.id,
          ownerEntryId: edge.fromOwnerEntryId,
          context: edge.fromContext,
          file: edge.fromFile,
        }))
        .sort((left, right) => left.edgeId.localeCompare(right.edgeId))
      const compositionFiles = uses
        .filter((entry) => moduleLocation(entry.fromFile)?.rest === 'composition')
        .map((entry) => entry.fromFile)
        .sort()
      const active =
        consumers.length > 0 && providerAdapters.length > 0 && compositionFiles.length === 1
      out.push({
        id: `required:${location.context}:${item.name}`,
        context: location.context,
        symbol: item.name,
        ownerEntryId: ownerEntryId(unit.path, item.name),
        consumerOwnerEntryIds: consumers,
        providerAdapters,
        compositionFiles,
        compositionOwnerEntryIds: compositionFiles.map((file) => ownerEntryId(file, '$file')),
        status: active ? 'active' : 'declared-debt',
        removeAfterWave: active
          ? null
          : location.context === 'development-automation'
            ? 'W4-E8/W5'
            : location.context === 'system-operations'
              ? 'W4-E7'
              : location.context === 'task-execution'
                ? 'W4-E1/W5'
                : 'W4-E9',
      })
    }
  }

  const reconciler = backend.find((unit) =>
    unit.path.endsWith('modules/development-automation/application/ports/reconcilerPorts.ts'),
  )
  if (reconciler !== undefined) {
    const aggregate = topLevelNamedNodes(reconciler).find((item) => item.name === 'ReconcilerPorts')
    if (aggregate !== undefined) {
      out.push({
        id: 'required:development-automation:ReconcilerPorts-legacy-aggregate',
        context: 'development-automation',
        symbol: 'ReconcilerPorts',
        ownerEntryId: ownerEntryId(reconciler.path, 'ReconcilerPorts'),
        consumerOwnerEntryIds: [],
        providerAdapters: [],
        compositionFiles: ['packages/backend/src/modules/development-automation/composition.ts'],
        compositionOwnerEntryIds: [
          ownerEntryId(
            'packages/backend/src/modules/development-automation/composition.ts',
            '$file',
          ),
        ],
        status: 'declared-debt',
        removeAfterWave: 'W4-E8/W5',
      })
    }
  }
  return out.sort((left, right) => left.id.localeCompare(right.id))
}

const MUTATION_NAME =
  /^(?:add|admit|apply|archive|attach|cancel|claim|commit|confirm|create|delete|deliver|disable|enable|execute|handoff|launch|move|open|patch|promote|publish|reject|remove|rename|resume|retry|restore|revoke|run|save|seal|set|stage|start|stop|submit|sync|terminate|transition|unarchive|update|upsert)/i

interface ControlEvidence {
  readonly authority: 'effect' | 'internal-family' | 'none-observed' | 'request' | 'system'
  readonly authorization: boolean
  readonly transaction: boolean
  readonly fenceOrOcc: boolean
  readonly audit: boolean
  readonly event: boolean
}

function controls(text: string): ControlEvidence {
  const authority =
    /RequestAuthority|DelegatedAuthority|DirectOperationContext|AuthorizationSubjectRef/.test(text)
      ? 'request'
      : /EffectCapability|OwnershipToken|CurrentAuthorityInTx|SystemEffect/.test(text)
        ? 'effect'
        : /SystemActor|background|recovery|bootstrap/i.test(text)
          ? 'system'
          : /Capability|Claim|Epoch/.test(text)
            ? 'internal-family'
            : 'none-observed'
  return {
    authority,
    authorization:
      /authorize|permission|can[A-Z]|require[A-Z]|assert.*(?:owner|edit|permission)|visible|access/i.test(
        text,
      ),
    transaction: /\btransaction\b|\bdbTx(?:Sync)?\b|\btx\b/.test(text),
    fenceOrOcc:
      /\bCAS\b|compare-and-swap|expectedRevision|revision|stale|conflict|epoch|fence|claim/i.test(
        text,
      ),
    audit: /audit|observability|record.*(?:attempt|decision)|ledger/i.test(text),
    event: /event|emit|publish|outbox|invalidate/i.test(text),
  }
}

function missingControlNames(evidence: ControlEvidence): string[] {
  return [
    ...(evidence.authority === 'none-observed' ? ['authority'] : []),
    ...Object.entries(evidence)
      .filter(([name, present]) => name !== 'authority' && present === false)
      .map(([name]) => name),
  ].sort()
}

interface MutationEntry {
  readonly id: string
  readonly file: string
  readonly symbol: string
  readonly ownerEntryId: string
  readonly targetContext: TargetOwner
  readonly targetLayer: string
  readonly controls: ControlEvidence
  readonly missingControls: readonly string[]
  readonly finalCriterion: string
}

function buildMutationEntries(backend: readonly SourceUnit[]): MutationEntry[] {
  const out: MutationEntry[] = []
  for (const unit of backend) {
    const namedNodes = topLevelNamedNodes(unit)
    for (const item of namedNodes) {
      if (!MUTATION_NAME.test(item.name)) continue
      if (
        ts.isFunctionDeclaration(item.node) &&
        item.node.body === undefined &&
        namedNodes.some(
          (candidate) =>
            candidate.name === item.name &&
            ts.isFunctionDeclaration(candidate.node) &&
            candidate.node.body !== undefined,
        )
      ) {
        continue
      }
      const text = item.node.getText(unit.source)
      const evidence = controls(text)
      const missingControls = missingControlNames(evidence)
      out.push({
        id: `mutation:${unit.path}#${item.name}`,
        file: unit.path,
        symbol: item.name,
        ownerEntryId: ownerEntryId(unit.path, item.name),
        targetContext: targetContextFor(unit.path),
        targetLayer: targetLayerFor(unit.path, item.name),
        controls: evidence,
        missingControls,
        finalCriterion: missingControls.length === 0 ? 'controls-complete' : 'W3/W4 owner cutover',
      })
    }

    if (!/\/(?:routes|mcp|ws)\//.test(unit.path)) continue
    const stableSite = siteRecorder(unit.path)
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['delete', 'patch', 'post', 'put'].includes(node.expression.name.text)
      ) {
        const symbol = enclosingSymbol(node)
        const id = stableSite(node, `$http:${node.expression.name.text}`)
        const text = node.getText(unit.source)
        const evidence = controls(text)
        out.push({
          id,
          file: unit.path,
          symbol,
          ownerEntryId: ownerEntryId(unit.path, '$file'),
          targetContext: targetContextFor(unit.path),
          targetLayer: 'inbound',
          controls: evidence,
          missingControls: missingControlNames(evidence),
          finalCriterion: 'W4 transport-to-application cutover',
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return out.sort((left, right) => left.id.localeCompare(right.id))
}

interface NodeRunInsertSite {
  readonly id: string
  readonly file: string
  readonly line: number
  readonly symbol: string
  readonly ownerEntryId: string
  readonly status: 'canonical-writer' | 'reviewed-dispatch-exception' | 'unreviewed'
  readonly removeAfterWave: 'W2/W7' | null
  readonly guard: 'rfc098-node-run-mint-grep-guard'
}

const CANONICAL_NODE_RUN_INSERT_FILES = new Set([
  'packages/backend/src/modules/task-execution/infrastructure/nodeRunMintParticipant.ts',
])

function buildNodeRunInsertSites(backend: readonly SourceUnit[]): NodeRunInsertSite[] {
  const out: NodeRunInsertSite[] = []
  for (const unit of backend) {
    const lines = unit.text.split('\n')
    const stableSite = siteRecorder(unit.path)
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'insert' &&
        node.arguments[0] !== undefined &&
        ts.isIdentifier(node.arguments[0]) &&
        node.arguments[0].text === 'nodeRuns'
      ) {
        const line = unit.source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        const owner = enclosingTopLevelSymbol(unit, node)
        const symbol = owner?.name ?? '$file'
        const nearby = lines.slice(Math.max(0, line - 6), line).join('\n')
        const status = CANONICAL_NODE_RUN_INSERT_FILES.has(unit.path)
          ? 'canonical-writer'
          : /rfc098-allow-direct-node-run-insert/.test(nearby)
            ? 'reviewed-dispatch-exception'
            : 'unreviewed'
        out.push({
          id: stableSite(node, 'nodeRuns.insert'),
          file: unit.path,
          line,
          symbol,
          ownerEntryId: ownerEntryId(unit.path, symbol),
          status,
          removeAfterWave: status === 'canonical-writer' ? null : 'W2/W7',
          guard: 'rfc098-node-run-mint-grep-guard',
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return out.sort((left, right) => left.id.localeCompare(right.id))
}

const EXTERNAL_EFFECT =
  /\b(?:fetch|spawn|runGit|push|publish|send|upload|download|writeFile|rename|unlink|rm|mkdir|copyFile|webhook|provider)\b/i
const TRANSACTION_CALL = /^(?:dbTx|dbTxSync|runInTransaction|transaction|withTransaction)$/

function enclosingTopLevelSymbol(unit: SourceUnit, node: ts.Node): NamedNode | null {
  const containing = topLevelNamedNodes(unit)
    .filter(
      (item) =>
        item.node.getStart(unit.source) <= node.getStart(unit.source) && item.node.end >= node.end,
    )
    .sort(
      (left, right) =>
        left.node.end -
        left.node.getStart(unit.source) -
        (right.node.end - right.node.getStart(unit.source)),
    )
  return containing[0] ?? null
}

interface TransactionExternalEffect {
  readonly id: string
  readonly file: string
  readonly symbol: string
  readonly line: number
  readonly transactionCallee: string
  readonly ownerEntryId: string
  readonly targetContext: TargetOwner
  readonly effectTokens: readonly string[]
  readonly status: 'clear' | 'co-located-risk'
  readonly finalCriterion: 'commit-intent-then-effect' | 'no-external-effect-observed'
}

function buildTransactionEffects(backend: readonly SourceUnit[]): TransactionExternalEffect[] {
  const out: TransactionExternalEffect[] = []
  for (const unit of backend) {
    const stableSite = siteRecorder(unit.path)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : null
        if (callee !== null && TRANSACTION_CALL.test(callee)) {
          const text = node.getText(unit.source)
          const effectTokens = [...text.matchAll(new RegExp(EXTERNAL_EFFECT.source, 'gi'))]
            .map((match) => match[0]!.toLowerCase())
            .filter((value, index, values) => values.indexOf(value) === index)
            .sort()
          const line = unit.source.getLineAndCharacterOfPosition(node.getStart()).line + 1
          const owner = enclosingTopLevelSymbol(unit, node)
          const symbol = owner?.name ?? '$file'
          out.push({
            id: stableSite(node, callee),
            file: unit.path,
            symbol,
            line,
            transactionCallee: callee,
            ownerEntryId: ownerEntryId(unit.path, symbol),
            targetContext: targetContextFor(unit.path),
            effectTokens,
            status: effectTokens.length === 0 ? 'clear' : 'co-located-risk',
            finalCriterion:
              effectTokens.length === 0
                ? 'no-external-effect-observed'
                : 'commit-intent-then-effect',
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return [...new Map(out.map((entry) => [entry.id, entry])).values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )
}

interface FacadeEntry {
  readonly id: string
  readonly file: string
  readonly ownerEntryId: string
  readonly targetContext: TargetOwner
  readonly targetLayer: string
  readonly status: 'legacy-implementation' | 'thin-facade'
  readonly boundaryEdgeIds: readonly string[]
  readonly exportedSymbols: readonly string[]
  readonly removeAfterWave: string
}

function buildFacades(
  backend: readonly SourceUnit[],
  observedEdges: readonly ObservedContextEdge[],
): FacadeEntry[] {
  return backend
    .filter((unit) => unit.path.startsWith(`${BACKEND_PREFIX}services/`))
    .map((unit) => {
      const thinFacade =
        topLevelNamedNodes(unit).length === 0 &&
        unit.source.statements.every(
          (statement) => ts.isExportDeclaration(statement) || ts.isEmptyStatement(statement),
        )
      const boundaryEdgeIds = observedEdges
        .filter((edge) => edge.fromFile === unit.path || edge.toFile === unit.path)
        .map((edge) => edge.id)
        .sort()
      return {
        id: `facade:${unit.path}`,
        file: unit.path,
        ownerEntryId: ownerEntryId(unit.path, '$file'),
        targetContext: targetContextFor(unit.path),
        targetLayer: targetLayerFor(unit.path, '$file'),
        status: thinFacade ? ('thin-facade' as const) : ('legacy-implementation' as const),
        boundaryEdgeIds,
        exportedSymbols: topLevelNamedNodes(unit)
          .filter((entry) => entry.exported)
          .map((entry) => entry.name)
          .sort(),
        removeAfterWave: targetRemoveAfterWaveFor(unit.path, '$file'),
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id))
}

export interface ArchitectureSource {
  readonly sourceSha: string
  readonly sourceTime: string
  readonly units: readonly SourceUnit[]
  readonly architectureFiles: readonly string[]
  readonly readText: (path: string) => string | undefined
}
function gitText(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`architecture Git read failed: ${result.stderr.trim()}`)
  return result.stdout
}
export function readReportSource(repoRoot: string, ref = 'HEAD'): ArchitectureSource {
  const base = readCommittedArchitectureSource(repoRoot, ref)
  const paths = gitText(repoRoot, [
    'ls-tree',
    '-r',
    '-z',
    '--name-only',
    base.sourceSha,
    '--',
    'packages/backend/src',
    'packages/system-mocks',
    'architecture',
    'scripts/build-binary.ts',
  ])
    .split('\0')
    .filter(Boolean)
  const extras = paths.filter(
    (path) =>
      path === 'scripts/build-binary.ts' ||
      path === 'packages/system-mocks/package.json' ||
      /\.[cm]?jsx?$/.test(path) ||
      (path.startsWith('packages/system-mocks/src/') && /\.[cm]?tsx?$/.test(path)),
  )
  const texts = new Map<string, string>()
  // Batch-read supplemental blobs; this does not create a checkout or consult the working tree.
  if (extras.length > 0) {
    const result = spawnSync('git', ['cat-file', '--batch'], {
      cwd: repoRoot,
      input: extras.map((path) => `${base.sourceSha}:${path}\n`).join(''),
      maxBuffer: 64 * 1024 * 1024,
    })
    if (result.status !== 0) throw new Error('architecture supplemental object read failed')
    let offset = 0
    for (const path of extras) {
      const newline = result.stdout.indexOf(10, offset)
      const header = result.stdout.subarray(offset, newline).toString('utf8')
      const [, kind, sizeText] = header.split(' '),
        size = Number(sizeText)
      if (
        newline < 0 ||
        kind !== 'blob' ||
        !Number.isSafeInteger(size) ||
        offset + size >= result.stdout.length
      )
        throw new Error(`invalid architecture object: ${path}`)
      offset = newline + 1
      texts.set(path, result.stdout.subarray(offset, offset + size).toString('utf8'))
      offset += size + 1
    }
  }
  return {
    sourceSha: base.sourceSha,
    sourceTime: gitText(repoRoot, ['show', '-s', '--format=%cI', base.sourceSha]).trim(),
    units: [
      ...base.units,
      ...extras
        .filter((path) => /\.[cm]?[jt]sx?$/.test(path) && path.includes('/src/'))
        .map((path) => sourceUnit(path, texts.get(path)!)),
    ].sort((a, b) => a.path.localeCompare(b.path)),
    architectureFiles: paths
      .filter((path) => path.startsWith('architecture/'))
      .map((path) => path.slice('architecture/'.length)),
    readText: (path) => texts.get(path) ?? base.readText(path),
  }
}
export function workspaceExports(text: string): Record<string, string> {
  const value = JSON.parse(text) as {
    exports?: Record<string, string | { default?: string; import?: string; types?: string }>
  }
  return Object.fromEntries(
    Object.entries(value.exports ?? {}).flatMap(([key, target]) => {
      const path =
        typeof target === 'string' ? target : (target.import ?? target.default ?? target.types)
      return path === undefined ? [] : [[key, path]]
    }),
  )
}
export function binaryEntries(buildText: string): string[] {
  const unit = sourceUnit('scripts/build-binary.ts', buildText),
    entries: string[] = []
  walk(unit.source, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      node.initializer === undefined ||
      ![
        'mainEntry',
        'managedProcessLauncherEntry',
        'gitCredentialHelperEntry',
        'WORKER_ENTRIES',
      ].includes(node.name.text)
    )
      return
    walk(node.initializer, (call) => {
      if (
        !ts.isCallExpression(call) ||
        calleeName(call.expression) !== 'join' ||
        call.arguments[0]?.getText(unit.source) !== 'backendSrc'
      )
        return
      const parts = call.arguments.slice(1).map(literal)
      if (parts.some((part) => part === null)) throw new Error('non-literal binary entry')
      entries.push(BACKEND_PREFIX + parts.join('/'))
    })
  })
  // RFC-375 counts embedded .mjs assets in the retention list. They are copied
  // into the binary as data, not executable graph roots from the entry arrays.
  if (!entries.includes(BACKEND_PREFIX + 'main.ts')) throw new Error('binary main entry is missing')
  return unique(entries)
}
export interface KnownViolationRecord {
  readonly rule: string
  readonly from: string
  readonly to: string
  readonly why: string
  readonly removeWhen: string
  readonly removeWave?: string
}
export function parseKnownViolations(text: string): KnownViolationRecord[] {
  const unit = sourceUnit('scripts/depcheck.ts', text)
  const resolving = new Set<string>()
  const resolveName = (name: string): unknown => {
    if (resolving.has(name)) throw new Error(`cyclic data declaration: ${name}`)
    resolving.add(name)
    const value = dataLiteral(declarationInitializer(unit, name), resolveName)
    resolving.delete(name)
    return value
  }
  const parsed = resolveName('KNOWN_VIOLATIONS')
  if (!Array.isArray(parsed)) throw new Error('KNOWN_VIOLATIONS is not a literal array')
  for (const item of parsed)
    if (
      item === null ||
      typeof item !== 'object' ||
      !['rule', 'from', 'to', 'why', 'removeWhen'].every((key) => typeof item[key] === 'string')
    )
      throw new Error('invalid KNOWN_VIOLATIONS entry')
  return parsed as KnownViolationRecord[]
}
export interface DefinitionSite {
  readonly id: string
  readonly file: string
  readonly symbol: string
  readonly kind: string
}
function bootstrapFile(path: string): boolean {
  return (
    (BOOTSTRAP_FILES as readonly string[]).includes(path) ||
    /\/bootstrap\/|\/cli\/|\/(?:main|server|embed)\.ts$/.test(path)
  )
}
export function mutableSingletons(units: readonly SourceUnit[]): DefinitionSite[] {
  const entries: DefinitionSite[] = []
  for (const unit of units) {
    if (
      bootstrapFile(unit.path) ||
      /\/(?:routes\/registry|platform\/operations\/catalog)\.ts$/.test(unit.path)
    )
      continue
    const state = new Set<string>(),
      record = siteRecorder(unit.path)
    for (const statement of unit.source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) {
          state.add(name)
          if ((statement.declarationList.flags & ts.NodeFlags.Let) !== 0)
            entries.push({
              id: record(declaration, `let:${name}`),
              file: unit.path,
              symbol: name,
              kind: 'top-level-let',
            })
        }
      }
    }
    for (const item of topLevelNamedNodes(unit)) {
      if (
        !item.exported ||
        !/^(?:set|bind|reset|register|configure|install)[A-Z]/.test(item.name) ||
        /^register(?:Route|Operation|BoundOperation)/.test(item.name)
      )
        continue
      let writes = false
      walk(item.node, (node) => {
        let target: ts.Node | undefined
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        )
          target = node.left
        if (
          (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
          [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
        )
          target = node.operand
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          /^(?:set|add|delete|clear|push|pop|splice)$/.test(node.expression.name.text)
        )
          target = node.expression.expression
        while (
          target !== undefined &&
          (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))
        )
          target = target.expression
        if (target !== undefined && ts.isIdentifier(target) && state.has(target.text)) writes = true
      })
      if (writes)
        entries.push({
          id: `${unit.path}#${item.name}#module-state-write#1`,
          file: unit.path,
          symbol: item.name,
          kind: 'exported-state-mutator',
        })
    }
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id))
}
function nearestCallable(node: ts.Node): string | undefined {
  let cursor: ts.Node | undefined = node.parent
  while (cursor !== undefined) {
    if (
      (ts.isFunctionDeclaration(cursor) || ts.isMethodDeclaration(cursor)) &&
      cursor.name !== undefined
    )
      return cursor.name.getText()
    if (
      (ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor)) &&
      ts.isVariableDeclaration(cursor.parent)
    )
      return cursor.parent.name.getText()
    cursor = cursor.parent
  }
  return undefined
}
function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  const property = object.properties.find(
    (item) => ts.isPropertyAssignment(item) && propertyName(item.name) === name,
  )
  return property !== undefined && ts.isPropertyAssignment(property)
    ? property.initializer
    : undefined
}
function providerHandleId(node: ts.ObjectLiteralExpression): string | null {
  const id = literal(objectProperty(node, 'id')) ?? literal(objectProperty(node, 'runtimeId'))
  if (id === null) return null
  let cursor: ts.Node = node
  while (cursor.parent !== undefined && !ts.isSourceFile(cursor.parent)) {
    const parent = cursor.parent
    if (ts.isCallExpression(parent)) {
      const callee = calleeName(parent.expression)
      if (/^define(?:BackgroundJob|ManagedWorker)$/.test(callee)) return null
      if (
        /^create(?:ManagedWorkerRuntimeHandleFactory|PollingDaemonRuntimeHandleFactory|SignalledDaemonRuntimeHandleFactory|(?:Lazy)?PausableDaemonRuntimeServiceBindings)$/.test(
          callee,
        )
      )
        return id
      if (callee !== 'Object.freeze') return null
    }
    if (
      (ts.isVariableDeclaration(parent) &&
        /DaemonProviderRuntimeHandleFactory|SignalledDaemonRuntimeOwner/.test(
          parent.type?.getText() ?? '',
        )) ||
      ((ts.isSatisfiesExpression(parent) || ts.isAsExpression(parent)) &&
        /DaemonProviderRuntimeHandleFactory|SignalledDaemonRuntimeOwner/.test(
          parent.type.getText(),
        ))
    )
      return id
    if (
      ts.isPropertyAssignment(parent) &&
      /^(?:runtimeFactories|backgroundWriterFactories|hostedBackgroundWorkers)$/.test(
        parent.name.getText(),
      )
    )
      return id
    if (ts.isFunctionLike(parent)) return null
    cursor = parent
  }
  return null
}

export function backgroundDefinitions(units: readonly SourceUnit[]): DefinitionSite[] {
  const entries: DefinitionSite[] = []
  for (const unit of units) {
    const record = siteRecorder(unit.path)
    walk(unit.source, (node) => {
      let kind: string | undefined
      if (ts.isCallExpression(node)) {
        const callee = calleeName(node.expression)
        if (/^define(?:BackgroundJob|ManagedWorker)$/.test(callee)) kind = 'managed-definition'
        if (/^(?:globalThis\.)?setInterval$/.test(callee)) kind = 'setInterval'
        if (/^(?:globalThis\.)?setTimeout$/.test(callee)) {
          // A timer is a loop only if it reschedules its enclosing callable, directly or via its callback.
          const owner = nearestCallable(node)
          const callback = node.arguments[0]
          let recursive =
            callback !== undefined && ts.isIdentifier(callback) && callback.text === owner
          if (callback !== undefined)
            walk(callback, (child) => {
              if (ts.isCallExpression(child) && calleeName(child.expression) === owner)
                recursive = true
            })
          if (recursive) kind = 'self-rescheduling-timeout'
        }
      }
      // Provider session IDs are factory registrations, not arbitrary objects named worker/job.
      if (ts.isObjectLiteralExpression(node)) {
        const id = providerHandleId(node)
        if (id !== null) kind = `provider-session-handle:${id}`
      }
      if (kind !== undefined)
        entries.push({
          id: record(node, kind),
          file: unit.path,
          symbol: enclosingSymbol(node),
          kind,
        })
    })
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id))
}
export function reportGateSets(
  corpus: GateCorpus,
  architectureFiles: readonly string[],
  entries: readonly string[],
  known: readonly KnownViolationRecord[],
): Record<string, string[]> {
  const pairs = corpus.edges
    .filter(
      (edge) => edge.kind === 'value' && edge.workerUrl !== true && corpus.byPath.has(edge.target),
    )
    .map((edge) => [edge.from.path, edge.target] as const)
  const services = corpus.backend.filter((unit) =>
    unit.path.startsWith(BACKEND_PREFIX + 'services/'),
  )
  const thin = services.filter(
    (unit) =>
      topLevelNamedNodes(unit).length === 0 &&
      unit.source.statements.every(
        (statement) => ts.isExportDeclaration(statement) || ts.isEmptyStatement(statement),
      ),
  )
  const dbPairs = (prefix: RegExp): string[] =>
    unique(
      corpus.edges
        .filter(
          (edge) =>
            prefix.test(edge.from.path) &&
            edge.kind === 'value' &&
            edge.target.startsWith(BACKEND_PREFIX + 'db/'),
        )
        .map((edge) => `${edge.from.path} -> ${edge.target}`),
    )
  return {
    ...gateViolationSets(corpus, architectureFiles, entries),
    'depcheck-known-violations': known
      .map((entry) => `${entry.rule}|${entry.from}|${entry.to}`)
      .sort(),
    'backend-value-scc': stronglyConnected(
      pairs.filter(
        ([from, to]) => from.startsWith(BACKEND_PREFIX) && to.startsWith(BACKEND_PREFIX),
      ),
    ).map((members) => members.join('|')),
    'repo-value-scc': stronglyConnected(pairs).map((members) => members.join('|')),
    'route-to-db': dbPairs(/^packages\/backend\/src\/routes\//),
    'transport-to-db': dbPairs(/^packages\/backend\/src\/(?:ws|mcp)\//),
    'node-runs-insert-sites': buildNodeRunInsertSites(corpus.backend).map((entry) => entry.id),
    'legacy-service-implementations': services
      .filter((unit) => !thin.includes(unit))
      .map((unit) => unit.path)
      .sort(),
    'legacy-thin-facades': thin.map((unit) => unit.path).sort(),
    'legacy-horizontal-files': corpus.backend
      .filter((unit) =>
        /^(?:services|routes|ws|mcp|auth|util)\//.test(unit.path.slice(BACKEND_PREFIX.length)),
      )
      .map((unit) => unit.path)
      .sort(),
  }
}
/** C7 remains report-only; type and ordinary production consumers both count. */
export function unconsumedPublicSymbols<
  T extends {
    readonly consumerEdgeIds?: readonly unknown[]
    readonly productionConsumers?: readonly unknown[]
    readonly publicTypeConsumerIds?: readonly unknown[]
  },
>(entries: readonly T[]): T[] {
  return entries.filter(
    (entry) =>
      (entry.consumerEdgeIds ?? []).length === 0 &&
      (entry.productionConsumers ?? []).length === 0 &&
      (entry.publicTypeConsumerIds ?? []).length === 0,
  )
}
export function buildArchitectureReport(source: ArchitectureSource) {
  const read = (path: string): string => {
    const text = source.readText(path)
    if (text === undefined) throw new Error(`missing report input: ${path}`)
    return text
  }
  const corpus = createGateCorpus(
    source.units,
    workspaceExports(read('packages/system-mocks/package.json')),
  )
  const known = parseKnownViolations(read('scripts/depcheck.ts'))
  const entries = binaryEntries(read('scripts/build-binary.ts'))
  const gates = reportGateSets(corpus, source.architectureFiles, entries, known)
  // System-mock sources are resolution inputs for workspace edges, not production inventory.
  const inventoryUnits = source.units.filter((unit) =>
    /^packages\/(?:backend|shared|frontend)\/src\//.test(unit.path),
  )
  const owners = buildOwnerEntries(inventoryUnits)
  const edges = observedContextEdges(corpus.backend, inventoryUnits, owners)
  const publicSurfaces = buildPublicSurfaces(corpus.backend, inventoryUnits, edges)
  const requiredPorts = buildRequiredPorts(corpus.backend, inventoryUnits, edges)
  return {
    schemaVersion: 1,
    sourceSha: source.sourceSha,
    // Commit time is the reproducible report clock; actual invocation time is printed by the CLI.
    reportTime: source.sourceTime,
    reportClock: 'source-commit',
    metrics: {
      productionFiles: inventoryUnits.length,
      backendProductionFiles: corpus.backend.length,
    },
    gates,
    counts: Object.fromEntries(
      Object.entries(gates)
        .filter(([id]) => id !== 'architecture-directory-files')
        .map(([id, values]) => [id, values.length]),
    ),
    entrypoints: entries,
    knownViolations: known,
    targetEdges: TARGET_CONTEXT_EDGES,
    moduleSymbolOwners: owners,
    crossContextImports: edges,
    publicSurfaces,
    requiredPorts,
    unconsumedPublicSymbols: unconsumedPublicSymbols(publicSurfaces),
    publicSurfaceDeviations: publicSurfaceViolations(inventoryUnits),
    governedFieldSurfaces: buildGovernedFieldSurfaces(inventoryUnits),
    mutationEntrypoints: buildMutationEntries(corpus.backend),
    taskExecutionAuthority: buildTaskExecutionAuthorityEntries(corpus.backend),
    taskExecutionControlGateways: buildTaskExecutionControlGateways(corpus.backend),
    transactionExternalEffects: buildTransactionEffects(corpus.backend),
    taskOwnedEffects: buildTaskOwnedEffectEntries(corpus.backend),
    codeHostRecoveryBindings: buildCodeHostRecoveryBindingManifest(source.units),
    backgroundJobs: backgroundDefinitions(corpus.backend),
    ambientWiring: mutableSingletons(corpus.backend),
    facades: buildFacades(corpus.backend, edges),
  }
}
export type ArchitectureReport = ReturnType<typeof buildArchitectureReport>
export function renderReportStatus(report: ArchitectureReport): string {
  return (
    `# Architecture report\n\nSource: ${report.sourceSha}\nReport clock: ${report.reportTime} (source commit; reproducible)\n\n` +
    Object.entries(report.counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, count]) => `- ${id}: ${count}`)
      .join('\n') +
    '\n'
  )
}
export function renderGateBaselines(
  report: Pick<ArchitectureReport, 'sourceSha' | 'gates' | 'counts' | 'publicSurfaceDeviations'>,
): string {
  return (
    `// RFC-376 committed baseline at ${report.sourceSha}.\n` +
    Object.entries(report.gates)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([id, values]) =>
          `export const KNOWN_${id.replaceAll('-', '_').toUpperCase()} = ${JSON.stringify(values, null, 2)} as const\n`,
      )
      .join('\n') +
    `\nexport const KNOWN_PUBLIC_SURFACE_DEVIATIONS = ${JSON.stringify(report.publicSurfaceDeviations, null, 2)} as const\n` +
    `\nexport const INITIAL_COUNTS = ${JSON.stringify(report.counts, null, 2)} as const\n`
  )
}
