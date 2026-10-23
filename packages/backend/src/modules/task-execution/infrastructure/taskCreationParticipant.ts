import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { TaskCreationParticipantInTx } from '../application/ports/taskCreation'
import { deriveTaskCreationLineage } from '../domain/taskCreation'
import { definitionAnchorId } from '../domain/taskSubject'
import { taskRepositoryCount } from '../domain/taskRepository'
import { writeTaskWorkspaceDirectoriesInTx } from './taskWorkspaceDirectoryParticipant'
import { taskRepositoryMountColumns } from './taskRepositoryCodec'

/** Caller owns the transaction; root, child and fusion share this one task writer. */
export function createTaskCreationParticipantInTx(tx: PersistenceDb): TaskCreationParticipantInTx {
  return {
    async create(input) {
      const { tasks, taskRepos } = tablesOf(tx)
      const lineage = deriveTaskCreationLineage(
        input.core.id,
        input.definition.workflowVersion,
        input.launch,
      )
      await insertOne(tx, tasks, {
        ...input.core,
        ...input.definition,
        ...input.launchContext,
        ...input.workspace,
        workflowId: definitionAnchorId(input.subject),
        workgroupId: input.subject.kind === 'workgroup' ? input.subject.sourceId : null,
        sourceAgentId: input.subject.kind === 'agent' ? input.subject.sourceId : null,
        sourceAgentName: input.subject.kind === 'agent' ? input.subject.sourceName : null,
        codeRoundId: input.subject.kind === 'code-round' ? input.subject.sourceId : null,
        repoCount: taskRepositoryCount(input.repos),
        rootTaskId: lineage.rootTaskId,
        executionLineageId: lineage.executionLineageId,
        lineageSlotPathJson: lineage.lineageSlotPathJson,
        launchOrigin: lineage.launchOrigin,
      })
      if (input.repos.length > 0)
        await tx.insert(taskRepos).values(
          input.repos.map((repo) => ({
            taskId: input.core.id,
            ...taskRepositoryMountColumns(repo),
          })),
        )
      await writeTaskWorkspaceDirectoriesInTx(
        tx,
        input.core.id,
        input.repos.map((repo) => repo.mountPath),
        input.nodePaths,
      )
      return lineage
    },
  }
}
