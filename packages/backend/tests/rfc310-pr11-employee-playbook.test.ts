// RFC-310 PR-11/12 — business employee playbook contract.
//
// Locks the user-facing model requested after the original RFC delivery:
// steps say who does what and where success/failure goes; MR problem producers
// and handlers are closed; child employees and approvals are first-class
// producers. The compiler is pure and the publish validator, not an Agent,
// rejects ambiguous or incomplete control flow.

import { describe, expect, test } from 'bun:test'

import {
  compileEmployeePlaybook,
  digitalEmployeeContentSchema,
  validateDigitalEmployeeForPublish,
  type DigitalEmployeeContent,
  type EmployeePublishLookup,
} from '../src/modules/development-automation/domain/digitalEmployee'
import { unknownKeySurvivors } from './helpers/rfc310UnknownKeyHarness'

const ref = (id: string, revision = 1) => ({ id, revision })

const CONTENT = {
  schemaVersion: 1,
  description: 'Java employee with cross-repository gate repair and approval',
  businessStatus: 'enabled',
  supportedRepositoryFacts: [],
  steps: [
    {
      stepId: 'understand',
      displayName: 'Understand the request',
      description: 'Read the frozen requirement bundle.',
      when: [],
      producer: { kind: 'agent', implementationRef: ref('tpl-analyze') },
      input: { kind: 'mission-requirement' },
      onSuccess: 'repair-gate-repo',
      join: null,
      onFailure: {
        retry: { sameScene: 1, freshScene: 1 },
        onExhausted: 'block',
        onRejected: null,
        onExpired: null,
      },
    },
    {
      stepId: 'repair-gate-repo',
      displayName: 'Ask the gate configuration employee',
      description: 'Create an independent child mission in the gate repository.',
      when: [],
      producer: {
        kind: 'digital-employee',
        employeeRef: ref('employee-gate'),
        repository: { kind: 'fixed', repositoryId: 'repo-gate' },
        completion: 'ready-to-merge',
        deadlineMs: 86_400_000,
      },
      input: { kind: 'step-output', stepId: 'understand' },
      onSuccess: 'prepare-approval',
      join: {
        groupId: 'gate-dependencies',
        mode: 'all',
        quorum: null,
        memberStepIds: ['repair-gate-repo'],
        deadlineMs: 86_400_000,
        onDeadline: 'handoff',
        onPartial: 'block',
      },
      onFailure: {
        retry: { sameScene: 0, freshScene: 1 },
        onExhausted: 'handoff',
        onRejected: null,
        onExpired: 'handoff',
      },
    },
    {
      stepId: 'prepare-approval',
      displayName: 'Prepare approval material',
      description: 'The Agent produces a draft envelope without credentials.',
      when: [],
      producer: {
        kind: 'approval-prepare',
        executor: 'agent',
        implementationRef: ref('tpl-approval-draft'),
        approvalType: 'gate-change',
      },
      input: { kind: 'step-output', stepId: 'repair-gate-repo' },
      onSuccess: 'submit-approval',
      join: null,
      onFailure: {
        retry: { sameScene: 1, freshScene: 1 },
        onExhausted: 'block',
        onRejected: null,
        onExpired: null,
      },
    },
    {
      stepId: 'submit-approval',
      displayName: 'Submit approval',
      description: 'A program submits the validated draft idempotently.',
      when: [],
      producer: { kind: 'approval-submit', adapterRef: ref('adapter-approval') },
      input: { kind: 'step-output', stepId: 'prepare-approval' },
      onSuccess: 'wait-approval',
      join: null,
      onFailure: {
        retry: { sameScene: 2, freshScene: 0 },
        onExhausted: 'block',
        onRejected: 'block',
        onExpired: 'handoff',
      },
    },
    {
      stepId: 'wait-approval',
      displayName: 'Wait for approval',
      description: 'A short program observes; pending becomes a durable wait.',
      when: [],
      producer: {
        kind: 'approval-observe',
        adapterRef: ref('adapter-approval'),
        pollIntervalMs: 60_000,
        deadlineMs: 86_400_000,
        webhookSourceKey: 'gate-approval',
      },
      input: { kind: 'step-output', stepId: 'submit-approval' },
      onSuccess: 'verify',
      join: null,
      onFailure: {
        retry: { sameScene: 2, freshScene: 0 },
        onExhausted: 'block',
        onRejected: 'handoff',
        onExpired: 'handoff',
      },
    },
    {
      stepId: 'verify',
      displayName: 'Verify again',
      description: 'Programmatic verification decides whether work may continue.',
      when: [],
      producer: { kind: 'platform', capabilityId: 'verification.run' },
      input: { kind: 'selected-problems' },
      onSuccess: 'reconcile',
      join: null,
      onFailure: {
        retry: { sameScene: 1, freshScene: 0 },
        onExhausted: 'block',
        onRejected: null,
        onExpired: null,
      },
    },
  ],
  problemTypes: [
    {
      typeId: 'compile',
      displayName: 'Compilation failure',
      evidenceDomain: 'pipeline',
      repairable: true,
      priority: 10,
      unknownFallback: false,
    },
    {
      typeId: 'pipeline-unknown',
      displayName: 'Unknown pipeline failure',
      evidenceDomain: 'pipeline',
      repairable: false,
      priority: 9_999,
      unknownFallback: true,
    },
  ],
  problemProducers: [
    {
      producerId: 'pipeline-classifier',
      displayName: 'Pipeline classifier',
      kind: 'script',
      implementationRef: ref('tpl-classifier'),
      evidenceDomains: ['pipeline'],
      allowedTypeIds: ['compile', 'pipeline-unknown'],
      when: [],
      retry: { sameScene: 2, freshScene: 1 },
      fallbackProducerId: null,
    },
  ],
  problemHandlers: [
    {
      ruleId: 'repair-compile',
      typeId: 'compile',
      when: [],
      handler: { kind: 'agent', implementationRef: ref('tpl-repair') },
      verifyStepIds: ['verify'],
      retry: { sameScene: 1, freshScene: 1 },
      fallbackRuleId: null,
    },
  ],
  capabilityRoutes: [
    {
      capabilityId: 'change.implement',
      rules: [],
      fallbackTemplateRef: ref('tpl-repair'),
    },
  ],
  requirementSources: [],
  pipelineProviders: [],
  defaultPolicyRef: ref('policy-default'),
} as const

