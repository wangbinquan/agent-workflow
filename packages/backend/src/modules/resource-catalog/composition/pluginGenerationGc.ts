import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createPluginGenerationGcCommand } from '../application/pluginGenerationGc'
import type { PluginGenerationFilesystemGcPort } from '../application/ports/pluginGenerationGc'
import type { PluginGenerationGcCommand } from '../public/commands'
import { createPluginGenerationReferenceReadPort } from '../infrastructure/pluginGenerationGc'

export type { PluginGenerationFilesystemGcPort }

/** RFC-359 W4-D17 —— 插件代际清扫命令一份装配（此前 SQLite / PG 各一份只做绑定的具名装配）。 */
export function composePluginGenerationGcCommand(
  db: PersistenceDb,
  filesystem: PluginGenerationFilesystemGcPort,
): PluginGenerationGcCommand {
  return createPluginGenerationGcCommand({
    references: createPluginGenerationReferenceReadPort(db),
    filesystem,
  })
}

export {
  createPluginGenerationFilesystemGcPort,
  hasPluginGenerationGcCandidates,
  type PluginGenerationFilesystemGcInput,
  type PluginGenerationFilesystemGcAdapter,
} from '../infrastructure/local/filePluginGenerationGc'

// RFC-456 (RFC-294 W9-D): the maintenance binding below moved here from `services/pluginGenerationGc.ts`, whose
// other exports were identity forwards of the ones above.
// RFC-201 T10.2 — conservative Plugin generation orphan/old GC.
//
// A generation is removed only when no Plugin row references it, it has aged
// past grace, and there are no non-terminal node runs at all. The last gate is
// intentionally coarse: until runtime paths are persisted per run, absence of
// all active work is the only cheap proof that an old cachedPath is not still
// being imported by a child process. Uncertainty retains data.

const DEFAULT_GRACE_MS = 24 * 60 * 60_000

export async function runPluginGenerationGc(opts: {
  command: PluginGenerationGcCommand
  executionFence: 'clear' | 'busy'
  graceMs?: number
  now?: number
}): Promise<string[]> {
  const receipt = await opts.command.run({
    executionFence: opts.executionFence,
    graceMs: opts.graceMs ?? DEFAULT_GRACE_MS,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  })
  return [...receipt.removedGenerationPaths]
}
