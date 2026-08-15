import { AdditionalPermissionValidationError } from '@agent-workflow/shared'
import { UserAccessError } from '../public/types'

export function mapPermissionValidationError(error: unknown): never {
  if (error instanceof AdditionalPermissionValidationError) {
    throw new UserAccessError('validation', error.code, error.code, {
      permission: typeof error.permission === 'string' ? error.permission : null,
    })
  }
  throw error
}
