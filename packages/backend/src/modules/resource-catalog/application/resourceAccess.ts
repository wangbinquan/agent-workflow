import type { ResourceAccess } from '@agent-workflow/shared'
import { isResourceNameSubmissionAllowed } from '../domain/resourceAccess'
import { ForbiddenError } from '@/util/errors'

/** Application error mapping for the domain's owner-only rename rule. */
export function assertNameUnchangedForEditor(
  access: ResourceAccess,
  currentName: string,
  submittedName: string | null | undefined,
): void {
  if (isResourceNameSubmissionAllowed(access, currentName, submittedName)) return
  throw new ForbiddenError(
    'resource-rename-owner-only',
    'only the resource owner can rename it; an edit grant covers content only',
  )
}
