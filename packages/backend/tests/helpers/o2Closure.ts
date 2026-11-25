import { testExecutionPermits } from './executionPermits'
import { composeTaskMemorySnapshotPort } from '@/modules/memory/composition'
import { epoch2RuntimeTestPorts } from './epoch2RuntimePorts'
// RFC-395 II-b package O2: tests explicitly inject the same owner adapters as bootstrap.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { composeCrossContextClosure } from '@/bootstrap/crossContextClosure'
import { createFileWorkspacePresenceQueries } from '@/modules/source-control/composition/workspacePresence'
import {
  composePortArtifactOperations,
  createFilePortArtifactContent,
} from '@/modules/task-execution/composition/portArtifacts'
import { Paths } from '@/platform/configuration/installationPaths'
import { neverPruneTerminalWorkspaces } from '@/modules/task-execution/composition'

export const o2Ports = (db: PersistenceDb) =>
  composeCrossContextClosure(
    db,
    testExecutionPermits,
    createFileWorkspacePresenceQueries(),
    neverPruneTerminalWorkspaces,
  )

export function withO2Closure<T extends { readonly db: PersistenceDb }>(input: T) {
  const ports = o2Ports(input.db)
  // RFC-526: the review dispatch's port artifact reader is required; this is the local reader it used to build from the
  // review's own app home when none was given (a case that gives one keeps it — `...input` comes last).
  const appHome = (input as { readonly appHome?: string }).appHome ?? Paths.root
  return {
    ...epoch2RuntimeTestPorts(input.db),
    executionPermits: testExecutionPermits,
    taskRolePolicy: ports.taskRolePolicy,
    humanGateOpen: ports.humanGateOpen,
    taskMembership: ports.taskMembership,
    memorySnapshots: composeTaskMemorySnapshotPort(),
    taskLock: ports.taskLock,
    taskExecutionParticipants: ports.taskExecutionParticipants,
    upstreamAgents: ports.upstreamAgents,
    clarifyNav: ports.collaborationReads.clarifyNav,
    archiveCollaboration: ports.collaborationReads.archive,
    portArtifactReader: composePortArtifactOperations(createFilePortArtifactContent(appHome)),
    ...input,
  }
}
