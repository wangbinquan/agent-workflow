// RFC-349 回归防护 —— PostgreSQL daemon 自用的「系统身份」必须由 identity-access 注册表
// **铸**出来，不能手捏。
//
// 为什么这条测试存在：`cli/postgresqlDaemonApplication.ts` 曾在模块作用域用
// `buildActor({ user: { id: SYSTEM_USER_ID, … }, source: 'daemon' })` 拼出一个 `systemActor`，
// 再把它交给 `authorityFor` / `resourceAuthorityFor`。但 RFC-345 之后授权句柄是按**对象引用**
// 从注册表的 WeakMap 里取的（`modules/identity-access/application/operationContext.ts` 的
// `authorityByProjection`，只有 `mintDirectAuthority` 会往里写），手捏的投影一律抛
// `foreign-legacy-actor-projection`。于是 PostgreSQL 部署上有四条 daemon 自用路径**必然**炸：
//   1. `validationContext.load()`                      —— 动态工作流校验上下文（代理启动前的校验）
//   2. `workgroupLaunchResources.loadExistingAgentIds()` —— 工作组启动
//   3. 数字员工执行的 `agents.get` / `workflows.get`
//   4. 数字员工执行的 `resourceAuthorityFor(deps.actor)`（launch 第一步）
// SQLite 部署看不到这条：那边压根不用系统 actor——`cli/start.ts` 的动态工作流校验直接查库，
// 数字员工执行走 `composeDigitalEmployeeExecution` 的 `startDeps` 依赖链。
//
// 判据：①正式 admit 出来的 daemon 身份，能同时穿过两种生产接线（`authorityFor` 用的
// `directOperationAuthority`、`resourceAuthorityFor` 用的 `authorityForLegacyProjection`），
// 且账号事实与那个常量当年声称的完全一致（`__system__` / admin / daemon）；②当年那个手捏
// 常量**确实**会被同一个注册表拒掉——把「为什么不能手捏」钉进测试而不是靠注释；③daemon
// 组合根不许再退回手捏。
//
// 注：注册表本身与 provider 无关（两个 provider 共用 `buildIdentityAccessRuntime`，只有仓库
// 实现不同），所以 ①② 用内存 SQLite 起同一套运行时即可；缺陷落在**接线**上，由 ③ 锁住。

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildActor, SYSTEM_USER_ID, type Actor } from '../src/auth/actor'
import { actorOfDirectAuthority, admitDaemonIdentity } from '../src/auth/session'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createIdentityAccessRuntime } from '../src/modules/identity-access/composition'
import { directOperationAuthority, directRequestAuthority } from '../src/routes/operationAuthority'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_SOURCE = resolve(import.meta.dir, '..', 'src', 'cli', 'postgresqlDaemonApplication.ts')

/** daemon 组合根当年手捏的那个投影，逐字段照抄。 */
function handBuiltSystemActor(): Actor {
  return buildActor({
    user: {
      id: SYSTEM_USER_ID,
      username: SYSTEM_USER_ID,
      displayName: 'System',
      role: 'admin',
      status: 'active',
    },
    source: 'daemon',
  })
}

let db: DbClient
let identityAccess: ReturnType<typeof createIdentityAccessRuntime>

beforeEach(() => {
  db = createInMemoryDb(MIGRATIONS)
  identityAccess = createIdentityAccessRuntime({ db })
})

describe('RFC-349 — PostgreSQL daemon 的系统身份', () => {
  test('正式 admit 出来的身份能穿过两种生产接线，账号事实与手捏常量一致', async () => {
    const identity = await admitDaemonIdentity(identityAccess)
    expect(
      identity,
      '`__system__` 由迁移 0018 播种且不可禁用，admit 不出来说明库坏了',
    ).not.toBeNull()

    const actor = actorOfDirectAuthority(identity!)
    // `authorityFor` 那一路（validationContext / loadExistingAgentIds / agents.get / workflows.get）
    expect(() => directOperationAuthority(identityAccess.directAuthority, actor)).not.toThrow()
    // `resourceAuthorityFor` 那一路（数字员工 launch）
    expect(() => identityAccess.directAuthority.authorityForLegacyProjection(actor)).not.toThrow()
    expect(() => directRequestAuthority(identityAccess.directAuthority, actor)).not.toThrow()

    // 换掉常量不能顺手换掉身份：这些正是四条消费路径读的账号事实。
    expect(actor.user.id).toBe(SYSTEM_USER_ID)
    expect(actor.user.role).toBe('admin')
    expect(actor.user.status).toBe('active')
    expect(actor.source).toBe('daemon')
  })

  test('手捏的系统投影正是注册表要拒的那种', async () => {
    const handBuilt = handBuiltSystemActor()
    expect(
      () => directOperationAuthority(identityAccess.directAuthority, handBuilt),
      '手捏投影居然被接受了 ⇒ 上面那条「必须正式 admit」的判据失去意义',
    ).toThrow('foreign-legacy-actor-projection')
    expect(() => identityAccess.directAuthority.authorityForLegacyProjection(handBuilt)).toThrow(
      'foreign-legacy-actor-projection',
    )

    // 账号事实齐全、`__system__` 也确实活着——差的只是注册表句柄，所以旧代码在编译期
    // 与代码审查里都看不出问题，只在 PostgreSQL 真跑起来时炸。
    const current = await identityAccess.resolveAuthority.resolveCurrentSubject(SYSTEM_USER_ID)
    expect(current).not.toBeNull()
    expect(handBuilt.user.id).toBe(current!.userId)
    expect(handBuilt.user.role).toBe(current!.role)
    expect(current!.status).toBe('active')
  })

  test('daemon 组合根不再手捏系统 actor', () => {
    const source = readFileSync(DAEMON_SOURCE, 'utf8')
    const at = source.indexOf('const systemActor')
    expect(
      at,
      'postgresqlDaemonApplication.ts 里找不到 systemActor 的绑定（结构变了？）',
    ).toBeGreaterThan(-1)
    expect(
      source.slice(at, at + 200),
      'systemActor 不再来自被 admit 的身份 ⇒ 四条 daemon 自用路径又会抛 foreign-legacy-actor-projection',
    ).toContain('actorOfDirectAuthority(systemIdentity)')
    expect(
      source.includes('buildActor('),
      'daemon 组合根又手捏 actor 了 ⇒ 注册表不认它，交给 authorityFor / resourceAuthorityFor 必炸',
    ).toBe(false)
  })
})
