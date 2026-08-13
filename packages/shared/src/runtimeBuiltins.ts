// RFC-295 — discoverable runtime/task parameters.
//
// This table only describes values that already had a renderer before
// RFC-295. It does not add tokens or producers. Agent prompt validation and
// the CallWorkgroup goal producer both project their closed sets from here.

export const RUNTIME_BUILTIN_SURFACES = ['agent-prompt', 'call-workgroup-goal'] as const
export type RuntimeBuiltinSurface = (typeof RUNTIME_BUILTIN_SURFACES)[number]

export const RUNTIME_BUILTIN_GROUPS = [
  'repository',
  'identity',
  'iteration',
  'review',
  'clarify',
] as const
export type RuntimeBuiltinGroup = (typeof RUNTIME_BUILTIN_GROUPS)[number]

export type RuntimeBuiltinFormat =
  | 'plain'
  | 'conditional'
  | 'newline-paths'
  | 'newline-mount-paths'
  | 'bullet-name-paths'
  | 'comma-root-names'

export interface RuntimeBuiltinSurfaceSemantics {
  readonly format: RuntimeBuiltinFormat
  /** Stable i18n suffix. Display prose lives in the frontend locale bundle. */
  readonly descriptionKey: string
}

export interface RuntimeBuiltinParameterSpec {
  readonly name: `__${string}__`
  readonly group: RuntimeBuiltinGroup
  readonly semantics: Readonly<
    Partial<Record<RuntimeBuiltinSurface, RuntimeBuiltinSurfaceSemantics>>
  >
}

const both = <const Name extends RuntimeBuiltinParameterSpec['name']>(
  name: Name,
  group: RuntimeBuiltinGroup,
) =>
  ({
    name,
    group,
    semantics: {
      'agent-prompt': { format: 'plain', descriptionKey: `agent.${name}` },
      'call-workgroup-goal': { format: 'plain', descriptionKey: `workgroup.${name}` },
    },
  }) as const satisfies RuntimeBuiltinParameterSpec

export const RUNTIME_BUILTIN_PARAMETERS = [
  both('__repo_path__', 'repository'),
  both('__base_branch__', 'repository'),
  both('__task_id__', 'identity'),
  both('__node_id__', 'identity'),
  both('__iteration__', 'iteration'),
  both('__shard_key__', 'iteration'),
  {
    name: '__review_rejection__',
    group: 'review',
    semantics: {
      'agent-prompt': {
        format: 'conditional',
        descriptionKey: 'agent.__review_rejection__',
      },
    },
  },
  {
    name: '__review_comments__',
    group: 'review',
    semantics: {
      'agent-prompt': { format: 'conditional', descriptionKey: 'agent.__review_comments__' },
    },
  },
  {
    name: '__iterate_target_port__',
    group: 'review',
    semantics: {
      'agent-prompt': {
        format: 'conditional',
        descriptionKey: 'agent.__iterate_target_port__',
      },
    },
  },
  {
    name: '__sibling_outputs__',
    group: 'review',
    semantics: {
      'agent-prompt': { format: 'conditional', descriptionKey: 'agent.__sibling_outputs__' },
    },
  },
  {
    name: '__clarify_iteration__',
    group: 'clarify',
    semantics: {
      'agent-prompt': {
        format: 'conditional',
        descriptionKey: 'agent.__clarify_iteration__',
      },
    },
  },
  {
    name: '__clarify_remaining__',
    group: 'clarify',
    semantics: {
      'agent-prompt': {
        format: 'conditional',
        descriptionKey: 'agent.__clarify_remaining__',
      },
    },
  },
  {
    name: '__repos__',
    group: 'repository',
    semantics: {
      'agent-prompt': { format: 'newline-paths', descriptionKey: 'agent.__repos__' },
      'call-workgroup-goal': {
        format: 'bullet-name-paths',
        descriptionKey: 'workgroup.__repos__',
      },
    },
  },
  {
    name: '__repo_names__',
    group: 'repository',
    semantics: {
      'agent-prompt': {
        format: 'newline-mount-paths',
        descriptionKey: 'agent.__repo_names__',
      },
      'call-workgroup-goal': {
        format: 'comma-root-names',
        descriptionKey: 'workgroup.__repo_names__',
      },
    },
  },
  both('__repo_count__', 'repository'),
  {
    name: '__repo_group__',
    group: 'repository',
    semantics: {
      'agent-prompt': { format: 'plain', descriptionKey: 'agent.__repo_group__' },
    },
  },
] as const satisfies readonly RuntimeBuiltinParameterSpec[]

export type RuntimeBuiltinName = (typeof RUNTIME_BUILTIN_PARAMETERS)[number]['name']

export function runtimeBuiltinParametersFor(
  surface: RuntimeBuiltinSurface,
): readonly RuntimeBuiltinParameterSpec[] {
  return RUNTIME_BUILTIN_PARAMETERS.filter((spec) => surface in spec.semantics)
}

export const AGENT_PROMPT_BUILTIN_NAMES: ReadonlySet<RuntimeBuiltinName> = new Set(
  runtimeBuiltinParametersFor('agent-prompt').map((spec) => spec.name as RuntimeBuiltinName),
)

export const CALL_WORKGROUP_BUILTIN_NAMES = [
  '__repo_path__',
  '__base_branch__',
  '__task_id__',
  '__node_id__',
  '__iteration__',
  '__shard_key__',
  '__repos__',
  '__repo_names__',
  '__repo_count__',
] as const satisfies readonly RuntimeBuiltinName[]

export type CallWorkgroupBuiltinName = (typeof CALL_WORKGROUP_BUILTIN_NAMES)[number]
