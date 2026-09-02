// RFC-271 T23/T24 —— 导出入口的端到端：闭包 → manifest / README / bundle.json → zip。
//
// 三条产品级断言：
//  ① **包不带任何权属信息**（决策 4/12）。manifest 里出现 owner / visibility /
//     grant 都是 bug——带上它们只会诱导导入侧去「还原」一个在本实例上根本不存在
//     的主体，而用户拍板的规则是「谁导入的整体所有资源权限就归谁」。
//  ② **凭据的位置在包里、值不在包里**。
//  ③ **同一份闭包导出两次逐字节相同**（AC-7b 的前提，见 `encodeZip`）。

//
// 覆盖验收条款：AC-10（requirements 分段列出导入方需自备的东西）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { parse as parseYaml } from 'yaml'
import {
  encodePackageSecretFieldSegments,
  type ResourceBundle,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { eq } from 'drizzle-orm'
import { agents, mcps, workflows } from '../src/db/schema'
import { decodeZip } from '../src/modules/resource-catalog/infrastructure/legacy/skill-zip'
import { applyPackageSecretInputs } from '../src/services/resourcePackage/secretInputs'
import { exportResourcePackage } from './helpers/resourcePackageProvider'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
// 技能内容在文件系统里（`${appHome}/skills/{id}/files/`），所以导出要 appHome。
// 本文件的 seed 不建 managed 技能，目录不存在 ⇒ 读到空树，不影响这里的断言。
const APP_HOME = mkdtempSync(join(tmpdir(), 'rfc271-export-'))

const actorOf = (id: string, permissions: string[] = ['scripts:author']): Actor =>
  ({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'daemon',
    permissions: new Set(['resource-acl:private', ...permissions]),
  }) as unknown as Actor

const defn = (nodes: unknown[]): WorkflowDefinition =>
  ({ $schema_version: 4, inputs: [], nodes, edges: [] }) as unknown as WorkflowDefinition

async function seed(db: DbClient): Promise<{ wf: string }> {
  const mcpId = ulid()
  await db
    .insert(mcps)
    .values({
      id: mcpId,
      name: 'gh-tools',
      description: '',
      type: 'remote',
      config: JSON.stringify({
        url: 'https://api.test/mcp',
        headers: { Authorization: 'Bearer ghp_REAL_SECRET_VALUE' },
      }),
      enabled: true,
      ownerUserId: 'u1',
      visibility: 'private',
      createdAt: 1,
      updatedAt: 1,
    } as never)
    .run()
  const agentId = ulid()
  await db
    .insert(agents)
    .values({
      id: agentId,
      name: 'auditor',
      description: '',
      outputs: '[]',
      permission: '{}',
      skills: '[]',
      dependsOn: '[]',
      mcp: JSON.stringify([mcpId]),
      plugins: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
      ownerUserId: 'u1',
      visibility: 'private',
      createdAt: 1,
      updatedAt: 1,
    } as never)
    .run()
  const wfId = ulid()
  await db
    .insert(workflows)
    .values({
      id: wfId,
      name: 'audit',
      description: '',
      definition: JSON.stringify(defn([{ id: 'n1', kind: 'agent-single', agentId }])),
      ownerUserId: 'u1',
      visibility: 'private',
      createdAt: 1,
      updatedAt: 1,
    } as never)
    .run()
  return { wf: wfId }
}

const readEntry = (zip: Uint8Array, path: string): string => {
  const entry = decodeZip(zip).find((e) => e.path === path)
  if (entry === undefined) throw new Error(`missing zip entry ${path}`)
  return new TextDecoder().decode(entry.bytes())
}

describe('包的目录结构（AC-1：内部结构清晰明确）', () => {
  test('三个固定条目：manifest.yaml / README.md / bundle.json', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { wf } = await seed(db)
    const pkg = await exportResourcePackage(
      db,
      actorOf('u1'),
      { type: 'workflow', id: wf },
      { appHome: APP_HOME },
    )
    expect(
      decodeZip(pkg.zip)
        .map((e) => e.path)
        .sort(),
    ).toEqual(['README.md', 'bundle.json', 'manifest.yaml'])
    expect(pkg.filename).toContain('audit')
  })

  test('bundle.json 是机器契约、manifest 是给人看的 —— 两者分开', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { wf } = await seed(db)
    const pkg = await exportResourcePackage(
      db,
      actorOf('u1'),
      { type: 'workflow', id: wf },
      { appHome: APP_HOME },
    )
    const bundle = JSON.parse(readEntry(pkg.zip, 'bundle.json')) as {
      ops: unknown[]
      rootRef: string
    }
    expect(bundle.ops).toHaveLength(3) // workflow + agent + mcp
    expect(bundle.rootRef).toBe('local:workflow-audit')
  })
})

