// RFC-395 II-a A2: node-run business ports and mechanics must stay independent of checkpoint columns.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../src')
const source = (path: string) => readFileSync(resolve(root, path), 'utf8')
const taskSource = (path: string) => source(`modules/task-execution/${path}`)
const legacyColumns =
  /\b(?:preSnapshotReposJson|isoBaseSnapshot(?:ReposJson)?|isoNodeTree(?:ReposJson)?|isoSubmodules(?:Repos)?Json)\b/

test('node-run ports expose checkpoints and keep merge state / isolation root at run level', () => {
  for (const path of [
    'application/ports/nodeExecutionPersistence.ts',
    'application/ports/mergeStateLifecyclePersistence.ts',
    'application/ports/nodeRunLifecyclePersistence.ts',
    'domain/wrapperExecution.ts',
  ]) {
    const text = taskSource(path)
    if (
      path === 'application/ports/nodeRunLifecyclePersistence.ts' ||
      path === 'domain/wrapperExecution.ts'
    )
      expect(text).toContain('checkpoints')
    expect(text).not.toMatch(legacyColumns)
    expect(text).not.toMatch(/readonly preSnapshot[?:]/)
  }
  const run = taskSource('application/ports/nodeExecutionPersistence.ts')
  expect(run).toMatch(
    /export interface NodeExecutionSnapshot\s+extends[^{}]+NodeRunRuntimeStateView,[^{}]+NodeRunCheckpointView,/,
  )
  expect(run).toContain("from '../../domain/nodeRunSnapshot'")
  const snapshot = taskSource('domain/nodeRunSnapshot.ts')
  expect(snapshot).toContain('readonly checkpoints: readonly TaskRepositoryCheckpoint[]')
  expect(snapshot).toContain('readonly isoWorktreePath: string | null')
  expect(snapshot).toContain('readonly mergeState: MergeStateOrNull')
  expect(snapshot).not.toMatch(legacyColumns)
  const merge = taskSource('application/ports/mergeStateLifecyclePersistence.ts')
  expect(merge).toContain('export type MergeStateProjectionPatch = NodeRunMergeWrite')
  const writes = taskSource('application/ports/nodeRunWrites.ts')
  expect(writes).toContain('export interface NodeRunMergeWrite')
  expect(writes).toContain(
    "readonly checkpoint?: Omit<NodeRunCheckpointWrite, 'pendingSubResolves'>",
  )
  expect(writes).toContain('readonly checkpoints?: readonly TaskRepositoryCheckpoint[]')
  expect(writes).not.toMatch(legacyColumns)
  const checkpoint = taskSource('domain/taskCheckpoint.ts')
  expect(checkpoint).not.toContain('isoWorktreePath')
  expect(checkpoint).not.toContain('mergeState')
})

const AGENT_EXECUTOR_FILES = [
  'engine/node/agent-single/runAgentSingleNode.ts',
  'engine/node/agent-single/runWorkgroupHost.ts',
  // RFC-407: the fan-out shard / aggregator lines and their attempt port left wrapperMechanics.ts.
  'engine/node/agent-single/runFanoutShard.ts',
  'engine/node/agent-single/runFanoutAggregator.ts',
  'engine/node/agent-single/fanoutAttempts.ts',
  'composition/agentNodeExecution.ts',
  'application/agentRunHistory.ts',
]

