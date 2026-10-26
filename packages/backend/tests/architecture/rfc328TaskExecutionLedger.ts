// RFC-395 II-pre：改接生产启动 / 读取路径，保留原断言意图。
// RFC-376 T2: RFC-328 inventory builders copied from RFC-294 for direct contract assertions.
// All source-dependent data is supplied by the caller; this module imports no production code.
import ts from 'typescript'
import { type SourceUnit } from './census'

const MODULE_PREFIX = 'packages/backend/src/modules/'
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

function ownerEntryId(path: string, symbol: string): string {
  return `owner:${path}#${symbol}`
}

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

function propertyName(node: ts.PropertyName | undefined): string | null {
  if (node === undefined) return null
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) {
    return node.text
  }
  if (ts.isNumericLiteral(node)) return node.text
  return null
}

type TaskExecutionAuthorityKind =
  | 'worker-epoch'
  | 'control-revision'
  | 'recovery-proof'
  | 'terminal-maintenance'

type TaskExecutionControlSubtype =
  | 'continuation-admission'
  | 'terminal-control'
  | 'gate-control'
  | 'membership-control'
  | 'daemon-shutdown'
  | 'recovery-candidate-revoke'

export const TASK_EXECUTION_DURABLE_TABLES = new Set([
  // Business projections are part of the authority denominator too.  The
  // RFC-328 ledgers are not useful if a stale worker can still bypass them by
  // writing the task/node projection directly.
  'tasks',
  'nodeRuns',
  'nodeRunOutputs',
  'nodeRunEvents',
  'taskExecutionOwners',
  'taskExecutionIntents',
  'taskExecutionEffects',
  'taskExecutionEffectAttempts',
  'taskExecutionEffectFences',
  'taskExecutionMaintenanceClaims',
  'taskExecutionMaintenanceMembers',
  'taskExecutionLineageOperationRecords',
])

interface TaskExecutionAuthorityEntry {
  readonly id: string
  readonly file: string
  readonly line: number
  readonly ownerEntryId: string
  readonly symbol: string
  readonly consumer: string
  readonly dataClass: string
  readonly authorityKind: TaskExecutionAuthorityKind
  readonly controlSubtype: TaskExecutionControlSubtype | null
  readonly allowedTables: readonly string[]
  readonly revisionPredicate: string
  readonly requiredBrandedProof: string
}

interface TaskExecutionControlGatewayEntry {
  readonly id: string
  readonly subtype: TaskExecutionControlSubtype
  readonly file: string
  readonly symbol: string
  readonly ownerEntryId: string
  readonly allowedTables: readonly string[]
  readonly allowedTransitions: readonly string[]
  readonly revisionPredicate: string
  readonly requiredBrandedProof: string
}

function nearestCallableName(unit: SourceUnit, node: ts.Node): string {
  let cursor: ts.Node | undefined = node
  while (cursor !== undefined && cursor !== unit.source) {
    if (
      (ts.isMethodDeclaration(cursor) || ts.isFunctionDeclaration(cursor)) &&
      cursor.name !== undefined
    ) {
      return cursor.name.getText(unit.source)
    }
    if (
      (ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor)) &&
      ts.isVariableDeclaration(cursor.parent) &&
      ts.isIdentifier(cursor.parent.name)
    ) {
      return cursor.parent.name.text
    }
    cursor = cursor.parent
  }
  return enclosingTopLevelSymbol(unit, node)?.name ?? '$file'
}

function durableMutationTable(node: ts.Node): string | null {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !['insert', 'update', 'delete'].includes(node.expression.name.text)
  ) {
    return null
  }
  const table = node.arguments[0]
  return table !== undefined && ts.isIdentifier(table) ? table.text : null
}

export function classifyTaskExecutionAuthority(input: {
  file: string
  callable: string
}): Pick<
  TaskExecutionAuthorityEntry,
  'authorityKind' | 'controlSubtype' | 'revisionPredicate' | 'requiredBrandedProof'
