import {
  WEBHOOK_VAR_GROUPS,
  availableVarsFor,
  runtimeBuiltinParametersFor,
  webhookTriggerToken,
  parseTemplate,
  type CodeHostEventType,
  type RuntimeBuiltinSurface,
  type WebhookTemplateVar,
} from '@agent-workflow/shared'

export type RuntimeParameterSurface =
  | 'agent-prompt'
  | 'call-workgroup-goal'
  | 'review-comment'
  | 'code-host'
  | 'webhook-launch'

export type RuntimeParameterAudience = 'workflow-inspector' | 'webhook-launch'
export type RuntimeParameterScope = 'global' | 'local'

export interface RuntimeParameterPath {
  readonly scope: string
  readonly type: string
  readonly source: string
  readonly group: string
  readonly field: string
}

export interface RuntimeParameterEntry {
  readonly id: string
  readonly token: string
  readonly label: string
  readonly description: string
  readonly path: RuntimeParameterPath
  readonly pathLabels: readonly [string, string, string, string]
  readonly aliases?: readonly string[]
  readonly availability?: 'available' | 'unavailable'
  readonly unavailableReason?: string
}

export interface RuntimeParameterCatalogContext {
  readonly audience: RuntimeParameterAudience
  readonly surface: RuntimeParameterSurface
  readonly eventTypes?: readonly CodeHostEventType[]
  readonly t: (key: string, options?: Record<string, unknown>) => string
}

export interface RuntimeParameterProvider {
  readonly id: string
  readonly audiences: readonly RuntimeParameterAudience[]
  readonly surfaces: readonly RuntimeParameterSurface[]
  readonly entries: (context: RuntimeParameterCatalogContext) => readonly RuntimeParameterEntry[]
}

export interface LocalRuntimeParameter {
  readonly id: string
  readonly field: string
  readonly token: string
  readonly label: string
  readonly description: string
  readonly source: 'current-node' | 'review-context'
  readonly aliases?: readonly string[]
  readonly unavailableReason?: string
}

function parameterPath(
  scope: RuntimeParameterScope,
  type: string,
  source: string,
  group: string,
  field: string,
): RuntimeParameterPath {
  return { scope, type, source, group, field }
}

function webhookEntries(context: RuntimeParameterCatalogContext): RuntimeParameterEntry[] {
  const available = context.eventTypes === undefined ? null : availableVarsFor(context.eventTypes)
  const scope = context.t('runtimeParameters.scope.global')
  const type = context.t('runtimeParameters.type.trigger')
  const source = context.t('runtimeParameters.source.webhook')
  return WEBHOOK_VAR_GROUPS.flatMap((group) => {
    const groupLabel = context.t(
      group.key === 'api'
        ? 'runtimeParameters.group.webhookApi'
        : 'runtimeParameters.group.webhookContext',
    )
    return group.vars.flatMap((field) => {
      if (available !== null && !available.has(field)) return []
      return [
        {
          id: `global:trigger:webhook:${group.key}:${field}`,
          token: webhookTriggerToken(field),
          label: context.t(`runtimeParameters.webhookLabels.${field}`),
          description: [
            context.t(`webhookTriggers.fields.vars.${field}`),
            ...(context.audience === 'workflow-inspector'
              ? [context.t('runtimeParameters.optionalWebhook')]
              : []),
          ].join(' '),
          path: parameterPath('global', 'trigger', 'webhook', group.key, field),
          pathLabels: [scope, type, source, groupLabel],
          aliases: [field, `trigger.webhook.${field}`],
        },
      ]
    })
  })
}

const WEBHOOK_PROVIDER: RuntimeParameterProvider = {
  id: 'trigger:webhook',
  audiences: ['workflow-inspector', 'webhook-launch'],
  surfaces: [
    'agent-prompt',
    'call-workgroup-goal',
    'review-comment',
    'code-host',
    'webhook-launch',
  ],
  entries: webhookEntries,
}

function runtimeTaskEntries(context: RuntimeParameterCatalogContext): RuntimeParameterEntry[] {
  if (context.surface !== 'agent-prompt' && context.surface !== 'call-workgroup-goal') return []
  const surface: RuntimeBuiltinSurface = context.surface
  const scope = context.t('runtimeParameters.scope.global')
  const type = context.t('runtimeParameters.type.runtime')
  const source = context.t('runtimeParameters.source.task')
  return runtimeBuiltinParametersFor(surface).map((spec) => {
    const semantics = spec.semantics[surface]
    if (semantics === undefined) {
      throw new Error(`runtime builtin '${spec.name}' has no semantics for '${surface}'`)
    }
    const groupLabel = context.t(`runtimeParameters.group.${spec.group}`)
    return {
      id: `global:runtime:task:${spec.group}:${spec.name}`,
      token: `{{${spec.name}}}`,
      label: context.t(`runtimeParameters.builtins.${spec.name}.label`),
      description: context.t(
        `runtimeParameters.builtins.${spec.name}.${surface === 'agent-prompt' ? 'agent' : 'workgroup'}`,
      ),
      path: parameterPath('global', 'runtime', 'task', spec.group, spec.name),
      pathLabels: [scope, type, source, groupLabel],
      aliases: [spec.name, semantics.format],
    }
  })
}

