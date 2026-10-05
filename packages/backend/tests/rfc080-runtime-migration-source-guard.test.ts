// RFC-080 PR-A — source-level guard: the agent-output runtime dispatch points
// must route through the PARAMETRIC registry, never the legacy 3-key HANDLERS
// Record. The legacy helpers (getOutputKindHandler / groupPortsByKind /
// composePerKindRepairBlocks) still exist in outputKinds/index.ts for
// independent unit tests, but if any of these three files starts CALLING them
// again, parametric kinds (path<ext> / list<T> / signal) would throw
// `handler not registered` at dispatch — the exact regression this guards.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FILES: Record<string, string> = {
  'shared/src/prompt.ts': join(import.meta.dir, '../../shared/src/prompt.ts'),
  'backend/src/services/envelope.ts': join(
    import.meta.dir,
    '../src/modules/task-execution/application/portOutputValidation.ts',
  ),
  'backend/src/services/runner.ts': join(
    import.meta.dir,
    '../src/modules/task-execution/application/taskAgentRun.ts',
  ),
}

describe('RFC-080 runtime migration source guard', () => {
  for (const [label, path] of Object.entries(FILES)) {
    test(`${label} does not CALL the legacy 3-key registry helpers`, () => {
      const src = readFileSync(path, 'utf8')
      // Call syntax only (open paren) — prose mentions in comments are fine.
      expect(src).not.toContain('getOutputKindHandler(')
      expect(src).not.toContain('groupPortsByKind(')
      expect(src).not.toContain('composePerKindRepairBlocks(')
    })
  }

  test('the three files reference the parametric replacements', () => {
    const prompt = readFileSync(FILES['shared/src/prompt.ts']!, 'utf8')
    const envelope = readFileSync(FILES['backend/src/services/envelope.ts']!, 'utf8')
    const runner = readFileSync(FILES['backend/src/services/runner.ts']!, 'utf8')
    expect(prompt).toContain('groupPortsByParsedKind')
    expect(envelope).toContain('getHandlerForParsedKind')
    expect(runner).toContain('composePerParsedKindRepairBlocks')
  })
})
