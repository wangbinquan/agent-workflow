import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '..', 'src', 'styles.css'), 'utf8')
const editor = readFileSync(
  resolve(__dirname, '..', 'src', 'components', 'repos', 'RepoGroupEditor.tsx'),
  'utf8',
)

describe('RFC-249 responsive contract', () => {
  test('移动端保留 44px 触控目标，行内设置降为单列', () => {
    expect(css).toMatch(
      /@media \(max-width: 820px\)[\s\S]*?\.repo-tree-editor__row[\s\S]*?min-height: 44px/,
    )
    expect(css).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.repo-tree-editor__inline-settings[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/,
    )
  })

  test('编辑器是单树行内设置，不再有常驻右侧 inspector', () => {
    expect(editor).toContain('<RepoTreeEditor')
    expect(editor).toContain('renderSettings=')
    expect(editor).not.toContain('repo-group-editor__inspector')
    expect(css).not.toContain('.repo-group-editor__inspector')
  })

  test('工作区阻止横向溢出，深层目录缩进有上限', () => {
    expect(css).toMatch(/\.repo-group-editor__workspace\s*\{[\s\S]*?overflow-x: hidden/)
    expect(editor).toContain('previewNodes={preview.data?.nodes}')
  })
})
