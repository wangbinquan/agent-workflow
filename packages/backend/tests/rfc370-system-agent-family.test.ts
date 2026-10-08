// RFC-370: ordinary System callers select one family for runtime material,
// execution and retained contents. Native fixtures are explicit root selections.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeLocalSystemAgentRunFamily } from '../src/modules/task-execution/composition/localSystemAgentRunFamily'
import { composeSystemAgentRunFamily } from '../src/modules/task-execution/composition/systemAgentRunFamily'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '../src/services/systemAgentRun'
import { emptySystemAgentOutputEvidence } from '../src/services/systemAgentRun'
import type { SystemAgentRunRequest } from '../src/modules/task-execution/application/ports/systemAgentRunFamily'
import type {
  SystemAgentRetainedContents,
  SystemAgentWorkspaceScopes,
} from '../src/modules/runtime-management/public/participants'
import { createLogger } from '../src/util/log'

function result(scratchDir: string): SystemAgentRunResult {
  return {
    status: 'ok',
    exitCode: 0,
    eventText: 'selected response',
    stderrTail: '',
    durationMs: 1,
    capturedSessionId: 'selected:session',
    scratchDir,
    scratchRetained: true,
    outputEvidence: emptySystemAgentOutputEvidence(),
  }
}

describe('RFC-370 complete System family binding', () => {
  test('normal selection keeps exact owner members and reads defaults before opening', async () => {
    const events: string[] = []
    const original = new Error('selected-open-failure')
    const workspaces: SystemAgentWorkspaceScopes = {
      capture(scope) {
        return scope
      },
      withName(scope, name) {
        return { namespace: scope.namespace, name }
      },
    }
    const retainedContents: SystemAgentRetainedContents = {
      forget() {},
      release() {
        throw new Error('not reached')
      },
    }
    const log = createLogger('system-family-default-boundary')
    const request: SystemAgentRunRequest = {
      feature: 'selected',
      agentName: 'persona',
      systemPrompt: 'system',
      prompt: 'prompt',
      protocol: 'opencode',
      workspaceScope: { namespace: 'shared', name: 'selected' },
      get log() {
        events.push('log')
        return log
      },
      get timeoutMs() {
        events.push('timeout')
        return 234
      },
      get maxEventTextBytes() {
        events.push('cap')
        return 567
      },
    }
    const invocations = {
      open(input: SystemAgentRunRequest, selectedLog: typeof log): never {
        expect(this).toBe(invocations)
        expect(input).toBe(request)
        expect(selectedLog).toBe(log)
        events.push('open')
        throw original
      },
    }
    const family = composeSystemAgentRunFamily({ invocations, workspaces, retainedContents })
    expect(family.workspaces).toBe(workspaces)
    expect(family.retainedContents).toBe(retainedContents)
    await expect(family.run(request)).rejects.toBe(original)
    expect(events).toEqual(['log', 'timeout', 'cap', 'open'])
  })

  test('the same explicit native root interprets its lazy runtime reference for a fixture', async () => {
    const events: string[] = []
    class Profile {
      get binaryPath() {
        events.push('binary')
        return '/fixture/custom-runtime'
      }
      get protocol() {
        expect<Profile>(this).toBe(profile)
        events.push('protocol')
        return 'claude-code' as const
      }
      get model() {
        expect<Profile>(this).toBe(profile)
        events.push('model')
        return 'fixture/model'
      }
    }
    const profile = new Profile()
    const binding = composeLocalSystemAgentRunFamily({
      appHome: () => {
        events.push('home')
        return '/fixture/home'
      },
    })
    const selected = binding.bindRuntime(profile)
    expect(events).toEqual([])
    expect('binaryPath' in selected).toBe(false)
    let received: SystemAgentRunOptions | undefined
    const fixture = binding.withFixture(async (input) => {
      received = input
      return result('/fixture/home/scratch/named')
    })
    expect(fixture.bindRuntime).toBe(binding.bindRuntime)
    const completed = await fixture.family.run({
      feature: 'memory',
      agentName: 'persona',
      systemPrompt: 'system',
      prompt: 'prompt',
      protocol: selected.protocol,
      runtimeBinding: selected.runtimeBinding,
      model: selected.model,
      workspaceScope: fixture.family.workspaces.capture({ namespace: 'shared', name: 'named' }),
      resumeSessionId: 'original-session',
    })
    expect(events).toEqual(['protocol', 'binary', 'model', 'home'])
    expect(received?.runtimeBinary).toBe('/fixture/custom-runtime')
    expect(received?.scratchParent).toBe(join('/fixture/home', 'scratch'))
    expect(received?.scratchName).toBe('named')
    expect(received?.resumeSessionId).toBe('original-session')
    expect(completed.retainedRef).toStartWith('aw-system-fixture:')
    expect('scratchDir' in completed).toBe(false)
    expect(completed.capturedSessionId).toBe('selected:session')
  })

  test('native fixture result accessors stay lazy and use the actual result receiver', async () => {
    const reads: string[] = []
    class NativeResult implements SystemAgentRunResult {
      exitCode = 0
      stderrTail = ''
      durationMs = 1
      scratchRetained = true
      outputEvidence = emptySystemAgentOutputEvidence()
      get status() {
        expect<NativeResult>(this).toBe(nativeResult)
        reads.push('status')
        return 'ok' as const
      }
      get eventText() {
        expect<NativeResult>(this).toBe(nativeResult)
        reads.push('eventText')
        return 'prototype result'
      }
      get scratchDir() {
        expect<NativeResult>(this).toBe(nativeResult)
        reads.push('scratchDir')
        return '/fixture/home/scratch/result'
      }
    }
    const nativeResult = new NativeResult()
    const selected = composeLocalSystemAgentRunFamily({
      appHome: () => '/fixture/home',
      fixture: { runFn: async () => nativeResult },
    })
    const completed = await selected.family.run({
      feature: 'intent',
      agentName: 'persona',
      systemPrompt: 'system',
      prompt: 'prompt',
      protocol: 'opencode',
      workspaceScope: selected.family.workspaces.capture({ namespace: 'shared', name: 'result' }),
    })
    expect(reads).toEqual([])
    expect(completed.eventText).toBe('prototype result')
    expect(reads).toEqual(['eventText'])
    expect(completed.retainedRef).toStartWith('aw-system-fixture:')
    expect(reads).toEqual(['eventText', 'scratchDir'])
    expect(completed.status).toBe('ok')
    expect(reads).toEqual(['eventText', 'scratchDir', 'status'])
    expect('scratchDir' in completed).toBe(false)
  })

  test('an explicit fixture cannot interpret another root runtime reference', async () => {
    const first = composeLocalSystemAgentRunFamily({ appHome: () => '/first' })
    const second = composeLocalSystemAgentRunFamily({ appHome: () => '/second' })
    let calls = 0
    const selected = second.withFixture(async () => {
      calls++
      return result('/second/scratch/named')
    })
    await expect(
      selected.family.run({
        feature: 'intent',
        agentName: 'persona',
        systemPrompt: 'system',
        prompt: 'prompt',
        protocol: 'opencode',
        runtimeBinding: first.bindRuntime({ binaryPath: '/first/runtime' }).runtimeBinding,
        workspaceScope: selected.family.workspaces.capture({ namespace: 'shared', name: 'named' }),
      }),
    ).rejects.toThrow('system-runtime-binding-unavailable')
    expect(calls).toBe(0)
  })

  for (const protocol of ['opencode', 'claude-code'] as const) {
    test(`${protocol} native selection compiles persona and seeds before a failed launch`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'aw-system-native-family-'))
      try {
        const selected = composeLocalSystemAgentRunFamily({ appHome: () => home })
        const scope = selected.family.workspaces.capture({ namespace: 'shared', name: 'native' })
        const runtime = selected.bindRuntime({ binaryPath: join(home, 'missing-runtime.exe') })
        const completed = await selected.family.run({
          feature: 'native-family',
          agentName: 'selected-native-persona',
          systemPrompt: 'selected native system prompt',
          prompt: 'selected native prompt',
          protocol,
          runtimeBinding: runtime.runtimeBinding,
          workspaceScope: scope,
          seedFiles: [{ path: 'SEED.md', content: 'selected seed\0' }],
          timeoutMs: 5000,
        })
        expect(completed.status).toBe('spawn-failed')
        // The unchanged core's early spawn-failed branch intentionally omits
        // declared even after successful compilation; distinguish it from
        // scratch/compile failure using the actual native launch diagnostic.
        expect(completed.stderrTail).toStartWith('binary failed to start:')
        expect(completed.declared).toBeUndefined()
        expect(completed.retainedRef).toBeString()
        expect(completed.scratchRetained).toBe(true)
        expect(readFileSync(join(home, 'scratch', 'native', 'worktree', 'SEED.md'), 'utf8')).toBe(
          'selected seed\0',
        )
        expect(
          await selected.family.retainedContents.release({
            retainedRef: completed.retainedRef,
            scope,
          }),
        ).toEqual({ removed: true })
        expect(existsSync(join(home, 'scratch', 'native'))).toBe(false)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })
  }

  test('a chain keeps one captured parent and releases all same-content references together', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aw-system-family-'))
    let selectedHome = home
    try {
      const binding = composeLocalSystemAgentRunFamily({ appHome: () => selectedHome })
      const parent = binding.family.workspaces.capture({ namespace: 'shared' })
      selectedHome = join(home, 'later')
      const named = binding.family.workspaces.withName(parent, 'chain')
      const root = join(home, 'scratch', 'chain')
      mkdirSync(root, { recursive: true })
      const fixture = binding.withFixture(async (input) => {
        expect(input.scratchParent).toBe(join(home, 'scratch'))
        return result(root)
      })
      const request: SystemAgentRunRequest = {
        feature: 'memory',
        agentName: 'persona',
        systemPrompt: 'system',
        prompt: 'prompt',
        protocol: 'opencode',
        workspaceScope: named,
      }
      const first = await fixture.family.run(request)
      const second = await fixture.family.run({ ...request, resumeSessionId: 'selected:session' })
      expect(first.retainedRef).not.toBe(second.retainedRef)
      expect(
        await fixture.family.retainedContents.release({
          retainedRef: first.retainedRef,
          scope: named,
        }),
      ).toEqual({ removed: true })
      expect(existsSync(root)).toBe(false)
      expect(
        await fixture.family.retainedContents.release({
          retainedRef: second.retainedRef,
          scope: named,
        }),
      ).toEqual({ removed: false, reason: 'unsafe-path' })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