> | null {
  const value = `${input.file}#${input.callable}`
  // RFC-395 II-a A7：只重定向迁入 owner 的既有写点，未知函数仍不放行。
  if (
    input.file ===
    `${MODULE_PREFIX}task-execution/infrastructure/humanGatePersistenceParticipant.ts`
  ) {
    if (['cancelClarifyRunInTx', 'cancelTaskGateRunsInTx'].includes(input.callable)) {
      return classifyTaskExecutionAuthority({
        file: `${MODULE_PREFIX}collaboration/infrastructure/humanGateTerminalSweep.ts`,
        callable: input.callable,
      })
    }
    if (['completeClarifyRunInTx', 'writeReviewOutputInTx'].includes(input.callable)) {
      return classifyTaskExecutionAuthority({
        file: `${MODULE_PREFIX}collaboration/infrastructure/reviewRepairParticipant.ts`,
        callable: input.callable,
      })
    }
    if (input.callable === 'transferTaskOwnerInTx') {
      return {
        authorityKind: 'control-revision',
        controlSubtype: 'membership-control',
        revisionPredicate: 'task-member-plan-and-caller-owned-membership-transaction',
        requiredBrandedProof: 'AuthorizedTaskMembersReplacement',
      }
    }
    return null
  }
  if (input.file === `${MODULE_PREFIX}task-execution/infrastructure/crewstation/bootRecovery.ts`) {
    return {
      authorityKind: 'recovery-proof',
      controlSubtype: null,
      revisionPredicate: 'active-CS-epoch-lease-and-revoked-previous-owner-before-admission',
      requiredBrandedProof:
        'ExclusiveDaemonLockProof(CS-lease)+DurablePlatformResultOrNeverSubmittedProof',
    }
  }
  if (
    input.file ===
    `${MODULE_PREFIX}task-execution/infrastructure/crewstation/processEffectProjection.ts`
  ) {
    return {
      authorityKind: 'worker-epoch',
      controlSubtype: null,
      revisionPredicate: 'task-owner-epoch-and-active-CS-epoch-lease-in-same-transaction',
      requiredBrandedProof: 'OwnershipToken+CrewStationMutationFence',
    }
  }
  if (
    input.file ===
      `${MODULE_PREFIX}task-execution/infrastructure/crewstation/nodeEventArchive.ts` &&
    // RFC-370 v3 V6: the range removal commits inside the neutral object
    // publication's ready transaction (`commit`), as `finish` did before.
    (input.callable === 'finish' || input.callable === 'commit')
  ) {
    // The archive worker borrows the active CS epoch. Its exact immutable
    // range and verified object receipt commit with source-row removal.
    return {
      authorityKind: 'worker-epoch',
      controlSubtype: null,
      revisionPredicate:
        'active-CS-epoch-lease-and-original-archive-range-content-in-same-transaction',
      requiredBrandedProof: 'CrewStationMutationFence',
    }
  }
  if (
    (input.file === `${MODULE_PREFIX}task-execution/infrastructure/taskDeletionParticipant.ts` &&
      ['deleteRoot', 'recomputeAncestors'].includes(input.callable)) ||
    /sqliteTerminalMaintenance|terminalMaintenanceClaim|terminalMaintenancePersistence|taskArchive|taskDelete|services\/eventsArchive\.ts|services\/gc\.ts|services\/lifecycleRepair\//.test(
      value,
    )
  ) {
    return {
      authorityKind: 'terminal-maintenance',
      controlSubtype: null,
      revisionPredicate: 'exact-claim-revision-and-member-set-digest',
      requiredBrandedProof: 'TerminalMaintenanceClaim',
    }
  }
  // RFC-370 v3 V5: hosted restore normalization runs once, inside the restore
  // migration Job's import transaction, on a database no service slot has
  // activated yet (the standalone RFC-213 restore semantics).
  if (
    input.file === `${MODULE_PREFIX}task-execution/infrastructure/hostedRestoreNormalization.ts`
  ) {
    return {
      authorityKind: 'recovery-proof',
      controlSubtype: null,
      revisionPredicate: 'restored-generation-before-activation-in-the-restore-job-transaction',
      requiredBrandedProof: 'DatabaseRestoreInstallation',
    }
  }
  if (/recoverTaskExecutions|releaseRecovered|closeRecovered/.test(value)) {
    return {
      authorityKind: 'recovery-proof',
      controlSubtype: null,
      revisionPredicate: 'exact-old-owner-revision-and-daemon-generation',
      requiredBrandedProof: 'ExclusiveDaemonLockProof+VerifiedTakeoverOrOutcomeProof',
    }
  }
  // RFC-374: the resumable sequence catch-up is boot recovery, before any execution.
  if (
    /modules\/task-execution\/infrastructure\/legacyMigration\/nodeRunSeqBackfillStore\.ts#backfillTask$/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'recovery-proof',
      controlSubtype: null,
      revisionPredicate: 'boot-before-recovery-and-null-seq-only-per-task-transaction',
      requiredBrandedProof: 'ExclusiveDaemonLockProof(boot-before-scheduler)',
    }
  }

  if (
    /modules\/task-execution\/application\/applySourceTerminationEffect\.ts|services\/task\.ts#cancelTask|services\/terminalSweep\.ts/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'terminal-control',
      revisionPredicate: 'task-lifecycle-cas-and-source-or-terminal-control-fence',
      requiredBrandedProof: 'ExactTerminalControlTuple',
    }
  }
  if (
    /services\/clarify\/seal\.ts|services\/review\.ts#submitReviewDecisionUnlocked|services\/taskQuestionDispatch\.ts|services\/workgroup\/(?:configActions|lifecycle)\.ts/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'gate-control',
      revisionPredicate: 'task-scoped-decision-transaction-and-row-cas',
      requiredBrandedProof: 'GateDecisionTransaction',
    }
  }
  if (
    /services\/lifecycle\.ts|services\/limits\.ts|services\/recoveryBreaker\.ts|services\/repoCredentials\.ts/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'continuation-admission',
      revisionPredicate: 'task-lifecycle-or-metadata-cas',
      requiredBrandedProof: 'CanonicalControlTransaction',
    }
  }
  if (/services\/humanGateContinuationEffects\.ts#releaseClarifyConvergenceForRetry/.test(value)) {
    return {
      authorityKind: 'worker-epoch',
      controlSubtype: null,
      revisionPredicate: 'exact-intent-task-kind-claimed-epoch-and-state',
      requiredBrandedProof: 'OwnershipToken+ExactClaimedIntentFence',
    }
  }
  if (
    /services\/humanGateContinuationEffects\.ts#projectWorkspaceRollbackTx|modules\/task-execution\/application\/drive\/gateContinuationEffectStep\.ts#run/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'worker-epoch',
      controlSubtype: null,
      revisionPredicate: 'exact-owned-intent-and-succeeded-effect-receipt',
      requiredBrandedProof: 'OwnershipToken+TaskExecutionEffectReceipt',
    }
  }
  if (
    // RFC-395 II-a A3: review dispatch's consumed-edge write moved into this exact method.
    (input.file === `${MODULE_PREFIX}task-execution/infrastructure/consumedInputsParticipant.ts` &&
      ['record', 'recordNodeRunInputsInTx'].includes(input.callable)) ||
    (input.file === `${MODULE_PREFIX}task-execution/infrastructure/taskPreparationParticipant.ts` &&
      input.callable === 'writeWorkspace') ||
    /services\/(?:runner|scheduler|isolatedAgentRun|commitPushRunner|nodeRunMint|runtimeSessionLease)\.ts|modules\/task-execution\/composition\/(?:nodeMechanics|wrapperMechanics|wrapperRunLifecycle)\.ts|services\/runtime\/(?:opencode|claudeCode)\/(?:sessionCapture|subagentLiveCapture)\.ts|services\/review\.ts#dispatchReviewNodeUnlocked|modules\/collaboration\/infrastructure\/humanGateOpenParticipant\.ts#project(?:Review|Clarify)GateOpen|services\/workgroup\/rounds\.ts|services\/task\.ts#persistPreparedProjection/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'worker-epoch',
      controlSubtype: null,
      revisionPredicate: 'exact-owner-id-daemon-generation-epoch-and-claimed-state',
      requiredBrandedProof: 'OwnershipToken+OwnedTaskTx',
    }
  }
  if (
    /sqliteTaskExecutionIntent|taskContinuationAdmission|submitTaskContinuation|submitContinuationIntentTx|modules\/task-execution\/infrastructure\/repositoryPreparationRetryCommand\.ts#admitRetry/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'continuation-admission',
      revisionPredicate: 'expected-task-revision-and-active-intent-unique',
      requiredBrandedProof: 'CanonicalContinuationRequest',
    }
  }
  if (/terminalizeExecutionIntent/.test(value)) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'terminal-control',
      revisionPredicate: 'bound-intent-and-decision-revision',
      requiredBrandedProof: 'TerminalControlDecision',
    }
  }
  if (/revoke|markRecoveryRequired|releaseAfterStop/.test(input.callable)) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'terminal-control',
      revisionPredicate: 'exact-owner-tuple-state-and-revision',
      requiredBrandedProof: 'VerifiedStopProofOrExactControlTuple',
    }
  }
  // RFC-359 W8：归属端口合一成 `taskOwnershipPersistence.ts`（两引擎共用），认领 / 心跳这两个
  // worker-epoch 写点跟着搬家；同文件的 revoke / markRecoveryRequired / releaseAfterStop /
  // releaseRecovered 仍由上面的终止控制 / 恢复证明两条规则先行认领。
  if (
    /sqliteTaskOwnership|taskOwnershipPersistence|sqliteTaskExecutionEffect|processEffectObserver/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'worker-epoch',
      controlSubtype: null,
      revisionPredicate: 'exact-owner-id-daemon-generation-epoch-and-claimed-state',
      requiredBrandedProof: 'OwnershipToken',
    }
  }
  // RFC-349 moved the remaining Task Execution writers out of legacy services
  // and into provider-owned adapters.  Classify those concrete mechanisms by
  // the authority they consume; a blanket "infrastructure is trusted" rule
  // would make the ledger blind to future adapters, so every family below is
  // deliberately named.
  if (
    // RFC-359 W7：`reviewRepairParticipant` 合一后是中立文件名，provider 前缀那两份已删；
    // `CollaborationRuntimeMechanics` 同样合一（PG 那份原生重写已退役，写手回到 review）。
    /modules\/collaboration\/infrastructure\/(?:clarify\/seal|review|humanGateOpenParticipant|reviewRepairParticipant)/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'gate-control',
      revisionPredicate: 'task-scoped-gate-state-and-node-lifecycle-cas',
      requiredBrandedProof: 'GateDecisionTransaction+NodeRunLifecycleParticipantInTx',
    }
  }
  if (/modules\/collaboration\/infrastructure\/humanGateTerminalSweep/.test(value)) {
    return {
      authorityKind: 'terminal-maintenance',
      controlSubtype: null,
      revisionPredicate: 'terminal-human-gate-state-and-node-status-cas',
      requiredBrandedProof: 'TerminalMaintenanceExecutionFence',
    }
  }
  if (/modules\/resource-catalog\/infrastructure\/legacy\/workgroup\//.test(value)) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'membership-control',
      revisionPredicate: 'workgroup-config-revision-and-task-node-cas',
      requiredBrandedProof: 'AuthorizedWorkgroupTaskRoomCommand',
    }
  }
  if (/modules\/task-execution\/infrastructure\/taskRepositoryUsage/.test(value)) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'continuation-admission',
      revisionPredicate: 'workspace-sealing-generation-and-task-revision',
      requiredBrandedProof: 'RepositoryWorkspaceMutationAuthority',
    }
  }
  if (
    // RFC-359 W7：两份 provider 实现已合一为中立的 `resourceLimitPersistence.ts`（首字母小写、
    // 无 provider 前缀）。旧前缀保留在这里没有代价，但**中立名必须认**——不认就会让合一后的
    // 写点变成 unknown writer，普查当场失败（本刀实撞）。
    /modules\/task-execution\/infrastructure\/taskResourceLimitFacts/.test(value)
  ) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'terminal-control',
      revisionPredicate: 'resource-limit-observation-and-task-lifecycle-cas',
      requiredBrandedProof: 'ResourceLimitEnforcementDecision',
    }
  }
  // RFC-350：不活跃超时收割的原因覆盖。与上面 resource-limit 那条同形——只在**已经
  // 落进 canceled** 的行上覆盖终态文案，写入判据是「这一行的终态是不是我们写的」
  // （status='canceled' 且 error_summary 仍是 cancelTask 的默认值），竞态里被别的
  // 终态写手抢先的行原样保留它自己的原因。
  if (/modules\/task-execution\/infrastructure\/taskIdleTimeoutPersistence/.test(value)) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'terminal-control',
      revisionPredicate: 'idle-observation-and-own-terminal-copy-cas',
      requiredBrandedProof: 'IdleTimeoutReapDecision',
    }
  }
  if (
    /(?:modules\/task-execution\/infrastructure\/taskNodeEventArchiveStore|platform\/persistence\/sqlite\/(?:systemEventsArchive|taskLifecycleRepair\/))/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'terminal-maintenance',
      controlSubtype: null,
      revisionPredicate: 'exact-maintenance-fence-claim-and-durable-cutoff',
      requiredBrandedProof: 'TerminalMaintenanceClaim+MaintenanceExecutionFence',
    }
  }
  if (/modules\/task-execution\/infrastructure\/taskLifecycle\.ts/.test(value)) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'terminal-control',
      revisionPredicate: 'task-or-node-lifecycle-status-cas',
      requiredBrandedProof: 'CanonicalControlTransaction',
    }
  }
  // RFC-359 W16 moves both physical task-status CAS bodies into this exact
  // shared program; the original native/async entries still own their transaction.
  if (
    /modules\/task-execution\/infrastructure\/(?:taskLifecycleWriteSequence\.ts#taskLifecycleWriteSequence|taskDefinitionWriteParticipant\.ts#transitionLifecycle)$/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'terminal-control',
      revisionPredicate: 'task-status-and-optional-lifecycle-revision-cas',
      requiredBrandedProof: 'CanonicalControlTransaction',
    }
  }
  if (
    /modules\/task-execution\/infrastructure\/(?:(?:postgresql|sqlite)TaskExecutionRecovery|effectQuiescence)/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'recovery-proof',
      controlSubtype: null,
      revisionPredicate: 'effect-attempt-fence-and-recovery-watermark',
      requiredBrandedProof: 'VerifiedTakeoverOrOutcomeProof',
    }
  }
  if (
    /modules\/task-execution\/infrastructure\/(?:(?:postgresql|sqlite)(?:TaskRecoveryOperations|RepositoryPreparationRetryCommand)|taskRecoveryOperations)/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'recovery-proof',
      controlSubtype: null,
      revisionPredicate: 'task-recovery-generation-and-lifecycle-revision',
      requiredBrandedProof: 'RecoveryCandidateProof',
    }
  }
  if (
    /modules\/task-execution\/infrastructure\/(?:postgresql|sqlite)(?:TaskArchiveMaintenanceCommand|TerminalMaintenancePersistence)/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'terminal-maintenance',
      controlSubtype: null,
      revisionPredicate: 'exact-claim-revision-and-member-set-digest',
      requiredBrandedProof: 'TerminalMaintenanceClaim',
    }
  }
  if (
    /modules\/task-execution\/infrastructure\/(?:(?:postgresql|sqlite)(?:TaskExecutionIntentPersistence|TaskExecutionIntentTerminalPersistence|TaskRouteLaunchOperations|ChildExecutionLaunchOperations|ChildTaskLifecycleParticipant|FusionEngineTaskOperations|SourceTerminationParticipant|TaskExecutionShutdownOperations|TaskRouteOperations|TaskRuntimeLifecyclePersistence|WorkgroupTaskRoomTaskParticipant)|fusionEngineTaskOperations|taskExecutionIntentPersistence|taskExecutionIntentTerminalPersistence|taskExecutionShutdownOperations|taskRuntimeLifecyclePersistence|workgroupTaskRoomTaskParticipant|sourceTerminationTarget|taskRouteLaunchOperations|childExecutionLaunchOperations|childTaskLifecycleParticipant|taskRouteWorkspaceParticipant|taskRouteRepairOperations|taskRouteOperations|taskDefinitionWriteParticipant)/.test(
      value,
    )
  ) {
    const membership = /replaceTaskMembers|replaceConfig|replaceWorkgroupRuntimeConfig/.test(
      input.callable,
    )
    const terminal =
      /terminalize|cancel|failTask|deleteTask|interruptSurvivor|SourceTermination|sourceTerminationTarget/.test(
        value,
      )
    return {
      authorityKind: 'control-revision',
      controlSubtype: membership
        ? 'membership-control'
        : terminal
          ? 'terminal-control'
          : 'continuation-admission',
      revisionPredicate: 'task-lifecycle-revision-and-provider-transaction-cas',
      requiredBrandedProof: 'CanonicalControlTransaction',
    }
  }
  // RFC-359 W17 retains the original terminal companion classification when
  // its physical writes move from the two wrappers to this exact shared body.
  if (
    /modules\/task-execution\/infrastructure\/sqliteTerminalizeExecutionIntent/.test(value) ||
    /modules\/task-execution\/infrastructure\/taskExecutionIntentTerminalSequence\.ts#taskExecutionIntentTerminalSequence$/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'terminal-control',
      revisionPredicate: 'bound-intent-and-decision-revision',
      requiredBrandedProof: 'TerminalControlDecision',
    }
  }
  if (
    /modules\/task-execution\/infrastructure\/(?:(?:postgresql|sqlite)(?:GateContinuationPreDrivePersistence|GateContinuationEffectStep|MergeStateLifecyclePersistence|NodeExecutionPersistence|NodeRunLifecyclePersistence|NodeRunMintParticipant|NodeRunRuntimePersistence|ProcessEffectObserver|RuntimeSessionCapturePersistence|RuntimeSessionLeaseOperations|TaskLifecycleTransaction|TaskOwnershipPersistence|WorkgroupHostLedgerParticipant|WrapperRunPersistence)|nodeRunMintParticipant|humanGateTaskTransition|workspaceRollbackEffect|nodeRunLifecycleTransition|ownedTaskExecution|wrapperRunPersistence|nodeRunRuntimePersistence|schedulerCompletionPersistence|runtimeSessionCapturePersistence|gateContinuationPreDrivePersistence|mergeStateLifecyclePersistence|taskEngineApplicationPersistence|taskExecutionEffectPersistence|nodeExecutionPersistence|nodeRunLifecyclePersistence|workgroupHostLedgerParticipant|runtimeSessionLeaseOperations|humanGateTaskLifecyclePersistence|taskLifecycleTransaction)/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'worker-epoch',
      controlSubtype: null,
      revisionPredicate: 'exact-owner-id-daemon-generation-epoch-and-claimed-state',
      requiredBrandedProof: 'OwnershipToken+OwnedTaskTx',
    }
  }
  return null
}

