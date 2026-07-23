// RFC-224 T22 — inventory for the verified direct-API path.
//
// The legacy inventory plugin is intentionally unavailable in verified mode:
// plugins are forbidden and inventory must not execute tools or call
// `/mcp/status`. The launcher writes one bounded snapshot only after `/config`,
// `/config/providers`, `/agent`, `/skill`, the second `/agent`, and the source
// fingerprint have all passed.

import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import {
  InventorySnapshotCapturedSchema,
  type InventoryAgent,
  type InventorySnapshotCaptured,
} from '@agent-workflow/shared'
import { z } from 'zod'
import { executionIdentityFailure } from './failure'
import { PINNED_BUILTIN_SKILL } from './hermetic'

const MAX_VERIFIED_INVENTORY_BYTES = 1024 * 1024
const InventoryNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('\0'))
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/)

const VerifiedFrozenSkillInventorySchema = z
  .object({
    name: InventoryNameSchema,
    skillId: z.string().min(1).max(256),
    treeDigest: DigestSchema,
  })
  .strict()

const VerifiedMcpInventorySchema = z
  .object({
    name: InventoryNameSchema,
    type: z.enum(['local', 'remote']),
  })
  .strict()

const VerifiedInventoryEnabledPlanSchema = z
  .object({
    enabled: z.literal(true),
    frozenSkills: z.array(VerifiedFrozenSkillInventorySchema).max(256),
    mcps: z.array(VerifiedMcpInventorySchema).max(256),
  })
  .strict()

export const VerifiedInventoryPlanSchema = z
  .discriminatedUnion('enabled', [
    z.object({ enabled: z.literal(false) }).strict(),
    VerifiedInventoryEnabledPlanSchema,
  ])
  .superRefine((value, ctx) => {
    if (!value.enabled) return
    for (const [field, entries] of [
      ['frozenSkills', value.frozenSkills],
      ['mcps', value.mcps],
    ] as const) {
      const seen = new Set<string>()
      for (let index = 0; index < entries.length; index += 1) {
        const name = entries[index]!.name
        if (seen.has(name)) {
          ctx.addIssue({
            code: 'custom',
            path: [field, index, 'name'],
            message: 'duplicate inventory identity',
          })
        }
        seen.add(name)
      }
    }
  })

export type VerifiedInventoryPlan = z.infer<typeof VerifiedInventoryPlanSchema>
export type VerifiedInventoryEnabledPlan = Extract<VerifiedInventoryPlan, { enabled: true }>

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0) as number)
  const b = Array.from(right, (character) => character.codePointAt(0) as number)
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index]! - b[index]!
    if (difference !== 0) return difference
  }
  return a.length - b.length
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Freeze the non-executable inventory metadata into the one-shot manifest.
 * Skill contents remain prompt-injected; only their already-verified identity
 * and tree digest cross into the launcher.
 */
export function buildVerifiedInventoryPlan(input: {
  enabled: boolean
  frozenSkills: readonly { name: string; skillId: string; treeDigest: string }[]
  mcps: readonly { name: string; type: 'local' | 'remote'; enabled: boolean }[]
}): VerifiedInventoryPlan {
  if (!input.enabled) return { enabled: false }
  const parsed = VerifiedInventoryPlanSchema.safeParse({
    enabled: true,
    frozenSkills: input.frozenSkills
      .map((skill) => ({ ...skill }))
      .sort((left, right) => compareCodePoints(left.name, right.name)),
    mcps: input.mcps
      .filter((mcp) => mcp.enabled)
      .map((mcp) => ({ name: mcp.name, type: mcp.type }))
      .sort((left, right) => compareCodePoints(left.name, right.name)),
  })
  if (!parsed.success) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  return parsed.data
}