const LOOKUP: EmployeePublishLookup = {
  getTemplate(id) {
    const capabilities: Record<string, string> = {
      'tpl-analyze': 'requirement.analyze',
      'tpl-approval-draft': 'approval.prepare',
      'tpl-classifier': 'problem.classify',
      'tpl-repair': 'change.implement',
    }
    return capabilities[id] === undefined ? null : { capabilityId: capabilities[id] }
  },
  getPolicy: (id) => (id === 'policy-default' ? { exists: true } : null),
  getAdapter: (id) =>
    id === 'adapter-approval'
      ? { purpose: 'approval-gateway' }
      : id === 'adapter-pipeline'
        ? { purpose: 'pipeline-gate' }
        : null,
  getEmployee: (id) => (id === 'employee-gate' ? { exists: true } : null),
}

function parsed(): DigitalEmployeeContent {
  return digitalEmployeeContentSchema.parse(CONTENT)
}

describe('RFC-310 PR-11/12 employee playbook', () => {
  test('strict codec, pure compile and full closure are deterministic', () => {
    const content = parsed()
    expect(unknownKeySurvivors(digitalEmployeeContentSchema, CONTENT)).toEqual([])
    expect(validateDigitalEmployeeForPublish(content, LOOKUP)).toEqual([])
    const first = compileEmployeePlaybook(content)
    expect(first.stepIds).toEqual([
      'understand',
      'repair-gate-repo',
      'prepare-approval',
      'submit-approval',
      'wait-approval',
      'verify',
    ])
    expect(first.callTargets).toEqual(['employee-gate@1'])
    expect(first.approvalAdapterRefs).toEqual(['adapter-approval@1', 'adapter-approval@1'])
    for (let index = 0; index < 100; index += 1) {
      expect(compileEmployeePlaybook(content)).toEqual(first)
    }
  })

  test.each([
    [
      'duplicate-step-id',
      (content: DigitalEmployeeContent) => ({
        ...content,
        steps: [content.steps![0]!, content.steps![0]!],
      }),
    ],
    [
      'step-target-missing',
      (content: DigitalEmployeeContent) => ({
        ...content,
        steps: content.steps!.map((step, index) =>
          index === 0 ? { ...step, onSuccess: 'missing-step' } : step,
        ),
      }),
    ],
    [
      'step-input-source-missing',
      (content: DigitalEmployeeContent) => ({
        ...content,
        steps: content.steps!.map((step, index) =>
          index === 0 ? { ...step, input: { kind: 'step-output', stepId: 'verify' } } : step,
        ),
      }),
    ],
    [
      'step-cycle',
      (content: DigitalEmployeeContent) => ({
        ...content,
        steps: content.steps!.map((step) =>
          step.stepId === 'verify' ? { ...step, onSuccess: 'understand' } : step,
        ),
      }),
    ],
    [
      'join-invalid',
      (content: DigitalEmployeeContent) => ({
        ...content,
        steps: content.steps!.map((step) =>
          step.stepId === 'repair-gate-repo'
            ? { ...step, join: { ...step.join!, mode: 'quorum', quorum: 2 } }
            : step,
        ),
      }),
    ],
    [
      'duplicate-problem-type',
      (content: DigitalEmployeeContent) => ({
        ...content,
        problemTypes: [content.problemTypes![0]!, content.problemTypes![0]!],
      }),
    ],
    [
      'problem-type-missing',
      (content: DigitalEmployeeContent) => ({
        ...content,
        problemHandlers: content.problemHandlers!.map((handler) => ({
          ...handler,
          typeId: 'not-catalogued',
        })),
      }),
    ],
    [
      'problem-producer-fallback-missing',
      (content: DigitalEmployeeContent) => ({
        ...content,
        problemProducers: content.problemProducers!.map((producer) => ({
          ...producer,
          fallbackProducerId: 'missing-producer',
        })),
      }),
    ],
    [
      'problem-handler-fallback-missing',
      (content: DigitalEmployeeContent) => ({
        ...content,
        problemHandlers: content.problemHandlers!.map((handler) => ({
          ...handler,
          fallbackRuleId: 'missing-rule',
        })),
      }),
    ],
    [
      'problem-producer-fallback-cycle',
      (content: DigitalEmployeeContent) => ({
        ...content,
        problemProducers: [
          {
            ...content.problemProducers![0]!,
            producerId: 'producer-a',
            fallbackProducerId: 'producer-b',
          },
          {
            ...content.problemProducers![0]!,
            producerId: 'producer-b',
            fallbackProducerId: 'producer-a',
          },
        ],
      }),
    ],
    [
      'problem-handler-fallback-cycle',
      (content: DigitalEmployeeContent) => ({
        ...content,
        problemHandlers: [
          { ...content.problemHandlers![0]!, ruleId: 'handler-a', fallbackRuleId: 'handler-b' },
          { ...content.problemHandlers![0]!, ruleId: 'handler-b', fallbackRuleId: 'handler-a' },
        ],
      }),
    ],
    [
      'problem-handler-fallback-type-mismatch',
      (content: DigitalEmployeeContent) => ({
        ...content,
        problemHandlers: [
          { ...content.problemHandlers![0]!, fallbackRuleId: 'unknown-handler' },
          {
            ...content.problemHandlers![0]!,
            ruleId: 'unknown-handler',
            typeId: 'pipeline-unknown',
            fallbackRuleId: null,
          },
        ],
      }),
    ],
  ] as const)('publish rejects %s', (code, mutate) => {
    const content = digitalEmployeeContentSchema.parse(mutate(parsed()))
    expect(validateDigitalEmployeeForPublish(content, LOOKUP).map((item) => item.code)).toContain(
      code,
    )
  })

  test('child and approval references are exact published resources', () => {
    const missingLookup: EmployeePublishLookup = {
      ...LOOKUP,
      getEmployee: () => null,
      getAdapter: () => ({ purpose: 'pipeline-gate' }),
    }
    const codes = validateDigitalEmployeeForPublish(parsed(), missingLookup).map(
      (item) => item.code,
    )
    expect(codes).toContain('child-employee-missing')
    expect(codes).toContain('approval-adapter-mismatch')
  })

  test('specialized producer slots reject a template with the wrong capability contract', () => {
    const content = parsed()
    const mismatched = digitalEmployeeContentSchema.parse({
      ...content,
      steps: content.steps!.map((step) =>
        step.producer.kind === 'approval-prepare'
          ? {
              ...step,
              producer: { ...step.producer, implementationRef: ref('tpl-repair') },
            }
          : step,
      ),
      problemProducers: content.problemProducers!.map((producer) => ({
        ...producer,
        implementationRef: ref('tpl-repair'),
      })),
    })
    const codes = validateDigitalEmployeeForPublish(mismatched, LOOKUP).map((item) => item.code)
    expect(codes).toContain('step-implementation-capability-mismatch')
    expect(codes).toContain('problem-implementation-capability-mismatch')
  })
})
