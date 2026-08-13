import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = resolve(import.meta.dirname, '../src')

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx|css)$/.test(name) ? [path] : []
  })
}

const FORBIDDEN = [
  'TemplateVarChips',
  'WebhookTriggerVarChips',
  'template-var-chips',
  'agent-trigger-var',
  'review-trigger-var',
  'code-host-trigger-var',
  'savedTemplateOption',
] as const

function legacyWriterHits(text: string): string[] {
  return FORBIDDEN.filter((needle) => text.includes(needle))
}

describe('RFC-295 old runtime-parameter writer extinction', () => {
  test('scanner sentinel proves every retired identifier is detectable', () => {
    expect(legacyWriterHits(FORBIDDEN.join('\n'))).toEqual(FORBIDDEN)
  })

  test('production source has zero old chip/private Select writers', () => {
    const violations = sourceFiles(SRC).flatMap((file) =>
      legacyWriterHits(readFileSync(file, 'utf8')).map((needle) => ({ file, needle })),
    )
    expect(violations).toEqual([])
  })

  test('the public picker consumes the exhaustive authority target builder', () => {
    const picker = readFileSync(join(SRC, 'components/RuntimeParameterPicker.tsx'), 'utf8')
    expect(picker).toContain('runtimeParameterTargetForAuthority(authority, proposedTarget)')
    expect(picker).toContain('data-runtime-parameter-authority={authority}')
  })
})
