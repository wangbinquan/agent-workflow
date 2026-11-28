import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  emitBootRow,
  blockBootRow,
  createBootUpgradeFacts,
  type BootUpgradeFacts,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { ConversionContractError } from '@/platform/persistence/migration/conversion/blockCodes'
import type {
  ConversionContribution,
  ConversionRule,
} from '@/platform/persistence/migration/conversion/rule'
import {
  bootSourceRows,
  type BootUpgradeEnvironmentContribution,
} from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'

const ref = { id: 'runtime-management/boot-runtime-config', version: 2 } as const
const factId = 'runtime-config:legacy'
const defaults = [
  'defaultModel',
  'defaultVariant',
  'defaultTemperature',
  'defaultSteps',
  'defaultMaxSteps',
  'defaultClaudeModel',
] as const
const profiles = ['model', 'variant', 'temperature', 'steps', 'max_steps'] as const
const configSchema = z.strictObject({
  state: z.enum(['absent', 'present', 'unavailable', 'invalid']),
  source: z.string(),
  opencodePath: z.string().nullable(),
  claudeCodePath: z.string().nullable(),
  legacyDefaults: z.record(z.string(), z.json()),
  profiles: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      protocol: z.string(),
      values: z.record(z.string(), z.json()),
    }),
  ),
})
export type RuntimeConfigFact = z.infer<typeof configSchema>
/** RFC-626 §3.4 row 6a: the decision recorded when legacy defaults are left behind. */
export const RUNTIME_DEFAULTS_NOT_CARRIED = 'v2-boot-runtime-defaults-not-carried'
/** How `config.json` in the home directory reads, as the upgrade judges it. */
export interface RuntimeConfigFileJudgement {
  readonly valid: boolean
  readonly state: RuntimeConfigFact['state']
  /** Why the file cannot be used; null when it can. */
  readonly reason: string | null
  /** The top-level object when parsing got that far, also when a binary path is invalid. */
  readonly object: Readonly<Record<string, unknown>> | null
}
/**
 * RFC-626 §3.5: whether `config.json` is usable — the one judgement shared by the boot-upgrade
 * facts and the environment check that runs before an automatic upgrade, so the check refuses
 * exactly the files the conversion would find unproven. A missing file is fine. Unusable: a
 * read error other than ENOENT, bytes that are not strict UTF-8, text that is not JSON, a
 * top-level value that is not an object, or `opencodePath` / `claudeCodePath` present and not
 * text. v0.19.2 could not start with most of these either.
 */
