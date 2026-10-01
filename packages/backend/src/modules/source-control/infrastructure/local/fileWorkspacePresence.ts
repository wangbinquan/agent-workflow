import { existsSync } from 'node:fs'
import type { WorkspacePresenceQueries } from '../../application/ports/workspacePresence'

export function createFileWorkspacePresenceQueries(): WorkspacePresenceQueries {
  return Object.freeze({ exists: (workspaceRef: string) => existsSync(workspaceRef) })
}
