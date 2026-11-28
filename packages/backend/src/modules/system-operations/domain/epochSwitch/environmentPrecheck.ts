// RFC-626 §3.5: the environment checks an automatic upgrade makes before it records anything.
//
// Disk space, the structure of the old database, the configuration file and the right to
// create a database do not depend on how much data there is. They are judged after the session
// lock is taken and before the session's intent is recorded, so a refusal here leaves no
// session record, no operation directory, no allocation file and no new database behind.
// This file holds the judgements and the wording; reading the disk is an adapter's job.
import type { AutoUpgradeConclusion } from './autoUpgrade'
import type { DirectUpgradeCapacity } from './capacity'

export interface EnvironmentRefusal {
  readonly reason: string
  readonly guidance: readonly string[]
}

const UNTOUCHED =
  'The database was not modified and nothing was recorded for this upgrade. Start again after the correction.'

/** A refusal that happened before the session existed: there is no operation to name. */
export function environmentRefusalConclusion(refusal: EnvironmentRefusal): AutoUpgradeConclusion {
  return {
    mode: 'auto',
    outcome: 'refused',
    exitCode: 3,
    operationId: null,
    guidance: refusal.guidance,
    code: refusal.reason,
  }
}

/** What reading the home `config.json` gave: its bytes, its absence (`null`), or the failure. */
export type HomeConfigObservation =
  | { readonly bytes: Uint8Array | null }
  | { readonly error: string }
export type HomeConfigCheck =
  | { readonly valid: true; readonly state: 'absent' | 'present' }
  | {
      readonly valid: false
      readonly reason: 'unreadable' | 'not-utf8' | 'not-json' | 'not-object' | 'binary-invalid'
      /** The decoder's or parser's own words, or what was found instead. */
      readonly detail: string
    }

const kindOf = (value: unknown): string =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'an array'
      : typeof value === 'object'
        ? 'an object'
        : `a ${typeof value}`

/**
 * Whether the conversion will accept the home `config.json`.
 *
 * This is the judgement the runtime-configuration rule makes when it captures the file for the
 * conversion (`modules/runtime-management/infrastructure/migration/runtimeConfigRule.ts`,
 * `judgeRuntimeConfigFile`, used by `runtimeConfigEnvironment().capture`): a file it classifies
 * as `unavailable` or `invalid` blocks the conversion of every runtime row
 * (`v2-boot-runtime-config-unproven`). The module cannot import that rule, so the conditions
 * are restated here in the rule's order and under the rule's names (`config-<reason>`), and
 * `tests/rfc626-home-config-parity.test.ts` feeds one table of cases to both and requires the
 * same verdict and the same reason for each. A file that does not exist is valid: the rule
 * records it as absent.
 */
