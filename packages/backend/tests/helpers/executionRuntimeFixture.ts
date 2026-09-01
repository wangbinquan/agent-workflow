import type { DbClient } from '../../src/db/client'
import { composeSqliteRuntimeRegistryOperations } from '../../src/platform/runtime-registry/composition'

export const TEST_OPENCODE_MODEL = 'openai/gpt-5.6'

/**
 * RFC-224 requires every successful OpenCode product path to resolve an
 * explicit model. Keep legacy fixtures on their original implicit
 * `runtime ?? defaultRuntime ?? "opencode"` path while making that default
 * product-valid.
 */
export async function seedTestDefaultOpencodeRuntime(db: DbClient): Promise<void> {
  const runtimeRegistry = composeSqliteRuntimeRegistryOperations(db)
  const existing = await runtimeRegistry.getRuntime('opencode')
  if (existing === null) {
    await runtimeRegistry.createRuntime({
      name: 'opencode',
      protocol: 'opencode',
      model: TEST_OPENCODE_MODEL,
    })
    return
  }
  await runtimeRegistry.updateRuntime('opencode', { model: TEST_OPENCODE_MODEL })
}
