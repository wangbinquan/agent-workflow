// RFC-370: a consumer-owned demand must accept the actual complete producer
// family unchanged. Real Intent/HTTP/queued suites exercise this same binding.
import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IntentSystemAgentRunFamily } from '../src/modules/intent/application/ports/intentSystemAgent'
import { composeLocalSystemAgentRunFamily } from '../src/modules/task-execution/composition/localSystemAgentRunFamily'
import type { SystemAgentRunOptions } from '../src/services/systemAgentRun'
import { emptySystemAgentOutputEvidence } from '../src/services/systemAgentRun'
import { classifyMissingEnvelope as coreClassifier } from '../src/modules/task-execution/application/systemAgentRun'
import { classifyMissingEnvelope as sharedClassifier } from '@agent-workflow/shared'

test('Intent accepts the same complete System family and preserves its runtime and retained-content owner', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aw-intent-system-purpose-'))
  try {
    const native = composeLocalSystemAgentRunFamily({ appHome: () => home })
    let received: SystemAgentRunOptions | undefined
    const selected = native.withFixture(async (request) => {
      received = request
      return {
        status: 'ok',
        exitCode: 0,
        eventText: 'same selected family',
        stderrTail: '',
        durationMs: 1,
        scratchDir: join(home, 'intent-scratch', 'chosen'),
        scratchRetained: true,
        outputEvidence: emptySystemAgentOutputEvidence(),
      }
    })
    // The assignment is deliberately direct; an incompatible producer port
    // must fail hosted Typecheck rather than being coerced by a test cast.
    const intent: IntentSystemAgentRunFamily = selected.family
    expect(intent).toBe(selected.family)
    expect(intent.workspaces).toBe(selected.family.workspaces)
    expect(intent.retainedContents).toBe(selected.family.retainedContents)
    expect(coreClassifier).toBe(sharedClassifier)
    const runtime = selected.bindRuntime({ binaryPath: 'chosen-runtime' })
    const scope = intent.workspaces.capture({ namespace: 'intent', name: 'chosen' })
    mkdirSync(join(home, 'intent-scratch', 'chosen'), { recursive: true })
    const result = await intent.run({
      feature: 'intent-builder',
      agentName: 'purpose-persona',
      systemPrompt: 'purpose-system',
      prompt: 'purpose-prompt',
      protocol: 'opencode',
      runtimeBinding: runtime.runtimeBinding,
      workspaceScope: scope,
      seedFiles: [{ path: 'INTENT.md', content: 'purpose-seed' }],
      retainScratchOnSuccess: true,
    })
    expect(received).toMatchObject({
      runtimeBinary: 'chosen-runtime',
      scratchParent: join(home, 'intent-scratch'),
      scratchName: 'chosen',
      seedFiles: [{ path: 'INTENT.md', content: 'purpose-seed' }],
      retainScratchOnSuccess: true,
    })
    expect(result.eventText).toBe('same selected family')
    expect(result.retainedRef).toStartWith('aw-system-fixture:')
    expect(
      await intent.retainedContents.release({ retainedRef: result.retainedRef, scope }),
    ).toEqual({
      removed: true,
    })
    expect(existsSync(join(home, 'intent-scratch', 'chosen'))).toBe(false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
