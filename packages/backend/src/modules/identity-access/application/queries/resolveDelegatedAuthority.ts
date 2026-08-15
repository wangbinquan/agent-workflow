import { createDelegatedAuthorityRef } from '../operationContext'
import type {
  AuthorizationSubjectRef,
  DelegatedAuthorityRef,
  DelegatedAuthorityResolver,
  DelegatedSource,
  CurrentSubjectAccessResolver,
} from '../../public/participants'
import { UserAccessError } from '../../public/types'

export class ResolveDelegatedAuthority implements DelegatedAuthorityResolver {
  constructor(private readonly currentSubjects: CurrentSubjectAccessResolver) {}

  async resolve(
    source: DelegatedSource,
    subject: AuthorizationSubjectRef,
  ): Promise<DelegatedAuthorityRef> {
    const current = await this.currentSubjects.resolveCurrentSubject(subject.userId)
    if (current === null) {
      throw new UserAccessError(
        'forbidden',
        'delegated-subject-inactive',
        'delegated subject is missing or inactive',
      )
    }
    return createDelegatedAuthorityRef(current.userId, current.accessRevision, source)
  }
}