export function buildTaskExecutionAuthorityEntries(backend: readonly SourceUnit[]): {
  entries: TaskExecutionAuthorityEntry[]
  unknown: Array<{ file: string; line: number; table: string; callable: string }>
} {
  const entries: TaskExecutionAuthorityEntry[] = []
  const unknown: Array<{ file: string; line: number; table: string; callable: string }> = []
  const sharedProtocol = `${MODULE_PREFIX}task-execution/infrastructure/nodeRunWriteProtocol.ts`
  // The shared physical writer is not an authority factory: workers, canonical
  // controls and boot recovery all call it. Attribute each write to the actual
  // caller instead of incorrectly labelling every call as worker-epoch.
  const protocolCallers = (method: string) => {
    const accepted = new Set([
      'compareAndWriteNodeRunInTx',
      'writeNodeRunProjectionInTx',
      ...(method === 'replaceInputs' ? ['writeNodeRunTablesInTx'] : []),
    ])
    const callers: Array<{ file: string; line: number; callable: string }> = []
    for (const unit of backend) {
      if (unit.path === sharedProtocol) continue
      const names = new Set<string>()
      for (const statement of unit.source.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          !/(?:^|\/)nodeRunWriteProtocol$/.test(statement.moduleSpecifier.text)
        )
          continue
        const bindings = statement.importClause?.namedBindings
        if (bindings && ts.isNamedImports(bindings))
          for (const binding of bindings.elements)
            if (accepted.has((binding.propertyName ?? binding.name).text))
              names.add(binding.name.text)
      }
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          names.has(node.expression.text)
        )
          callers.push({
            file: unit.path,
            line: unit.source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            callable: nearestCallableName(unit, node),
          })
        ts.forEachChild(node, visit)
      }
      visit(unit.source)
    }
    return callers
  }
  for (const unit of backend) {
    const ordinals = new Map<string, number>()
    const siteId = (symbol: string, callee: string): string => {
      const key = `${unit.path}#${symbol}#${callee}`
      const ordinal = (ordinals.get(key) ?? 0) + 1
      ordinals.set(key, ordinal)
      return `${key}#${ordinal}`
    }
    const visit = (node: ts.Node): void => {
      const table = durableMutationTable(node)
      if (table !== null && TASK_EXECUTION_DURABLE_TABLES.has(table)) {
        const line = unit.source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        const owner = enclosingTopLevelSymbol(unit, node)
        const symbol = owner?.name ?? '$file'
        const callable = nearestCallableName(unit, node)
        const callers =
          unit.path === sharedProtocol &&
          ['replaceInputs', 'compareAndWriteNodeRunInTx'].includes(callable)
            ? protocolCallers(callable)
            : [{ file: unit.path, line, callable }]
        if (callers.length === 0) unknown.push({ file: unit.path, line, table, callable })
        for (const caller of callers) {
          const classification = classifyTaskExecutionAuthority(caller)
          if (classification === null) {
            unknown.push({ ...caller, table })
            continue
          }
          entries.push({
            id: siteId(callable, table),
            file: unit.path,
            line,
            ownerEntryId: ownerEntryId(unit.path, symbol),
            symbol,
            consumer:
              unit.path === sharedProtocol
                ? `${caller.file}:${caller.line}#${caller.callable}`
                : callable,
            dataClass: table,
            ...classification,
            allowedTables: [table],
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return {
    entries: entries.sort((left, right) => left.id.localeCompare(right.id)),
    unknown: unknown.sort((left, right) =>
      `${left.file}:${left.line}`.localeCompare(`${right.file}:${right.line}`),
    ),
  }
}

const TASK_EXECUTION_CONTROL_GATEWAY_SPECS: readonly Omit<
  TaskExecutionControlGatewayEntry,
  'id' | 'ownerEntryId'
>[] = [
  {
    subtype: 'continuation-admission',
    file: 'packages/backend/src/modules/task-execution/application/submitTaskContinuation.ts',
    symbol: 'submitTaskContinuation',
    allowedTables: ['tasks', 'taskExecutionIntents', 'taskExecutionLineageOperationRecords'],
    allowedTransitions: [
      'business-state->pending',
      'intent-absent->pending',
      'decision->authorized',
    ],
    revisionPredicate: 'task-lifecycle-event-revision+decision-record-revision',
    requiredBrandedProof: 'CanonicalContinuationRequest',
  },
  {
    // RFC-359 AC-1（第 11 刀）：取消合一，网关从 legacy 的 `cancelTask` 搬到共用实现。
    // 写面一格没变（同三张表、同三条转移、同一条 revision 判据）——搬的是家，不是判据。
    subtype: 'terminal-control',
    file: 'packages/backend/src/modules/task-execution/infrastructure/childTaskLifecycleParticipant.ts',
    symbol: 'cancelTaskProjection',
    allowedTables: ['tasks', 'taskExecutionOwners', 'taskExecutionIntents'],
    allowedTransitions: ['task->canceled', 'owner-claimed->revoked', 'intent->canceled'],
    revisionPredicate: 'task-lifecycle-event-revision+exact-owner-revision',
    requiredBrandedProof: 'ExactTerminalControlTuple',
  },
  {
    subtype: 'gate-control',
    // RFC-359：同步的 `bindTaskDecisionParticipantInTx` 整条链退役（生产零消费者），
    // 决定接受的唯一写者是中立的 `acceptHumanGateDecisionTx`。写点与判据未变，只是搬了家。
    file: 'packages/backend/src/modules/task-execution/infrastructure/taskDecisionParticipant.ts',
    symbol: 'acceptHumanGateDecisionTx',
    allowedTables: ['tasks', 'taskExecutionIntents', 'gate-companion-table'],
    allowedTransitions: ['awaiting-gate->pending', 'intent-absent->pending'],
    revisionPredicate: 'task-lifecycle-event-revision',
    requiredBrandedProof: 'GateDecisionTransaction',
  },
  {
    subtype: 'membership-control',
    file: 'packages/backend/src/modules/task-execution/public/taskRoutes.ts',
    symbol: 'TaskRouteOperations',
    allowedTables: ['tasks', 'taskCollaborators'],
    allowedTransitions: ['membership-revision-cas'],
    revisionPredicate: 'task-membership-revision',
    requiredBrandedProof: 'AuthorizedTaskMembershipActor',
  },
  {
    subtype: 'daemon-shutdown',
    // RFC-359：优雅停机的幸存者处置在 W4-B1 批 2h 合成了两个引擎共用的一份；SQLite 专属的
    // `services/task.ts#markTaskExecutionShutdownSurvivor` 自那以后生产零调用方，现已删除。
    // 权威没有消失，只是搬了家：`services/shutdown.ts` 经 `dependencies.operations` 调这一个类，
    // 写点（tasks / intents / owners）与 CAS 判据逐条未变。
    file: 'packages/backend/src/modules/task-execution/infrastructure/taskExecutionShutdownOperations.ts',
    symbol: 'DrizzleTaskExecutionShutdownOperations',
    allowedTables: ['tasks', 'taskExecutionIntents', 'taskExecutionOwners'],
    allowedTransitions: [
      'running->interrupted',
      'claimed->recovery-required',
      'revoked->recovery-required',
    ],
    revisionPredicate: 'task-lifecycle-event-revision+exact-owner-revision',
    requiredBrandedProof: 'ExplicitShutdownReason+ExactOwnerTuple',
  },
  {
    subtype: 'recovery-candidate-revoke',
    file: 'packages/backend/src/modules/task-execution/application/recoverTaskExecutions.ts',
    symbol: 'prepareTaskExecutionRecovery',
    allowedTables: ['taskExecutionOwners'],
    allowedTransitions: ['old-daemon-claimed->revoked'],
    revisionPredicate: 'exact-old-owner-revision',
    requiredBrandedProof: 'ExclusiveDaemonLockProof',
  },
]

export function buildTaskExecutionControlGateways(backend: readonly SourceUnit[]): {
  entries: TaskExecutionControlGatewayEntry[]
  unknown: string[]
} {
  const entries: TaskExecutionControlGatewayEntry[] = []
  const unknown: string[] = []
  for (const spec of TASK_EXECUTION_CONTROL_GATEWAY_SPECS) {
    const unit = backend.find((candidate) => candidate.path === spec.file)
    const symbolExists = unit?.source.statements.some(
      (statement) => declarationName(statement) === spec.symbol,
    )
    if (unit === undefined || symbolExists !== true) {
      unknown.push(`${spec.subtype}:${spec.file}#${spec.symbol}`)
      continue
    }
    entries.push({
      ...spec,
      id: `task-control:${spec.subtype}`,
      ownerEntryId: ownerEntryId(spec.file, spec.symbol),
    })
  }
  return { entries, unknown: unknown.sort() }
}

export const TASK_EFFECT_OBSERVER_CALLEES = new Set([
  'createCodeHostEffectAttemptObserver',
  'createLocalEffectAttemptObserver',
  'createProcessEffectAttemptObserver',
  'runTaskLocalEffect',
])

interface TaskOwnedEffectEntry {
  readonly id: string
  readonly file: string
  readonly symbol: string
  readonly line: number
  readonly effectKind: string
  readonly operationFamily: 'lineage-slot-stable-action'
  readonly generationPolicy: 'intent-or-node-generation' | 'next-retained-generation'
  readonly journaledBy: string
  readonly attemptPolicy: 'per-act' | 'per-spawn' | 'per-http-send'
  readonly resourceKeySetResolver: 'explicit-multi-resource-set'
  readonly recoveryClass: string
  readonly responseClassifier: string
  readonly transportRetryPolicy: string
  readonly recoveryProbeOrActorReplay: string
  readonly auditRetention: 'effect-attempt-watermark-and-decision'
  readonly ownerEntryId: string
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== name) continue
    return property.initializer
  }
  return null
}

function literalText(expression: ts.Expression | null): string | null {
  return expression !== null && ts.isStringLiteralLike(expression) ? expression.text : null
}

export function buildTaskOwnedEffectEntries(backend: readonly SourceUnit[]): {
  entries: TaskOwnedEffectEntry[]
  unknown: Array<{ file: string; line: number; reason: string }>
} {
  const entries: TaskOwnedEffectEntry[] = []
  const unknown: Array<{ file: string; line: number; reason: string }> = []
  for (const unit of backend) {
    // Coordinator internals call one another; the denominator is production
    // act-site registration, not the coordinator's own adapter plumbing.
    if (
      unit.path.startsWith(`${MODULE_PREFIX}task-execution/application/`) &&
      unit.path !== `${MODULE_PREFIX}task-execution/application/taskAgentRun.ts`
    )
      continue
    const ordinals = new Map<string, number>()
    const siteId = (symbol: string, callee: string): string => {
      const key = `${unit.path}#${symbol}#${callee}`
      const ordinal = (ordinals.get(key) ?? 0) + 1
      ordinals.set(key, ordinal)
      return `${key}#${ordinal}`
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        TASK_EFFECT_OBSERVER_CALLEES.has(node.expression.text)
      ) {
        const callee = node.expression.text
        const line = unit.source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        const owner = enclosingTopLevelSymbol(unit, node)
        const symbol = owner?.name ?? '$file'
        const argument = node.arguments[0]
        if (argument === undefined || !ts.isObjectLiteralExpression(argument)) {
          unknown.push({
            file: unit.path,
            line,
            reason: `${callee} lacks an object-literal policy`,
          })
          ts.forEachChild(node, visit)
          return
        }
        const text = argument.getText(unit.source)
        let effectKind: string | null = null
        if (callee === 'createProcessEffectAttemptObserver') effectKind = 'process'
        else if (callee === 'createCodeHostEffectAttemptObserver') effectKind = 'code-host-mutation'
        else if (callee === 'createLocalEffectAttemptObserver' && symbol === 'runTaskLocalEffect') {
          effectKind = 'local-provider-effect'
        } else effectKind = literalText(objectProperty(argument, 'kind'))
        if (effectKind === null) {
          unknown.push({
            file: unit.path,
            line,
            reason: `${callee} has an unclassified effect kind`,
          })
          ts.forEachChild(node, visit)
          return
        }
        if (!/\bresourceKeys\s*:/.test(text)) {
          unknown.push({ file: unit.path, line, reason: `${callee} has no resource-key resolver` })
          ts.forEachChild(node, visit)
          return
        }
        const isProcess = effectKind === 'process'
        const isCodeHost = effectKind === 'code-host-mutation'
        const isHostedProcess =
          isProcess &&
          unit.path === `${MODULE_PREFIX}task-execution/composition/crewstationAgentInvocation.ts`
        entries.push({
          id: siteId(symbol, callee),
          file: unit.path,
          symbol,
          line,
          effectKind,
          operationFamily: 'lineage-slot-stable-action',
          generationPolicy: isCodeHost ? 'next-retained-generation' : 'intent-or-node-generation',
          journaledBy: callee,
          attemptPolicy: isCodeHost ? 'per-http-send' : isProcess ? 'per-spawn' : 'per-act',
          resourceKeySetResolver: 'explicit-multi-resource-set',
          recoveryClass: isHostedProcess
            ? 'crewstation-v3-execution'
            : isCodeHost
              ? 'action-provider-candidate-matrix'
              : isProcess
                ? 'managed-process-preactivation'
                : 'local-probe-or-actor',
          responseClassifier: isHostedProcess
            ? 'crewstation-v3-final-cursor-result'
            : isCodeHost
              ? 'http-status-plus-prior-ambiguity'
              : isProcess
                ? 'spawn-receipt-exit-reap'
                : 'applied-or-ambiguous-throw',
          transportRetryPolicy: isHostedProcess
            ? 'crewstation-v3-stable-request-key'
            : isCodeHost
              ? 'rfc269-current-method-policy'
              : isProcess
                ? 'no-hidden-respawn'
                : 'caller-explicit-only',
          recoveryProbeOrActorReplay: isHostedProcess
            ? 'durable-binding-event-journal-adopt'
            : isCodeHost
              ? 'binding-profile-or-actor-next-generation'
              : isProcess
                ? 'pid-nonce-binary-probe'
                : 'local-probe-or-actor-next-generation',
          auditRetention: 'effect-attempt-watermark-and-decision',
          ownerEntryId: ownerEntryId(unit.path, symbol),
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return {
    entries: entries.sort((left, right) => left.id.localeCompare(right.id)),
    unknown: unknown.sort((left, right) =>
      `${left.file}:${left.line}`.localeCompare(`${right.file}:${right.line}`),
    ),
  }
}

/** Parse data declarations from the selected source text; never execute production modules. */
export function declarationInitializer(unit: SourceUnit, name: string): ts.Expression {
  for (const statement of unit.source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer !== undefined
      )
        return unwrapLiteral(declaration.initializer)
    }
  }
  throw new Error(`missing declaration ${unit.path}#${name}`)
}
function unwrapLiteral(node: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  )
    node = node.expression
  return node
}
export function dataLiteral(node: ts.Expression, resolveName?: (name: string) => unknown): unknown {
  node = unwrapLiteral(node)
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isIdentifier(node) && resolveName !== undefined) return resolveName(node.text)
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans
        .map((span) => {
          const value = dataLiteral(span.expression, resolveName)
          if (typeof value !== 'string' && typeof value !== 'number')
            throw new Error('non-scalar template value')
          return String(value) + span.literal.text
        })
        .join('')
    )
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = dataLiteral(node.left, resolveName),
      right = dataLiteral(node.right, resolveName)
    if (typeof left === 'string' && typeof right === 'string') return left + right
    throw new Error('non-string data concatenation')
  }
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isArrayLiteralExpression(node))
    return node.elements.flatMap((element) => {
      if (!ts.isSpreadElement(element)) return [dataLiteral(element, resolveName)]
      const values = dataLiteral(element.expression, resolveName)
      if (!Array.isArray(values)) throw new Error('non-array data spread')
      return values
    })
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'map'
  ) {
    const values = dataLiteral(node.expression.expression, resolveName),
      callback = node.arguments[0]
    if (
      !Array.isArray(values) ||
      node.arguments.length !== 1 ||
      callback === undefined ||
      !ts.isArrowFunction(callback) ||
      ts.isBlock(callback.body) ||
      callback.parameters.some((parameter) => !ts.isIdentifier(parameter.name))
    )
      throw new Error('non-literal data map')
    const body = callback.body
    return values.map((value, index) =>
      dataLiteral(body, (name) => {
        if (callback.parameters[0]?.name.getText() === name) return value
        if (callback.parameters[1]?.name.getText() === name) return index
        if (resolveName === undefined) throw new Error(`unresolved data name: ${name}`)
        return resolveName(name)
      }),
    )
  }
  if (ts.isObjectLiteralExpression(node))
    return Object.fromEntries(
      node.properties.map((property) => {
        if (!ts.isPropertyAssignment(property)) throw new Error('non-literal object property')
        const name = propertyName(property.name)
        if (name === null) throw new Error('non-literal property name')
        return [name, dataLiteral(property.initializer, resolveName)]
      }),
    )
  throw new Error(`non-literal data: ${node.getText().slice(0, 80)}`)
}
export interface CodeHostRecoveryBindingManifestEntry {
  readonly id: string
  readonly action: string
  readonly provider: string
  readonly candidateId: string
  readonly candidateIndex: number | null
  readonly supported: boolean
  readonly method: string | null
  readonly path: string | null
  readonly recoveryClass: string
  readonly transportProfile: string | null
  readonly compatibilityFallbackAvailable: boolean
  readonly probeProfile: string
}
export function buildCodeHostRecoveryBindingManifest(
  units: readonly SourceUnit[],
): CodeHostRecoveryBindingManifestEntry[] {
  const required = (path: string): SourceUnit => {
    const unit = units.find((candidate) => candidate.path === path)
    if (unit === undefined) throw new Error(`missing code-host source: ${path}`)
    return unit
  }
  const recovery = required(`${MODULE_PREFIX}task-execution/domain/codeHostRecovery.ts`)
  const registry = required('packages/shared/src/codeHost/actions.ts')
  const actions = dataLiteral(declarationInitializer(registry, 'CODE_HOST_ACTIONS')) as string[]
  const providers = dataLiteral(declarationInitializer(recovery, 'CODE_HOST_PROVIDERS')) as string[]
  const methods = dataLiteral(declarationInitializer(recovery, 'CUSTOM_METHODS')) as string[]
  const classes = dataLiteral(declarationInitializer(recovery, 'RECOVERY_BY_ACTION')) as Record<
    string,
    string
  >
  const probes = dataLiteral(declarationInitializer(recovery, 'PROBE_BY_ACTION')) as Record<
    string,
    string
  >
  const definitions = declarationInitializer(registry, 'CODE_HOST_ACTION_DEFS')
  if (!ts.isObjectLiteralExpression(definitions))
    throw new Error('code-host registry is not an object')
  const bindings = new Map<string, Record<string, Record<string, unknown>>>()
  for (const property of definitions.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer))
      continue
    const expression = objectProperty(property.initializer, 'bindings')
    if (expression !== null)
      bindings.set(
        propertyName(property.name)!,
        dataLiteral(expression) as Record<string, Record<string, unknown>>,
      )
  }
  const result: CodeHostRecoveryBindingManifestEntry[] = []
  for (const action of actions)
    for (const provider of providers) {
      const binding = bindings.get(action)?.[provider]
      if (binding === undefined || classes[action] === undefined || probes[action] === undefined)
        throw new Error(`incomplete code-host binding: ${action}:${provider}`)
      if ('unsupported' in binding) {
        result.push({
          id: `${action}:${provider}:unsupported`,
          action,
          provider,
          candidateId: 'unsupported',
          candidateIndex: null,
          supported: false,
          method: null,
          path: null,
          recoveryClass: 'R-UNSUPPORTED',
          transportProfile: null,
          compatibilityFallbackAvailable: false,
          probeProfile: 'unsupported',
        })
        continue
      }
      const candidates =
        action === 'custom'
          ? methods.map((method) => ({ method, path: '<dynamic>' }))
          : [
              binding,
              ...((binding.compatibilityFallbacks as Record<string, unknown>[] | undefined) ?? []),
            ]
      candidates.forEach((candidate, index) => {
        const method = String(candidate.method),
          path = String(candidate.path)
        const transportProfile =
          method === 'GET'
            ? 'T-READ'
            : method === 'POST'
              ? 'T-POST'
              : ['PUT', 'PATCH', 'DELETE'].includes(method)
                ? 'T-IDEMPOTENT-METHOD'
                : null
        if (transportProfile === null || typeof candidate.path !== 'string')
          throw new Error(`invalid code-host candidate: ${action}:${provider}:${index}`)
        const custom = action === 'custom'
        result.push({
          id: `${action}:${provider}:${custom ? method : `c${index}`}`,
          action,
          provider,
          candidateId: custom ? `custom:${method.toLowerCase()}` : `${action}:c${index}`,
          candidateIndex: index,
          supported: true,
          method,
          path,
          recoveryClass: custom && method === 'GET' ? 'R-READ' : classes[action]!,
          transportProfile,
          compatibilityFallbackAvailable: !custom && index + 1 < candidates.length,
          probeProfile: custom && method === 'GET' ? 'read-only' : probes[action]!,
        })
      })
    }
  return result.sort((a, b) => a.id.localeCompare(b.id))
}
export function validateCodeHostRecoveryBindingManifest(
  entries: readonly CodeHostRecoveryBindingManifestEntry[],
  units: readonly SourceUnit[],
): string[] {
  const expected = buildCodeHostRecoveryBindingManifest(units)
  const actual = new Map(entries.map((entry) => [entry.id, entry]))
  const errors: string[] = []
  if (entries.length === 0) errors.push('code-host recovery binding denominator is empty')
  if (actual.size !== entries.length) errors.push('duplicate code-host recovery binding id')
  for (const entry of expected) {
    if (!actual.has(entry.id)) errors.push(`missing code-host recovery binding '${entry.id}'`)
    else if (JSON.stringify(actual.get(entry.id)) !== JSON.stringify(entry))
      errors.push(`drifted code-host recovery binding '${entry.id}'`)
  }
  const ids = new Set(expected.map((entry) => entry.id))
  for (const entry of entries) {
    if (!ids.has(entry.id)) errors.push(`unknown code-host recovery binding '${entry.id}'`)
    if (entry.action === 'mr.approve' && entry.recoveryClass !== 'R-ACTOR')
      errors.push(`mr.approve must remain actor-replay for ${entry.provider}`)
  }
  return [...new Set(errors)].sort()
}

