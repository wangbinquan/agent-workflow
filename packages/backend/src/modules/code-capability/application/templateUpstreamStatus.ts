// RFC-309 T16 / RFC-349 — provider-neutral capability-template upstream sync.
//
// The application owns three-way comparison and merge decisions. Persistence
// owns the provider transaction and executes load -> decide -> persist without
// exposing a raw transaction or table to the use case.

import type { Actor } from '@/auth/actor'
import type {
  TemplateUpstreamMergePatch,
  TemplateUpstreamPersistence,
  TemplateUpstreamPersistenceResult,
  TemplateUpstreamRecord,
  TemplateUpstreamSnapshot,
} from '@/modules/code-capability/application/ports/templateUpstreamPersistence'
import {
  judgeUpstream,
  mergeUnoverridden,
  resolveThreeWay,
  type FieldResolution,
  type UpstreamStatus,
} from '@/modules/code-capability/domain/templateUpstream'
import { sha256Hex } from '@/util/hash'

const MERGEABLE_FIELDS = [
  'description',
  'scripts',
  'hooks',
  'paramSchema',
  'paramDefaults',
  'agentBySlot',
  'promptBySlot',
  'params',
  'stageContractVer',
] as const

type MergeableField = (typeof MERGEABLE_FIELDS)[number]

export interface UpstreamReport {
  /** Absent when this template was authored here rather than copied. */
  link: { upstreamId: string; upstreamVersion: number } | null
  status: UpstreamStatus | null
  /** The upstream's current name, so the badge can say WHICH template. */
  upstreamName: string | null
  /** Per-field verdicts. Empty when there is no upstream to compare against. */
  fields: readonly FieldResolution[]
  /** False when the copy predates the base snapshot. */
  baseRecorded: boolean
}

export interface MergeOutcome {
  applied: readonly string[]
  keptLocal: readonly string[]
  stillConflicted: readonly string[]
}

export type TemplateUpstreamMergeResult =
  | TemplateUpstreamPersistenceResult
  | { ok: false; code: 'scripts-forbidden' }

export interface TemplateUpstreamOperations {
  read(templateId: string): Promise<UpstreamReport | null>
  merge(templateId: string, actor: Actor, now?: number): Promise<TemplateUpstreamMergeResult>
}

export function createTemplateUpstreamOperations(
  persistence: TemplateUpstreamPersistence,
): TemplateUpstreamOperations {
  return Object.freeze({
    async read(templateId: string): Promise<UpstreamReport | null> {
      return await readUpstreamReport(persistence, templateId)
    },
    async merge(
      templateId: string,
      actor: Actor,
      now?: number,
    ): Promise<TemplateUpstreamMergeResult> {
      return await mergeFromUpstream(persistence, templateId, actor, now)
    },
  })
}

export async function readUpstreamReport(
  persistence: TemplateUpstreamPersistence,
  templateId: string,
): Promise<UpstreamReport | null> {
  const row = await persistence.load(templateId)
  if (row === null) return null
  const upstream = row.upstreamId === null ? null : await persistence.load(row.upstreamId)
  return projectUpstreamReport(row, upstream)
}

/**
 * Take every upstream field that changed while the local copy did not.
 *
 * The persistence adapter reloads both rows inside its provider transaction,
 * invokes this synchronous decision, and applies the returned patch before the
 * transaction closes. PostgreSQL therefore never relies on a SQLite shadow or
 * a stale route-loaded row.
 */
export async function mergeFromUpstream(
  persistence: TemplateUpstreamPersistence,
  templateId: string,
  actor: Actor,
  now: number = Date.now(),
): Promise<TemplateUpstreamMergeResult> {
  if (!actor.permissions.has('scripts:author')) {
    return { ok: false, code: 'scripts-forbidden' }
  }

  const result = await persistence.decideAndPersist(templateId, (snapshot) =>
    decideTemplateUpstreamMerge(snapshot, now),
  )
  return result ?? { ok: false, code: 'upstream-gone' }
}

function decideTemplateUpstreamMerge(
  snapshot: TemplateUpstreamSnapshot,
  now: number,
): {
  readonly result: TemplateUpstreamPersistenceResult
  readonly patch: TemplateUpstreamMergePatch | null
} {
  const row = snapshot.local
  if (row.upstreamId === null || row.upstreamVersion === null) {
    return { result: { ok: false, code: 'no-upstream' }, patch: null }
  }
  if (snapshot.upstream === null) {
    return { result: { ok: false, code: 'upstream-gone' }, patch: null }
  }

  const report = projectUpstreamReport(row, snapshot.upstream)
  const outcome = mergeUnoverridden(report.fields)
  const taken = new Map(
    report.fields
      .filter((field): field is Extract<FieldResolution, { action: 'take-upstream' }> => {
        return field.action === 'take-upstream'
      })
      .map((field) => [field.field, field.value]),
  )

  if (taken.size === 0) return { result: { ok: true, ...outcome }, patch: null }

  const next: TemplateUpstreamRecord = { ...row }
  for (const [field, value] of taken) writeField(next, field as MergeableField, value)

  const oldBase = readBase(row)
  const upstreamNow = mergeableSnapshot(snapshot.upstream)
  const conflicted = new Set(outcome.stillConflicted)
  const newBase: Record<string, unknown> = {}
  for (const field of MERGEABLE_FIELDS) {
    newBase[field] = conflicted.has(field) ? (oldBase?.[field] ?? null) : upstreamNow[field]
  }

  next.baseSnapshotJson = JSON.stringify(newBase)
  next.baseDigest = templateDigest(next)
  if (conflicted.size === 0) next.upstreamVersion = snapshot.upstream.updatedAt
  next.updatedAt = now

  return {
    result: { ok: true, ...outcome },
    patch: {
      description: next.description,
      scriptsJson: next.scriptsJson,
      hooksJson: next.hooksJson,
      paramSchemaJson: next.paramSchemaJson,
      paramDefaultsJson: next.paramDefaultsJson,
      agentBySlotJson: next.agentBySlotJson,
      promptBySlotJson: next.promptBySlotJson,
      paramsJson: next.paramsJson,
      stageContractVer: next.stageContractVer,
      upstreamVersion: next.upstreamVersion,
      baseDigest: next.baseDigest,
      baseSnapshotJson: next.baseSnapshotJson,
      updatedAt: next.updatedAt,
    },
  }
}

