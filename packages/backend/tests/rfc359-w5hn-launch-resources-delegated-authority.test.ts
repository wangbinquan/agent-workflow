// RFC-359 AC-1（plan §5hn 批次二 ①）—— 启动资源面**必须接受委派 actor**，两个引擎都要。
//
// 为什么这条测试存在（先红后绿，红的是生产缺陷不是测试）：
// PostgreSQL 守护进程根曾给单代理 / 工作组启动的资源面注入这样一份实现——
//
//     loadVisible: (actor) => workgroupCatalog.queries.get(
//       directOperationAuthority(identityAccess.directAuthority, actor), { id })
//
// `directOperationAuthority` 按**对象同一性**反查（`operationContext.ts` 的
// `directAuthorityForProjection`：`authorityByProjection.get(projection)`），只认凭据边缘
// `mintDirectAuthority` 铸出来的那一个投影。而**定时 / webhook / 子任务 / 任务执行**四条入口
// 拿到的都是 `delegatedRequests.forXxx(...)` 铸的**委派** actor——投影表里根本没有它，
// 于是当场抛 `foreign-legacy-actor-projection`，路由层翻成 HTTP 500。
// SQLite 那半在 `startAgentTask` / `startWorkgroupTask` 体内直接读库 + `canViewResource`，
// 对两种 actor 都成立，所以**同一个功能在 SQLite 上一直好、在 PostgreSQL 上一直 500**。
//
// 这条测试钉的不是某一条启动路，而是**端口契约本身**：启动资源面收的是 `Actor`，
// 那它就必须对**每一种**能合法出现在这个位置的 actor 成立。类型面把两类 actor 抹成了
// 同一个 `Actor`，所以只能由行为判据来守——`describeEachProvider`，两个引擎一起。
import { beforeEach, expect, test } from 'bun:test'

import type { Actor } from '@/auth/actor'
import { describeEachProvider } from './helpers/eachProvider'
import type { ProviderNeutralDatabase } from '@/db/query'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { composeDatabaseAgentResourceIntegrity } from '@/modules/resource-catalog/composition/agentResourceIntegrity'
import { createAgent } from '@/modules/resource-catalog/infrastructure/legacy/agent'
import { createWorkgroup } from '@/modules/resource-catalog/infrastructure/legacy/workgroups'
import { composeAgentLaunchResourceOperations } from '@/modules/task-execution/composition/agentLaunchResources'
import { composeWorkgroupLaunchResourceOperations } from '@/modules/task-execution/composition/workgroupLaunchResources'
import { directOperationAuthority } from '@/routes/operationAuthority'
import { admitDaemonIdentity } from '@/auth/session'
import { createUser } from '@/services/users'

