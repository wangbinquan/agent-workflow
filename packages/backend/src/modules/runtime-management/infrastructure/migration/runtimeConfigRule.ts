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
      const rows = await bootSourceRows(input.source, 'runtimes')
      const source = join(input.root.root, 'config.json')
      let bytes: Uint8Array | null = null
      let state: RuntimeConfigFact['state'] = 'absent'
      let raw: Record<string, unknown> = {}
      try {
        bytes = await read(source)
        if (bytes !== null) {
          state = 'invalid'
          const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
          if (value === null || typeof value !== 'object' || Array.isArray(value))
            throw new Error('config-not-object')
          raw = value as Record<string, unknown>
          if (
            ['opencodePath', 'claudeCodePath'].some(
              (name) =>
                raw[name] !== undefined && raw[name] !== null && typeof raw[name] !== 'string',
            )
          )
            throw new Error('config-binary-invalid')
          state = 'present'
        }
      } catch {
        state = bytes === null ? 'unavailable' : 'invalid'
      }
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
      if (blocked && rows.length === 0)
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
        if (blocked) {
          blockBootRow(ctx, ref, row, blocked, before, [factId])
          continue
        }
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
