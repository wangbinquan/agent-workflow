// RFC-020 T7: source-layer guard that NodeInspector lets users author
// kind:'upload' input nodes with all required + optional fields.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(
  // RFC-146 T3: the input branch (incl. UploadInputFields) lives in
  // inspector/InputEdit.tsx now.
  resolve(import.meta.dirname, '..', 'src', 'components', 'canvas', 'inspector', 'InputEdit.tsx'),
  'utf-8',
)

describe('NodeInspector upload-kind support (RFC-020)', () => {
  test('inputKind dropdown includes "upload"', () => {
    // RFC-036 migration: native <option> → shared <Select> option object.
    expect(SRC).toContain("{ value: 'upload', label: 'upload' }")
  })

  test('UploadInputFields component is mounted when kind === upload', () => {
    expect(SRC).toContain("inputKind === 'upload'")
    expect(SRC).toContain('UploadInputFields')
  })

  test('targetDir field reports invalid characters', () => {
    expect(SRC).toContain('targetDirInvalid')
    expect(SRC).toContain("targetDir.includes('..')")
    expect(SRC).toContain("targetDir.startsWith('/')")
    expect(SRC).toContain('inspector.upload.targetDirError')
  })

  test('upload fields persist via patchInputDef (targetDir/accept/maxFileSize/min/maxCount)', () => {
    expect(SRC).toContain('targetDir:')
    expect(SRC).toContain('accept:')
    expect(SRC).toContain('maxFileSize:')
    expect(SRC).toContain('minCount:')
    expect(SRC).toContain('maxCount:')
  })
})
