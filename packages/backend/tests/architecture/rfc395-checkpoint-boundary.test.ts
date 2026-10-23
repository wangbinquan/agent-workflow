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

test('isolation, replay and wrapper mechanics do not inspect scalar/map columns or directory aliases', () => {
  for (const path of [
    'composition/nodeMechanics.ts',
    'composition/executionMergeRecovery.ts',
    'composition/wrapperMechanics.ts',
    'engine/wrapper/gitStrategy.ts',
    'infrastructure/isolatedAgentRun.ts',
  ]) {
    const text = taskSource(path)
    expect(text).not.toMatch(
      /\.(?:preSnapshotReposJson|isoBaseSnapshot(?:ReposJson)?|isoNodeTree(?:ReposJson)?|isoSubmodules(?:Repos)?Json)\b/,
    )
    expect(text).not.toMatch(/\.worktreeDirName\b/)
    // C1: the two inherited child-workspace sites retain HEAD's count decision.
    const layoutDecisions =
      path === 'composition/nodeMechanics.ts' ? text.replaceAll('state.repos.length > 1', '') : text
    expect(layoutDecisions).not.toMatch(/repoCount\s*===|repos\.length\s*(?:===\s*1|>\s*1)/)
  }
})

function epochOneCheckpointReads(text: string): boolean {
  return legacyColumns.test(text) || /\.worktreeDirName\b/.test(text)
}

test('scheduler and workspace view, scene and local effects keep the checkpoint boundary', () => {
  for (const path of [
    'services/scheduler.ts',
    'modules/task-execution/infrastructure/isolationWorkspaceView.ts',
    'modules/task-execution/composition/isolationWorkspaceScene.ts',
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

test('the four deferred single-non-root defect sites retain the HEAD count decisions', () => {
  const mechanics = taskSource('composition/nodeMechanics.ts')
  expect(mechanics.match(/state\.repos\.length > 1/g)).toHaveLength(4)
  for (const [path, count] of [
    ['services/structuralDiff/callGraph/expandService.ts', 'workspace.repos.length > 1'],
    ['services/worktreeFileContent.ts', 'task.repos.length > 1'],
  ]) {
    const text = source(path!)
    expect(text).toContain(count!)
    expect(text).not.toContain('isSingleRootRepository')
  }
})
