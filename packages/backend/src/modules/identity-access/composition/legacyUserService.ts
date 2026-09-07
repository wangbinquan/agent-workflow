// RFC-349/RFC-359 — shared compatibility composition. Keeping this lazy
// facade outside the production composition root prevents the legacy adapter's
// test-only callback into createIdentityAccessRuntime from closing a runtime
// import cycle.

import type { LegacyUserService } from '../infrastructure/legacyUserService'

const loadLegacyUserService = () => import('../infrastructure/legacyUserService')

export const legacyUserService: LegacyUserService = Object.freeze({
  countNonSystemUsers: async (...args: Parameters<LegacyUserService['countNonSystemUsers']>) =>
    (await loadLegacyUserService()).countNonSystemUsers(...args),
  createUser: async (...args: Parameters<LegacyUserService['createUser']>) =>
    (await loadLegacyUserService()).createUser(...args),
  disableUser: async (...args: Parameters<LegacyUserService['disableUser']>) =>
    (await loadLegacyUserService()).disableUser(...args),
  enableUser: async (...args: Parameters<LegacyUserService['enableUser']>) =>
    (await loadLegacyUserService()).enableUser(...args),
  findById: async (...args: Parameters<LegacyUserService['findById']>) =>
    (await loadLegacyUserService()).findById(...args),
  findByUsername: async (...args: Parameters<LegacyUserService['findByUsername']>) =>
    (await loadLegacyUserService()).findByUsername(...args),
  getUserGitCommitIdentity: async (
    ...args: Parameters<LegacyUserService['getUserGitCommitIdentity']>
  ) => (await loadLegacyUserService()).getUserGitCommitIdentity(...args),
  listAllUsers: async (...args: Parameters<LegacyUserService['listAllUsers']>) =>
    (await loadLegacyUserService()).listAllUsers(...args),
  lookupUsersPublic: async (...args: Parameters<LegacyUserService['lookupUsersPublic']>) =>
    (await loadLegacyUserService()).lookupUsersPublic(...args),
  patchUser: async (...args: Parameters<LegacyUserService['patchUser']>) =>
    (await loadLegacyUserService()).patchUser(...args),
  resetPassword: async (...args: Parameters<LegacyUserService['resetPassword']>) =>
    (await loadLegacyUserService()).resetPassword(...args),
  searchUsersPublic: async (...args: Parameters<LegacyUserService['searchUsersPublic']>) =>
    (await loadLegacyUserService()).searchUsersPublic(...args),
})