/** Direct RFC-328 closure, independent of inventory ownership/projection metadata. */
export function validateTaskExecutionContracts(contracts: {
  authority: ReturnType<typeof buildTaskExecutionAuthorityEntries>
  gateways: ReturnType<typeof buildTaskExecutionControlGateways>
  effects: ReturnType<typeof buildTaskOwnedEffectEntries>
}): string[] {
  const { authority, gateways, effects } = contracts
  const errors: string[] = []
  const requiredFields = (
    entries: readonly object[],
    label: string,
    fields: readonly string[],
  ): void => {
    for (const value of entries) {
      const entry = value as Record<string, unknown>
      for (const field of fields)
        if (typeof entry[field] !== 'string' || String(entry[field]).trim() === '')
          errors.push(`${label} '${String(entry.id)}' lacks ${field}`)
    }
  }
  const requiredArrays = (
    entries: readonly object[],
    label: string,
    fields: readonly string[],
  ): void => {
    for (const value of entries) {
      const entry = value as Record<string, unknown>
      for (const field of fields)
        if (!Array.isArray(entry[field]) || entry[field].length === 0)
          errors.push(`${label} '${String(entry.id)}' lacks ${field}`)
    }
  }
  if (authority.entries.length === 0) errors.push('task-execution authority denominator is empty')
  if (authority.unknown.length > 0) errors.push('task-execution authority has unknown writers')
  if (gateways.unknown.length > 0) errors.push('task-execution control has unknown gateways')
  if (effects.entries.length === 0) errors.push('task-execution effect denominator is empty')
  if (effects.unknown.length > 0) errors.push('task-execution effect has unknown act sites')
  for (const kind of ['worker-epoch', 'control-revision', 'recovery-proof', 'terminal-maintenance'])
    if (!authority.entries.some((entry) => entry.authorityKind === kind))
      errors.push(`task-execution authority kind is empty: ${kind}`)
  for (const subtype of [
    'continuation-admission',
    'terminal-control',
    'gate-control',
    'membership-control',
    'daemon-shutdown',
    'recovery-candidate-revoke',
  ])
    if (!gateways.entries.some((entry) => entry.subtype === subtype))
      errors.push(`task-execution control subtype is empty: ${subtype}`)
  requiredFields(authority.entries, 'task-execution authority', [
    'consumer',
    'dataClass',
    'authorityKind',
    'revisionPredicate',
    'requiredBrandedProof',
  ])
  requiredArrays(authority.entries, 'task-execution authority', ['allowedTables'])
  requiredArrays(gateways.entries, 'task-execution control gateway', [
    'allowedTables',
    'allowedTransitions',
  ])
  requiredFields(effects.entries, 'task-execution effect', [
    'effectKind',
    'operationFamily',
    'generationPolicy',
    'journaledBy',
    'attemptPolicy',
    'resourceKeySetResolver',
    'recoveryClass',
    'responseClassifier',
    'transportRetryPolicy',
    'recoveryProbeOrActorReplay',
    'auditRetention',
  ])
  return errors.sort()
}
