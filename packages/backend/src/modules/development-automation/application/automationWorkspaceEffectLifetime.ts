import type {
  AutomationWorkspaceEffects,
  AutomationWorkspaceEffectsFactory,
} from './ports/automationWorkspaceEffects'
type Completion<T> = T | Promise<T>

/** Complete content-scope lifetime; default native selection belongs to composition. */
export async function withSelectedAutomationWorkspaceEffects<T>(
  factory: AutomationWorkspaceEffectsFactory,
  body: (
    effects: AutomationWorkspaceEffects,
    factory: AutomationWorkspaceEffectsFactory,
  ) => Completion<T>,
): Promise<T> {
  const effects = await factory.acquire()
  let result: T | undefined
  let bodyFailed = false
  let bodyError: unknown
  try {
    if (
      effects === null ||
      effects === undefined ||
      [
        'exists',
        'inspect',
        'listNames',
        'listEntries',
        'readBytes',
        'readText',
        'readLink',
        'createDirectory',
        'copyFile',
        'setMode',
        'writeText',
        'close',
      ].some((name) => typeof effects[name as keyof AutomationWorkspaceEffects] !== 'function')
    ) {
      throw new Error('automation-workspace-effects-scope-incomplete')
    }
    result = await body(effects, factory)
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
      'automation-workspace-effects-body-and-close-failed',
    )
  }
  if (bodyFailed) throw bodyError
  if (closeFailed) throw closeError
  return result as T
}
