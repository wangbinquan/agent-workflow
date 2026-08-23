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

// RFC-317 T13 —— 语料非空（守卫的守卫：architecture/rfc317-guard-corpus-floor.test.ts）。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到源码语料（扫空即假绿）', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThanOrEqual(250)
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的**真实用法**喂给同一份判据。
//
// 上面已有一条 sentinel（`legacyWriterHits(FORBIDDEN.join('\n'))`），它证明的是
// 「每个 needle 单独成行时能被检出」。真实源码里退役写法从不单独成行——它出现在
// JSX 属性、import 语句、className 拼接、模板串里。这一条把判据放到那些形态上，
// 顺带钉住「注释里提到不算」这条边界。
describe('RFC-317 T14 —— matcher 自证：真实形态下的退役写法', () => {
  test('JSX / import / className / 模板串四种形态都命中', () => {
    for (const fabricated of [
      '<TemplateVarChips value={vars} onChange={setVars} />',
      "import { WebhookTriggerVarChips } from '@/components/WebhookTriggerVarChips'",
      'const cls = `template-var-chips ${active ? "is-active" : ""}`',
      "const opt = { key: savedTemplateOption, label: t('x') }",
    ]) {
      expect(legacyWriterHits(fabricated).length, `没抓到：${fabricated}`).toBeGreaterThan(0)
    }
  })

  test('现行写法零命中（判据不能宽到把正解也报了）', () => {
    const fabricated =
      "import { ChipsInput } from '@/components/ChipsInput'\n" +
      '<ChipsInput values={vars} onChange={setVars} testidPrefix="runtime-param" />\n'
    expect(legacyWriterHits(fabricated)).toEqual([])
  })
})
