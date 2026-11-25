import type {
  AutomationWorkspaceEffects,
  AutomationWorkspaceEffectsFactory,
} from '../application/ports/automationWorkspaceEffects'
import { withSelectedAutomationWorkspaceEffects } from '../application/automationWorkspaceEffectLifetime'

type Completion<T> = T | Promise<T>

/**
 * RFC-600: checks a stated selection (the caller gives it — bootstrap the deployment's, tests or the in-image executor the
 * local implementation); there is no local fallback here.
 */
export function selectedAutomationWorkspaceEffects(
  factory: AutomationWorkspaceEffectsFactory,
): AutomationWorkspaceEffectsFactory {
  if (
    factory === null ||
    typeof factory.resolve !== 'function' ||
    typeof factory.parent !== 'function' ||
    typeof factory.acquire !== 'function'
  ) {
    throw new Error('automation-workspace-effects-factory-incomplete')
  }
  return factory
}

/** Finish a whole selected effect and its close before returning owner data. */
export async function withAutomationWorkspaceEffects<T>(
  chosen: AutomationWorkspaceEffectsFactory,
  body: (
    effects: AutomationWorkspaceEffects,
    factory: AutomationWorkspaceEffectsFactory,
  ) => Completion<T>,
): Promise<T> {
  return withSelectedAutomationWorkspaceEffects(selectedAutomationWorkspaceEffects(chosen), body)
}
