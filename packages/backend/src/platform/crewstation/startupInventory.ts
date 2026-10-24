import { z } from 'zod'
import { utf16MaxLength } from '@agent-workflow/shared'
import type { ObservedInventoryFaces, StartupObservation } from '@agent-workflow/shared'

/** The platform's verified startup report names how it observed each runtime. */
const INVENTORY_SOURCE = {
  opencode: 'opencode-inventory',
  'claude-code': 'claude-init',
} as const satisfies Record<'opencode' | 'claude-code', string>

// RFC-040 transports runtime facts, never configuration or diagnostic text.
// An absent face differs from a reported, empty face. Invalid or oversized
// reports retain a stable failure code without retaining the rejected bytes.
const Name = z
  .string()
  .min(1)
  .check(utf16MaxLength(512))
  .refine((s) =>
    [...s].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
  )
const Names = z
  .array(Name)
  .max(2048)
  .refine((names) => new Set(names).size === names.length)
const Reason = z.string().regex(/^[a-z][a-z0-9-]{0,95}$/)
export const HostedStartupInventory = z.discriminatedUnion('state', [
  z
    .object({
      version: z.literal(1),
      state: z.literal('verified'),
      source: z.enum(['claude-init', 'opencode-inventory']),
      mcpServers: z
        .array(
          z
            .object({
              name: Name,
              status: z.enum(['connected', 'failed', 'disabled', 'unknown']),
            })
            .strict(),
        )
        .max(2048)
        .refine((servers) => new Set(servers.map((s) => s.name)).size === servers.length),
      agents: Names.optional(),
      skills: Names.optional(),
      tools: Names.optional(),
    })
    .strict(),
  z.object({ version: z.literal(1), state: z.literal('unavailable'), reason: Reason }).strict(),
  z.object({ version: z.literal(1), state: z.literal('malformed'), reason: Reason }).strict(),
])
export type HostedStartupInventory = z.infer<typeof HostedStartupInventory>

export function readHostedStartupInventory(
  data: unknown,
  protocol: 'opencode' | 'claude-code',
): HostedStartupInventory {
  const invalid = (reason: string): HostedStartupInventory => ({
    version: 1,
    state: 'malformed',
    reason,
  })
  let bytes: number
  try {
    bytes = Buffer.byteLength(JSON.stringify(data))
  } catch {
    return invalid('hosted-inventory-invalid')
  }
  if (bytes > 256 * 1024) return { version: 1, state: 'unavailable', reason: 'inventory-too-large' }
  const parsed = HostedStartupInventory.safeParse(data)
  if (!parsed.success) return invalid('hosted-inventory-invalid')
  if (parsed.data.state === 'verified' && parsed.data.source !== INVENTORY_SOURCE[protocol])
    return invalid('hosted-inventory-source-mismatch')
  return parsed.data
}

export function hostedStartupObservation(report: HostedStartupInventory): StartupObservation {
  const { version: _version, ...observation } = report
  return observation
}

export function startupInventoryFaces(
  observation: StartupObservation,
): ObservedInventoryFaces | null {
  if (observation.state !== 'verified') return null
  const named = (names: string[]) => names.map((name) => ({ key: name, name }))
  return {
    mcps: observation.mcpServers.map(({ name, status }) => ({ key: name, name, status })),
    ...(observation.agents === undefined ? {} : { agents: named(observation.agents) }),
    ...(observation.skills === undefined ? {} : { skills: named(observation.skills) }),
    ...(observation.tools === undefined ? {} : { tools: named(observation.tools) }),
  }
}
