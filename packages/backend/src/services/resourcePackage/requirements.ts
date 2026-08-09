// RFC-271 package prerequisites.
//
// The manifest is advisory UI, but the bundle is the machine contract. Derive the
// prerequisite projection from that contract on both export and import so a hand-edited
// manifest cannot hide a missing runtime/executable (or invent a scary prerequisite).

import type { ResourceBundle } from '@agent-workflow/shared'

export interface PackageRequirements {
  runtimes: string[]
  codeHosts: string[]
  executables: string[]
  pluginSources: Array<{ name: string; spec: string; sourceKind: string }>
  projectSkills: string[]
  mcpKinds: string[]
  humanMembers: string[]
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/** Stable, secret-safe prerequisite projection of a validated bundle. */
export function collectPackageRequirements(bundle: ResourceBundle): PackageRequirements {
  const runtimes = new Set<string>()
  const codeHosts = new Set<string>()
  const executables = new Set<string>()
  const pluginSources: PackageRequirements['pluginSources'] = []
  const projectSkills = new Set<string>()
  const mcpKinds = new Set<string>()
  const humanMembers = new Set<string>()

  for (const op of bundle.ops) {
    const payload = op.payload as Record<string, unknown>
    if (op.kind === 'agent-create' || op.kind === 'agent-update') {
      if (typeof payload.runtime === 'string' && payload.runtime.length > 0) {
        runtimes.add(payload.runtime)
      }
      for (const ref of Array.isArray(payload.skills) ? payload.skills : []) {
        if (typeof ref === 'string' && ref.startsWith('project:') && ref.length > 8) {
          projectSkills.add(ref.slice(8))
        }
      }
      continue
    }

    if (op.kind === 'workflow-create' || op.kind === 'workflow-update') {
      const definition = asRecord(payload.definition)
      for (const raw of Array.isArray(definition?.nodes) ? definition.nodes : []) {
        const node = asRecord(raw)
        if (
          node?.kind === 'code-host-call' &&
          typeof node.provider === 'string' &&
          node.provider.length > 0
        ) {
          codeHosts.add(node.provider)
        }
      }
      continue
    }

    if (op.kind === 'mcp-create' || op.kind === 'mcp-update') {
      if (typeof payload.type === 'string') mcpKinds.add(payload.type)
      if (payload.type === 'local') {
        const config = asRecord(payload.config)
        const command = Array.isArray(config?.command) ? config.command : []
        if (typeof command[0] === 'string' && command[0].length > 0) {
          executables.add(command[0])
        }
      }
      continue
    }

    if (op.kind === 'plugin-create' || op.kind === 'plugin-update') {
      pluginSources.push({
        name: String(payload.name ?? ''),
        spec: String(payload.spec ?? ''),
        sourceKind: String(payload.sourceKind ?? 'npm'),
      })
      continue
    }

    if (op.kind === 'workgroup-create' || op.kind === 'workgroup-update') {
      for (const raw of Array.isArray(payload.members) ? payload.members : []) {
        const member = asRecord(raw)
        if (
          member?.memberType === 'human' &&
          typeof member.username === 'string' &&
          member.username.length > 0
        ) {
          humanMembers.add(member.username)
        }
      }
    }
  }

  return {
    runtimes: [...runtimes].sort(),
    codeHosts: [...codeHosts].sort(),
    executables: [...executables].sort(),
    pluginSources: pluginSources.sort((a, b) =>
      a.name === b.name
        ? a.sourceKind === b.sourceKind
          ? a.spec.localeCompare(b.spec)
          : a.sourceKind.localeCompare(b.sourceKind)
        : a.name.localeCompare(b.name),
    ),
    projectSkills: [...projectSkills].sort(),
    mcpKinds: [...mcpKinds].sort(),
    humanMembers: [...humanMembers].sort(),
  }
}
