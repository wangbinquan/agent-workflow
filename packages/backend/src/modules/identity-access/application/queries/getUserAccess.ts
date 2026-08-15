import { UserAccessError, type AdminUserAccessView } from '../../public/types'
import { admissionSubjectOf, admitUserDirectoryAccess } from '../accessAdmission'
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
    const user = await this.repository.findUser(query.userId)
    if (user === null) return null
    const grants = await this.repository.listGrants([user.id])
    return materializeUserAccessView(user, grants)
  }

  async list(context: QueryContext): Promise<ReadonlyArray<AdminUserAccessView>> {
    await this.admit(context)
    const users = await this.repository.listUsers()
    const grants = await this.repository.listGrants(users.map((user) => user.id))
    const grantsByUser = new Map<string, typeof grants>()
    for (const grant of grants) {
      const current = grantsByUser.get(grant.userId) ?? []
      grantsByUser.set(grant.userId, [...current, grant])
    }
    return users.map((user) => materializeUserAccessView(user, grantsByUser.get(user.id) ?? []))
  }

  private async admit(context: QueryContext): Promise<void> {
    const actor = await this.repository.findUser(subjectRefOf(context.authority).userId)
    const grants = actor === null ? [] : await this.repository.listGrants([actor.id])
    admitUserDirectoryAccess(
      admissionSubjectOf(
        actor,
        grants.map((grant) => grant.permission),
      ),
      trustedContextMetadata(context),
    )
  }
}

export function requireUserAccess(view: AdminUserAccessView | null): AdminUserAccessView {
  if (view === null) throw new UserAccessError('not-found', 'user-not-found', 'user not found')
  return view
}