describeEachProvider('RFC-359 AC-1 —— 启动资源面接受委派 actor', (harness) => {
  let db: ProviderNeutralDatabase
  let identityAccess: ReturnType<typeof createIdentityAccessRuntime>
  let ownerId = ''
  let agentId = ''
  let workgroupId = ''

  beforeEach(async () => {
    db = harness.db
    identityAccess = createIdentityAccessRuntime({ db })
    const owner = await createUser(db, {
      username: 'delegated-owner',
      displayName: 'D',
      role: 'user',
      password: 'longEnoughPassword',
    })
    ownerId = owner.id
    const agent = await createAgent(
      db,
      {
        name: 'delegated-visible-agent',
        description: '',
        outputs: [],
        syncOutputsOnIterate: true,
        permission: {},
        skills: [],
        dependsOn: [],
        mcp: [],
        plugins: [],
        frontmatterExtra: {},
        bodyMd: 'x',
      },
      { ownerUserId: ownerId },
    )
    agentId = agent.id
    const group = await createWorkgroup(
      db,
      {
        name: 'delegated-visible-workgroup',
        description: '',
        instructions: '',
        mode: 'leader_worker',
        leaderDisplayName: 'lead',
        switches: { shareOutputs: true, directMessages: false, blackboard: false },
        maxRounds: 5,
        completionGate: false,
        members: [{ memberType: 'agent', agentId, displayName: 'lead', roleDesc: '' }],
      },
      { ownerUserId: ownerId },
    )
    workgroupId = group.id
  })

  /** 四种委派入口各铸一个 actor：它们是生产上真正会走到启动资源面的那些。 */
  async function delegatedActors(): Promise<ReadonlyArray<readonly [string, Actor]>> {
    const admissions = [
      [
        'schedule',
        await identityAccess.delegatedRequests.forSchedule({
          ownerUserId: ownerId,
          scheduleId: 'sched-1',
          invocation: { kind: 'manual' },
        }),
      ],
      [
        'webhook',
        await identityAccess.delegatedRequests.forWebhook({
          ownerUserId: ownerId,
          triggerId: 'trig-1',
          deliveryId: 'del-1',
          fireId: 'fire-1',
        }),
      ],
      [
        'call-workflow',
        await identityAccess.delegatedRequests.forCall({
          kind: 'call-workflow',
          ownerUserId: ownerId,
          parentTaskId: 'task-1',
          parentNodeRunId: 'run-1',
        }),
      ],
      [
        'task-execution',
        await identityAccess.delegatedRequests.forTaskExecution({
          ownerUserId: ownerId,
          taskId: 'task-1',
        }),
      ],
    ] as const
    return admissions.map(([kind, admission]) => {
      expect(admission, `${kind}：委派身份没被准入，夹具本身坏了`).not.toBeNull()
      return [kind, admission!.actor as unknown as Actor] as const
    })
  }

  test('单代理启动的可见性查询对四种委派 actor 都成立', async () => {
    const resources = composeAgentLaunchResourceOperations({ db })
    for (const [kind, actor] of await delegatedActors()) {
      expect(
        (await resources.loadVisibleAgent(actor, agentId))?.id,
        `${kind} 铸出来的委派 actor 取不到自己 owner 的 agent`,
      ).toBe(agentId)
    }
  })

  test('工作组启动的可见性查询对四种委派 actor 都成立', async () => {
    const resources = composeWorkgroupLaunchResourceOperations({
      db,
      integrity: composeDatabaseAgentResourceIntegrity({
        db,
        authorization: composeResourceCatalogFor({ db }).authorization,
      }).launch,
    })
    for (const [kind, actor] of await delegatedActors()) {
      expect(
        (await resources.loadVisible(actor, workgroupId))?.id,
        `${kind} 铸出来的委派 actor 取不到自己 owner 的工作组`,
      ).toBe(workgroupId)
    }
  })

  // 变异证据：把上面两条换成**曾经的生产写法**（先投影成 direct authority），
  // 同一个委派 actor 立刻炸。没有这条，上面两条绿了也说明不了它们在守什么——
  // 它们可能只是在测「读库能读到自己的行」。
  test('曾经的生产写法（先投影成 direct authority）对同一个委派 actor 当场抛', async () => {
    const [, actor] = (await delegatedActors())[0]!
    expect(() => directOperationAuthority(identityAccess.directAuthority, actor)).toThrow(
      'foreign-legacy-actor-projection',
    )
  })

  // 反向：直连（凭据边缘铸出来的）actor 仍然能被投影——上一条不是「这个函数永远抛」。
  // `auth/session.ts:289-305` 把这条规律写在注释里很久了：「hand-built actors fail with
  // `foreign-legacy-actor-projection`」。知识一直在，装配还是踩了——所以要有行为判据。
  test('直连 actor 仍可被投影成 direct authority（上一条不是同义反复）', async () => {
    const identity = await admitDaemonIdentity(identityAccess)
    expect(identity, 'daemon 直连身份没被准入，夹具本身坏了').not.toBeNull()
    expect(directOperationAuthority(identityAccess.directAuthority, identity!.actor)).toBeDefined()
  })
})