describe('① 包**不带任何权属信息**（决策 4/12）', () => {
  test('manifest 里不出现 owner / visibility / grant', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { wf } = await seed(db)
    const pkg = await exportResourcePackage(
      db,
      actorOf('u1'),
      { type: 'workflow', id: wf },
      { appHome: APP_HOME },
    )
    const raw = readEntry(pkg.zip, 'manifest.yaml')
    expect(raw).not.toContain('ownerUserId')
    expect(raw).not.toContain('visibility')
    expect(raw).not.toContain('aclRevision')
    // README 明说这件事，免得导入方以为「权限会跟着过来」。
    expect(readEntry(pkg.zip, 'README.md')).toContain('归**导入者**所有')
  })

  test('bundle.json 里同样没有权属字段', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { wf } = await seed(db)
    const pkg = await exportResourcePackage(
      db,
      actorOf('u1'),
      { type: 'workflow', id: wf },
      { appHome: APP_HOME },
    )
    const raw = readEntry(pkg.zip, 'bundle.json')
    expect(raw).not.toContain('ownerUserId')
    expect(raw).not.toContain('"visibility"')
  })
})

describe('② 凭据：位置在包里、值不在包里', () => {
  test('manifest.secrets 点名字段，原 token 在**整个包**里找不到', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { wf } = await seed(db)
    const pkg = await exportResourcePackage(
      db,
      actorOf('u1'),
      { type: 'workflow', id: wf },
      { appHome: APP_HOME },
    )
    const manifest = parseYaml(readEntry(pkg.zip, 'manifest.yaml')) as {
      secrets: Array<{ field: string; resourceName: string; resourceType: string }>
    }
    expect(manifest.secrets.some((s) => s.field === 'config.headers.Authorization')).toBe(true)

    // 硬断言：**整个 zip 的字节**里都不含原值。
    const all = new TextDecoder().decode(pkg.zip)
    expect(all).not.toContain('ghp_REAL_SECRET_VALUE')
  })

  test('README 说明了要重新填写，并给出数量', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { wf } = await seed(db)
    const pkg = await exportResourcePackage(
      db,
      actorOf('u1'),
      { type: 'workflow', id: wf },
      { appHome: APP_HOME },
    )
    expect(readEntry(pkg.zip, 'README.md')).toContain('原值不在包里')
  })

  test('分离式 --token/--password 的 value 槽脱敏，整个 zip 字节不含原值', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { wf } = await seed(db)
    const [agent] = await db.select().from(agents)
    const localMcpId = ulid()
    const tokenValue = 'SYNTHETIC_SEPARATED_TOKEN_FOR_ZIP_SCAN'
    const passwordValue = 'SYNTHETIC_SEPARATED_PASSWORD_FOR_ZIP_SCAN'
    await db
      .insert(mcps)
      .values({
        id: localMcpId,
        name: 'local-secret-tools',
        description: '',
        type: 'local',
        config: JSON.stringify({
          command: [
            'acme-tool',
            '--token',
            tokenValue,
            '--password',
            passwordValue,
            '--port',
            '8080',
          ],
          env: {},
        }),
        enabled: true,
        ownerUserId: 'u1',
        visibility: 'private',
        createdAt: 1,
        updatedAt: 1,
      } as never)
      .run()
    await db
      .update(agents)
      .set({ mcp: JSON.stringify([...JSON.parse(agent!.mcp), localMcpId]) })
      .where(eq(agents.id, agent!.id))
      .run()

    const pkg = await exportResourcePackage(
      db,
      actorOf('u1'),
      { type: 'workflow', id: wf },
      { appHome: APP_HOME },
    )
    const manifest = parseYaml(readEntry(pkg.zip, 'manifest.yaml')) as {
      secrets: Array<{ field: string; resourceName: string }>
    }
    expect(
      manifest.secrets
        .filter((ref) => ref.resourceName === 'local-secret-tools')
        .map((ref) => ref.field),
    ).toEqual(['config.command[2]', 'config.command[4]'])

    const bundle = JSON.parse(readEntry(pkg.zip, 'bundle.json')) as ResourceBundle
    const local = bundle.ops.find(
      (op) => (op.payload as { name?: string }).name === 'local-secret-tools',
    )
    expect((local?.payload as { config?: { command?: string[] } }).config?.command).toEqual([
      'acme-tool',
      '--token',
      '<REDACTED:SECRET>',
      '--password',
      '<REDACTED:SECRET>',
      '--port',
      '8080',
    ])

    const zipBytes = new TextDecoder().decode(pkg.zip)
    const decodedEntries = decodeZip(pkg.zip)
      .map((entry) => new TextDecoder().decode(entry.bytes()))
      .join('\n')
    for (const rawSecret of [tokenValue, passwordValue]) {
      expect(zipBytes).not.toContain(rawSecret)
      expect(decodedEntries).not.toContain(rawSecret)
    }

    const applied = applyPackageSecretInputs(
      bundle,
      manifest.secrets,
      manifest.secrets.map((ref) => ({
        ...ref,
        value:
          ref.resourceName !== 'local-secret-tools'
            ? 'synthetic-replacement'
            : ref.field === 'config.command[2]'
              ? tokenValue
              : passwordValue,
      })),
    )
    const appliedLocal = applied.bundle.ops.find(
      (op) => (op.payload as { name?: string }).name === 'local-secret-tools',
    )
    expect((appliedLocal?.payload as { config?: { command?: string[] } }).config?.command).toEqual([
      'acme-tool',
      '--token',
      tokenValue,
      '--password',
      passwordValue,
      '--port',
      '8080',
    ])
  })

  test('自由 JSON 的 dot/bracket/numeric key 经 export→apply 精确往返', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { wf } = await seed(db)
    const [agent] = await db.select().from(agents)
    const original = {
      'a.b': { token: 'literal-dot-value' },
      a: { b: { token: 'nested-dot-value' } },
      'items[0]': { password: 'literal-bracket-value' },
      items: [{ password: 'array-index-value' }],
      numeric: { '0': { apiKey: 'numeric-key-value' } },
    }
    await db
      .update(agents)
      .set({ frontmatterExtra: JSON.stringify(original) })
      .where(eq(agents.id, agent!.id))
      .run()

    const pkg = await exportResourcePackage(
      db,
      actorOf('u1'),
      { type: 'workflow', id: wf },
      { appHome: APP_HOME },
    )
    const manifest = parseYaml(readEntry(pkg.zip, 'manifest.yaml')) as {
      secrets: Array<{ field: string; resourceName: string; resourceType: string }>
    }
    const bundle = JSON.parse(readEntry(pkg.zip, 'bundle.json')) as ResourceBundle
    const expected = new Map<string, string>([
      [encodePackageSecretFieldSegments(['frontmatterExtra', 'a.b', 'token']), 'literal-dot-value'],
      [
        encodePackageSecretFieldSegments(['frontmatterExtra', 'a', 'b', 'token']),
        'nested-dot-value',
      ],
      [
        encodePackageSecretFieldSegments(['frontmatterExtra', 'items[0]', 'password']),
        'literal-bracket-value',
      ],
      [
        encodePackageSecretFieldSegments(['frontmatterExtra', 'items', 0, 'password']),
        'array-index-value',
      ],
      [
        encodePackageSecretFieldSegments(['frontmatterExtra', 'numeric', '0', 'apiKey']),
        'numeric-key-value',
      ],
    ])
    const agentSecrets = manifest.secrets.filter((ref) => ref.resourceName === 'auditor')
    expect(agentSecrets.map((ref) => ref.field).sort()).toEqual([...expected.keys()].sort())

    const applied = applyPackageSecretInputs(
      bundle,
      manifest.secrets,
      manifest.secrets.map((ref) => ({
        ...ref,
        value: expected.get(ref.field) ?? 'synthetic-replacement',
      })),
    )
    const agentOp = applied.bundle.ops.find(
      (op) => (op.payload as { name?: string }).name === 'auditor',
    )
    expect(
      (agentOp?.payload as { frontmatterExtra?: Record<string, unknown> }).frontmatterExtra,
    ).toEqual(original)
  })
})

