// RFC-020 T6: source-layer guard against silent regression on the launch
// route. If anyone removes the multipart branch or the UploadPicker hookup,
// these strings will go missing.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'workflows.launch.tsx'),
  'utf-8',
)

describe('workflows.launch.tsx (RFC-020 wiring)', () => {
  test('imports UploadPicker', () => {
    expect(SRC).toContain('UploadPicker')
    expect(SRC).toMatch(/from '@\/components\/launch\/UploadPicker'/)
  })

  test('imports buildLaunchFormDataV2 (RFC-165: the path-mode builder is retired)', () => {
    expect(SRC).toContain('buildLaunchFormDataV2')
  })

  test("branches on def.kind === 'upload' in the field render path", () => {
    expect(SRC).toContain("def.kind === 'upload'")
  })

  test('Start mutation switches to api.postMultipart when uploads exist', () => {
    expect(SRC).toContain('postMultipart')
    expect(SRC).toContain('hasUploadKind')
  })

  test('Start-disabled rule consults uploads[] length', () => {
    // missingRequired considers list.length when def.kind === 'upload'
    expect(SRC).toContain('list.length')
    expect(SRC).toContain('minCount')
  })
})
