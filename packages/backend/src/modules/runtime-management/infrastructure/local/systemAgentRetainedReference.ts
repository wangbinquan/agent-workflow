import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { releaseSystemAgentScratch } from './agentMaterialWorkspace'

const prefix = 'aw-system-retained-v1:'
const ownerFile = '.aw-system-content-owner.json'
const descriptor = z
  .object({
    reference: z.string().min(1),
    root: z.string().min(1),
    parent: z.string().min(1),
    namespace: z.enum(['intent', 'shared']),
  })
  .strict()

export function createDurableSystemRetainedReference(input: z.infer<typeof descriptor>): string {
  return prefix + Buffer.from(JSON.stringify(descriptor.parse(input))).toString('base64url')
}

export function markDurableSystemRetainedReference(root: string, reference: string): void {
  writeFileSync(join(root, ownerFile), JSON.stringify({ reference }), { mode: 0o600 })
}

/** A persisted reference can be reopened only by the same selected scope, and
 * only for its original material generation. A replacement tree stays intact. */
export function releaseDurableSystemRetainedReference(input: {
  readonly retainedRef: string
  readonly expectedParent: string
  readonly expectedName: string
  readonly namespace: 'intent' | 'shared'
  readonly inspectOnly?: boolean
}): { removed: boolean; reason?: 'unsafe-path' | 'remove-failed' } | undefined {
  if (!input.retainedRef.startsWith(prefix)) return undefined
  const unavailable = { removed: false, reason: 'unsafe-path' as const }
  if (input.retainedRef.length > 16384) return unavailable
  let value: unknown
  try {
    value = JSON.parse(
      Buffer.from(input.retainedRef.slice(prefix.length), 'base64url').toString('utf8'),
    )
  } catch {
    return unavailable
  }
  const parsed = descriptor.safeParse(value)
  if (
    !parsed.success ||
    parsed.data.namespace !== input.namespace ||
    parsed.data.parent !== input.expectedParent ||
    parsed.data.root !== join(input.expectedParent, input.expectedName)
  )
    return unavailable
  try {
    const info = lstatSync(parsed.data.root)
    if (info.isSymbolicLink() || !info.isDirectory()) return unavailable
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { removed: true }
      : { removed: false, reason: 'remove-failed' }
  }
  try {
    const owner: unknown = JSON.parse(readFileSync(join(parsed.data.root, ownerFile), 'utf8'))
    if (
      owner === null ||
      typeof owner !== 'object' ||
      !('reference' in owner) ||
      owner.reference !== input.retainedRef
    )
      return unavailable
  } catch {
    return unavailable
  }
  if (input.inspectOnly) return { removed: false }
  return releaseSystemAgentScratch({
    scratchDir: parsed.data.root,
    expectedParent: input.expectedParent,
    expectedName: input.expectedName,
  })
}
