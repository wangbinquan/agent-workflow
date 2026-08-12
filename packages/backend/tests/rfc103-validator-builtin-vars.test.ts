// RFC-103 T5 (调研报告 04-WFM-06/07) — 校验器内置 prompt 变量单一事实源。
//
// 为什么这条测试存在：校验器（workflow.validator.ts）维护了一份 builtin
// prompt-var Set，与替换引擎（shared/prompt.ts BUILTIN_VARS）各写一份并漂移：
// 校验器漏了 RFC-066 多仓（__repos__ / __repo_names__ / __repo_count__）与
// RFC-056 cross-clarify（__external_feedback__ 等），导致合法的 {{__repos__}}
// 模板被误报 prompt-template-unresolved 而阻止 launch。修复后校验器复用 shared
// 的同一个 BUILTIN_VARS。本测试锁定：① 单源集含曾漏的 token；② 校验器不再有
// 本地副本、且 import 了共享集。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { BUILTIN_VARS, DEPRECATED_PROMPT_TOKENS } from '@agent-workflow/shared'

describe('RFC-103 T5 — BUILTIN_VARS 单一事实源含曾被校验器漏掉的 token', () => {
  test('RFC-066 多仓变量在集中', () => {
    expect(BUILTIN_VARS.has('__repos__')).toBe(true)
    expect(BUILTIN_VARS.has('__repo_names__')).toBe(true)
    expect(BUILTIN_VARS.has('__repo_count__')).toBe(true)
  })
  test('RFC-148: 死 token 已出集（cross-clarify 三件 + 轮次分组两件）', () => {
    // RFC-132 收尾——这些 token 的渲染路径零生产者，随 RFC-148 删除；
    // 模板校验器不应再把它们当合法内建变量放行。
    expect(BUILTIN_VARS.has('__external_feedback__')).toBe(false)
    expect(BUILTIN_VARS.has('__external_feedback_iteration__')).toBe(false)
    expect(BUILTIN_VARS.has('__external_feedback_sources__')).toBe(false)
    expect(BUILTIN_VARS.has('__clarify_questions__')).toBe(false)
    expect(BUILTIN_VARS.has('__clarify_answers__')).toBe(false)
    // 活 token 仍在。
    expect(BUILTIN_VARS.has('__clarify_iteration__')).toBe(true)
    expect(BUILTIN_VARS.has('__clarify_remaining__')).toBe(true)
    // 实现门 high：出集 ≠ 破坏存量——五死 token 落 DEPRECATED 集（validator
    // 降级 warning、渲染替空），存量模板照常启动。
    for (const t of [
      '__external_feedback__',
      '__external_feedback_iteration__',
      '__external_feedback_sources__',
      '__clarify_questions__',
      '__clarify_answers__',
    ]) {
      expect(DEPRECATED_PROMPT_TOKENS.has(t)).toBe(true)
    }
  })
  test('基础变量仍在', () => {
    expect(BUILTIN_VARS.has('__repo_path__')).toBe(true)
    expect(BUILTIN_VARS.has('__shard_key__')).toBe(true)
  })
})

describe('RFC-103 T5 — 源码层断言（校验器复用共享集，无本地副本）', () => {
  const validatorSrc = readFileSync(
    join(import.meta.dir, '../src/services/workflow.validator.ts'),
    'utf8',
  )
  test('校验器 import 共享 BUILTIN_VARS 并用它判定', () => {
    expect(validatorSrc).toContain('BUILTIN_VARS')
    expect(validatorSrc).toContain('BUILTIN_VARS.has(name)')
  })
  test('校验器不再定义本地 BUILTIN_PROMPT_VARS 副本', () => {
    expect(validatorSrc).not.toContain('const BUILTIN_PROMPT_VARS')
  })
})
