// RFC-294 review 2026-08-30 §A2 —— status.md 必须是 committed architecture/*.json 的逐字投影。
//
// 为什么存在：RFC-294 三件套里同一组指标在 ≥5 处手抄且已互相漂移（design §17 写 AppDeps 54、
// plan §1 写 53、report 是 48）。`rfc294Status.ts` 把 committed 账本渲染成
// `design/RFC-294-backend-layered-target-architecture/status.md`，三件套只引用它；本守卫
// 钉住「渲染结果 == 提交的文件」，重生成账本却没刷新 status.md 就红。渲染器与
// `architecture:write` / `architecture:status` 共用同一实现。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  ARCHITECTURE_STATUS_PATH,
  readArchitectureStatusInputs,
  renderArchitectureStatus,
} from './rfc294Status'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const INPUTS = readArchitectureStatusInputs(REPO_ROOT)

describe('RFC-294 review §A2 —— status.md 投影', () => {
  test('status.md 与 committed architecture/*.json 逐字相等（重生成账本后必须一起刷新）', () => {
    expect(readFileSync(resolve(REPO_ROOT, ARCHITECTURE_STATUS_PATH), 'utf8')).toBe(
      renderArchitectureStatus(INPUTS),
    )
  })

  test('投影覆盖核心指标、分母、模块形状、facade、跨域边、public surface 与 required port 七节', () => {
    const rendered = renderArchitectureStatus(INPUTS)
    for (const heading of ['## 1. ', '## 2. ', '## 3. ', '## 4. ', '## 5. ', '## 6. ', '## 7. ']) {
      expect(rendered).toContain(heading)
    }
  })

  test('mutation：改动任一指标或账本条目都会改变投影', () => {
    const rendered = renderArchitectureStatus(INPUTS)
    const metrics = INPUTS.report.metrics as Record<string, unknown>
    expect(
      renderArchitectureStatus({
        ...INPUTS,
        report: { ...INPUTS.report, metrics: { ...metrics, knownViolations: 999 } },
      }),
    ).not.toBe(rendered)
    expect(renderArchitectureStatus({ ...INPUTS, facades: INPUTS.facades.slice(1) })).not.toBe(
      rendered,
    )
  })
})
