// 锁定 `assertTriggerSaveable` 的 **ACL 顺序不变量**：launch 目标对保存者不可见
// （或不存在）时，必须在读取并回显其 definition 内容之前，以 404 同形拒绝。
//
// 为什么这条测试存在（2026-08-11 资源归一调研的发现）：
//   `services/webhook/triggerValidation.ts` 原本先无 ACL 地 `select` workflow
//   definition，把 inputs 喂给 `validateWorkflowInputMappings`，而该函数产出的
//   issue **逐字回显 workflow 的 input key 与 kind**（`unknown-input` 回显 key、
//   `required-input-unmapped` 回显 def.key、`input-kind-unmappable` 回显
//   `${key}: ${def.kind}`）。这些 issue 在静态校验层就抛出，**早于**
//   `assertScheduledTargetUsable` 里的 `canViewResource` 门 ⇒ 结构上构成一个
//   「不可见 workflow 的存在性 + 必填输入名 + 输入 kind」oracle，正是仓内其它
//   地方（如 routes/workflows.ts 的 DELETE 门顺序）精心保序防的 D1 泄漏。
//
// 当前**不可利用**，本测试锁的是顺序不变量本身：`webhook-triggers:create` /
//   `:update` 今天只在 admin 的权限集里（shared/schemas/permission.ts —— 既不在
//   USER_BASELINE 也不在 MANAGER_EXTRA），而 admin 恒 `isResourceAdminActor`
//   ⇒ `canViewResource` 对任何 workflow 都返回 true，能走到这条路径的人本就全可见。
//   但 RFC-260 已经把 webhook 的**读**面下放给了全体用户，写面下放是可预见的演进；
//   没有这条锁，那一天泄漏会静默变成真漏洞。因此测试直接在**服务层**构造一个
//   role='user' 的 actor，绕开路由权限矩阵，精确断言函数自身的顺序契约。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { workflows } from '../src/db/schema'
import { buildActor, type Actor } from '../src/auth/actor'
import { createUser } from '../src/services/users'
import { assertTriggerSaveable } from '../src/services/webhook/triggerValidation'
import { NotFoundError, ValidationError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

/** workflow 的输入结构 —— 这些字面量就是「不得泄漏给不可见者」的内容。 */
const SECRET_INPUT_KEYS = ['classified_prompt', 'classified_ref', 'classified_mode'] as const

async function harness(): Promise<{
  db: DbClient
  workflowId: string
  owner: Actor
  outsider: Actor
}> {
  const db = createInMemoryDb(MIGRATIONS)
  const aliceRow = await createUser(db, {
    username: 'alice',
    displayName: 'alice',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const bobRow = await createUser(db, {
    username: 'bob',
    displayName: 'bob',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'classified-workflow',
    description: '',
    definition: JSON.stringify({
      $schema_version: 1,
      inputs: [
        { kind: 'text', key: SECRET_INPUT_KEYS[0], label: 'p', required: true },
        { kind: 'git', key: SECRET_INPUT_KEYS[1], label: 'g', required: true },
        { kind: 'enum', key: SECRET_INPUT_KEYS[2], label: 'm', required: false, values: ['a'] },
      ],
      nodes: [],
      edges: [],
    }),
    version: 1,
    ownerUserId: aliceRow.id,
    visibility: 'private',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const asActor = (row: { id: string; username: string }): Actor =>
    buildActor({
      user: {
        id: row.id,
        username: row.username,
        displayName: row.username,
        role: 'user',
        status: 'active',
      },
      source: 'session',
    })
  return {
    db,
    workflowId,
    owner: asActor({ id: aliceRow.id, username: 'alice' }),
    outsider: asActor({ id: bobRow.id, username: 'bob' }),
  }
}

/** 触发**全部三类**回显型 issue 的 payload：未知 key + 必填未映射 + enum 不可映射。 */
function leakyPayload(): unknown {
  return {
    inputs: {
      totally_unknown_key: { kind: 'template', template: 'x' },
      [SECRET_INPUT_KEYS[2]]: { kind: 'template', template: 'a' },
    },
  }
}

function candidateFor(workflowId: string, payload: unknown) {
  return {
    launchKind: 'workflow' as const,
    launchRefId: workflowId,
    launchPayload: payload,
    eventTypes: ['mr_opened'] as const,
    autoRegisterRepos: false,
  }
}

describe('webhook 触发器保存期 · ACL 顺序不变量', () => {
  test('目标不可见：先 404 同形，且错误里不含 workflow 的任何输入结构', async () => {
    const h = await harness()
    let thrown: unknown
    try {
      await assertTriggerSaveable(
        h.db,
        h.outsider,
        candidateFor(h.workflowId, leakyPayload()),
        null,
      )
    } catch (err) {
      thrown = err
    }
    // 顺序：ACL 门先于静态校验 ⇒ 必须是 404 同形，不是 422 静态校验失败。
    expect(thrown).toBeInstanceOf(NotFoundError)
    expect((thrown as NotFoundError).code).toBe('workflow-not-found')
    // 正向防泄漏断言：整个错误（含 details）不得出现该 workflow 的任何 input key。
    const serialized = JSON.stringify({
      code: (thrown as NotFoundError).code,
      message: (thrown as Error).message,
      details: (thrown as { details?: unknown }).details ?? null,
    })
    for (const key of SECRET_INPUT_KEYS) {
      expect(serialized).not.toContain(key)
    }
  })

  test('目标不存在：同样 404 同形（存在性不可区分）', async () => {
    const h = await harness()
    let thrown: unknown
    try {
      await assertTriggerSaveable(
        h.db,
        h.outsider,
        candidateFor('01JMISSINGWORKFLOWID0000', leakyPayload()),
        null,
      )
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(NotFoundError)
    expect((thrown as NotFoundError).code).toBe('workflow-not-found')
  })

  test('对照：目标可见时静态校验照常报 422 并回显输入结构（修复不得压掉正常路径）', async () => {
    const h = await harness()
    let thrown: unknown
    try {
      await assertTriggerSaveable(h.db, h.owner, candidateFor(h.workflowId, leakyPayload()), null)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ValidationError)
    expect((thrown as ValidationError).code).toBe('webhook-trigger-invalid')
    const issues = ((thrown as { details?: { issues?: Array<{ code: string; detail: string }> } })
      .details?.issues ?? []) as Array<{ code: string; detail: string }>
    const codes = issues.map((i) => i.code)
    expect(codes).toContain('unknown-input')
    expect(codes).toContain('required-input-unmapped')
    expect(codes).toContain('input-kind-unmappable')
    // owner 有权看见自己的结构 —— 回显在这一侧是正确行为。
    expect(JSON.stringify(issues)).toContain(SECRET_INPUT_KEYS[0])
  })
})
