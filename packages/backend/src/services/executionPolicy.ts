// RFC-224 — backend adapter for the shared effective-runtime policy.
//
// The shared package owns the closed policy table and stable failure codes.
// This module only resolves a runtime name and converts the first violation
// into the daemon's normal validation error surface.

import { executionPolicyViolations, type ExecutionPolicyViolation } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { ValidationError } from '@/util/errors'
import { resolveAgentRuntime, type ResolvedRuntime } from '@/services/runtimeRegistry'

export function throwExecutionPolicyViolation(violation: ExecutionPolicyViolation): never {
  throw new ValidationError(violation.code, violation.code, {
    field: violation.field,
    permanent: true,
  })
}

export function assertResolvedExecutionPolicy(
  runtime: Pick<ResolvedRuntime, 'protocol' | 'model'>,
  resources: { enabledPluginCount?: number; dependentAgentCount?: number } = {},
): void {
  const violation = executionPolicyViolations({
    protocol: runtime.protocol,
    model: runtime.model,
    ...resources,
  })[0]
  if (violation !== undefined) throwExecutionPolicyViolation(violation)
}

export async function assertAgentExecutionPolicy(
  db: DbClient,
  agent: {
    id?: string
    runtime?: string | null
    plugins: readonly string[]
    dependsOn: readonly string[]
  },
  defaultRuntime?: string | null,
): Promise<void> {
  const runtime = await resolveAgentRuntime(db, agent.runtime, defaultRuntime)
  assertResolvedExecutionPolicy(runtime, {
    enabledPluginCount: agent.plugins.length,
    dependentAgentCount: agent.dependsOn.length,
  })
}

/**
 * RFC-224 product-boundary adapter for workflow/workgroup closures.
 *
 * Canonical ids are the only accepted identity. Missing ids are deliberately
 * left to the caller's existing reference/readiness gate so this helper cannot
 * turn an ACL-safe 404 or a detailed workflow validation error into a different
 * surface; every row that does resolve must pass the same effective-runtime
 * policy as a direct single-agent launch.
 *
 * The dynamic import avoids a module-initialization cycle: agent.ts itself
 * imports this module for create/update save gates.
 */
export async function assertAgentIdsExecutionPolicy(
  db: DbClient,
  agentIds: Iterable<string>,
  defaultRuntime?: string | null,
): Promise<void> {
  const { getAgentById } = await import('@/services/agent')
  const ids = [...new Set(agentIds)].filter((id) => id.length > 0).sort()
  for (const id of ids) {
    const agent = await getAgentById(db, id)
    if (agent === null) continue
    await assertAgentExecutionPolicy(db, agent, defaultRuntime)
  }
}
