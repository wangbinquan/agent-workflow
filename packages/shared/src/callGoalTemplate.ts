// RFC-292 — parent-side call-workgroup goal rendering shared by runtime and UI.

import { triggerContextValue, type TriggerContext } from './triggerContext'
import { renderTemplateRefs, type TemplateRefIssue } from './templateRef'

export type CallWorkgroupGoalRenderResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: 'trigger-context-missing' }
  | {
      readonly ok: false
      readonly code: 'invalid-template-ref'
      readonly reason: TemplateRefIssue
    }

export function renderCallWorkgroupGoalTemplate(args: {
  template: string
  inputs: Readonly<Record<string, string>>
  builtins: Readonly<Record<string, string>>
  triggerContext: TriggerContext | null
}): CallWorkgroupGoalRenderResult {
  let missingContext = false
  const rendered = renderTemplateRefs(args.template, (ref) => {
    if (ref.kind === 'trigger') {
      if (args.triggerContext === null) {
        missingContext = true
        return ''
      }
      return triggerContextValue(args.triggerContext, ref.source, ref.field)
    }
    if (Object.hasOwn(args.builtins, ref.name)) return args.builtins[ref.name] ?? ''
    return args.inputs[ref.name] ?? ''
  })
  if (rendered.invalid.length > 0) {
    return {
      ok: false,
      code: 'invalid-template-ref',
      reason: rendered.invalid[0]!.reason,
    }
  }
  if (missingContext) return { ok: false, code: 'trigger-context-missing' }
  return { ok: true, value: rendered.value }
}
