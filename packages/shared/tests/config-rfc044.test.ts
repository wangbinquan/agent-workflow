// RFC-044 — ConfigSchema additions for distiller source-context budget.
//
// Locks the new memoryDistillSourceContext field (optional) + its byte caps
// against the existing DEFAULT_CONFIG / ConfigPatchSchema contract surface.

import { describe, expect, test } from 'bun:test'

import {
  ConfigPatchSchema,
  ConfigSchema,
  DEFAULT_CONFIG,
  DEFAULT_SOURCE_CONTEXT_BUDGET,
  resolveSourceContextBudget,
} from '../src/schemas/config.js'

describe('RFC-044 ConfigSchema additions', () => {
  test('accepts a valid memoryDistillSourceContext object', () => {
    const parsed = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      memoryDistillSourceContext: { clarifyTranscriptMaxBytes: 8192, reviewBodyMaxBytes: 4096 },
    })
    expect(parsed.memoryDistillSourceContext).toEqual({
      clarifyTranscriptMaxBytes: 8192,
      reviewBodyMaxBytes: 4096,
    })
  })

  test('omitted field stays undefined (backward-compatible default)', () => {
    const parsed = ConfigSchema.parse({ ...DEFAULT_CONFIG })
    expect(parsed.memoryDistillSourceContext).toBeUndefined()
  })

  test('zero is allowed (disables block)', () => {
    const parsed = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      memoryDistillSourceContext: { clarifyTranscriptMaxBytes: 0, reviewBodyMaxBytes: 0 },
    })
    expect(parsed.memoryDistillSourceContext?.clarifyTranscriptMaxBytes).toBe(0)
    expect(parsed.memoryDistillSourceContext?.reviewBodyMaxBytes).toBe(0)
  })

  test('upper bound 65536 accepted; 65537 rejected', () => {
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        memoryDistillSourceContext: {
          clarifyTranscriptMaxBytes: 65536,
          reviewBodyMaxBytes: 65536,
        },
      }),
    ).not.toThrow()
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        memoryDistillSourceContext: {
          clarifyTranscriptMaxBytes: 65537,
          reviewBodyMaxBytes: 65536,
        },
      }),
    ).toThrow()
  })

  test('negative byte budget rejected', () => {
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        memoryDistillSourceContext: {
          clarifyTranscriptMaxBytes: -1,
          reviewBodyMaxBytes: 0,
        },
      }),
    ).toThrow()
  })

  test('non-integer rejected', () => {
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        memoryDistillSourceContext: {
          clarifyTranscriptMaxBytes: 100.5,
          reviewBodyMaxBytes: 1000,
        },
      }),
    ).toThrow()
  })

  test('ConfigPatchSchema accepts the new field as a partial', () => {
    const parsed = ConfigPatchSchema.parse({
      memoryDistillSourceContext: { clarifyTranscriptMaxBytes: 1024, reviewBodyMaxBytes: 1024 },
    })
    expect(parsed.memoryDistillSourceContext?.clarifyTranscriptMaxBytes).toBe(1024)
  })

  test('DEFAULT_SOURCE_CONTEXT_BUDGET is the single source of truth', () => {
    // RFC-366 加了四项（agent-run 的三块 + task-run 的摘要块）。整体相等而不是
    // 逐项包含：这个常量的职责就是「唯一一份默认值」，多出一项没人注意到的默认
    // 预算，等于多了一处可以和设置页/文档走散的数字。
    expect(DEFAULT_SOURCE_CONTEXT_BUDGET).toEqual({
      // RFC-044 原始两项，值不许动（它们是 RFC-041 字节基线的延伸）。
      clarifyTranscriptMaxBytes: 16384,
      reviewBodyMaxBytes: 16384,
      // RFC-366 新增四项。
      agentTranscriptMaxBytes: 16384,
      agentOutputsMaxBytes: 8192,
      agentInjectedMemoriesMaxBytes: 4096,
      taskSummaryMaxBytes: 8192,
    })
  })

  // RFC-366：新四项在 zod 上是 optional，而 SourceContextBudget 这个内部类型里是
  // 必填——桥接只能发生在 resolveSourceContextBudget 一处。这条锁的是**存量配置**：
  // RFC-366 之前写下的 config.json 只有 RFC-044 那两个键，如果哪天有人把新键改成
  // 必填、或者绕过 resolver 直接读原始字段，那份配置要么解析失败、要么在需要数字的
  // 地方拿到 undefined —— 两种坏都不会在新装的机器上出现。
  test('resolveSourceContextBudget 把只有 RFC-044 两键的存量配置补全', () => {
    const legacy = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      memoryDistillSourceContext: { clarifyTranscriptMaxBytes: 1024, reviewBodyMaxBytes: 2048 },
    })
    expect(resolveSourceContextBudget(legacy.memoryDistillSourceContext)).toEqual({
      clarifyTranscriptMaxBytes: 1024,
      reviewBodyMaxBytes: 2048,
      agentTranscriptMaxBytes: 16384,
      agentOutputsMaxBytes: 8192,
      agentInjectedMemoriesMaxBytes: 4096,
      taskSummaryMaxBytes: 8192,
    })
  })

  test('resolveSourceContextBudget 对完全缺省的配置返回默认值的副本', () => {
    const resolved = resolveSourceContextBudget(undefined)
    expect(resolved).toEqual(DEFAULT_SOURCE_CONTEXT_BUDGET)
    // 副本而非同一个对象：调用方改了它不该污染那份唯一默认值。
    expect(resolved).not.toBe(DEFAULT_SOURCE_CONTEXT_BUDGET)
  })

  test('resolveSourceContextBudget 保留 0（关闭该块），不把它当成缺省', () => {
    expect(
      resolveSourceContextBudget({
        clarifyTranscriptMaxBytes: 0,
        reviewBodyMaxBytes: 0,
        agentTranscriptMaxBytes: 0,
        agentOutputsMaxBytes: 0,
        agentInjectedMemoriesMaxBytes: 0,
        taskSummaryMaxBytes: 0,
      }),
    ).toEqual({
      clarifyTranscriptMaxBytes: 0,
      reviewBodyMaxBytes: 0,
      agentTranscriptMaxBytes: 0,
      agentOutputsMaxBytes: 0,
      agentInjectedMemoriesMaxBytes: 0,
      taskSummaryMaxBytes: 0,
    })
  })
})
