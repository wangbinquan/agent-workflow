import { describe, expect, test } from 'bun:test'
import {
  AGENT_PROMPT_BUILTIN_NAMES,
  BUILTIN_VARS,
  CALL_WORKGROUP_BUILTIN_NAMES,
  CODE_HOST_ACTIONS,
  CODE_HOST_FIELDS,
  DEPRECATED_PROMPT_TOKENS,
  RUNTIME_TEMPLATE_AUTHORITY_KEYS,
  RUNTIME_BUILTIN_PARAMETERS,
  codeHostActionFields,
  codeHostActionSupported,
  collectActiveWorkflowTemplateSurfaces,
  collectTriggerDependencies,
  collectWebhookTemplateSurfaces,
  collectWorkflowTemplateSurfaces,
  projectCodeHostTemplates,
  runtimeBuiltinParametersFor,
  type WorkflowDefinition,
  type WorkflowNode,
} from '../src'

function call(extra: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: 'host',
    kind: 'code-host-call',
    provider: 'gitlab',
    action: 'comment.create',
    params: {
      project: 'group/repo',
      mr: '{{trigger.webhook.mr_iid}}',
      body: 'hello',
      state: '{{trigger.webhook.pipeline_status}}',
    },
    request: {
      method: 'POST',
      path: '/inactive/{{trigger.webhook.branch}}',
      query: { q: '{{trigger.webhook.comment_text}}' },
      body: '{{trigger.webhook.event_json}}',
    },
    ...extra,
  } as WorkflowNode
}

function workflow(node: WorkflowNode): WorkflowDefinition {
  return { $schema_version: 5, inputs: [], nodes: [node], edges: [] }
}

describe('RFC-295 runtime/task descriptor authority', () => {
  test('agent validation, picker descriptors and producer surfaces have exact sets', () => {
    const agentNames = runtimeBuiltinParametersFor('agent-prompt').map((spec) => spec.name)
    const callNames = runtimeBuiltinParametersFor('call-workgroup-goal').map((spec) => spec.name)

    expect([...BUILTIN_VARS]).toEqual(agentNames)
    expect([...AGENT_PROMPT_BUILTIN_NAMES]).toEqual(agentNames)
    expect(CALL_WORKGROUP_BUILTIN_NAMES).toEqual(callNames)
    expect(new Set(RUNTIME_BUILTIN_PARAMETERS.map((spec) => spec.name)).size).toBe(
      RUNTIME_BUILTIN_PARAMETERS.length,
    )
    for (const retired of DEPRECATED_PROMPT_TOKENS) {
      expect(agentNames).not.toContain(retired)
      expect(callNames).not.toContain(retired)
    }
  })

  test('surface-specific prose metadata preserves different runtime formats', () => {
    const repos = RUNTIME_BUILTIN_PARAMETERS.find((spec) => spec.name === '__repos__')!
    const names = RUNTIME_BUILTIN_PARAMETERS.find((spec) => spec.name === '__repo_names__')!

    expect(repos.semantics['agent-prompt']).toEqual({
      format: 'newline-paths',
      descriptionKey: 'agent.__repos__',
    })
    expect(repos.semantics['call-workgroup-goal']).toEqual({
      format: 'bullet-name-paths',
      descriptionKey: 'workgroup.__repos__',
    })
    expect(names.semantics['agent-prompt']?.format).toBe('newline-mount-paths')
    expect(names.semantics['call-workgroup-goal']?.format).toBe('comma-root-names')
  })
})

