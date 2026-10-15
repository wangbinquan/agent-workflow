// RFC-370 v2 §3.2 / §5.2 — the CrewStation execution lease (Manifest
// `tasks.executionControl: fenced`).
//
// The protocol is the platform's own (CrewStation templates/business-execution-v3
// src/control.ts): every tick reads the control record; a migration freezes the
// instance and reports it ready; otherwise the instance claims a preparing
// lease, renews it, records `preparing` in the application database (the
// application barrier — older holders' transactions now fail), reports a
// pending handoff ready, activates, and records `active`. Once active it renews
// every `renewMs`; a rejected renewal, a freeze, or failures past the recorded
// expiry mean the lease is lost. The instance never returns to active: it
// reports the loss once and the daemon exits through its graceful shutdown
// (crash-only, §3.2); the platform restarts it as a standby.
import { createHash } from 'node:crypto'
import {
  isCrewStationApiError,
  type CrewStationPlatformApi,
} from '@/platform/crewstation/platformApi'
import type { Logger } from '@/util/log'
import type {
  ExecutionAuthorityPort,
  ExecutionAuthorityState,
  ExecutionFence,
} from '../../application/ports/executionAuthority'
import type { HostedExecutionControlStore } from '../../application/ports/hostedExecutionControl'
import { encodeHostedFenceToken } from '../hostedExecutionControl'

const CONTROL_ROOT = '/v3/business-execution/control'

interface ControlRecord {
  readonly epoch: number
  readonly phase: 'inactive' | 'frozen' | 'preparing' | 'active'
  readonly leaseOwner: string | null
  readonly leaseExpiresAt: string | null
  readonly leaseId?: string
  readonly operationId?: string
  readonly migration?: { readonly operationId: string }
}

/** Standby reasons the status route and the frontend report. */
export const CREWSTATION_STANDBY_REASONS = {
  claiming: 'execution-lease-pending',
  busy: 'execution-lease-held-elsewhere',
  notActiveRelease: 'not-the-active-release',
  frozen: 'execution-frozen-by-platform',
  unreachable: 'platform-unreachable',
  rejected: 'execution-lease-rejected',
} as const

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }
  return value
}

export function preparationDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}

function standbyReasonOf(error: unknown): string {
  if (!isCrewStationApiError(error)) return CREWSTATION_STANDBY_REASONS.unreachable
  if (error.code === 'execution_lease_busy') return CREWSTATION_STANDBY_REASONS.busy
  if (error.status === 403) return CREWSTATION_STANDBY_REASONS.notActiveRelease
  if (error.status >= 500) return CREWSTATION_STANDBY_REASONS.unreachable
  return CREWSTATION_STANDBY_REASONS.rejected
}

export interface CrewStationExecutionAuthority extends ExecutionAuthorityPort {
  /** Start competing for the lease; idempotent. */
  start(): void
  readonly instanceId: string
}

