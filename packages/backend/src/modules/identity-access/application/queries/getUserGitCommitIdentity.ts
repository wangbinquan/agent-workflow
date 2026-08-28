import type { GitCommitIdentity } from '@agent-workflow/shared'
import { UserAccessError } from '../../public/types'
import type { UserAccessReadRepository } from '../ports/userAccessRepository'

/** RFC-320 — purpose-specific task admission query. */
export class GetUserGitCommitIdentity {
  constructor(
    private readonly repository: UserAccessReadRepository,
    private readonly systemUserId: string,
  ) {}

  async execute(userId: string): Promise<GitCommitIdentity> {
    if (userId === this.systemUserId) {
      throw new UserAccessError(
        'forbidden',
        'git-identity-system-owner',
        'system-owned tasks do not use a human Git commit identity',
      )
    }
    const snapshot = await this.repository.findAccessSnapshot(userId)
    if (snapshot === null) {
      throw new UserAccessError('not-found', 'user-not-found', 'task creator was not found')
    }
    if (snapshot.user.status !== 'active') {
      throw new UserAccessError(
        'forbidden',
        'git-identity-owner-inactive',
        'task creator is not active',
      )
    }
    if (snapshot.user.email === null) {
      throw new UserAccessError(
        'validation',
        'git-identity-email-missing',
        'configure an account email before creating a task',
      )
    }
    if (snapshot.user.gitName.trim().length === 0) {
      throw new UserAccessError(
        'validation',
        'git-identity-name-missing',
        'configure a Git name before creating a task',
      )
    }
    return { name: snapshot.user.gitName, email: snapshot.user.email }
  }
}
