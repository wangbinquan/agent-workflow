// RFC-359 AC-10 —— `checkConfiguredDatabase` 的第一份判据。
//
// # 为什么这个文件此刻才出现
//
// 它是 `doctor` 里唯一按数据库 provider 分叉的那段，也是 AC-10 账本上 `cli/doctor.ts` 的
// 来源。动它之前先查覆盖面，结论是**一条都没有**：全仓没有任何测试 import
// `checkConfiguredDatabase`，它只作为 `doctorCommand()` 的一个未被断言的副作用执行过
// （`tests/cli.test.ts` 断的是 `opencode binary` / `git version` 两条别的检查）。
// 也就是说，在这份文件之前，把它整段删掉都不会有任何测试变红。
//
// # 这里锁的是什么——以及**不是**什么
//
// 锁的是这三条路径的**用户可见行为**：配置读不出来只报一条 not-ok；SQLite 且本地库文件还
// 不存在时不开库就能回话、且另外两条检查照常给出；PostgreSQL 即使本地没有库文件也不得走
// 「还没有库」那条分支，而是继续走到 provider runtime 解析并在那里收场。
//
// **它不是 AC-10 那次改形状的红绿证明**，这一点要说清楚：把
// `absentLocalStoreMessage !== null` 换回 `storage === 'embedded-file'`，这三条**照样全绿**。
// 因为本仓只有两个 provider、`storage` 与品牌一一对应，两种写法**今天逐字等价**——
// 这恰恰就是 W5-T19 头注说的「`storage` 只是同一张真值表的另一种拼法」。
// 形状由账本守卫（`PROVIDER_BRANCH_DEBT` 的站点计数）管，不由这个文件管；
// 这个文件管的是「将来谁改这段逻辑时，用户看到的话不许变」。
//
// 所以这份文件真正的价值在于**它此前不存在**：全仓没有任何测试 import
// `checkConfiguredDatabase`，在它之前把这整段删掉都不会有任何测试变红。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkConfiguredDatabase } from '@/cli/doctor'

const homes: string[] = []
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.AGENT_WORKFLOW_HOME
  const home = mkdtempSync(join(tmpdir(), 'aw-rfc359-ac10-doctor-'))
  homes.push(home)
  process.env.AGENT_WORKFLOW_HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
  else process.env.AGENT_WORKFLOW_HOME = previousHome
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function writeConfig(database: unknown): void {
  writeFileSync(
    join(process.env.AGENT_WORKFLOW_HOME!, 'config.json'),
    JSON.stringify({ database }),
    'utf8',
  )
}

describe('RFC-359 AC-10 —— doctor 的数据库检查', () => {
  test('配置读不出来时只报一条，且是 not-ok', async () => {
    writeFileSync(join(process.env.AGENT_WORKFLOW_HOME!, 'config.json'), '{ not json', 'utf8')
    const checks = await checkConfiguredDatabase()
    expect(checks).toHaveLength(1)
    expect(checks[0]?.name).toBe('database provider')
    expect(checks[0]?.ok).toBe(false)
    expect(checks[0]?.message).toContain('configuration unavailable')
  })

  test('SQLite 且本地库文件还不存在：报「还没有库」，并带上另外两条检查', async () => {
    writeConfig({ provider: 'sqlite' })
    const checks = await checkConfiguredDatabase()
    expect(checks).toHaveLength(3)
    expect(checks[0]).toMatchObject({
      name: 'database provider',
      ok: true,
      message: 'SQLite (no database yet)',
    })
    // 这条分支的意义在于**不去开库**就能回话，所以另外两条检查也必须照常给出来。
    expect(checks.map((check) => check.name)).toEqual([
      'database provider',
      'lifecycle',
      'repo credentials',
    ])
  })

  test('PostgreSQL 即使本地没有库文件，也不得走「还没有库」那条分支', async () => {
    // 与上一条用例**唯一**的差别就是 provider：同样是空 home、同样没有 Paths.db。
    writeConfig({
      provider: 'postgresql',
      urlEnv: 'AW_RFC359_AC10_UNSET_URL',
      poolMax: 4,
      connectTimeoutMs: 1_000,
      statementTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
    })
    const checks = await checkConfiguredDatabase()
    // 关键断言：**没有**那句 SQLite 专属的回话。改动前这里拿到的就是它。
    expect(checks.map((check) => check.message)).not.toContain('SQLite (no database yet)')
    // 它继续往下走到 provider runtime 解析，并在那里以一条 not-ok 收场
    //（这个 home 里没有世代指针，解析必然失败）——重点是**失败在该失败的地方**。
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ name: 'database provider', ok: false })
  })
})
