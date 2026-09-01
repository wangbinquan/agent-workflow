// RFC-349 — isolated SQLite compatibility composition.  Keeping this lazy
// facade outside the production composition root prevents the legacy adapter's
// test-only callback into createIdentityAccessRuntime from closing a runtime
// import cycle.

import type { LegacySqliteUserService } from '../infrastructure/legacySqliteUserService'

const loadLegacySqliteUserService = () => import('../infrastructure/legacySqliteUserService')

export const legacySqliteUserService: LegacySqliteUserService = Object.freeze({
  countNonSystemUsers: async (
    ...args: Parameters<LegacySqliteUserService['countNonSystemUsers']>
  ) => (await loadLegacySqliteUserService()).countNonSystemUsers(...args),
  createUser: async (...args: Parameters<LegacySqliteUserService['createUser']>) =>
    (await loadLegacySqliteUserService()).createUser(...args),
  disableUser: async (...args: Parameters<LegacySqliteUserService['disableUser']>) =>
    (await loadLegacySqliteUserService()).disableUser(...args),
  enableUser: async (...args: Parameters<LegacySqliteUserService['enableUser']>) =>
    (await loadLegacySqliteUserService()).enableUser(...args),
  findById: async (...args: Parameters<LegacySqliteUserService['findById']>) =>
    (await loadLegacySqliteUserService()).findById(...args),
  findByUsername: async (...args: Parameters<LegacySqliteUserService['findByUsername']>) =>
    (await loadLegacySqliteUserService()).findByUsername(...args),
  getUserGitCommitIdentity: async (
    ...args: Parameters<LegacySqliteUserService['getUserGitCommitIdentity']>
  ) => (await loadLegacySqliteUserService()).getUserGitCommitIdentity(...args),
  listAllUsers: async (...args: Parameters<LegacySqliteUserService['listAllUsers']>) =>
    (await loadLegacySqliteUserService()).listAllUsers(...args),
  lookupUsersPublic: async (...args: Parameters<LegacySqliteUserService['lookupUsersPublic']>) =>
    (await loadLegacySqliteUserService()).lookupUsersPublic(...args),
  patchUser: async (...args: Parameters<LegacySqliteUserService['patchUser']>) =>
    (await loadLegacySqliteUserService()).patchUser(...args),
  resetPassword: async (...args: Parameters<LegacySqliteUserService['resetPassword']>) =>
    (await loadLegacySqliteUserService()).resetPassword(...args),
  searchUsersPublic: async (...args: Parameters<LegacySqliteUserService['searchUsersPublic']>) =>
    (await loadLegacySqliteUserService()).searchUsersPublic(...args),
})