function inventoryAgent(raw: unknown): InventoryAgent {
  if (!isPlainRecord(raw) || typeof raw.name !== 'string' || typeof raw.mode !== 'string') {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  if (raw.native !== true && raw.native !== false) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  let modelProviderId: string | null = null
  let modelId: string | null = null
  if (raw.model !== undefined && raw.model !== null) {
    if (!isPlainRecord(raw.model)) {
      return executionIdentityFailure('execution-identity-mismatch')
    }
    if (
      raw.model.providerID !== undefined &&
      raw.model.providerID !== null &&
      typeof raw.model.providerID !== 'string'
    ) {
      return executionIdentityFailure('execution-identity-mismatch')
    }
    if (
      raw.model.modelID !== undefined &&
      raw.model.modelID !== null &&
      typeof raw.model.modelID !== 'string'
    ) {
      return executionIdentityFailure('execution-identity-mismatch')
    }
    modelProviderId = typeof raw.model.providerID === 'string' ? raw.model.providerID : null
    modelId = typeof raw.model.modelID === 'string' ? raw.model.modelID : null
  }
  return {
    name: raw.name,
    mode: raw.mode,
    modelProviderId,
    modelId,
    source: raw.native ? 'runtime-native' : 'manifest-controlled',
  }
}

/**
 * Convert only already-verified same-instance data. The pinned built-in skill
 * is clearly labelled as a runtime baseline; managed skills remain a separate
 * prompt-injected provenance class. MCPs come from the sealed manifest and
 * never from `/mcp/status`; plugins are structurally fixed to `[]`.
 */
export function buildVerifiedInventorySnapshot(input: {
  agents: unknown
  plan: VerifiedInventoryEnabledPlan
  capturedAt: number
}): InventorySnapshotCaptured {
  if (!Array.isArray(input.agents)) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  const agentNames = new Set<string>()
  const agents = input.agents.map(inventoryAgent).sort((left, right) => {
    const difference = compareCodePoints(left.name, right.name)
    return difference !== 0 ? difference : compareCodePoints(left.source, right.source)
  })
  for (const agent of agents) {
    if (agentNames.has(agent.name)) {
      return executionIdentityFailure('execution-identity-mismatch')
    }
    agentNames.add(agent.name)
  }

  const snapshot = InventorySnapshotCapturedSchema.safeParse({
    captured: true,
    schemaVersion: 1,
    capturedAt: input.capturedAt,
    agents,
    skills: [
      {
        name: PINNED_BUILTIN_SKILL.name,
        source: 'runtime-baseline',
        path: PINNED_BUILTIN_SKILL.location,
        description: PINNED_BUILTIN_SKILL.description,
      },
      ...input.plan.frozenSkills.map((skill) => ({
        name: skill.name,
        source: 'prompt-injected-frozen',
        path: null,
        description: null,
      })),
    ].sort((left, right) => {
      const difference = compareCodePoints(left.name, right.name)
      return difference !== 0 ? difference : compareCodePoints(left.source, right.source)
    }),
    mcps: input.plan.mcps.map((mcp) => ({
      name: mcp.name,
      type: mcp.type,
      status: 'configured',
      hint: null,
    })),
    plugins: [],
  })
  if (!snapshot.success) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  return snapshot.data
}

function noFollow(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
}

/** Exclusive private write: a pre-existing file or symlink fails closed. */
export async function writeVerifiedInventorySnapshot(
  runRoot: string,
  snapshot: InventorySnapshotCaptured,
): Promise<void> {
  const parsed = InventorySnapshotCapturedSchema.safeParse(snapshot)
  if (!parsed.success) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  const bytes = Buffer.from(JSON.stringify(parsed.data), 'utf8')
  if (bytes.byteLength > MAX_VERIFIED_INVENTORY_BYTES) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }

  let handle
  try {
    handle = await open(
      join(runRoot, 'inventory.json'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(),
      0o600,
    )
    await handle.writeFile(bytes)
    await handle.sync()
    const metadata = await handle.stat()
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size !== bytes.byteLength
    ) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
  } catch {
    return executionIdentityFailure('execution-identity-store-unsafe')
  } finally {
    await handle?.close().catch(() => {})
  }
}
