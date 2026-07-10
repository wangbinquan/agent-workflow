// RFC-037 T6 — source-layer wiring guard for workflows.launch.tsx: locks the
// task-name field render, state + trim semantic, and the canSubmit gate. A
// future refactor that drops `taskName.trim()` from `canSubmit` would let the
// Start button enable on whitespace and we'd start eating 422s; the grep
// assertions here catch that quickly.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'workflows.launch.tsx'),
  'utf-8',
)

describe('workflows.launch.tsx — RFC-037 task name wiring', () => {
  test('declares taskName state', () => {
    expect(SRC).toMatch(/const \[taskName, setTaskName\] = useState\(['"]['"]\)/)
  })

  test('renders the task-name Field with maxLength=255', () => {
    expect(SRC).toContain("t('launch.fieldTaskName')")
    expect(SRC).toContain("t('launch.fieldTaskNameHint')")
    expect(SRC).toMatch(/maxLength=\{?255\}?/)
    expect(SRC).toContain('data-testid="launch-task-name"')
  })

  test('canSubmit consults trimmed name length > 0', () => {
    expect(SRC).toMatch(/taskName\.trim\(\)\.length\s*>\s*0/)
    expect(SRC).toMatch(/canSubmit\s*=[\s\S]*nameReady/)
  })

  test('all three submit branches stamp name into the body', () => {
    // RFC-067 refactor: name is hoisted into `launchCommon` (alongside the
    // optional RFC-067 gitUserName / gitUserEmail), then every submit branch
    // spreads launchCommon. RFC-165 retired the path-multipart branch, so
    // three remain: multi-repo JSON / single-repo JSON / url-multipart.
    expect(SRC).toMatch(/launchCommon\s*=\s*\{[\s\S]*?\bname\b[\s\S]*?\}/)
    // RFC-066 PR-C: multi-repo JSON path
    expect(SRC).toMatch(/buildLaunchBodyMultiRepo\(\s*repos,\s*launchCommon\s*\)/)
    // legacy JSON path — single source variable renamed `onlySource` in the
    // PR-C refactor so the multi-repo branch keeps the outer `repos` array.
    expect(SRC).toMatch(/buildLaunchBody\(\s*onlySource,\s*launchCommon\s*\)/)
    // url-multipart — passes launchCommon directly
    expect(SRC).toMatch(/buildLaunchFormDataV2\([\s\S]*?launchCommon[\s\S]*?\)/)
  })

  test('Start button text reads from t() and disabled prop is canSubmit-driven', () => {
    expect(SRC).toContain('disabled={!canSubmit}')
  })
})
