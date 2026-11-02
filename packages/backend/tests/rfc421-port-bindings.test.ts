// RFC-421: the provider-neutral parts of the agent invocation stack moved from task-execution composition into
// application. These cases lock the moved bodies on their new owners: the two-phase preparation's single bind and
// cleanup, the system agent run core releasing its retained reference when the invocation is rejected (a failed
// release never masks the rejection), the runtime smoke core's open → nonce → materialize order, and the smoke
// material declaration.
import { expect, test } from 'bun:test'
import { createAgentInvocationPreparation } from '@/modules/task-execution/application/agentInvocationPreparation'
import { createSystemAgentRunFamily } from '@/modules/task-execution/application/systemAgentRun'
import {
  createRuntimeSmokeMaterialIntent,
  createRuntimeSmokeRunFamily,
} from '@/modules/task-execution/application/runtimeSmoke'

test('the preparation compiles once, binds the compiled material once and cleans up through the consumer', async () => {
  const calls: unknown[] = []
  const material = {
    materialRef: 'material-1',
    declared: { skills: [] },
    evidenceCapabilities: { live: false },
  }
  const binding = { sentinel: 'binding' }
  const preparation = createAgentInvocationPreparation({
    compiler: {
      async compile(intent: unknown) {
        calls.push(['compile', intent])
        return material
      },
    } as never,
    workspace: { sentinel: 'workspace' } as never,
    bind: (compiled) => {
      calls.push(['bind', compiled])
      return binding as never
    },
    cleanupMaterial: (compiled) => {
      calls.push(['cleanup', compiled])
    },
  })
  expect(preparation.workspace).toEqual({ sentinel: 'workspace' } as never)
  const compiled = await preparation.compile({ prompt: 'p' } as never)
  expect(compiled.materialRef).toBe('material-1')
  expect(compiled.declared).toBe(material.declared as never)
  expect(compiled.evidenceCapabilities).toBe(material.evidenceCapabilities as never)
  expect(compiled.bind()).toBe(binding as never)
  expect(() => compiled.bind()).toThrow('agent-invocation-material-already-bound')
  await compiled.cleanup?.()
  expect(calls).toEqual([
    ['compile', { prompt: 'p' }],
    ['bind', material],
    ['cleanup', material],
  ])
})

function rejectedInvocation(discardError: Error) {
  return {
    workspace: {
      retainedRef: 'retained-1',
      async discard() {
        throw discardError
      },
    },
    async prepareWorkspace() {
      throw new Error('scratch unavailable')
    },
  }
}

function systemFamily(input: {
  readonly invocation: unknown
  readonly forget: (ref: { retainedRef: string }) => void
}) {
  const retainedContents = {
    forget(ref: { retainedRef: string }) {
      input.forget(ref)
    },
  }
  return createSystemAgentRunFamily({
    invocations: { open: () => input.invocation as never },
    retainedContents: retainedContents as never,
    workspaces: { sentinel: 'workspaces' } as never,
  })
}

test('a rejected system agent invocation releases its retained reference and rethrows', async () => {
  const forgotten: unknown[] = []
  const rejection = new Error('discard failed')
  const family = systemFamily({
    invocation: rejectedInvocation(rejection),
    forget: (ref) => forgotten.push(ref),
  })
  expect(family.workspaces).toEqual({ sentinel: 'workspaces' } as never)
  const warnings: unknown[] = []
  const log = { warn: (...args: unknown[]) => warnings.push(args) } as never
  await expect(family.run({ feature: 'probe', log } as never)).rejects.toBe(rejection)
  expect(forgotten).toEqual([{ retainedRef: 'retained-1' }])
  expect(warnings).toEqual([])
})

test('a failed release is only logged; the original rejection still reaches the caller', async () => {
  const rejection = new Error('discard failed')
  const family = systemFamily({
    invocation: rejectedInvocation(rejection),
    forget: () => {
      throw new Error('forget failed')
    },
  })
  const warnings: unknown[] = []
  const log = { warn: (...args: unknown[]) => warnings.push(args) } as never
  await expect(family.run({ feature: 'probe', log } as never)).rejects.toBe(rejection)
  expect(warnings).toEqual([
    ['system-agent-retained-reference-forget-failed', { feature: 'probe', err: 'forget failed' }],
  ])
})

test('the smoke core opens the invocation, allocates the nonce, then materializes and runs the prompt', async () => {
  const order: string[] = []
  const prompts: string[] = []
  const family = createRuntimeSmokeRunFamily({
    invocations: {
      open() {
        order.push('open')
        return {
          materialize() {
            order.push('materialize')
            return {
              workspace: {
                async discard() {
                  order.push('discard')
                },
              },
              async prepareWorkspace() {
                order.push('prepareWorkspace')
              },
              async compile(prompt: string) {
                order.push('compile')
                prompts.push(prompt)
                throw new Error('compile unavailable')
              },
            } as never
          },
        }
      },
    } as never,
  })
  await family
    .run({ protocol: 'opencode', log: { warn() {}, info() {} } } as never)
    .catch(() => undefined)
  expect(order.slice(0, 4)).toEqual(['open', 'materialize', 'prepareWorkspace', 'compile'])
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatch(/awsmoke-[0-9a-f]{16}/)
})

test('the smoke material declaration carries the smoke agent profile and only non-empty extra args', () => {
  const preparation = { workspace: { workspace: 'ws-ref', runContent: 'run-ref' } } as never
  const log = { sentinel: 'log' } as never
  const base = {
    protocol: 'opencode',
    model: 'm1',
    isSandbox: true,
    runtimeBinding: 'binding-1',
  } as never
  const intent = createRuntimeSmokeMaterialIntent(base, preparation, 'say hi', log)
  expect(intent).toEqual({
    protocol: 'opencode',
    injection: { mcps: [] },
    prompt: 'say hi',
    agentName: 'aw-smoke',
    systemPrompt: 'You are a runtime smoke-test agent. Follow the user prompt exactly.',
    resolvedProfiles: [
      [
        'aw-smoke',
        {
          model: 'm1',
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
          isSandbox: true,
        },
      ],
    ],
    workspace: 'ws-ref',
    runContent: 'run-ref',
    freshAgentRun: false,
    runtimeBinding: 'binding-1',
    nodeRunId: 'runtime-smoke',
    log,
  } as never)
  expect(
    createRuntimeSmokeMaterialIntent(
      { ...(base as object), extraArgs: [] } as never,
      preparation,
      'p',
      log,
    ),
  ).not.toHaveProperty('extraArgs')
  expect(
    createRuntimeSmokeMaterialIntent(
      { ...(base as object), extraArgs: ['--x'], model: undefined } as never,
      preparation,
      'p',
      log,
    ),
  ).toMatchObject({ extraArgs: ['--x'], resolvedProfiles: [['aw-smoke', { model: null }]] })
})
