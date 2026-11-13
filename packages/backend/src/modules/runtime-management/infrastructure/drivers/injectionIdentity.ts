// RFC-223 PR-6 — runtime-independent identity guard for the framework-managed
// resources injected into one business run.
//
// OpenCode and Claude Code both address injected agents / managed skills / MCP
// servers by name at their respective CLI boundaries. Internally we keep ids,
// so two distinct rows with the same name must fail before either runtime
// stages files or assembles argv. The three resource kinds have independent
// runtime namespaces; a skill and an agent may legitimately share a name.

export type ManagedInjectionResourceKind = 'agent' | 'managed-skill' | 'mcp'

export interface ManagedInjectionIdentity {
  id: string
  name: string
}

export interface ManagedInjectionMcpIdentity extends ManagedInjectionIdentity {
  enabled: boolean
}

export interface ManagedInjectionNameConflict {
  kind: ManagedInjectionResourceKind
  name: string
  firstId: string
  secondId: string
}

export interface ManagedInjectionIdentitySet {
  agents: readonly ManagedInjectionIdentity[]
  managedSkills: readonly ManagedInjectionIdentity[]
  mcps: readonly ManagedInjectionMcpIdentity[]
}

function firstConflict(
  kind: ManagedInjectionResourceKind,
  rows: readonly ManagedInjectionIdentity[],
): ManagedInjectionNameConflict | null {
  const firstIdByName = new Map<string, string>()
  for (const row of rows) {
    const firstId = firstIdByName.get(row.name)
    if (firstId === undefined) {
      firstIdByName.set(row.name, row.id)
      continue
    }
    // Re-visiting the same canonical row is harmless. Only two distinct ids
    // sharing the external registry key are ambiguous.
    if (firstId === row.id) continue
    return { kind, name: row.name, firstId, secondId: row.id }
  }
  return null
}

export function findManagedInjectionNameConflict(
  identities: ManagedInjectionIdentitySet,
): ManagedInjectionNameConflict | null {
  return (
    firstConflict('agent', identities.agents) ??
    firstConflict('managed-skill', identities.managedSkills) ??
    firstConflict(
      'mcp',
      identities.mcps.filter((mcp) => mcp.enabled),
    )
  )
}

export function formatManagedInjectionNameConflict(conflict: ManagedInjectionNameConflict): string {
  return (
    `duplicate-name-in-closure: ${conflict.kind} name '${conflict.name}' ` +
    `maps to distinct ids '${conflict.firstId}' and '${conflict.secondId}'`
  )
}
