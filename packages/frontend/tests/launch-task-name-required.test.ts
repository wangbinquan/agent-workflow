// RFC-037 T6 → RFC-165 — source-layer wiring guard for the task-creation
// wizard (tasks.new.tsx, the surviving launch surface): locks the task-name
// field render, state + trim semantic, and the canSubmit gate. A future
// refactor that drops `taskName.trim()` from the gate would let Start enable
// on whitespace and we'd start eating 422s; the grep assertions here catch
// that quickly.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.new.tsx'),
  'utf-8',
)

describe('tasks.new.tsx — RFC-037 task name wiring', () => {
  test('declares taskName state', () => {
    expect(SRC).toMatch(/const \[taskName, setTaskName\] = useState\(['"]['"]\)/)
  })

  test('renders the task-name Field with maxLength=255', () => {
    expect(SRC).toContain("t('launch.fieldTaskName')")
    expect(SRC).toContain("t('launch.fieldTaskNameHint')")
    expect(SRC).toMatch(/maxLength=\{?255\}?/)
    expect(SRC).toContain('data-testid="wizard-task-name"')
  })

  test('canSubmit consults trimmed name length > 0', () => {
    expect(SRC).toMatch(/taskName\.trim\(\)\.length\s*>\s*0/)
    expect(SRC).toMatch(/canSubmit\s*=[\s\S]*stepContentReady/)
    expect(SRC).toMatch(/stepContentReady\s*=[\s\S]*nameReady/)
  })

  test('every submit arm stamps the trimmed name into the body', () => {
    // RFC-165: all three kind builders receive `name: taskName.trim()` — the
    // agent / workgroup arms inside buildImmediateBody, the workflow
    // multipart arm inline. Assert the stamp exists and each builder is fed.
    expect(SRC).toMatch(/name:\s*taskName\.trim\(\)/)
    expect(SRC).toMatch(/buildAgentStartBody\(/)
    expect(SRC).toMatch(/buildWorkgroupStartBody\(/)
    expect(SRC).toMatch(/buildWorkflowStartBody\(/)
    expect(SRC).toMatch(/buildWorkflowStartFormData\(/)
  })

  test('Launch button disabled prop is canSubmit-driven', () => {
    expect(SRC).toContain('disabled={!canSubmit}')
  })
})
