// RFC-020 T6 → RFC-165: source-layer guard against silent regression on the
// task-creation wizard (the surviving launch surface). If anyone removes the
// multipart branch or the UploadPicker hookup, these strings will go missing.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.new.tsx'),
  'utf-8',
)

describe('tasks.new.tsx (RFC-020 wiring)', () => {
  test('imports UploadPicker', () => {
    expect(SRC).toContain('UploadPicker')
    expect(SRC).toMatch(/from '@\/components\/launch\/UploadPicker'/)
  })

  test('imports buildWorkflowStartFormData (RFC-165: the wizard multipart builder)', () => {
    expect(SRC).toContain('buildWorkflowStartFormData')
  })

  test("branches on def.kind === 'upload' in the field render path", () => {
    expect(SRC).toContain("def.kind === 'upload'")
  })

  test('Start mutation switches to api.postMultipart when uploads exist', () => {
    expect(SRC).toContain('postMultipart')
    expect(SRC).toContain('hasUploadInput')
  })

  test('Start-disabled rule consults uploads[] length', () => {
    // missingRequired considers list.length when def.kind === 'upload'
    expect(SRC).toContain('list.length')
    expect(SRC).toContain('minCount')
  })
})
