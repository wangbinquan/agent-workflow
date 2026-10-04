import type {
  AutomationWorkspaceEffects,
  AutomationWorkspaceEffectsFactory,
} from '../application/ports/automationWorkspaceEffects'
import { createFileAutomationWorkspaceEffectsFactory } from './local/fileAutomationWorkspaceEffects'
import { withSelectedAutomationWorkspaceEffects } from '../application/automationWorkspaceEffectLifetime'

type Completion<T> = T | Promise<T>

export function selectedAutomationWorkspaceEffects(
  factory: AutomationWorkspaceEffectsFactory | undefined,
): AutomationWorkspaceEffectsFactory {
  if (factory === undefined) return createFileAutomationWorkspaceEffectsFactory()
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
  chosen: AutomationWorkspaceEffectsFactory | undefined,
  body: (
    effects: AutomationWorkspaceEffects,
    factory: AutomationWorkspaceEffectsFactory,
  ) => Completion<T>,
): Promise<T> {
  return withSelectedAutomationWorkspaceEffects(selectedAutomationWorkspaceEffects(chosen), body)
}