describe('RFC-295 total CodeHost active-template projection', () => {
  test('every action and provider has a total registry-derived projection', () => {
    const params = Object.fromEntries(CODE_HOST_FIELDS.map((field) => [field, `value:${field}`]))
    const request = {
      method: 'POST',
      path: '/custom/path',
      query: { q: 'query value', 'a/b~c': 'escaped value' },
      body: '{"ok":true}',
    }

    for (const provider of ['gitlab', 'github'] as const) {
      for (const action of CODE_HOST_ACTIONS) {
        const projected = projectCodeHostTemplates({ provider, action, params, request })
        if (!codeHostActionSupported(action, provider)) {
          expect(projected).toMatchObject({ kind: 'unsupported', provider, action, active: [] })
          continue
        }
        if (action === 'custom') {
          expect(projected).toMatchObject({
            kind: 'valid-custom',
            provider,
            action,
            activeFields: [],
          })
          expect(projected.active.map((entry) => entry.pointer)).toEqual([
            '/request/path',
            '/request/query/q',
            '/request/query/a~1b~0c',
            '/request/body',
          ])
          expect(projected.active.some((entry) => entry.pointer.startsWith('/params/'))).toBe(false)
          continue
        }

        const expectedFields = codeHostActionFields(action, provider).map((field) => field.name)
        expect(projected).toMatchObject({
          kind: 'valid-preset',
          provider,
          action,
          activeFields: expectedFields,
        })
        expect(projected.active.map((entry) => entry.pointer)).toEqual(
          expectedFields.map((field) => `/params/${field}`),
        )
        expect(projected.active.some((entry) => entry.pointer.startsWith('/request/'))).toBe(false)
      }
    }
  })

  test('preset sees only fields declared by the selected action', () => {
    const projected = projectCodeHostTemplates(call())
    expect(projected.kind).toBe('valid-preset')
    expect(projected.active.map((item) => item.pointer)).toEqual([
      '/params/project',
      '/params/mr',
      '/params/body',
    ])
    expect(projected.active.map((item) => item.text)).not.toContain(
      '{{trigger.webhook.pipeline_status}}',
    )
  })

  test('custom sees request values only and preserves params for a later switch back', () => {
    const node = call({ action: 'custom' })
    const custom = projectCodeHostTemplates(node)
    expect(custom.kind).toBe('valid-custom')
    expect(custom.active.map((item) => item.pointer)).toEqual([
      '/request/path',
      '/request/query/q',
      '/request/body',
    ])

    const restored = projectCodeHostTemplates({ ...node, action: 'comment.create' })
    expect(restored.kind).toBe('valid-preset')
    expect(restored.active.map((item) => item.pointer)).toEqual([
      '/params/project',
      '/params/mr',
      '/params/body',
    ])
  })

  test('unsupported and invalid discriminators are total empty projections', () => {
    expect(
      projectCodeHostTemplates({ ...call(), provider: 'github', action: 'thread.resolve' }),
    ).toMatchObject({ kind: 'unsupported', active: [] })
    expect(projectCodeHostTemplates({ ...call(), action: 'not-an-action' })).toMatchObject({
      kind: 'invalid-action',
      active: [],
    })
    expect(projectCodeHostTemplates({ ...call(), provider: 'gitea' })).toMatchObject({
      kind: 'invalid-provider',
      active: [],
    })
  })

  test('persisted inventory remains exhaustive while authoring dependencies are active-only', () => {
    const definition = workflow(call())
    expect(collectWorkflowTemplateSurfaces(definition).map((item) => item.pointer)).toEqual([
      '/nodes/0/params/project',
      '/nodes/0/params/mr',
      '/nodes/0/params/body',
      '/nodes/0/params/state',
      '/nodes/0/request/path',
      '/nodes/0/request/query/q',
      '/nodes/0/request/body',
    ])
    expect(collectActiveWorkflowTemplateSurfaces(definition).map((item) => item.pointer)).toEqual([
      '/nodes/0/params/project',
      '/nodes/0/params/mr',
      '/nodes/0/params/body',
    ])
    expect(collectTriggerDependencies([definition]).map((item) => item.field)).toEqual(['mr_iid'])
  })
})

describe('RFC-295 stable webhook sink families', () => {
  test('all launch kinds expose stable domain/kind/sink authority keys', () => {
    expect(
      collectWebhookTemplateSurfaces('workflow', {
        inputs: { topic: { kind: 'template', template: 'T' } },
        workingBranch: 'B',
      }).map(({ launchKind, sink, pointer }) => [launchKind, sink, pointer]),
    ).toEqual([
      ['workflow', 'workflow-input-text', '/inputs/topic/template'],
      ['workflow', 'working-branch', '/workingBranch'],
    ])
    expect(
      collectWebhookTemplateSurfaces('agent', {
        description: 'D',
        inputs: { prompt: 'P' },
        workingBranch: 'B',
      }).map(({ launchKind, sink, pointer }) => [launchKind, sink, pointer]),
    ).toEqual([
      ['agent', 'agent-description', '/description'],
      ['agent', 'agent-input', '/inputs/prompt'],
      ['agent', 'working-branch', '/workingBranch'],
    ])
    expect(
      collectWebhookTemplateSurfaces('workgroup', { goal: 'G' }).map(
        ({ launchKind, sink, pointer }) => [launchKind, sink, pointer],
      ),
    ).toEqual([['workgroup', 'workgroup-goal', '/goal']])
  })

  test('canonical shared fixtures exercise every stable runtime-template authority exactly', () => {
    const workflowAuthorities = collectWorkflowTemplateSurfaces({
      $schema_version: 5,
      inputs: [],
      edges: [],
      nodes: [
        { id: 'agent', kind: 'agent-single', agentId: 'a', promptTemplate: 'P' },
        { id: 'group', kind: 'call-workgroup', workgroupId: 'w', goalTemplate: 'G' },
        { id: 'review', kind: 'review', commentInjectTemplate: 'R' },
        call(),
      ] as WorkflowNode[],
    }).map((surface) => surface.authorityKey)
    const webhookAuthorities = [
      ...collectWebhookTemplateSurfaces('workflow', {
        inputs: { topic: { kind: 'template', template: 'T' } },
        workingBranch: 'B',
      }),
      ...collectWebhookTemplateSurfaces('agent', {
        description: 'D',
        inputs: { prompt: 'P' },
        workingBranch: 'B',
      }),
      ...collectWebhookTemplateSurfaces('workgroup', {
        goal: 'G',
        workingBranch: 'B',
      }),
      ...collectWebhookTemplateSurfaces('digital-employee', {
        intakeKind: 'body',
        target: { repository: 'T' },
        body: 'D',
      }),
      ...collectWebhookTemplateSurfaces('digital-employee', {
        intakeKind: 'external-id',
        externalId: 'E',
      }),
    ].map((surface) => surface.authorityKey)

    const sourceOwnedAuthorities = [...new Set([...workflowAuthorities, ...webhookAuthorities])]
    expect(sourceOwnedAuthorities.sort()).toEqual(
      [...RUNTIME_TEMPLATE_AUTHORITY_KEYS]
        .filter((authority) => !authority.startsWith('event:'))
        .sort(),
    )
  })
})
