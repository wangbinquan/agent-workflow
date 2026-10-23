// RFC-395 II-a A1: public projection inputs, independent of the future physical table split.
import type { FixtureJson } from './core'

export interface AgentFixtureSpec {
  id: string
  name: string
  description?: string
  outputs?: FixtureJson
  inputs?: FixtureJson
  syncOutputsOnIterate?: boolean
  runtime?: string | null
  permission?: FixtureJson
  skills?: FixtureJson
  dependsOn?: FixtureJson
  mcp?: FixtureJson
  plugins?: FixtureJson
  frontmatterExtra?: FixtureJson
  bodyMd?: string
  ownerUserId?: string | null
  visibility?: 'private' | 'public'
  aclRevision?: number
  builtin?: boolean
  schemaVersion?: number
  createdAt?: number
  updatedAt?: number
}
