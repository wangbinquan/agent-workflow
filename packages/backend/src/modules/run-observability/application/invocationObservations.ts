import type { AcceptedObservationInvocation } from '@agent-workflow/shared'
import { ObservationInvocationError } from '../domain/invocationError'
import { PlatformSyncError } from '../domain/platformSync'
import type { InvocationObservationQuery } from '../ports/invocationObservations'
import type { ObservationInvocationStore } from '../ports/invocations'
import type { PlatformObservationStore } from '../ports/platformObservationStore'
import type { UsageLedgerStore } from '../ports/usageLedger'

function cursorScope(invocation: AcceptedObservationInvocation) {
  return JSON.stringify([invocation.invocationId, invocation.authority])
}
function continuation(after: string | undefined, scope: string): string | undefined {
  if (after === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(after)
  } catch {
    throw new PlatformSyncError('page-conflict', 'Invalid invocation observation cursor')
  }
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value[0] !== 1 ||
    value[1] !== scope ||
    typeof value[2] !== 'string' ||
    value[2].length === 0
  )
    throw new PlatformSyncError('page-conflict', 'Invocation observation cursor changed scope')
  return value[2]
}

/** Frozen acceptance is the only routing authority. An offline platform never selects local data. */
export function createInvocationObservationQuery(input: {
  readonly invocations: Pick<ObservationInvocationStore, 'get'>
  readonly local: Pick<UsageLedgerStore, 'records'>
  readonly platform: Pick<PlatformObservationStore, 'records'>
}): InvocationObservationQuery {
  return {
    async read(request) {
      if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 500)
        throw new RangeError('Invocation observation page limit must be 1 through 500')
      const invocation = await input.invocations.get(request.invocationId)
      if (!invocation)
        throw new ObservationInvocationError('invocation-not-found', 'Invocation was not accepted')
      const scope = cursorScope(invocation),
        after = continuation(request.after, scope),
        page = { limit: request.limit, ...(after === undefined ? {} : { after }) }
      const next = (cursor: string | undefined) =>
        cursor === undefined ? {} : { nextCursor: JSON.stringify([1, scope, cursor]) }
      const authority = invocation.authority
      if (authority.kind === 'local') {
        const result = await input.local.records(invocation.taskId, page)
        return {
          authority: 'local',
          invocation,
          consistency: 'live-page',
          scanned: result.items.length,
          items: result.items.filter(
            ({ measurement: m }) =>
              m.invocationId === invocation.invocationId &&
              m.taskId === invocation.taskId &&
              m.nodeRunId === invocation.nodeRunId &&
              m.agentId === invocation.agentId,
          ),
          ...next(result.nextCursor),
        }
      }
      if (authority.sourceId === null) {
        if (after !== undefined)
          throw new PlatformSyncError('page-conflict', 'Unbound invocation has no continuation')
        return {
          authority: 'crewstation',
          invocation,
          items: [],
          scanned: 0,
          consistency: 'platform-revision',
          source: 'legacy-unbound',
          state: null,
        }
      }
      const result = await input.platform.records(
        {
          sourceId: authority.sourceId,
          projectId: authority.projectId,
          taskId: authority.taskId,
        },
        page,
      )
      return {
        authority: 'crewstation',
        invocation,
        consistency: 'platform-revision',
        source: 'bound',
        state: result.state,
        scanned: result.items.length,
        items: result.items.filter(
          ({ identity: i }) =>
            i.projectId === authority.projectId &&
            i.taskId === authority.taskId &&
            i.subtaskId === authority.subtaskId &&
            i.executionId === authority.executionResourceId &&
            i.executionGeneration === authority.executionGeneration,
        ),
        ...next(result.nextCursor),
      }
    },
  }
}
