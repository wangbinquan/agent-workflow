import {
  AGENT_LAUNCH_INPUT_MAX_LEN,
  deriveAgentLaunchForm,
  type Agent,
  type AgentLaunchForm,
  type DerivedLaunchInput,
} from '@agent-workflow/shared'

export interface AgentTargetPayloadDraft {
  readonly description: string
  readonly descriptionPresent: boolean
  readonly inputs: Readonly<Record<string, string>>
  readonly inputsPresent: boolean
}

export type WebhookAgentBlocker =
  | { readonly kind: 'signal'; readonly port: string; readonly agentKind: string }
  | { readonly kind: 'upload'; readonly port: string; readonly agentKind: string }
  | {
      readonly kind: 'invalid-name'
      readonly port: string
      readonly agentKind: string
      readonly reason: string
    }

export type WebhookAgentRepair =
  | { readonly kind: 'inputs-on-zero'; readonly keys: readonly string[] }
  | { readonly kind: 'description-on-ported' }
  | { readonly kind: 'orphan-input'; readonly key: string; readonly value: string }
  | {
      readonly kind: 'incompatible-input'
      readonly key: string
      readonly value: string
      readonly agentKind: string
    }

export type WebhookAgentResolvedShape =
  | {
      readonly kind: 'zero'
      readonly signature: 'zero'
      readonly form: null
      readonly inputs: readonly []
      readonly blockers: readonly WebhookAgentBlocker[]
      readonly repairs: readonly WebhookAgentRepair[]
    }
  | {
      readonly kind: 'ported'
      readonly signature: string
      readonly form: AgentLaunchForm
      readonly inputs: readonly DerivedLaunchInput[]
      readonly blockers: readonly WebhookAgentBlocker[]
      readonly repairs: readonly WebhookAgentRepair[]
    }

function blockersOf(form: AgentLaunchForm): WebhookAgentBlocker[] {
  const kinds = new Map(form.inputs.map((input) => [input.key, input.agentKind]))
  const blockers: WebhookAgentBlocker[] = form.blockers.map((blocker) =>
    blocker.kind === 'signal-port'
      ? {
          kind: 'signal',
          port: blocker.port,
          agentKind: kinds.get(blocker.port) ?? 'signal',
        }
      : {
          kind: 'invalid-name',
          port: blocker.port,
          agentKind: kinds.get(blocker.port) ?? 'unknown',
          reason: blocker.reason,
        },
  )
  for (const input of form.inputs) {
    if (input.kind !== 'upload') continue
    blockers.push({ kind: 'upload', port: input.key, agentKind: input.agentKind })
  }
  return blockers
}

function structureSignature(form: AgentLaunchForm): string {
  return JSON.stringify(
    form.inputs.map((input) => ({
      key: input.key,
      kind: input.kind,
      presentation: input.presentation ?? null,
      required: input.required === true,
      agentKind: input.agentKind,
      multiline: 'multiline' in input ? input.multiline === true : false,
    })),
  )
}

export function resolveWebhookAgentShape(
  agent: Pick<Agent, 'inputs'>,
  draft: AgentTargetPayloadDraft,
): WebhookAgentResolvedShape {
  const form = deriveAgentLaunchForm(agent.inputs)
  if (form === null) {
    return {
      kind: 'zero',
      signature: 'zero',
      form: null,
      inputs: [],
      blockers: [],
      repairs: draft.inputsPresent
        ? [{ kind: 'inputs-on-zero', keys: Object.keys(draft.inputs).sort() }]
        : [],
    }
  }

  const blockers = blockersOf(form)
  const declared = new Map(form.inputs.map((input) => [input.key, input]))
  const blocked = new Map(blockers.map((blocker) => [blocker.port, blocker]))
  const repairs: WebhookAgentRepair[] = []
  if (draft.descriptionPresent) repairs.push({ kind: 'description-on-ported' })
  if (draft.inputsPresent) {
    for (const [key, value] of Object.entries(draft.inputs)) {
      const input = declared.get(key)
      if (input === undefined) repairs.push({ kind: 'orphan-input', key, value })
      else if (blocked.has(key)) {
        repairs.push({ kind: 'incompatible-input', key, value, agentKind: input.agentKind })
      }
    }
  }
  return {
    kind: 'ported',
    signature: structureSignature(form),
    form,
    inputs: form.inputs,
    blockers,
    repairs,
  }
}

export function repairWebhookAgentPayload(
  shape: WebhookAgentResolvedShape,
  draft: AgentTargetPayloadDraft,
): AgentTargetPayloadDraft {
  if (shape.kind === 'zero') {
    return { ...draft, inputs: {}, inputsPresent: false }
  }
  const allowed = new Set(shape.inputs.map((input) => input.key))
  const blocked = new Set(shape.blockers.map((blocker) => blocker.port))
  return {
    description: '',
    descriptionPresent: false,
    inputs: Object.fromEntries(
      Object.entries(draft.inputs).filter(([key]) => allowed.has(key) && !blocked.has(key)),
    ),
    inputsPresent: true,
  }
}

export function webhookAgentShapeError(
  shape: WebhookAgentResolvedShape,
  draft: AgentTargetPayloadDraft,
):
  | 'blockers'
  | 'repairs'
  | 'description-required'
  | 'description-too-long'
  | 'required-inputs'
  | null {
  if (shape.blockers.length > 0) return 'blockers'
  if (shape.repairs.length > 0) return 'repairs'
  if (shape.kind === 'zero') {
    if (draft.description.trim() === '') return 'description-required'
    if (draft.description.length > AGENT_LAUNCH_INPUT_MAX_LEN) return 'description-too-long'
    return null
  }
  const missing = shape.inputs.some(
    (input) =>
      input.kind !== 'upload' &&
      input.required === true &&
      (draft.inputs[input.key] ?? '').trim() === '',
  )
  return missing ? 'required-inputs' : null
}

export function agentTargetPayloadHasContent(draft: AgentTargetPayloadDraft): boolean {
  return (
    draft.descriptionPresent ||
    draft.inputsPresent ||
    draft.description !== '' ||
    Object.keys(draft.inputs).length > 0
  )
}
