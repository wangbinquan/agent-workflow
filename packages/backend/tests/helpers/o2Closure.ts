// RFC-395 II-b package O2: tests explicitly inject the same owner adapters as bootstrap.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { composeCrossContextClosure } from '@/bootstrap/crossContextClosure'

export const o2Ports = composeCrossContextClosure

export function withO2Closure<T extends { readonly db: PersistenceDb }>(input: T) {
  const ports = o2Ports(input.db)
  return {
    taskLock: ports.taskLock,
    upstreamAgents: ports.upstreamAgents,
    clarifyNav: ports.collaborationReads.clarifyNav,
    archiveCollaboration: ports.collaborationReads.archive,
    ...input,
  }
}
