// Regression guard for process-global backend test state.
//
// Backend files run in isolated globals, but shuffled cases inside one file
// still share process.env. Preserve a suite-level baseline while proving that
// a case-local mutation cannot leak into whichever case Bun schedules next.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'

const KEY = 'AGENT_WORKFLOW_TEST_HARNESS_LEAK'
let originalValue: string | undefined
let suiteCwd: string
let cwdFixture: string

beforeAll(() => {
  originalValue = process.env[KEY]
  process.env[KEY] = 'suite-baseline'
  suiteCwd = process.cwd()
  cwdFixture = mkdtempSync(join(tmpdir(), 'aw-test-harness-cwd-'))
})

afterAll(() => {
  expect(process.cwd()).toBe(suiteCwd)
  rmSync(cwdFixture, { recursive: true, force: true })
  if (originalValue === undefined) delete process.env[KEY]
  else process.env[KEY] = originalValue
})

beforeEach(() => {
  expect(process.env[KEY]).toBe('suite-baseline')
  expect(process.cwd()).toBe(suiteCwd)
})

for (const label of ['first mutation', 'second mutation']) {
  test(label, () => {
    process.env[KEY] = label
  })
}

test('cwd mutation', () => {
  process.chdir(cwdFixture)
})
