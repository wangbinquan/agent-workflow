import type { GitCommitIdentity, UserPrivateProfile } from '@agent-workflow/shared'
import type { UserAccessReadRepository } from '../ports/userAccessRepository'

/** RFC-320 — private profile projection. It deliberately omits role/grants and
 * password state; callers asking for commit identity cannot accidentally grow
 * into an account-directory dependency. */
export class GetUserProfile {
  constructor(private readonly repository: UserAccessReadRepository) {}

  async execute(userId: string): Promise<UserPrivateProfile | null> {
    const snapshot = await this.repository.findAccessSnapshot(userId)
    if (snapshot === null) return null
    const { displayName, gitName, email } = snapshot.user
    const gitCommitIdentity: GitCommitIdentity | null =
      email === null ? null : { name: gitName, email }
    return { displayName, gitName, email, gitCommitIdentity }
  }
}
