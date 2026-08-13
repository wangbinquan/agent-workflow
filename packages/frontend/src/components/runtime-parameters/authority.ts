import {
  RUNTIME_TEMPLATE_AUTHORITY_KEYS,
  type RuntimeTemplateAuthorityKey,
} from '@agent-workflow/shared'

import type { RuntimeParameterAudience, RuntimeParameterSurface } from './catalog'
import type { RuntimeParameterTarget, RuntimeParameterTargetMode } from './target'

export interface RuntimeParameterAuthorityAdapter {
  readonly audience: RuntimeParameterAudience
  readonly surface: RuntimeParameterSurface
  readonly modes: readonly RuntimeParameterTargetMode[]
}

const CARET = ['insert-at-caret'] as const

/** Exhaustive stable-family registry consumed by every production picker. */
export const RUNTIME_PARAMETER_AUTHORITY_ADAPTERS = {
  'workflow:model-prompt': {
    audience: 'workflow-inspector',
    surface: 'agent-prompt',
    modes: CARET,
  },
  'workflow:workgroup-goal': {
    audience: 'workflow-inspector',
    surface: 'call-workgroup-goal',
    modes: CARET,
  },
  'workflow:review-prompt': {
    audience: 'workflow-inspector',
    surface: 'review-comment',
    modes: CARET,
  },
  'workflow:http-param': {
    audience: 'workflow-inspector',
    surface: 'code-host',
    modes: ['insert-at-caret', 'replace-whole-value'],
  },
  'workflow:http-path': {
    audience: 'workflow-inspector',
    surface: 'code-host',
    modes: CARET,
  },
  'workflow:http-query': {
    audience: 'workflow-inspector',
    surface: 'code-host',
    modes: CARET,
  },
  'workflow:http-json-body': {
    audience: 'workflow-inspector',
    surface: 'code-host',
    modes: CARET,
  },
  'webhook:workflow:workflow-input-text': {
    audience: 'webhook-launch',
    surface: 'webhook-launch',
    modes: CARET,
  },
  'webhook:workflow:working-branch': {
    audience: 'webhook-launch',
    surface: 'webhook-launch',
    modes: CARET,
  },
  'webhook:agent:agent-description': {
    audience: 'webhook-launch',
    surface: 'webhook-launch',
    modes: CARET,
  },
  'webhook:agent:agent-input': {
    audience: 'webhook-launch',
    surface: 'webhook-launch',
    modes: CARET,
  },
  'webhook:agent:working-branch': {
    audience: 'webhook-launch',
    surface: 'webhook-launch',
    modes: CARET,
  },
  'webhook:workgroup:workgroup-goal': {
    audience: 'webhook-launch',
    surface: 'webhook-launch',
    modes: CARET,
  },
  'webhook:workgroup:working-branch': {
    audience: 'webhook-launch',
    surface: 'webhook-launch',
    modes: CARET,
  },
} satisfies Record<RuntimeTemplateAuthorityKey, RuntimeParameterAuthorityAdapter>

export function runtimeParameterTargetForAuthority(
  authority: RuntimeTemplateAuthorityKey,
  target: RuntimeParameterTarget,
): RuntimeParameterTarget {
  const adapter = RUNTIME_PARAMETER_AUTHORITY_ADAPTERS[authority]
  if (!(adapter.modes as readonly RuntimeParameterTargetMode[]).includes(target.mode)) {
    throw new Error(
      `runtime parameter authority '${authority}' does not support target mode '${target.mode}'`,
    )
  }
  return target
}

export function runtimeParameterAuthorityKeys(): readonly RuntimeTemplateAuthorityKey[] {
  return RUNTIME_TEMPLATE_AUTHORITY_KEYS
}