function projectUpstreamReport(
  row: TemplateUpstreamRecord,
  upstream: TemplateUpstreamRecord | null,
): UpstreamReport {
  if (row.upstreamId === null || row.upstreamVersion === null || row.baseDigest === null) {
    return { link: null, status: null, upstreamName: null, fields: [], baseRecorded: false }
  }

  const link = { upstreamId: row.upstreamId, upstreamVersion: row.upstreamVersion }
  const local = mergeableSnapshot(row)
  const base = readBase(row)

  if (upstream === null) {
    return {
      link,
      status: judgeUpstream({
        link: { ...link, baseDigest: row.baseDigest },
        upstreamVersionNow: null,
        localDigest: templateDigest(row),
        localOverrides: base === null ? [] : changedFields(base, local),
      }),
      upstreamName: null,
      fields: [],
      baseRecorded: base !== null,
    }
  }

  const upstreamNow = mergeableSnapshot(upstream)
  const fields = resolveThreeWay(
    MERGEABLE_FIELDS.map((field) => ({
      field,
      base: base === null ? NO_BASE : base[field],
      upstream: upstreamNow[field],
      local: local[field],
    })),
  )

  return {
    link,
    status: judgeUpstream({
      link: { ...link, baseDigest: row.baseDigest },
      upstreamVersionNow: upstream.updatedAt,
      localDigest: templateDigest(row),
      localOverrides: fields
        .filter((field) => field.action === 'keep-local' || field.action === 'conflict')
        .map((field) => field.field),
    }),
    upstreamName: upstream.name,
    fields,
    baseRecorded: base !== null,
  }
}

const NO_BASE = Symbol('no-base-recorded')

function parseJson(raw: string, fallback: unknown): unknown {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed === null ? fallback : parsed
  } catch {
    return fallback
  }
}

function mergeableSnapshot(row: TemplateUpstreamRecord): Record<MergeableField, unknown> {
  return {
    description: row.description,
    scripts: parseJson(row.scriptsJson, {}),
    hooks: parseJson(row.hooksJson, []),
    paramSchema: parseJson(row.paramSchemaJson, []),
    paramDefaults: parseJson(row.paramDefaultsJson, {}),
    agentBySlot: parseJson(row.agentBySlotJson, {}),
    promptBySlot: parseJson(row.promptBySlotJson, {}),
    params: parseJson(row.paramsJson, {}),
    stageContractVer: row.stageContractVer,
  }
}

function templateDigest(row: TemplateUpstreamRecord): string {
  return sha256Hex(
    JSON.stringify([
      row.capability,
      row.scriptsJson,
      row.hooksJson,
      row.paramSchemaJson,
      row.paramDefaultsJson,
      row.agentBySlotJson,
      row.promptBySlotJson,
      row.paramsJson,
      row.stageContractVer,
    ]),
  )
}

function readBase(row: TemplateUpstreamRecord): Record<MergeableField, unknown> | null {
  if (row.baseSnapshotJson === null) return null
  try {
    const parsed: unknown = JSON.parse(row.baseSnapshotJson)
    if (parsed === null || typeof parsed !== 'object') return null
    return parsed as Record<MergeableField, unknown>
  } catch {
    return null
  }
}

function changedFields(
  base: Record<MergeableField, unknown>,
  local: Record<MergeableField, unknown>,
): string[] {
  return MERGEABLE_FIELDS.filter((field) => {
    return JSON.stringify(base[field]) !== JSON.stringify(local[field])
  })
}

function writeField(row: TemplateUpstreamRecord, field: MergeableField, value: unknown): void {
  switch (field) {
    case 'description':
      row.description = typeof value === 'string' ? value : null
      return
    case 'scripts':
      row.scriptsJson = JSON.stringify(value ?? {})
      return
    case 'hooks':
      row.hooksJson = JSON.stringify(value ?? [])
      return
    case 'paramSchema':
      row.paramSchemaJson = JSON.stringify(value ?? [])
      return
    case 'paramDefaults':
      row.paramDefaultsJson = JSON.stringify(value ?? {})
      return
    case 'agentBySlot':
      row.agentBySlotJson = JSON.stringify(value ?? {})
      return
    case 'promptBySlot':
      row.promptBySlotJson = JSON.stringify(value ?? {})
      return
    case 'params':
      row.paramsJson = JSON.stringify(value ?? {})
      return
    case 'stageContractVer':
      row.stageContractVer = typeof value === 'number' ? value : row.stageContractVer
      return
  }
}
