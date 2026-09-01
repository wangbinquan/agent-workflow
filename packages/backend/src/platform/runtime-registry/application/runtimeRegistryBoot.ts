import type { RuntimeRegistryOperations } from './runtimeRegistryOperations'

type RuntimeRegistryBootOperations = Pick<
  RuntimeRegistryOperations,
  'seedBuiltinRuntimes' | 'migrateConfigIntoBuiltins' | 'assertConfigDefaultsMigrated'
>

export interface RuntimeRegistryBootInput {
  readonly operations: RuntimeRegistryBootOperations
  readonly config: {
    readonly opencodePath?: string | null
    readonly claudeCodePath?: string | null
  }
  readonly configPath: string
  readonly onRecoverableFailure: (error: unknown) => void
}

/**
 * Provider-neutral daemon boot contract for the runtime registry.
 *
 * Provider persistence stays captured behind RuntimeRegistryOperations. Both
 * SQLite and PostgreSQL run the same ordered seed/backfill/data-loss guard, so
 * adding another provider cannot silently omit the built-in runtime lifecycle.
 */
export async function initializeRuntimeRegistryBoot(
  input: RuntimeRegistryBootInput,
): Promise<void> {
  try {
    await input.operations.seedBuiltinRuntimes()
    await input.operations.migrateConfigIntoBuiltins(input.config)
  } catch (error) {
    // Preserve the historical best-effort seed/backfill behavior. The
    // data-loss guard below remains fail-loud and is deliberately outside this
    // catch, exactly as it was in the original SQLite bootstrap.
    input.onRecoverableFailure(error)
  }
  await input.operations.assertConfigDefaultsMigrated(input.configPath)
}
