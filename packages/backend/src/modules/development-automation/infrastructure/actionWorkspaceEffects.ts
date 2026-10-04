import type { ActionWorkspaceEffects } from '../application/ports/actionWorkspaceEffects'
import { createFileActionWorkspaceEffects } from './local/fileActionWorkspaceEffects'
import type { AutomationWorkspaceEffectsFactory } from '../application/ports/automationWorkspaceEffects'
import { selectedAutomationWorkspaceEffects } from './automationWorkspaceEffects'

export function selectActionWorkspaceEffects(
  selected: ActionWorkspaceEffects | undefined,
): ActionWorkspaceEffects {
  if (selected === undefined) return createFileActionWorkspaceEffects()
  if (
    selected === null ||
    ['allocate', 'cloneBaseline', 'run', 'installPlatformExclude', 'requireEntry', 'discard'].some(
      (name) => typeof selected[name as keyof ActionWorkspaceEffects] !== 'function',
    ) ||
    selected.contents === null ||
    selected.contents === undefined ||
    ['resolve', 'parent', 'acquire'].some(
      (name) =>
        typeof selected.contents[name as keyof ActionWorkspaceEffects['contents']] !== 'function',
    )
  ) {
    throw new Error('action-workspace-effects-incomplete')
  }
  return selected
}

/** Bootstrap selects paired owners before either can allocate a conflict scene. */
export function selectDevelopmentWorkspaceEffectBinding(input: {
  readonly actionWorkspaceEffects?: ActionWorkspaceEffects
  readonly automationWorkspaceEffects?: AutomationWorkspaceEffectsFactory
  readonly conflictWorkspaceSelected: boolean
}): {
  readonly actionWorkspaceEffects: ActionWorkspaceEffects
  readonly automationWorkspaceEffects: AutomationWorkspaceEffectsFactory
} {
  if (input.conflictWorkspaceSelected && input.actionWorkspaceEffects === undefined) {
    throw new Error('conflict-workspace-action-effects-required')
  }
  const actionWorkspaceEffects = selectActionWorkspaceEffects(input.actionWorkspaceEffects)
  const automationWorkspaceEffects = selectedAutomationWorkspaceEffects(
    input.automationWorkspaceEffects === undefined
      ? actionWorkspaceEffects.contents
      : input.automationWorkspaceEffects,
  )
  return Object.freeze({ actionWorkspaceEffects, automationWorkspaceEffects })
}