export function judgeRuntimeConfigFile(
  input: { readonly bytes: Uint8Array | null } | { readonly error: unknown },
): RuntimeConfigFileJudgement {
  if ('error' in input) {
    if ((input.error as NodeJS.ErrnoException | null)?.code === 'ENOENT')
      return { valid: true, state: 'absent', reason: null, object: null }
    const message = input.error instanceof Error ? input.error.message : String(input.error)
    return {
      valid: false,
      state: 'unavailable',
      reason: `config-unreadable: ${message}`,
      object: null,
    }
  }
  if (input.bytes === null) return { valid: true, state: 'absent', reason: null, object: null }
  const invalid = (reason: string, object: Record<string, unknown> | null = null) => ({
    valid: false,
    state: 'invalid' as const,
    reason,
    object,
  })
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes)
  } catch {
    return invalid('config-not-utf8')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return invalid(`config-not-json: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return invalid('config-not-object')
  const object = value as Record<string, unknown>
  const binary = ['opencodePath', 'claudeCodePath'].find(
    (name) =>
      object[name] !== undefined && object[name] !== null && typeof object[name] !== 'string',
  )
  if (binary !== undefined) return invalid(`config-binary-invalid: ${binary}`, object)
  return { valid: true, state: 'present', reason: null, object }
}
export function runtimeConfigEnvironment(
  read: (path: string) => Promise<Uint8Array | null> = async (path) => {
    try {
      return await readFile(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },
): BootUpgradeEnvironmentContribution {
  return {
    id: ref.id,
    async capture(input) {
      const rows = await bootSourceRows(input.source, 'runtimes', input)
      const source = join(input.root.root, 'config.json')
      let outcome: { readonly bytes: Uint8Array | null } | { readonly error: unknown }
      try {
        outcome = { bytes: await read(source) }
      } catch (error) {
        outcome = { error }
      }
      const judged = judgeRuntimeConfigFile(outcome)
      const bytes = 'bytes' in outcome ? outcome.bytes : null
      const state = judged.state
      const raw: Readonly<Record<string, unknown>> = judged.object ?? {}
      const config = configSchema.parse({
        state,
        source,
        opencodePath: typeof raw.opencodePath === 'string' ? raw.opencodePath : null,
        claudeCodePath: typeof raw.claudeCodePath === 'string' ? raw.claudeCodePath : null,
        legacyDefaults: Object.fromEntries(
          defaults
            .filter((key) => raw[key] !== null && raw[key] !== undefined)
            .map((key) => [key, raw[key]]),
        ),
        profiles: rows
          .filter(
            (row) =>
              row.name === row.protocol && ['opencode', 'claude-code'].includes(String(row.name)),
          )
          .map((row) => ({
            id: String(row.id),
            name: String(row.name),
            protocol: String(row.protocol),
            values: Object.fromEntries(profiles.map((column) => [column, row[column] ?? null])),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      })
      const bindings = rows
        .flatMap((row) => {
          const binary =
            row.name === row.protocol && row.binary_path === null
              ? row.name === 'opencode'
                ? config.opencodePath
                : row.name === 'claude-code'
                  ? config.claudeCodePath
                  : null
              : null
          return binary === null ? [] : [{ id: String(row.id), binaryPath: binary }]
        })
        .sort((a, b) => a.id.localeCompare(b.id))
      return [
        {
          id: factId,
          kind: 'runtime-config',
          material: { block: runtimeConfigBlock(config), bindings },
          evidence: { config, rawDigest: bytes === null ? null : bytesDigest(bytes), source },
        },
      ]
    },
  }
}
export function runtimeConfigBlock(fact: RuntimeConfigFact | undefined): string | null {
  if (!fact || fact.state === 'unavailable' || fact.state === 'invalid')
    return 'v2-boot-runtime-config-unproven'
  if (
    Object.keys(fact.legacyDefaults).length &&
    !fact.profiles.some((profile) => Object.values(profile.values).some((value) => value !== null))
  )
    return 'v2-boot-runtime-defaults-unmigrated'
  return null
}
export function runtimeConfigConversion(facts: BootUpgradeFacts): ConversionContribution {
  const captured = facts.facts.find((fact) => fact.id === factId)
  const config = captured
    ? configSchema.parse(z.object({ config: configSchema }).parse(captured.evidence).config)
    : undefined
  const rule: ConversionRule = {
    ref,
    owner: 'runtime-management',
    claims: ['runtimes'],
    produces: [{ table: 'runtimes' }],
    lookups: [],
    unit: { kind: 'source-chunk', table: 'runtimes' },
    convert(unit, ctx) {
      const blocked = runtimeConfigBlock(config),
        rows = unit.rows.get('runtimes') ?? []
      const automatic = ctx.resolution === 'automatic'
      // RFC-626 §3.4 row 6b: an unreadable or invalid config.json is refused by the environment
      // check before the upgrade starts, and the facts are always captured; meeting either
      // here means the upgrade's own steps disagree.
      if (automatic && blocked === 'v2-boot-runtime-config-unproven')
        throw new ConversionContractError(
          blocked,
          config
            ? `config.json was ${config.state} when the facts were captured`
            : `no ${factId} fact was captured`,
        )
      // RFC-626 §3.4 row 6a: the legacy default keys were never read by v0.19.2's runtimes and
      // the new version does not check them at boot; the runtimes convert as they are and the
      // report says the defaults were left behind.
      const defaultsLeft = automatic && blocked === 'v2-boot-runtime-defaults-unmigrated'
      const notCarried = {
        automatic: 'kept',
        sourceTable: 'runtimes',
        legacyDefaults: Object.keys(config?.legacyDefaults ?? {}).sort(),
        source: config?.source ?? null,
      }
      if (defaultsLeft && rows.length === 0)
        ctx.out.record({
          kind: 'decision',
          code: RUNTIME_DEFAULTS_NOT_CARRIED,
          payload: notCarried,
        })
      if (blocked && !defaultsLeft && rows.length === 0)
        ctx.out.block({
          code: blocked,
          scope: 'table',
          sourceTable: 'runtimes',
          sourceKey: null,
          taskId: null,
          runId: null,
          missingFields: ['raw-config', 'canonical-profiles'],
          detail: { factId },
        })
      for (const row of rows) {
        const before = {
          id: String(row.values.id),
          name: String(row.values.name),
          protocol: String(row.values.protocol),
          binaryPath: typeof row.values.binary_path === 'string' ? row.values.binary_path : null,
        }
        if (blocked && !defaultsLeft) {
          blockBootRow(ctx, ref, row, blocked, before, [factId])
          continue
        }
        if (defaultsLeft)
          ctx.out.record(
            {
              kind: 'decision',
              code: RUNTIME_DEFAULTS_NOT_CARRIED,
              payload: { ...notCarried, sourceKey: row.encodedKey },
            },
            row,
          )
        const binary =
          row.values.name === row.values.protocol && row.values.binary_path === null
            ? row.values.name === 'opencode'
              ? config!.opencodePath
              : row.values.name === 'claude-code'
                ? config!.claudeCodePath
                : null
            : null
        const values = {
          ...row.values,
          ...(binary !== null ? { binary_path: binary, updated_at: ctx.planTime } : {}),
        }
        emitBootRow(ctx, ref, row, values, {
          changed: binary !== null,
          before,
          after: {
            ...before,
            binaryPath: binary ?? before.binaryPath,
            inherited: binary !== null,
          },
          reason:
            binary !== null ? 'v2-boot-runtime-binary-inherited' : 'v2-boot-runtime-unchanged',
          factIds: [factId],
        })
      }
    },
  }
  return { rules: [rule], lookups: [], validators: [] }
}
export const conversion: ConversionContribution = {
  ...runtimeConfigConversion(createBootUpgradeFacts([])),
  withBootUpgrade: runtimeConfigConversion,
}
