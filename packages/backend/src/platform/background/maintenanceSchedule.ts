import type { MaintenanceJobKey, MaintenanceSchedule } from '@agent-workflow/shared'
import { computeNextRunAt, wallClockAt, zonedWallClockToEpoch } from '@agent-workflow/shared'

import { HOUR_MS, MAINTENANCE_PHASE } from '@/services/daemonCadence'
import { HEAVY_MAINTENANCE_JOB_KEYS } from './maintenanceCatalog'

export interface CleanupSlot {
  readonly scheduledAt: number
  readonly slotKey: string
  readonly cycleKey: string
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function localDateKey(epoch: number, timezone: string): string {
  const wall = wallClockAt(epoch, timezone)
  return `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)}`
}

export function hourlyCleanupSlot(job: MaintenanceJobKey, now: number): CleanupSlot {
  if (!(job in MAINTENANCE_PHASE)) throw new Error(`maintenance job has no hourly phase: ${job}`)
  const phase = MAINTENANCE_PHASE[job as keyof typeof MAINTENANCE_PHASE]
  const scheduledAt = Math.floor((now - phase) / HOUR_MS) * HOUR_MS + phase
  return {
    scheduledAt,
    slotKey: `hourly:${scheduledAt}`,
    cycleKey: `hourly:${Math.floor(scheduledAt / HOUR_MS)}`,
  }
}

export function nextHourlyCleanupSlot(job: MaintenanceJobKey, now: number): CleanupSlot {
  const latest = hourlyCleanupSlot(job, now)
  const scheduledAt = latest.scheduledAt > now ? latest.scheduledAt : latest.scheduledAt + HOUR_MS
  return {
    scheduledAt,
    slotKey: `hourly:${scheduledAt}`,
    cycleKey: `hourly:${Math.floor(scheduledAt / HOUR_MS)}`,
  }
}

/** Today's configured daily slot, whether it is before or after `now`. */
export function dailyCleanupSlot(
  schedule: Extract<MaintenanceSchedule, { kind: 'daily' }>,
  now: number,
): CleanupSlot {
  const wall = wallClockAt(now, schedule.timezone)
  return dailyCleanupSlotForDate(schedule, wall.year, wall.month, wall.day)
}

function dailyCleanupSlotForDate(
  schedule: Extract<MaintenanceSchedule, { kind: 'daily' }>,
  year: number,
  month: number,
  day: number,
): CleanupSlot {
  const [hour, minute] = schedule.at.split(':').map(Number) as [number, number]
  const scheduledAt = zonedWallClockToEpoch({ year, month, day, hour, minute }, schedule.timezone)
  const date = localDateKey(scheduledAt, schedule.timezone)
  return {
    scheduledAt,
    slotKey: `daily:${date}`,
    cycleKey: `daily:${date}`,
  }
}

export function latestDueDailyCleanupSlot(
  schedule: Extract<MaintenanceSchedule, { kind: 'daily' }>,
  now: number,
): CleanupSlot {
  const today = dailyCleanupSlot(schedule, now)
  if (today.scheduledAt <= now) return today
  const wall = wallClockAt(now, schedule.timezone)
  const previousDate = new Date(Date.UTC(wall.year, wall.month - 1, wall.day - 1))
  return dailyCleanupSlotForDate(
    schedule,
    previousDate.getUTCFullYear(),
    previousDate.getUTCMonth() + 1,
    previousDate.getUTCDate(),
  )
}

export function nextDailyCleanupSlot(
  schedule: Extract<MaintenanceSchedule, { kind: 'daily' }>,
  now: number,
): CleanupSlot {
  const scheduledAt = computeNextRunAt(schedule, now)
  const date = localDateKey(scheduledAt, schedule.timezone)
  return {
    scheduledAt,
    slotKey: `daily:${date}`,
    cycleKey: `daily:${date}`,
  }
}

export interface MaintenanceScheduleTimerApi {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const REAL_TIMERS: MaintenanceScheduleTimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface MaintenanceScheduleCoordinatorOptions {
  readonly schedule: () => MaintenanceSchedule
  readonly admit: (input: {
    job: MaintenanceJobKey
    jobClass: 'cleanup'
    slot: CleanupSlot
  }) => void
  readonly now?: () => number
  readonly timers?: MaintenanceScheduleTimerApi
  readonly catchUpDelayMs?: number
}

export interface MaintenanceScheduleCoordinator {
  reconfigure(): void
  nextRunAt(): number | null
  stop(): void
}

/**
 * Heavy-cleanup coordinator. It only admits durable rows; job bodies never run
 * in these timer callbacks. Reconfiguration cancels future timers but does not
 * touch a currently running Worker lease.
 */
export function startMaintenanceScheduleCoordinator(
  options: MaintenanceScheduleCoordinatorOptions,
): MaintenanceScheduleCoordinator {
  const now = options.now ?? Date.now
  const timers = options.timers ?? REAL_TIMERS
  const catchUpDelayMs = options.catchUpDelayMs ?? 30_000
  let generation = 0
  let stopped = false
  const handles = new Set<unknown>()
  let projectedNext: number | null = null
  const hourlyNextByJob = new Map<MaintenanceJobKey, number>()

  const clear = (): void => {
    for (const handle of handles) timers.clearTimeout(handle)
    handles.clear()
    projectedNext = null
    hourlyNextByJob.clear()
  }
  const unref = (handle: unknown): unknown => {
    ;(handle as { unref?: () => void } | null)?.unref?.()
    return handle
  }
  const scheduleTimer = (fn: () => void, delayMs: number): unknown => {
    const handle = unref(
      timers.setTimeout(() => {
        handles.delete(handle)
        fn()
      }, delayMs),
    )
    handles.add(handle)
    return handle
  }
  const admitAll = (slot: CleanupSlot): void => {
    for (const job of HEAVY_MAINTENANCE_JOB_KEYS) {
      options.admit({ job, jobClass: 'cleanup', slot })
    }
  }

  const configureHourly = (ownGeneration: number, catchUp: boolean): void => {
    for (const job of HEAVY_MAINTENANCE_JOB_KEYS) {
      const scheduleNext = (): void => {
        if (stopped || generation !== ownGeneration) return
        const slot = nextHourlyCleanupSlot(job, now())
        hourlyNextByJob.set(job, slot.scheduledAt)
        projectedNext = Math.min(...hourlyNextByJob.values())
        scheduleTimer(
          () => {
            if (stopped || generation !== ownGeneration) return
            options.admit({ job, jobClass: 'cleanup', slot })
            scheduleNext()
          },
          Math.max(0, slot.scheduledAt - now()),
        )
      }
      // Coalesce any slot missed while the daemon was stopped. Durable unique
      // admission makes this harmless when the slot already completed.
      if (catchUp) {
        const missed = hourlyCleanupSlot(job, now())
        scheduleTimer(() => {
          if (!stopped && generation === ownGeneration) {
            options.admit({ job, jobClass: 'cleanup', slot: missed })
          }
        }, catchUpDelayMs)
      }
      scheduleNext()
    }
  }

  const configureDaily = (
    schedule: Extract<MaintenanceSchedule, { kind: 'daily' }>,
    ownGeneration: number,
    catchUp: boolean,
  ): void => {
    // Always replay every job in the latest due cycle on daemon boot. Exact job/slot uniqueness
    // makes completed rows no-ops, while this also repairs a partially admitted
    // daily cycle after contention or a daemon crash. A hot schedule change
    // starts at its next slot and therefore never invents a historical cycle.
    if (catchUp) {
      const due = latestDueDailyCleanupSlot(schedule, now())
      scheduleTimer(() => {
        if (!stopped && generation === ownGeneration) admitAll(due)
      }, catchUpDelayMs)
    }
    const scheduleNext = (): void => {
      if (stopped || generation !== ownGeneration) return
      const slot = nextDailyCleanupSlot(schedule, now())
      projectedNext = slot.scheduledAt
      scheduleTimer(
        () => {
          if (stopped || generation !== ownGeneration) return
          admitAll(slot)
          scheduleNext()
        },
        Math.max(0, slot.scheduledAt - now()),
      )
    }
    scheduleNext()
  }

  const configure = (catchUp: boolean): void => {
    clear()
    generation += 1
    const ownGeneration = generation
    const schedule = options.schedule()
    if (schedule.kind === 'hourly') configureHourly(ownGeneration, catchUp)
    else configureDaily(schedule, ownGeneration, catchUp)
  }

  configure(true)
  return {
    reconfigure: () => configure(false),
    nextRunAt: () => projectedNext,
    stop: () => {
      stopped = true
      generation += 1
      clear()
    },
  }
}
