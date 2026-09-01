import type { DbClient } from '@/db/client'
import type { DirectCommandContextFactory } from '@/modules/identity-access/public/participants'
import type {
  MemoryCatalogCommands,
  MemoryCatalogOperations,
  MemoryCatalogQueries,
  MemoryScopeAuthority,
  MemoryScopeRef,
} from '../public/catalog'
import {
  annotateMemoryManageRights,
  archiveMemory,
  canManageMemory,
  canViewMemory,
  createManualCandidate,
  deleteMemory,
  filterMemoriesByScopeVisibility,
  getMemoryById,
  listMemories,
  moveMemory,
  patchMemory,
  promoteCandidate,
  unarchiveMemory,
  type MemoryResourceScopeAuthorization,
} from './sqliteMemoryCatalog'

export function composeSqliteMemoryCatalogOperations(input: {
  readonly db: DbClient
  readonly contexts: DirectCommandContextFactory
  readonly authorization: MemoryResourceScopeAuthorization
}): MemoryCatalogOperations {
  const authority = (value: Parameters<MemoryCatalogOperations['queries']['canView']>[0]) => ({
    ...value,
    authorization: input.authorization,
  })
  const queries: MemoryCatalogQueries = {
    list: (filter = {}) => listMemories(input.db, filter),
    listWithBody: (filter = {}) => listMemories(input.db, filter, { includeBody: true }),
    getById: (id) => getMemoryById(input.db, id),
    canView: (scopeAuthority, scope) => canViewMemory(input.db, authority(scopeAuthority), scope),
    canManage: (scopeAuthority, scope) =>
      canManageMemory(input.db, authority(scopeAuthority), scope),
    filterVisible: <T extends MemoryScopeRef>(
      scopeAuthority: MemoryScopeAuthority,
      rows: readonly T[],
    ) => filterMemoriesByScopeVisibility(input.db, authority(scopeAuthority), rows),
    annotateManageRights: <T extends MemoryScopeRef>(
      scopeAuthority: MemoryScopeAuthority,
      rows: readonly T[],
    ) => annotateMemoryManageRights(input.db, authority(scopeAuthority), rows),
  }
  const commands: MemoryCatalogCommands = {
    createManual: (command) => createManualCandidate(input.db, command),
    promote: (id, command, administratorUserId) =>
      promoteCandidate(input.db, id, command, administratorUserId),
    patch: (id, command, editorUserId) => patchMemory(input.db, id, command, editorUserId),
    move: async (context, id, command) =>
      moveMemory(input.db, input.contexts, context, input.authorization, id, command),
    archive: (id) => archiveMemory(input.db, id),
    unarchive: (id) => unarchiveMemory(input.db, id),
    delete: (id) => deleteMemory(input.db, id),
  }
  return Object.freeze({ queries: Object.freeze(queries), commands: Object.freeze(commands) })
}
