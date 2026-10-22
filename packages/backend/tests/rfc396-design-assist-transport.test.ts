// RFC-396 Windows CI: preserve configured runtime and send large design requests as invocation files.
import { expect, test } from 'bun:test'
import { createDesignAssistGeneration } from '@/modules/task-execution/infrastructure/designAssistGeneration'
import { composeLocalSystemAgentRunFamily } from '@/modules/task-execution/composition/localSystemAgentRunFamily'
import {
  emptySystemAgentOutputEvidence,
  type SystemAgentRunOptions,
} from '@/services/systemAgentRun'

test('design assist reads the live configured runtime and preserves its selected binary and model', async () => {
  const calls: SystemAgentRunOptions[] = []
  let responseText = '{}'
  let truncated = false
  const binding = composeLocalSystemAgentRunFamily({
    appHome: () => '/tmp/rfc396-runtime-fixture',
    fixture: {
      runFn: async (request) => {
        calls.push(request)
        return {
          status: 'ok',
          exitCode: 0,
          eventText: responseText,
          stderrTail: '',
          durationMs: 1,
          scratchDir: '/tmp/rfc396-runtime-fixture/result',
          scratchRetained: false,
          outputEvidence: { ...emptySystemAgentOutputEvidence(), eventTextCapHit: truncated },
        }
      },
    },
  })
  let configured: string | undefined = 'custom-local'
  const resolved: (string | null | undefined)[] = []
  const assist = createDesignAssistGeneration({
    ...binding,
    getDefaultRuntime: async () => configured,
    registry: {
      async resolveRuntimeByName() {
        throw new Error('bare-name fallback bypasses configured runtime')
      },
      async resolveInternalAgentRuntime() {
        throw new Error('unexpected resolver')
      },
      async resolveAgentRuntime(agent, name) {
        expect(agent).toBeUndefined()
        resolved.push(name)
        return {
          name: name ?? 'opencode',
          protocol: 'opencode',
          binaryPath: '/fixture/local-stub',
          configDir: { env: 'OPENCODE_CONFIG_DIR', name: '.opencode' },
          model: 'fixture/model',
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
          isSandbox: false,
        }
      },
    },
  })
  const request = {
    caseId: 'case',
    requestId: 'request',
    // Larger than Windows' command-line budget: content must travel as a seed file.
    prompt: JSON.stringify({ material: 'requirement '.repeat(10_000) }),
    signal: new AbortController().signal,
  }
  await assist.generate(request)
  configured = undefined
  await assist.generate({ ...request, requestId: 'next' })
  expect(resolved).toEqual(['custom-local', undefined])
  for (const call of calls) {
    expect(call.prompt.length).toBeLessThan(1000)
    expect(call.prompt).toContain('graph-design-request.json')
    expect(call.seedFiles).toEqual([{ path: 'graph-design-request.json', content: request.prompt }])
  }
  expect(calls.map((call) => [call.runtimeBinary, call.model])).toEqual([
    ['/fixture/local-stub', 'fixture/model'],
    ['/fixture/local-stub', 'fixture/model'],
  ])
  // A real OpenCode response included progress narration before its final JSON.
  // Do not corrupt strings, accept competing proposals, or treat a capped prefix as complete.
  const proposal = {
    description: 'Literal ```json and braces { } and escaped "quotes"',
    nested: { ok: true },
  }
  responseText = 'I will read the request.\n```json\n' + JSON.stringify(proposal) + '\n```\n'
  expect(JSON.parse((await assist.generate(request)).outputJson)).toEqual(proposal)
  for (const invalid of [
    'No proposal was produced',
    '{"first":1}\n{"second":2}',
    '{"first":1}\n{"unfinished":',
    '{"unfinished":',
  ]) {
    responseText = invalid
    await expect(assist.generate(request)).rejects.toThrow()
  }
  responseText = '{}'
  truncated = true
  await expect(assist.generate(request)).rejects.toThrow('graph-assist-output-truncated')
})
