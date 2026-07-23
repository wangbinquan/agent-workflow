import type { DbClient } from '../../src/db/client'
import { createRuntime, getRuntime, updateRuntime } from '../../src/services/runtimeRegistry'

export const TEST_OPENCODE_MODEL = 'openai/gpt-5.6'

/**
 * RFC-224 requires every successful OpenCode product path to resolve an
 * explicit model. Keep legacy fixtures on their original implicit
 * `runtime ?? defaultRuntime ?? "opencode"` path while making that default
 * product-valid.
 */
export async function seedTestDefaultOpencodeRuntime(db: DbClient): Promise<void> {
  const existing = await getRuntime(db, 'opencode')
  if (existing === null) {
    await createRuntime(db, {
      name: 'opencode',
      protocol: 'opencode',
      model: TEST_OPENCODE_MODEL,
    })
    return
  }
  await updateRuntime(db, 'opencode', { model: TEST_OPENCODE_MODEL })
}
