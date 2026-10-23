// RFC-395 II-a A1: public projection inputs, independent of the future physical table split.
import type { FixtureJson } from './core'

export interface WorkflowFixtureSpec {
  id: string
  name: string
  description?: string
  definition: FixtureJson
  version?: number
  ownerUserId?: string | null
  visibility?: 'private' | 'public'
  aclRevision?: number
  builtin?: boolean
  schemaVersion?: number
  createdAt?: number
  updatedAt?: number
}
