import type {
  ResourcePackageRecoveryEffects,
  ResourcePackageRecoveryEffectsFactory,
} from '../application/package/recoveryContentEffects'
import { createFileResourcePackageRecoveryEffectsFactory } from './local/fileResourcePackageRecoveryEffects'

type Completion<T> = T | Promise<T>

function requireCompleteFactory(
  factory: ResourcePackageRecoveryEffectsFactory,
): ResourcePackageRecoveryEffectsFactory {
  if (
    factory === null ||
    factory === undefined ||
    [
      'root',
      'live',
      'version',
      'staged',
      'candidate',
      'normalize',
      'parent',
      'storedReference',
      'assertManaged',
      'acquire',
    ].some(
      (name) => typeof factory[name as keyof ResourcePackageRecoveryEffectsFactory] !== 'function',
    )
  ) {
    throw new Error('resource-package-recovery-effects-factory-incomplete')
  }
  return factory
}

export function selectedResourcePackageRecoveryEffects(
  factory: ResourcePackageRecoveryEffectsFactory | undefined,
  appHome: string,
): ResourcePackageRecoveryEffectsFactory {
  return requireCompleteFactory(
    factory === undefined ? createFileResourcePackageRecoveryEffectsFactory(appHome) : factory,
  )
}

/** Return to AW only after the complete content phase and its close have settled. */
export async function withResourcePackageRecoveryEffects<T>(
  factory: ResourcePackageRecoveryEffectsFactory,
  body: (effects: ResourcePackageRecoveryEffects) => Completion<T>,
): Promise<T> {
  const effects = await requireCompleteFactory(factory).acquire()
  let result: T | undefined
  let bodyFailed = false
  let bodyError: unknown
  try {
    if (
      effects === null ||
      effects === undefined ||
      [
        'exists',
        'createDirectory',
        'removeDirectory',
        'move',
        'cleanupOperation',
        'swapStaged',
        'restoreBackup',
        'directoryChainState',
        'hashRegularTree',
        'close',
      ].some((name) => typeof effects[name as keyof ResourcePackageRecoveryEffects] !== 'function')
    ) {
      throw new Error('resource-package-recovery-effects-scope-incomplete')
    }
    result = await body(effects)
  } catch (error) {
    bodyFailed = true
    bodyError = error
  }
  let closeFailed = false
  let closeError: unknown
  try {
    if (effects !== null && effects !== undefined && typeof effects.close === 'function') {
      await effects.close()
    }
  } catch (error) {
    closeFailed = true
    closeError = error
  }
  if (bodyFailed && closeFailed) {
    throw new AggregateError(
      [bodyError, closeError],
      'resource-package-recovery-effects-body-and-close-failed',
    )
  }
  if (bodyFailed) throw bodyError
  if (closeFailed) throw closeError
  return result as T
}
