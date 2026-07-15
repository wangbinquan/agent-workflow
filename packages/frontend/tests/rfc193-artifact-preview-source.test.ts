// RFC-193 T8（design §6 case 10）— artifact preview source 纯函数契约。
//
// 为什么存在：`{ kind: 'file', path }` 预览源只带路径——独立的 tasks.preview
// 深链路由无从构造 port-artifacts URL，只能继续依赖 worktree（wrapper 内节点
// 的输出、GC 后的历史任务在预览里永久坏，Codex 设计门 P1）。artifact 源把
// path+runId+port 三元组带进 search；老链接（只 path）必须原样解析为 file
// 模式（向后兼容），runId+port 独存仍是 inline-port 模式。

import { describe, expect, test } from 'vitest'
import {
  buildPreviewTarget,
  resolvePreviewSource,
  validatePreviewSearch,
} from '../src/lib/markdown-preview'
import { portArtifactItemUrl } from '../src/lib/worktree-download'

describe('RFC-193 artifact preview source', () => {
  test('buildPreviewTarget(artifact) serializes path+runId+port', () => {
    const t = buildPreviewTarget('task1', {
      kind: 'artifact',
      path: 'design.md',
      runId: 'run1',
      port: 'doc',
    })
    expect(t.search).toEqual({ path: 'design.md', runId: 'run1', port: 'doc' })
    expect(t.to).toBe('/tasks/$id/preview')
  })

  test('resolvePreviewSource: all three params → artifact mode', () => {
    const search = validatePreviewSearch({ path: 'design.md', runId: 'run1', port: 'doc' })
    expect(resolvePreviewSource(search)).toEqual({
      mode: 'artifact',
      path: 'design.md',
      runId: 'run1',
      port: 'doc',
    })
  })

  test('legacy links keep their modes (back-compat)', () => {
    expect(resolvePreviewSource(validatePreviewSearch({ path: 'a.md' }))).toEqual({
      mode: 'file',
      path: 'a.md',
    })
    expect(resolvePreviewSource(validatePreviewSearch({ runId: 'r', port: 'p' }))).toEqual({
      mode: 'port',
      runId: 'r',
      port: 'p',
    })
    expect(resolvePreviewSource(validatePreviewSearch({}))).toEqual({ mode: 'invalid' })
  })

  test('portArtifactItemUrl encodes hostile port names and run ids', () => {
    expect(portArtifactItemUrl('http://d', 't1', 'r1', '../evil', 2)).toBe(
      'http://d/api/tasks/t1/port-artifacts/r1/..%2Fevil?item=2',
    )
    expect(portArtifactItemUrl('http://d', 't1', 'r1', 'doc')).toContain('?item=0')
  })
})
