// RFC-395 II-a A1: Agent fixtures keep public projection names while storage changes in II-b.
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { createFixtureAdapter, decodeFixture } from './core'
import type { AgentFixtureSpec } from './agent.spec'
export type { AgentFixtureSpec } from './agent.spec'
export type AgentFixtureRow = PersistenceTables['agents']['$inferSelect']
const adapter = createFixtureAdapter<
  AgentFixtureSpec,
  PersistenceTables['agents'],
  AgentFixtureRow
>({
  table: (db) => tablesOf(db).agents,
  physicalTable: 'agents',
  keys: ['id'],
  project: async (_db, row) => decodeFixture('agents', row) as AgentFixtureRow,
})
export const agentFixture = adapter.insert
export const patchAgentFixture = adapter.patch
export const readAgentFixtures = adapter.read