export function checkHomeConfig(observed: HomeConfigObservation): HomeConfigCheck {
  // A read that failed for any reason other than "no such file".
  if ('error' in observed) return { valid: false, reason: 'unreadable', detail: observed.error }
  if (observed.bytes === null) return { valid: true, state: 'absent' }
  let text: string
  try {
    // Strict, as in the rule: a byte sequence that is not UTF-8 is not replaced.
    text = new TextDecoder('utf-8', { fatal: true }).decode(observed.bytes)
  } catch (error) {
    return { valid: false, reason: 'not-utf8', detail: messageOf(error) }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { valid: false, reason: 'not-json', detail: messageOf(error) }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { valid: false, reason: 'not-object', detail: kindOf(value) }
  const raw = value as Record<string, unknown>
  for (const name of ['opencodePath', 'claudeCodePath'])
    if (raw[name] !== undefined && raw[name] !== null && typeof raw[name] !== 'string')
      return {
        valid: false,
        reason: 'binary-invalid',
        detail: `${name} is ${kindOf(raw[name])}`,
      }
  return { valid: true, state: 'present' }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const HOME_CONFIG_PROBLEM: Record<
  Extract<HomeConfigCheck, { valid: false }>['reason'],
  (path: string, detail: string) => string
> = {
  unreadable: (path, detail) => `The configuration file ${path} cannot be read: ${detail}`,
  'not-utf8': (path, detail) => `The configuration file ${path} is not valid UTF-8: ${detail}`,
  'not-json': (path, detail) => `The configuration file ${path} is not valid JSON: ${detail}`,
  'not-object': (path, detail) =>
    `The configuration file ${path} must hold a JSON object at the top level; it holds ${detail}.`,
  'binary-invalid': (path, detail) =>
    `In the configuration file ${path}, opencodePath and claudeCodePath must be text: ${detail}.`,
}

/** Null when the file is acceptable. */
export function homeConfigRefusal(path: string, check: HomeConfigCheck): EnvironmentRefusal | null {
  if (check.valid) return null
  return {
    reason: `config-${check.reason}`,
    guidance: [
      HOME_CONFIG_PROBLEM[check.reason](path, check.detail),
      `Correct ${path}, then start again. ${UNTOUCHED}`,
    ],
  }
}

/** The file passed the checks above and the configuration loader still rejected it. */
export function unloadableConfigRefusal(path: string, detail: string): EnvironmentRefusal {
  return {
    reason: 'config-not-loadable',
    guidance: [
      `The configuration file ${path} cannot be loaded: ${detail}`,
      `Correct ${path}, then start again. ${UNTOUCHED}`,
    ],
  }
}

export function sourceRefusal(input: {
  readonly reason: 'unreadable' | 'structure'
  readonly message: string
}): EnvironmentRefusal {
  return input.reason === 'structure'
    ? {
        reason: 'source-structure',
        guidance: [
          `The database to upgrade does not have the structure a released version writes: ${input.message}`,
          `The upgrade converts a database as a released version wrote it. Restore or remove the listed objects with the previous version, then start again. ${UNTOUCHED}`,
        ],
      }
    : {
        reason: 'source-unreadable',
        guidance: [`The database to upgrade cannot be opened: ${input.message}`, UNTOUCHED],
      }
}

/**
 * RFC-626 §3.5: the old database could not be opened because the disk has no space left.
 * Opening a SQLite database in WAL mode writes its shared-memory file, so on a disk that is
 * completely full the first check fails with `ENOSPC` before the space estimate is ever made;
 * that is a lack of space, not an unreadable database. The precheck puts the code of the error
 * in `detail.code`.
 */
export function sourceOutOfSpace(input: {
  readonly reason: 'unreadable' | 'structure'
  readonly detail?: Readonly<Record<string, unknown>>
}): boolean {
  return input.reason === 'unreadable' && input.detail?.code === 'ENOSPC'
}

/**
 * The refusal for a disk without any free space: a lack of space, with what is free and where.
 * `step` is what failed first — opening the old database (`sourceOutOfSpace`), or, on a disk
 * that is fuller still, writing the lock file every upgrade starts with.
 */
export function sourceOutOfSpaceRefusal(input: {
  /** The error as it was read. */
  readonly error: string
  /** Free bytes where the operation directory will be; null when unknown. */
  readonly availableBytes: number | null
  readonly directory: string
  readonly step?: 'open-source' | 'lock'
}): EnvironmentRefusal {
  return {
    reason: 'capacity',
    guidance: [
      `The disk that holds ${input.directory} has no free space left: ` +
        (input.step === 'lock'
          ? `the upgrade cannot even write its lock file`
          : `not even the database to upgrade can be opened for reading`) +
        ` (${input.error}).`,
      input.availableBytes === null
        ? `The free space in ${input.directory} could not be measured.`
        : `${formatByteCount(input.availableBytes)} are available in ${input.directory}.`,
      `Free disk space there, then start again. ${UNTOUCHED}`,
    ],
  }
}

/**
 * RFC-626 §3.5: taking the lock of the upgrade failed because the disk has no space left — the
 * lock file is the first thing an upgrade writes. Null for every other failure, which is the
 * caller's to raise as before.
 */
export function lockOutOfSpaceRefusal(input: {
  readonly code: string | null
  readonly error: string
  readonly availableBytes: number | null
  readonly directory: string
}): EnvironmentRefusal | null {
  if (input.code !== 'ENOSPC') return null
  return sourceOutOfSpaceRefusal({
    error: input.error,
    availableBytes: input.availableBytes,
    directory: input.directory,
    step: 'lock',
  })
}

const UNITS = ['KiB', 'MiB', 'GiB', 'TiB'] as const
/** `7193206784 bytes (6.7 GiB)`: the exact number, and one a person can compare at a glance. */
export function formatByteCount(bytes: number): string {
  let value = bytes
  let unit: string | null = null
  for (const next of UNITS) {
    if (value < 1024) break
    value /= 1024
    unit = next
  }
  return unit === null ? `${bytes} bytes` : `${bytes} bytes (${value.toFixed(1)} ${unit})`
}

/** Null when the space is sufficient. */
export function capacityRefusal(input: {
  readonly capacity: DirectUpgradeCapacity
  readonly availableBytes: number
  readonly directory: string
}): EnvironmentRefusal | null {
  const { capacity, availableBytes } = input
  if (availableBytes >= capacity.requiredBytes) return null
  return {
    reason: 'capacity',
    guidance: [
      `Not enough free disk space for the database upgrade in ${input.directory}: ` +
        `${formatByteCount(capacity.requiredBytes)} are needed, ` +
        `${formatByteCount(availableBytes)} are available.`,
      `The estimate is for ${formatByteCount(capacity.liveBytes)} of data in use: a frozen copy that is also the backup, ` +
        `a working copy, the conversion's staging store${capacity.targetFilesystemBytes > 0 ? ', the new database' : ''}, ` +
        `the content inventory and a margin of 10%.`,
      `Free at least ${formatByteCount(capacity.requiredBytes - availableBytes)} there, then start again. ${UNTOUCHED}`,
    ],
  }
}