const RUNTIME_TASK_PROVIDER: RuntimeParameterProvider = {
  id: 'runtime:task',
  audiences: ['workflow-inspector'],
  surfaces: ['agent-prompt', 'call-workgroup-goal'],
  entries: runtimeTaskEntries,
}

export const DEFAULT_RUNTIME_PARAMETER_PROVIDERS: readonly RuntimeParameterProvider[] = [
  WEBHOOK_PROVIDER,
  RUNTIME_TASK_PROVIDER,
]

export function localRuntimeParameterEntries(
  parameters: readonly LocalRuntimeParameter[],
  t: RuntimeParameterCatalogContext['t'],
): RuntimeParameterEntry[] {
  const scope = t('runtimeParameters.scope.local')
  const type = t(
    parameters.some((parameter) => parameter.source === 'current-node')
      ? 'runtimeParameters.type.node'
      : 'runtimeParameters.type.context',
  )
  return parameters.map((parameter) => {
    const isInput = parameter.source === 'current-node'
    const source = t(
      isInput ? 'runtimeParameters.source.currentNode' : 'runtimeParameters.source.review',
    )
    const group = t(isInput ? 'runtimeParameters.group.input' : 'runtimeParameters.group.review')
    const parsed = parseTemplate(parameter.token)
    const segment = parsed.length === 1 ? parsed[0] : undefined
    const tokenValid =
      segment?.kind === 'ref' &&
      segment.ref.kind === 'local' &&
      segment.ref.name === parameter.field &&
      segment.span.start === 0 &&
      segment.span.end === parameter.token.length
    const unavailableReason =
      parameter.unavailableReason ??
      (tokenValid
        ? undefined
        : t('runtimeParameters.invalidLocalParameter', { port: parameter.field }))
    return {
      id: parameter.id,
      token: parameter.token,
      label: parameter.label,
      description: parameter.description,
      path: parameterPath(
        'local',
        isInput ? 'node' : 'context',
        parameter.source,
        isInput ? 'input' : 'review',
        parameter.field,
      ),
      pathLabels: [scope, type, source, group],
      aliases: parameter.aliases,
      availability:
        unavailableReason === undefined ? ('available' as const) : ('unavailable' as const),
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
    }
  })
}

export function buildRuntimeParameterCatalog(
  context: RuntimeParameterCatalogContext,
  options: {
    readonly local?: readonly LocalRuntimeParameter[]
    readonly providers?: readonly RuntimeParameterProvider[]
  } = {},
): RuntimeParameterEntry[] {
  const providers = options.providers ?? DEFAULT_RUNTIME_PARAMETER_PROVIDERS
  const global = providers.flatMap((provider) =>
    provider.audiences.includes(context.audience) && provider.surfaces.includes(context.surface)
      ? provider.entries(context)
      : [],
  )
  const local = localRuntimeParameterEntries(options.local ?? [], context.t)
  const ids = new Set<string>()
  const paths = new Set<string>()
  for (const entry of [...local, ...global]) {
    const path = Object.values(entry.path).join('/')
    if (ids.has(entry.id) || paths.has(path)) {
      throw new Error(`duplicate runtime parameter catalog entry '${entry.id}' at '${path}'`)
    }
    ids.add(entry.id)
    paths.add(path)
    if (entry.description.trim() === '' || entry.label.trim() === '') {
      throw new Error(`runtime parameter catalog entry '${entry.id}' has empty text`)
    }
    if (entry.availability === 'unavailable' && entry.unavailableReason?.trim() === '') {
      throw new Error(`runtime parameter catalog entry '${entry.id}' has no unavailable reason`)
    }
  }
  return [...local, ...global]
}

function normalizedSearch(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replaceAll('{{', '')
    .replaceAll('}}', '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function runtimeParameterMatches(entry: RuntimeParameterEntry, query: string): boolean {
  const needle = normalizedSearch(query)
  if (needle === '') return true
  const haystack = normalizedSearch(
    [
      entry.label,
      entry.description,
      entry.token,
      ...entry.pathLabels,
      ...Object.values(entry.path),
      ...(entry.aliases ?? []),
    ].join(' '),
  )
  return haystack.includes(needle)
}

export function runtimeParameterBreadcrumb(entry: RuntimeParameterEntry): string {
  return [...entry.pathLabels, entry.label].join(' / ')
}

export function webhookFieldOfEntry(entry: RuntimeParameterEntry): WebhookTemplateVar | null {
  if (entry.path.type !== 'trigger' || entry.path.source !== 'webhook') return null
  return entry.path.field as WebhookTemplateVar
}
