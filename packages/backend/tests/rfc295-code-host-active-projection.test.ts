import { describe, expect, test } from 'bun:test'
import {
  INTENT_CHANGESET_SCHEMA_VERSION,
  IntentChangesetSchema,
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { executeCodeHostCall } from '../src/services/codeHost/call'
import { validateDraftChangeset } from '../src/services/intent/resolveChangeset'
import { validateWorkflowDefinition } from '../src/services/workflow.validator'

function call(extra: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: 'host',
    kind: 'code-host-call',
    provider: 'gitlab',
    action: 'comment.create',
    params: {
      mr: '42',
      body: 'hello',
      state: '{{trigger.webhook.no_such_field}}',
    },
    request: {
      method: 'POST',
      path: '/inactive/{{trigger.webhook.no_such_field}}',
      body: '{not-json',
    },
    ...extra,
  } as WorkflowNode
}

function workflow(node: WorkflowNode): WorkflowDefinition {
  return { $schema_version: WORKFLOW_SCHEMA_VERSION, inputs: [], nodes: [node], edges: [] }
}

function issueCodes(node: WorkflowNode): string[] {
  return validateWorkflowDefinition(workflow(node), { agents: [], skills: [] }).issues.map(
    (issue) => issue.code,
  )
}

function deps(provider: 'gitlab' | 'github' = 'gitlab') {
  return {
    connection: {
      provider,
      baseUrl: provider === 'gitlab' ? 'https://gitlab.test/api/v4' : 'https://github.test',
      repositoryUrlPrefixes: [],
      token: 'rfc295-fixture-token', // gitleaks:allow
      rejectUnauthorized: true,
    },
    ctx: { ports: {}, triggerContext: null },
    projectFallback: { ok: true as const, value: 'group%2Frepo' },
    fetchImpl: async () =>
      new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } }),
    sleep: async () => {},
  }
}

describe('RFC-295 CodeHost active projection consumers', () => {
  test('workflow validation ignores inactive preset and request templates', () => {
    expect(issueCodes(call())).not.toContain('code-host-var-unknown')
    expect(issueCodes(call())).not.toContain('code-host-body-invalid')

    const switched = call({
      action: 'commit-status.set',
      params: {
        sha: 'abc',
        state: '{{trigger.webhook.no_such_field}}',
      },
    })
    expect(issueCodes(switched)).toContain('code-host-var-unknown')
  })

  test('Intent confirm scans the same active authoring projection', () => {
    const changeset = IntentChangesetSchema.parse({
      $schema_version: INTENT_CHANGESET_SCHEMA_VERSION,
      ops: [
        {
          opId: 'op-1',
          action: 'create',
          resourceType: 'workflow',
          tempRef: '$new:workflow-1',
          payload: {
            name: 'Active projection',
            description: '',
            definition: workflow(call()),
          },
        },
      ],
    })
    expect(validateDraftChangeset([], changeset).errors).toEqual([])
  })

  test('direct preset execution does not require context for an inactive trigger ref', async () => {
    const outcome = await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'comment.create',
        params: {
          mr: '42',
          body: 'hello',
          state: '{{trigger.webhook.pipeline_status}}',
        },
      },
      deps(),
    )
    expect(outcome.ok).toBe(true)
  })

  test('direct custom execution ignores all persisted params', async () => {
    const outcome = await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'custom',
        params: { body: '{{trigger.webhook.comment_text}}' },
        request: { method: 'POST', path: '/projects/1/notes', body: '{"body":"ok"}' },
      },
      deps(),
    )
    expect(outcome.ok).toBe(true)
  })

  test('invalid and unsupported actions win over hidden trigger-context errors', async () => {
    const invalid = await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'not-an-action',
        params: { body: '{{trigger.webhook.comment_text}}' },
      },
      deps(),
    )
    expect(invalid).toMatchObject({ ok: false, code: 'code-host-param-invalid' })
    if (!invalid.ok) expect(invalid.summary).toContain('unknown action')

    const unsupported = await executeCodeHostCall(
      {
        provider: 'github',
        action: 'thread.resolve',
        params: { body: '{{trigger.webhook.comment_text}}' },
      },
      deps('github'),
    )
    expect(unsupported).toMatchObject({ ok: false, code: 'code-host-param-invalid' })
    if (!unsupported.ok) expect(unsupported.summary).toContain('not supported')
  })
})
