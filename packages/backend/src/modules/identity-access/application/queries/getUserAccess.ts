import { UserAccessError, type AdminUserAccessView } from '../../public/types'
import { admissionSubjectOf, admitUserDirectoryQuery } from '../accessAdmission'
import { subjectRefOf, trustedContextMetadata, type QueryContext } from '../operationContext'
import type { UserAccessReadRepository } from '../ports/userAccessRepository'
import { materializeUserAccessView } from '../view'

export interface GetUserAccessQuery {
  readonly userId: string
}

export class GetUserAccess {
  constructor(private readonly repository: UserAccessReadRepository) {}

  async execute(
    context: QueryContext,
    query: GetUserAccessQuery,
  ): Promise<AdminUserAccessView | null> {
    await this.admit(context)
    const snapshot = await this.repository.findAccessSnapshot(query.userId)
    return snapshot === null ? null : materializeUserAccessView(snapshot.user, snapshot.grants)
  }

  async list(context: QueryContext): Promise<ReadonlyArray<AdminUserAccessView>> {
    await this.admit(context)
    const snapshots = await this.repository.listAccessSnapshots()
    return snapshots.map(({ user, grants }) => materializeUserAccessView(user, grants))
  }

  private async admit(context: QueryContext): Promise<void> {
    const snapshot = await this.repository.findAccessSnapshot(
      subjectRefOf(context.authority).userId,
    )
    admitUserDirectoryQuery(
      admissionSubjectOf(
        snapshot?.user ?? null,
        snapshot?.grants.map((grant) => grant.permission) ?? [],
      ),
      trustedContextMetadata(context),
    )
  }

  /** Shared admission for public directory queries with a different projection. */
  async authorize(context: QueryContext): Promise<void> {
    await this.admit(context)
  }
}

export function requireUserAccess(view: AdminUserAccessView | null): AdminUserAccessView {
  if (view === null) throw new UserAccessError('not-found', 'user-not-found', 'user not found')
  return view
}