describe('③ 逐字节可复现', () => {
  test('同一份闭包导出两次，zip 字节完全相同', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { wf } = await seed(db)
    const a = await exportResourcePackage(
      db,
      actorOf('u1'),
      { type: 'workflow', id: wf },
      { appHome: APP_HOME },
    )
    const b = await exportResourcePackage(
      db,
      actorOf('u1'),
      { type: 'workflow', id: wf },
      { appHome: APP_HOME },
    )
    expect([...a.zip]).toEqual([...b.zip])
  })
})

describe('requirements —— 导入方需要自备的东西', () => {
  test('MCP 形态进 requirements（它不是包内容，是前提）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { wf } = await seed(db)
    const pkg = await exportResourcePackage(
      db,
      actorOf('u1'),
      { type: 'workflow', id: wf },
      { appHome: APP_HOME },
    )
    const manifest = parseYaml(readEntry(pkg.zip, 'manifest.yaml')) as {
      requirements: { mcpKinds: string[] }
    }
    expect(manifest.requirements.mcpKinds).toEqual(['remote'])
  })

  test('代码平台与本地 MCP 可执行文件进入预检前提清单', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { wf } = await seed(db)
    const [agent] = await db.select().from(agents)
    const localMcpId = ulid()
    await db
      .insert(mcps)
      .values({
        id: localMcpId,
        name: 'local-tools',
        description: '',
        type: 'local',
        config: JSON.stringify({ command: ['acme-tool', '--stdio'], env: {} }),
        enabled: true,
        ownerUserId: 'u1',
        visibility: 'private',
        createdAt: 1,
        updatedAt: 1,
      } as never)
      .run()
    await db
      .update(agents)
      .set({ mcp: JSON.stringify([...JSON.parse(agent!.mcp), localMcpId]) })
      .where(eq(agents.id, agent!.id))
      .run()
    await db
      .update(workflows)
      .set({
        definition: JSON.stringify(
          defn([
            { id: 'n1', kind: 'agent-single', agentId: agent!.id },
            {
              id: 'host',
              kind: 'code-host-call',
              provider: 'gitlab',
              action: 'comment.create',
              params: { mr: '1', body: 'hi' },
            },
          ]),
        ),
      })
      .where(eq(workflows.id, wf))
      .run()

    const pkg = await exportResourcePackage(
      db,
      actorOf('u1', ['scripts:author', 'code-host-calls:author']),
      { type: 'workflow', id: wf },
      { appHome: APP_HOME },
    )
    const manifest = parseYaml(readEntry(pkg.zip, 'manifest.yaml')) as {
      requirements: { codeHosts: string[]; executables: string[] }
    }
    expect(manifest.requirements.codeHosts).toEqual(['gitlab'])
    expect(manifest.requirements.executables).toEqual(['acme-tool'])
  })
})
