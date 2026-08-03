// RFC-224 — backend adapter for the shared effective-runtime policy.
//
// The shared package owns the closed policy table and stable failure codes.
// This module only resolves a runtime name and converts the first violation
// into the daemon's normal validation error surface.

import {
  executionPolicyViolations,
  type Agent,
  type ExecutionPolicyViolation,
} from '@agent-workflow/shared'
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
): void {
  const violation = executionPolicyViolations({
    protocol: runtime.protocol,
    model: runtime.model,
  })[0]
  if (violation !== undefined) throwExecutionPolicyViolation(violation)
}

/**
 * RFC-251: plugins and `dependsOn` are supported on the OpenCode path again,
 * so this gate no longer inspects an agent's resource selection — only the
 * runtime it resolves to. The parameter stays agent-shaped because every call
 * site already has the row and the resolution still depends on its `runtime`.
 */
export async function assertAgentExecutionPolicy(
  db: DbClient,
  agent: { id?: string; runtime?: string | null },
  defaultRuntime?: string | null,
): Promise<ResolvedRuntime> {
  const runtime = await resolveAgentRuntime(db, agent.runtime, defaultRuntime)
  assertResolvedExecutionPolicy(runtime)
  return runtime
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
): Promise<ResolvedRuntime[]> {
  return (await resolveAgentIdsExecutionPolicy(db, agentIds, defaultRuntime)).map(
    ({ runtime }) => runtime,
  )
}

export interface ResolvedAgentExecutionPolicy {
  agent: Agent
  runtime: ResolvedRuntime
}

/**
 * Same closed execution-policy gate, retaining the canonical Agent row so
 * containment demand can be derived from the exact permission/MCP surface
 * instead of a runtime-kind guess.
 */
export async function resolveAgentIdsExecutionPolicy(
  db: DbClient,
  agentIds: Iterable<string>,
  defaultRuntime?: string | null,
): Promise<ResolvedAgentExecutionPolicy[]> {
  const { getAgentById } = await import('@/services/agent')
  const ids = [...new Set(agentIds)].filter((id) => id.length > 0).sort()
  const resolved: ResolvedAgentExecutionPolicy[] = []
  for (const id of ids) {
    const agent = await getAgentById(db, id)
    if (agent === null) continue
    resolved.push({
      agent,
      runtime: await assertAgentExecutionPolicy(db, agent, defaultRuntime),
    })
  }
  return resolved
}