export function createCrewStationExecutionAuthority(input: {
  readonly platform: CrewStationPlatformApi
  readonly control: HostedExecutionControlStore
  /** Contract versions this release can take over (Manifest `acceptedTaskContractVersions`). */
  readonly acceptedTaskContractVersions: readonly string[]
  readonly log: Logger
  readonly instanceId?: string
  readonly tickMs?: number
  readonly renewMs?: number
  readonly now?: () => number
}): CrewStationExecutionAuthority {
  const instanceId = input.instanceId ?? Bun.randomUUIDv7()
  const tickMs = input.tickMs ?? 5_000
  const renewMs = input.renewMs ?? 10_000
  const now = input.now ?? Date.now
  const log = input.log
  let state: ExecutionAuthorityState = {
    kind: 'standby',
    reason: CREWSTATION_STANDBY_REASONS.claiming,
  }
  let held:
    | { readonly epoch: number; readonly leaseId: string; readonly expiresAt: number }
    | undefined
  let resolveActive!: (fence: ExecutionFence) => void
  const active = new Promise<ExecutionFence>((resolve) => {
    resolveActive = resolve
  })
  const lostListeners = new Set<(state: ExecutionAuthorityState) => void>()
  let lost = false
  let started = false
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let lastRenewedAt = 0

  const lose = (next: ExecutionAuthorityState): void => {
    state = next
    held = undefined
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    if (lost) return
    lost = true
    log.warn('crewstation execution lease lost', {
      reason: next.kind === 'active' ? null : next.reason,
    })
    for (const listener of [...lostListeners]) {
      try {
        listener(next)
      } catch (error) {
        log.error('execution authority loss listener failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  const armExpiry = (expiresAt: number): void => {
    if (!Number.isFinite(expiresAt) || expiresAt <= now())
      throw new Error('platform execution lease is already expired')
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    // A slow/retrying HTTP call must not keep a locally active lease alive
    // past its deadline. This timer is independent of the renewal request.
    expiryTimer = setTimeout(
      () => {
        if (!closed && held !== undefined && now() >= held.expiresAt) {
          lose({ kind: 'standby', reason: CREWSTATION_STANDBY_REASONS.unreachable })
        }
      },
      Math.max(1, expiresAt - now()),
    )
  }

  const acquire = async (): Promise<void> => {
    let control = await input.platform.get<ControlRecord>(CONTROL_ROOT)
    const migration = control.migration
    if (migration !== undefined) {
      await input.control.write({
        epoch: control.epoch,
        owner: null,
        phase: 'frozen',
        leaseId: null,
        expiresAt: null,
      })
      await input.platform.post(`${CONTROL_ROOT}/migrations/${migration.operationId}/ready`, {
        operationId: migration.operationId,
        expectedEpoch: control.epoch,
        preparationDigest: preparationDigest({ epoch: control.epoch, phase: 'frozen' }),
      })
      state = { kind: 'frozen', reason: CREWSTATION_STANDBY_REASONS.frozen }
      return
    }
    control = await input.platform.post<ControlRecord>(`${CONTROL_ROOT}/claim`, { instanceId })
    if (control.leaseId === undefined || control.leaseExpiresAt === null) {
      throw new Error('the platform granted no execution lease')
    }
    const lease = { expectedEpoch: control.epoch, leaseId: control.leaseId, instanceId }
    control = await input.platform.post<ControlRecord>(`${CONTROL_ROOT}/renew`, lease)
    const digest = preparationDigest({
      epoch: control.epoch,
      instanceId,
      acceptedTaskContractVersions: [...input.acceptedTaskContractVersions].sort(),
    })
    const expiresAt = Date.parse(control.leaseExpiresAt ?? '')
    if (closed || lost) return
    if (!Number.isFinite(expiresAt) || expiresAt <= now())
      throw new Error('platform execution lease is already expired')
    // The application barrier: from here on, an older holder's transactions fail.
    await input.control.write({
      epoch: control.epoch,
      owner: instanceId,
      phase: 'preparing',
      leaseId: lease.leaseId,
      expiresAt,
    })
    if (control.operationId !== undefined) {
      await input.platform.post(`${CONTROL_ROOT}/handoffs/${control.operationId}/ready`, {
        ...lease,
        operationId: control.operationId,
        preparationDigest: digest,
        acceptedTaskContractVersions: [...input.acceptedTaskContractVersions],
      })
    }
    control = await input.platform.post<ControlRecord>(`${CONTROL_ROOT}/activate`, {
      ...lease,
      preparationDigest: digest,
    })
    if (control.phase !== 'active') {
      throw new Error(`the platform kept the execution lease in phase ${control.phase}`)
    }
    const activeExpiry = Date.parse(control.leaseExpiresAt ?? '')
    if (closed || lost) return
    if (!Number.isFinite(activeExpiry) || activeExpiry <= now())
      throw new Error('platform execution lease is already expired')
    await input.control.write({
      epoch: control.epoch,
      owner: instanceId,
      phase: 'active',
      leaseId: lease.leaseId,
      expiresAt: activeExpiry,
    })
    if (closed || lost) return
    if (activeExpiry <= now()) throw new Error('platform execution lease expired during activation')
    held = { epoch: control.epoch, leaseId: lease.leaseId, expiresAt: activeExpiry }
    lastRenewedAt = now()
    armExpiry(activeExpiry)
    const fence: ExecutionFence = {
      epoch: control.epoch,
      token: encodeHostedFenceToken({ leaseId: lease.leaseId, instanceId }),
    }
    state = { kind: 'active', fence }
    log.info('crewstation execution lease active', { epoch: control.epoch })
    resolveActive(fence)
  }

  const renew = async (): Promise<void> => {
    const current = held
    if (current === undefined) return
    try {
      const observed = await input.platform.get<ControlRecord>(CONTROL_ROOT)
      if (closed || lost) return
      if (
        observed.phase !== 'active' ||
        observed.epoch !== current.epoch ||
        observed.leaseOwner !== instanceId ||
        observed.migration !== undefined
      ) {
        lose({ kind: 'frozen', reason: CREWSTATION_STANDBY_REASONS.frozen })
        await input.control.write({
          epoch: current.epoch,
          owner: instanceId,
          phase: 'frozen',
          leaseId: current.leaseId,
          expiresAt: null,
        })
        return
      }
      if (now() - lastRenewedAt < renewMs) return
      const control = await input.platform.post<ControlRecord>(`${CONTROL_ROOT}/renew`, {
        expectedEpoch: current.epoch,
        leaseId: current.leaseId,
        instanceId,
      })
      if (closed || lost) return
      if (
        control.phase !== 'active' ||
        control.epoch !== current.epoch ||
        control.leaseOwner !== instanceId ||
        control.leaseId !== current.leaseId
      ) {
        lose({ kind: 'frozen', reason: CREWSTATION_STANDBY_REASONS.frozen })
        return
      }
      const expiresAt = Date.parse(control.leaseExpiresAt ?? '')
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
        lose({ kind: 'standby', reason: CREWSTATION_STANDBY_REASONS.unreachable })
        return
      }
      await input.control.write({
        epoch: current.epoch,
        owner: instanceId,
        phase: 'active',
        leaseId: current.leaseId,
        expiresAt,
      })
      if (closed || lost) return
      if (expiresAt <= now()) {
        lose({ kind: 'standby', reason: CREWSTATION_STANDBY_REASONS.unreachable })
        return
      }
      held = { ...current, expiresAt }
      lastRenewedAt = now()
      armExpiry(expiresAt)
    } catch (error) {
      if (isCrewStationApiError(error) && error.status >= 400 && error.status < 500) {
        // The platform refused this lease (stale generation, frozen, revoked).
        lose({ kind: 'frozen', reason: CREWSTATION_STANDBY_REASONS.frozen })
        return
      }
      if (now() >= current.expiresAt) {
        lose({ kind: 'standby', reason: CREWSTATION_STANDBY_REASONS.unreachable })
        return
      }
      log.warn('crewstation execution lease renewal failed; retrying', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const schedule = (delay: number): void => {
    if (closed || lost) return
    timer = setTimeout(() => {
      void step()
    }, delay)
  }

  const step = async (): Promise<void> => {
    if (closed || lost) return
    if (state.kind === 'active') {
      await renew()
      schedule(tickMs)
      return
    }
    try {
      await acquire()
    } catch (error) {
      held = undefined
      state = { kind: 'standby', reason: standbyReasonOf(error) }
      log.info('crewstation execution lease not granted', {
        reason: state.reason,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    // An active lease renews on its own cadence; a standby retries the claim.
    schedule(tickMs)
  }

  return {
    mode: 'crewstation',
    instanceId,
    current: () => {
      if (held !== undefined && now() >= held.expiresAt) {
        lose({ kind: 'standby', reason: CREWSTATION_STANDBY_REASONS.unreachable })
      }
      return state
    },
    whenActive: () => active,
    onLost(listener) {
      lostListeners.add(listener)
      return () => {
        lostListeners.delete(listener)
      }
    },
    start() {
      if (started || closed) return
      started = true
      void step()
    },
    async close() {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      if (expiryTimer !== undefined) clearTimeout(expiryTimer)
      const current = held
      held = undefined
      state = { kind: 'standby', reason: 'execution-authority-closed' }
      if (current === undefined) return
      // Hand the lease back so a successor does not wait for it to expire.
      try {
        await input.platform.post(`${CONTROL_ROOT}/release`, {
          expectedEpoch: current.epoch,
          leaseId: current.leaseId,
          instanceId,
        })
      } catch (error) {
        log.warn('crewstation execution lease release failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}
