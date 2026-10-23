// RFC-395 II-a A1: public projection inputs, independent of the future physical table split.
import type { FixtureJson } from './core'

export interface NodeRunOutputFixtureSpec {
  nodeRunId: string
  portName: string
  content: string
  kind?: string | null
  archiveJson?: FixtureJson
  active?: boolean
}
