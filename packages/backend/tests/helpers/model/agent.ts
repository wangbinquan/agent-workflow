// Public fixture inputs map to the parent and four ordered target relations.
import type { AgentReferences } from '@agent-workflow/shared'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { replaceAgentReferences } from '@/modules/resource-catalog/infrastructure/agentReferenceWrite'
import { readAgentReferences } from '@/modules/resource-catalog/infrastructure/agentPersistence'
import { createFixtureAdapter, decodeFixture, fixtureJson, type FixtureJson } from './core'
import type { AgentFixtureSpec } from './agent.spec'
export type { AgentFixtureSpec } from './agent.spec'
export type AgentFixtureRow = PersistenceTables['agents']['$inferSelect'] & {
  skills: string
  dependsOn: string
  mcp: string
  plugins: string
}
export function agentFixtureReferences(
  spec: Pick<AgentFixtureSpec, 'skills' | 'dependsOn' | 'mcp' | 'plugins'>,
): AgentReferences {
  const array = (value: FixtureJson | undefined): unknown[] => {
    const parsed: unknown =
      value === undefined ? [] : typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(parsed)) throw new Error('fixture-agent-references-must-be-array')
    return parsed
  }
  const skills = array(spec.skills)
  if (
    skills.some(
      (ref) =>
        !ref ||
        typeof ref !== 'object' ||
        !('kind' in ref) ||
        (ref.kind === 'managed'
          ? !('skillId' in ref) || typeof ref.skillId !== 'string'
          : ref.kind === 'project'
            ? !('name' in ref) || typeof ref.name !== 'string'
            : true),
    )
  )
    throw new Error('fixture-agent-skill-reference-invalid')
  const ids = (value: FixtureJson | undefined) => {
    const values = array(value)
    if (values.some((id) => typeof id !== 'string'))
      throw new Error('fixture-agent-reference-id-invalid')
    return values as string[]
  }
  return {
    skills: skills as AgentReferences['skills'],
    dependsOn: ids(spec.dependsOn),
    mcp: ids(spec.mcp),
    plugins: ids(spec.plugins),
  }
}
const adapter = createFixtureAdapter<
  AgentFixtureSpec,
  PersistenceTables['agents'],
  AgentFixtureRow
>({
  table: (db) => tablesOf(db).agents,
  physicalTable: 'agents',
  keys: ['id'],
  async afterWrite(db, row, spec) {
    await replaceAgentReferences(db, row.id, agentFixtureReferences(spec))
  },
  async afterPatch(db, row, spec) {
    if (!['skills', 'dependsOn', 'mcp', 'plugins'].some((key) => key in spec)) return
    const current = (await readAgentReferences(db, [row.id])).get(row.id)!
    const values = Object.fromEntries(
      Object.entries(spec).filter(([, value]) => value !== undefined),
    )
    await replaceAgentReferences(db, row.id, agentFixtureReferences({ ...current, ...values }))
  },
  async project(db, row) {
    const refs = (await readAgentReferences(db, [row.id])).get(row.id)!
    return {
      ...decodeFixture('agents', row),
      ...Object.fromEntries(Object.entries(refs).map(([key, value]) => [key, fixtureJson(value)])),
    } as AgentFixtureRow
  },
})
export const agentFixture = adapter.insert
export const patchAgentFixture = adapter.patch
export const readAgentFixtures = adapter.read
