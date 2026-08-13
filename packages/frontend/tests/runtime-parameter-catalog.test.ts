import { describe, expect, test } from 'vitest'
import {
  DEFAULT_RUNTIME_PARAMETER_PROVIDERS,
  buildRuntimeParameterCatalog,
  runtimeParameterMatches,
  type RuntimeParameterCatalogContext,
  type RuntimeParameterProvider,
} from '../src/components/runtime-parameters/catalog'

const t: RuntimeParameterCatalogContext['t'] = (key) => key

function context(
  over: Partial<RuntimeParameterCatalogContext> = {},
): RuntimeParameterCatalogContext {
  return {
    audience: 'workflow-inspector',
    surface: 'agent-prompt',
    t,
    ...over,
  }
}

describe('RFC-295 runtime parameter catalog', () => {
  test('all entries carry the five-level logical path, readable text and canonical token', () => {
    const entries = buildRuntimeParameterCatalog(context(), {
      local: [
        {
          id: 'local:node:input:artifact',
          source: 'current-node',
          field: 'artifact',
          token: '{{artifact}}',
          label: 'Artifact input',
          description: 'Text from the connected upstream output.',
        },
      ],
    })
    expect(entries.length).toBeGreaterThan(30)
    for (const entry of entries) {
      expect(Object.keys(entry.path)).toEqual(['scope', 'type', 'source', 'group', 'field'])
      expect(entry.label.length).toBeGreaterThan(0)
      expect(entry.description.length).toBeGreaterThan(0)
      expect(entry.token).toMatch(/^\{\{.+\}\}$/)
    }
  })

  test('workflow surfaces expose only their real runtime/task producer subset', () => {
    const agent = buildRuntimeParameterCatalog(context({ surface: 'agent-prompt' }))
    const workgroup = buildRuntimeParameterCatalog(context({ surface: 'call-workgroup-goal' }))
    const codeHost = buildRuntimeParameterCatalog(context({ surface: 'code-host' }))

    expect(agent.some((entry) => entry.token === '{{__review_comments__}}')).toBe(true)
    expect(workgroup.some((entry) => entry.token === '{{__review_comments__}}')).toBe(false)
    expect(workgroup.some((entry) => entry.token === '{{__repos__}}')).toBe(true)
    expect(codeHost.some((entry) => entry.path.source === 'task')).toBe(false)
  })

  test('webhook eventTypes intersection filters out unavailable leaves', () => {
    const entries = buildRuntimeParameterCatalog(
      context({ surface: 'webhook-launch', audience: 'webhook-launch', eventTypes: ['push'] }),
    )
    expect(entries.some((entry) => entry.token === '{{trigger.webhook.commit_sha}}')).toBe(true)
    expect(entries.some((entry) => entry.token === '{{trigger.webhook.comment_text}}')).toBe(false)
    expect(
      buildRuntimeParameterCatalog(
        context({ surface: 'webhook-launch', audience: 'webhook-launch', eventTypes: [] }),
      ),
    ).toEqual([])
  })

  test('search matches labels, explanations, tokens without braces, aliases and breadcrumbs', () => {
    const entry = buildRuntimeParameterCatalog(context()).find(
      (item) => item.token === '{{trigger.webhook.comment_text}}',
    )!
    expect(runtimeParameterMatches(entry, 'comment_text')).toBe(true)
    expect(runtimeParameterMatches(entry, '{{trigger.webhook.comment_text}}')).toBe(true)
    expect(runtimeParameterMatches(entry, 'runtimeParameters.source.webhook')).toBe(true)
    expect(runtimeParameterMatches(entry, 'definitely absent')).toBe(false)
  })

  test('a future scheduler provider appears without changing the builder while webhook launch stays scoped', () => {
    const scheduler: RuntimeParameterProvider = {
      id: 'trigger:scheduler',
      audiences: ['workflow-inspector'],
      surfaces: ['agent-prompt'],
      entries: () => [
        {
          id: 'global:trigger:scheduler:context:scheduled_at',
          token: '{{trigger.scheduler.scheduled_at}}',
          label: 'Scheduled time',
          description: 'Fixture-only future source.',
          path: {
            scope: 'global',
            type: 'trigger',
            source: 'scheduler',
            group: 'context',
            field: 'scheduled_at',
          },
          pathLabels: ['Global', 'Trigger', 'Scheduler', 'Context'],
        },
      ],
    }
    const providers = [...DEFAULT_RUNTIME_PARAMETER_PROVIDERS, scheduler]
    expect(buildRuntimeParameterCatalog(context(), { providers })).toContainEqual(
      expect.objectContaining({ token: '{{trigger.scheduler.scheduled_at}}' }),
    )
    expect(
      buildRuntimeParameterCatalog(
        context({ surface: 'webhook-launch', audience: 'webhook-launch' }),
        { providers },
      ),
    ).not.toContainEqual(expect.objectContaining({ token: '{{trigger.scheduler.scheduled_at}}' }))
  })

  test('duplicate stable ids or logical paths fail closed', () => {
    const duplicate: RuntimeParameterProvider = {
      id: 'duplicate',
      audiences: ['workflow-inspector'],
      surfaces: ['agent-prompt'],
      entries: () => [
        {
          id: 'same',
          token: '{{a}}',
          label: 'A',
          description: 'A',
          path: { scope: 'global', type: 'x', source: 'y', group: 'z', field: 'a' },
          pathLabels: ['G', 'X', 'Y', 'Z'],
        },
        {
          id: 'same',
          token: '{{b}}',
          label: 'B',
          description: 'B',
          path: { scope: 'global', type: 'x', source: 'y', group: 'z', field: 'b' },
          pathLabels: ['G', 'X', 'Y', 'Z'],
        },
      ],
    }
    expect(() => buildRuntimeParameterCatalog(context(), { providers: [duplicate] })).toThrow(
      'duplicate runtime parameter catalog entry',
    )
  })

  test('one malformed or reserved local port is unavailable without poisoning other sources', () => {
    const catalog = buildRuntimeParameterCatalog(context(), {
      local: [
        {
          id: 'local:good',
          source: 'current-node',
          field: 'artifact',
          token: '{{artifact}}',
          label: 'Artifact',
          description: 'A valid upstream value.',
        },
        {
          id: 'local:bad',
          source: 'current-node',
          field: 'trigger.webhook.comment_text',
          token: '{{trigger.webhook.comment_text}}',
          label: 'Reserved port',
          description: 'A user-derived invalid local value.',
        },
      ],
    })
    expect(catalog.find((entry) => entry.id === 'local:good')?.availability).toBe('available')
    expect(catalog.find((entry) => entry.id === 'local:bad')).toMatchObject({
      availability: 'unavailable',
      unavailableReason: expect.any(String),
    })
    expect(catalog.some((entry) => entry.token === '{{trigger.webhook.event_json}}')).toBe(true)
  })
})
