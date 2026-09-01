// RFC-269 接线回归 —— 2026-08-10 本机全能力验收发现的 P0。
//
// 事故形状：`code-host-call` 节点在**任何**真实任务里都以
// `code-host-not-configured` 收场，即便管理员已经配好 gitlab 且设置页的
// 「测试连接」返回 ok。根因不是凭据、不是网络，而是**没有任何生产路径**把
// `CodeHostConnectionsService` 注进 scheduler：它只在 `mountCodeHostRoutes`
// 里就地构造，`buildStartTaskDeps` / `StartTaskDeps` / 子任务 opts 透传里
// 全都没有它。兄弟参数 `maxConcurrentCodeHostCalls` / `codeHostRequestTimeoutMs`
// 都从 config 一路穿到了 scheduler，唯独凭据服务漏了。
//
// 之所以整套 RFC-269 单测全绿：它们都直接调 `executeCodeHostCall` 并**自己
// 注入** connection，从没有一条断言走「从磁盘拿凭据」这一段。所以这里锁的
// 就是那一段——不注入时也必须能解析出来，且缺密钥/缺行时仍然干净地判未配置。
//
// 同族教训见 `docs/dev-gotchas.md`：RFC-115 的 `defaultRuntime`、RFC-266 的
// fan-out 上限都是同一形状——「设置页写入 + scheduler 消费 + 中间没人接线」。

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb } from '../src/db/client'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { codeHostConnections } from '../src/db/schema'
import {
  createCodeHostConnectionsService,
  resolveCodeHostConnectionsFromKeyFile,
} from '../src/services/codeHost/connections'
import {
  composeRepositoryTransportCredentials,
  SQLiteRepositoryTransportCredentialRepository,
} from '../src/modules/source-control/composition'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
// 夹具刻意不带 glpat- / ghp_ 前缀（gitleaks 规则），同 connections 测试。
const SECRET_TOKEN = 'aw-fixture-not-a-real-token-8100' // gitleaks:allow

function seededHome(): { keyPath: string; key: Buffer } {
  const home = mkdtempSync(join(tmpdir(), 'aw-codehost-wiring-'))
  const key = Buffer.alloc(32, 11)
  const keyPath = join(home, 'secret.key')
  writeFileSync(keyPath, key, { mode: 0o600 })
  return { keyPath, key }
}

async function dbWithGitlabRow(key: Buffer) {
  const db = createInMemoryDb(MIGRATIONS)
  const box = createSecretBoxFromKey(key)
  const repositoryTransport = composeRepositoryTransportCredentials(
    new SQLiteRepositoryTransportCredentialRepository(db),
    box,
  ).adminConnections
  await createCodeHostConnectionsService({ repositoryTransport, secretBox: box }).upsert('gitlab', {
    baseUrl: 'https://gitlab.corp.example/api/v4',
    token: SECRET_TOKEN,
  })
  return { db, repositoryTransport }
}

describe('RFC-269 凭据服务的磁盘懒解析（scheduler 的唯一接线点）', () => {
  test('有密钥文件 + 有配置行 ⇒ 不注入也解析得出完整凭据', async () => {
    const { keyPath, key } = seededHome()
    const { repositoryTransport } = await dbWithGitlabRow(key)

    const service = resolveCodeHostConnectionsFromKeyFile(repositoryTransport, keyPath)
    expect(service).not.toBeNull()

    const resolved = await service!.resolve('gitlab')
    expect(resolved).not.toBeNull()
    expect(resolved!.baseUrl).toBe('https://gitlab.corp.example/api/v4')
    // 解封后的 token 必须是原值——错的密钥会 unseal 抛错并被吞成 null，
    // 那正是「配了却像没配」的事故形态，所以这里比对逐字。
    expect(resolved!.token).toBe(SECRET_TOKEN)
  })

  test('未配置的 provider 仍然返回 null（自跳过语义不变）', async () => {
    const { keyPath, key } = seededHome()
    const { repositoryTransport } = await dbWithGitlabRow(key)
    const service = resolveCodeHostConnectionsFromKeyFile(repositoryTransport, keyPath)
    expect(await service!.resolve('github')).toBeNull()
  })

  test('密钥文件不存在 ⇒ 返回 null，且**不创建**密钥文件', async () => {
    const { key } = seededHome()
    const home = mkdtempSync(join(tmpdir(), 'aw-codehost-nokey-'))
    const missing = join(home, 'secret.key')
    const { repositoryTransport } = await dbWithGitlabRow(key)

    expect(resolveCodeHostConnectionsFromKeyFile(repositoryTransport, missing)).toBeNull()
    // 承重：这条路径每派发一个 code-host 节点就走一次。`ensureSecretKey` 会在
    // 缺文件时生成密钥——真用了它，一次节点派发就会在别人的 home 里落下一个
    // 密钥文件；读取路径必须保持无副作用。
    expect(existsSync(missing)).toBe(false)
  })

  test('密钥长度不对 ⇒ 返回 null 而不是抛穿到调度器', () => {
    const home = mkdtempSync(join(tmpdir(), 'aw-codehost-badkey-'))
    const keyPath = join(home, 'secret.key')
    writeFileSync(keyPath, Buffer.alloc(7, 1), { mode: 0o600 })
    const db = createInMemoryDb(MIGRATIONS)
    const repositoryTransport = composeRepositoryTransportCredentials(
      new SQLiteRepositoryTransportCredentialRepository(db),
      createSecretBoxFromKey(Buffer.alloc(32, 1)),
    ).adminConnections
    expect(resolveCodeHostConnectionsFromKeyFile(repositoryTransport, keyPath)).toBeNull()
  })

  test('密钥换过（密文解不开）⇒ resolve 返回 null，不拿空 token 去打 401', async () => {
    const { keyPath } = seededHome() // 密钥 = 11
    const { repositoryTransport } = await dbWithGitlabRow(Buffer.alloc(32, 22)) // 行是用另一把密钥封的
    const service = resolveCodeHostConnectionsFromKeyFile(repositoryTransport, keyPath)
    expect(service).not.toBeNull()
    expect(await service!.resolve('gitlab')).toBeNull()
  })
})

describe('RFC-269 接线：node mechanics 侧的解析点必须存在', () => {
  // 源码层兜底。上面的行为断言可以在「有人把 scheduler 里的 fallback 删掉、
  // 只留 opts.codeHostConnections」之后继续全绿——那恰好是回归本身。
  test('node mechanics 只消费 bootstrap 注入的 provider-neutral connection participant', async () => {
    const src = await Bun.file(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'composition',
        'nodeMechanics.ts',
      ),
    ).text()
    expect(src).toContain('const connections = opts.codeHostConnections')
    expect(src).toContain('await connections.resolve(provider)')
    expect(src).not.toContain('resolveCodeHostConnectionsFromKeyFile(')
    expect(src).not.toContain('Paths.secretKeyFile')
  })

  test('code_host_connections 行存在时，表结构仍是每 provider 一行', async () => {
    const { key } = seededHome()
    const { db } = await dbWithGitlabRow(key)
    const rows = db.select().from(codeHostConnections).all()
    expect(rows.length).toBe(1)
    expect(rows[0]!.provider).toBe('gitlab')
  })
})
