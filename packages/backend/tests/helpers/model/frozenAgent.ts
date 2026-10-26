// Explicit source conversion fixtures; malformed epoch-1 JSON never enters a target parent row.
import {
  decodeAgentReferenceIds,
  decodeAgentSkillReferences,
} from '@/modules/resource-catalog/infrastructure/agentReferenceCodec'
import { agentFixture } from './agent'
import { fixtureJson, type FixtureHandle, type FixtureOptions } from './core'
import type { AgentFixtureSpec } from './agent.spec'
export async function convertedAgentFixture(
  db: FixtureHandle,
  input: AgentFixtureSpec | readonly AgentFixtureSpec[],
  options: FixtureOptions = {},
) {
  const rows = Array.isArray(input) ? input : [input as AgentFixtureSpec]
  return agentFixture(
    db,
    rows.map((row) => ({
      ...row,
      skills: decodeAgentSkillReferences(fixtureJson(row.skills ?? '[]') ?? 'null'),
      dependsOn: decodeAgentReferenceIds(fixtureJson(row.dependsOn ?? '[]') ?? 'null'),
      mcp: decodeAgentReferenceIds(fixtureJson(row.mcp ?? '[]') ?? 'null'),
      plugins: decodeAgentReferenceIds(fixtureJson(row.plugins ?? '[]') ?? 'null'),
    })),
    options,
  )
}
