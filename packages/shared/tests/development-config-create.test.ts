// RFC-310 —— 配置资源创建载荷（前后端共用契约）的纯函数面。
//
// "载荷是否被真实后端接受"由 backend/tests/rfc310-config-create-contract.test.ts
// 打真实 app 验证（那条才是端到端的机械联系）。这里只锁**纯函数自身的行为**：
// 跨族不串字段、可执行引用 trim、各族最小必填齐全——这些用真实 app 测要么测不
// 出（串了字段后端也可能宽容收下），要么要绕一大圈。

import { describe, expect, test } from 'bun:test'

import {
  ADAPTER_PURPOSES,
  ADAPTER_REQUIRED_OPERATIONS,
  DEVELOPMENT_CONFIG_API_BASE,
  DEVELOPMENT_CONFIG_KINDS,
  buildDevelopmentConfigCreateBody,
} from '../src/developmentConfigCreate'

describe('buildDevelopmentConfigCreateBody', () => {
  test('the three draft-first kinds post name only — no adapter/template fields leak across', () => {
    for (const kind of ['employees', 'verification-profiles'] as const) {
      expect(
        buildDevelopmentConfigCreateBody({
          kind,
          name: 'n',
          // 故意把另外两族的输入一起塞进来：串出去就说明分支写反了。
          capabilityId: 'change.implement',
          purpose: 'pipeline-gate',
          executableRef: 'x.ts',
        }),
      ).toEqual({ name: 'n' })
    }
  })

  test('action templates carry capabilityId and nothing else (backend requires it at create)', () => {
    expect(
      buildDevelopmentConfigCreateBody({
        kind: 'action-templates',
        name: 'n',
        capabilityId: 'change.implement',
        executableRef: 'x.ts',
      }),
    ).toEqual({ name: 'n', capabilityId: 'change.implement' })
  })

  test('adapters carry a complete minimal content, with the purpose-specific operations', () => {
    for (const purpose of ADAPTER_PURPOSES) {
      const body = buildDevelopmentConfigCreateBody({
        kind: 'adapters',
        name: 'n',
        purpose,
        // 前后空白由构造器吃掉：用户粘贴路径时带空格是常态，而后端 strict
        // parse 不会替你 trim。
        executableRef: '  adapters/run.ts  ',
      })
      expect(body.purpose).toBe(purpose)
      const draft = body.draft as Record<string, unknown>
      expect(draft.executableRef).toBe('adapters/run.ts')
      expect(draft.purpose).toBe(purpose)
      expect(draft.operations).toEqual(ADAPTER_REQUIRED_OPERATIONS[purpose])
      // 事故 2 的报文正是 `Invalid literal value, expected 1`——两个版本字面量
      // 缺一不可。
      expect(draft.schemaVersion).toBe(1)
      expect(draft.contractVersion).toBe(1)
    }
  })

  test('every kind has an api base, and adapters stay integration-owned', () => {
    for (const kind of DEVELOPMENT_CONFIG_KINDS) {
      expect(DEVELOPMENT_CONFIG_API_BASE[kind]).toMatch(/^\/api\//)
    }
    // 前缀随 bounded context 而非随页面（RFC-294）。改成 `/api/code/...` 整页 404。
    expect(DEVELOPMENT_CONFIG_API_BASE.adapters).toBe('/api/integrations/development-adapters')
  })
})