test('isolation, replay and wrapper mechanics do not inspect scalar/map columns or directory aliases', () => {
  for (const path of [
    // RFC-405 / RFC-406: what nodeMechanics.ts held — both agent-executor lanes, their binding and the
    // run-history reads — is scanned at its owners.
    ...AGENT_EXECUTOR_FILES,
    'composition/executionMergeRecovery.ts',
    'composition/wrapperMechanics.ts',
    'engine/wrapper/gitStrategy.ts',
    'engine/kernel/isolation.ts',
    'engine/kernel/merge.ts',
    'engine/kernel/nodeRunLedger.ts',
    'engine/node/script/runScriptNode.ts',
    'engine/node/script/runOneScriptAttempt.ts',
    'composition/scriptNodeExecution.ts',
    'engine/node/code-host-call/runCodeHostCallNode.ts',
    'engine/node/input/runInputNode.ts',
    'engine/node/output/runOutputNode.ts',
    'engine/node/review/reviewNodeExecutor.ts',
    'engine/node/clarify/settleIdleClarify.ts',
    'engine/node/clarify-cross-agent/runCrossClarifyNode.ts',
    'engine/node/shared/child-call/runChildCallNode.ts',
    'engine/node/shared/child-call/launchChildCall.ts',
    'application/nodeInputs.ts',
    'application/nodeBranchActivation.ts',
    'composition/codeHostNodeExecution.ts',
    'composition/virtualIoNodeExecution.ts',
    'composition/humanGateNodeExecution.ts',
    'composition/nodeBranchActivation.ts',
    'composition/childCallNodeExecution.ts',
    'composition/executionMechanismBindings.ts',
  ]) {
    const text = taskSource(path)
    expect(text).not.toMatch(
      /\.(?:preSnapshotReposJson|isoBaseSnapshot(?:ReposJson)?|isoNodeTree(?:ReposJson)?|isoSubmodules(?:Repos)?Json)\b/,
    )
    expect(text).not.toMatch(/\.worktreeDirName\b/)
    expect(text).not.toMatch(/repoCount\s*===|repos\.length\s*(?:===\s*1|>\s*1)/)
  }
})

function epochOneCheckpointReads(text: string): boolean {
  return legacyColumns.test(text) || /\.worktreeDirName\b/.test(text)
}

test('scheduler and workspace view, scene and local effects keep the checkpoint boundary', () => {
  for (const path of [
    'modules/task-execution/engine/node/commit-push/runCommitPush.ts',
    'modules/task-execution/engine/task/readonlyInspection.ts',
    'modules/task-execution/composition/commitPushBinding.ts',
    'modules/task-execution/infrastructure/isolationWorkspaceView.ts',
    'modules/task-execution/infrastructure/executionWorkspaceSession.ts',
    'modules/task-execution/composition/executionWorkspaceBinding.ts',
    'modules/task-execution/engine/kernel/isolationCleanup.ts',
    'platform/workspace/local/isolation.ts',
    'platform/workspace/local/isolationReferences.ts',
  ]) {
    expect(epochOneCheckpointReads(source(path)), path).toBe(false)
  }
})

test('negative controls catch epoch-1 columns and directory aliases', () => {
  for (const name of [
    'preSnapshotReposJson',
    'isoBaseSnapshot',
    'isoBaseSnapshotReposJson',
    'isoNodeTree',
    'isoNodeTreeReposJson',
    'isoSubmodulesJson',
    'isoSubmodulesReposJson',
    'worktreeDirName',
  ]) {
    expect(epochOneCheckpointReads(`const checkpoint = run.${name};`), name).toBe(true)
  }
  expect(epochOneCheckpointReads('checkpoint.preSnapshot; checkpoint.mountPath')).toBe(false)
})

// II-a kept these four sites on the HEAD repo-count decision (plan §6.11 item 6). They were fixed afterwards as a
// separate bug fix (6198ae144, plan §6.6 Q5): the guard now locks the mount-layout decision instead.
test('the four single-non-root defect sites decide by mount layout, not by repo count', () => {
  // RFC-404: the two inherited child-workspace sites moved with the call node's launch arms.
  // RFC-405 / RFC-406: nodeMechanics.ts is gone; the agent executor's files replace it here.
  const mechanics = AGENT_EXECUTOR_FILES.map(taskSource).join('\n')
  const launch = taskSource('engine/node/shared/child-call/launchChildCall.ts')
  for (const text of [mechanics, launch]) expect(text.match(/state\.repos\.length > 1/g)).toBeNull()
  expect(launch).toContain('const singleRoot = isSingleRootRepository(parentMounts)')
  expect(launch.match(/const space = inheritedCallSpace\(\{/g)).toHaveLength(2)
  expect(mechanics).not.toContain('inheritedCallSpace(')
  for (const [path, before] of [
    ['services/structuralDiff/callGraph/expandService.ts', 'workspace.repos.length > 1'],
    ['services/worktreeFileContent.ts', 'task.repos.length > 1'],
  ]) {
    const text = source(path!)
    expect(text).not.toContain(before!)
    expect(text).toContain('if (!isSingleRootRepository(mounts)) {')
  }
})
