// RFC-252 G4 (T10) —— `agents.network` 的端到端契约。
//
// 这个字段的默认值是**安全语义**，不是风格问题：缺省 = `deny`，只有精确 `'allow'` 才是
// 授权。所以本文件锁的不是「能存能取」，而是**没有任何一条路径能把「未表态」读成「放行」**：
//
//   1. 存量行（列为 NULL）在 DTO 上必须**缺席**，而不是 `network: null` ——
//      一旦透出 null，下游任何 `?? 'allow'`、真值判断或 optional schema 序列化都可能
//      把它变成授权。
//   2. 列里的垃圾值（历史数据 / 手工 SQL）同样必须缺席，不得原样透出。
//   3. PATCH 传 null = 显式清回默认档；传 undefined = 不动（sparse patch）。
//   4. agent.md 导入时，任何非 `'deny'|'allow'` 的形状**降级进 frontmatterExtra 并告警**，
//      绝不当成授权 —— runtime 认错只是派发失败，network 认错是静默放行。
//
// AC-10：存量 agent（无该字段）行为与升级前字节一致。

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { parseAgentMarkdown, serializeAgentMarkdown } from '@agent-workflow/shared'
import { agents as agentsTable } from '../src/db/schema'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent, updateAgent } from '../src/services/agent'
import { getAgent } from './helpers/resourceLookup'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function basePayload(name: string) {
  return {
    name,
    description: '',
    outputs: ['report'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  }
}

async function rawRow(db: DbClient, name: string) {
  const rows = await db.select().from(agentsTable).where(eq(agentsTable.name, name))
  const row = rows[0]
  if (row === undefined) throw new Error(`no agent row '${name}'`)
  return row
}

describe('RFC-252 G4 · agents.network 默认即安全', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('不声明 → 列为 NULL，且 DTO 上该键**缺席**（不是 null）', async () => {
    const agent = await createAgent(db, basePayload('a'))
    expect((await rawRow(db, 'a')).network).toBe(null)
    expect(agent.network).toBeUndefined()
    // 关键：是「没有这个键」，不是「键存在但值为 null」——后者会被 optional schema
    // 序列化出去，也会让下游 `?? ` 兜底把它变成别的档。
    expect(Object.hasOwn(agent, 'network')).toBe(false)
  })

  test("声明 'allow' / 'deny' → 原样落列并回读", async () => {
    const allow = await createAgent(db, { ...basePayload('b'), network: 'allow' })
    expect(allow.network).toBe('allow')
    expect((await rawRow(db, 'b')).network).toBe('allow')

    const deny = await createAgent(db, { ...basePayload('c'), network: 'deny' })
    expect(deny.network).toBe('deny')
    expect((await rawRow(db, 'c')).network).toBe('deny')
  })

  test('列里的垃圾值不得透出（历史数据 / 手工 SQL 写入）', async () => {
    await createAgent(db, basePayload('d'))
    for (const junk of ['ALLOW', 'true', 'yes', '']) {
      await db.update(agentsTable).set({ network: junk }).where(eq(agentsTable.name, 'd'))
      const agent = await getAgent(db, 'd')
      expect(agent?.network).toBeUndefined()
      expect(Object.hasOwn(agent as object, 'network')).toBe(false)
    }
  })

  test('PATCH：null = 清回默认档，undefined = 不动', async () => {
    const created = await createAgent(db, { ...basePayload('e'), network: 'allow' })
    expect(created.network).toBe('allow')

    // 不动
    await updateAgent(db, created.id, { description: 'x' })
    expect((await getAgent(db, 'e'))?.network).toBe('allow')

    // 显式清除
    await updateAgent(db, created.id, { network: null })
    const cleared = await getAgent(db, 'e')
    expect(cleared?.network).toBeUndefined()
    expect((await rawRow(db, 'e')).network).toBe(null)

    // 再授权
    await updateAgent(db, created.id, { network: 'allow' })
    expect((await getAgent(db, 'e'))?.network).toBe('allow')
  })
})

describe('RFC-252 G4 · agent.md round-trip 与 fail-safe', () => {
  const md = (fm: string): string => `---\nname: x\n${fm}\n---\n\nbody\n`

  test('network: allow / deny 被识别为一等字段', () => {
    for (const value of ['allow', 'deny'] as const) {
      const parsed = parseAgentMarkdown(md(`network: ${value}`))
      expect(parsed.partial.network).toBe(value)
      expect(parsed.warnings).toEqual([])
      expect(parsed.partial.frontmatterExtra?.network).toBeUndefined()
    }
  })

  test('任何其它形状降级进 frontmatterExtra 并告警——绝不当成授权', () => {
    for (const bad of ['ALLOW', 'true', 'on', '1']) {
      const parsed = parseAgentMarkdown(md(`network: ${bad}`))
      expect(parsed.partial.network).toBeUndefined()
      expect(parsed.partial.frontmatterExtra?.network).toBeDefined()
      expect(parsed.warnings.join(' ')).toContain('network')
    }
  })

  test('序列化 → 解析 往返稳定，且缺省时不写出该键', () => {
    const withGrant = serializeAgentMarkdown({ name: 'x', network: 'allow', bodyMd: 'body' })
    expect(withGrant).toContain('network: allow')
    expect(parseAgentMarkdown(withGrant).partial.network).toBe('allow')

    const without = serializeAgentMarkdown({ name: 'x', bodyMd: 'body' })
    expect(without).not.toContain('network')
    expect(parseAgentMarkdown(without).partial.network).toBeUndefined()
  })
})
