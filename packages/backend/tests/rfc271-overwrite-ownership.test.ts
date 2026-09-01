// RFC-271 —— 归属规则「只能覆盖自己的，别人的不给覆盖选项」的**包级端到端**锁。
//
// 覆盖验收条款：AC-15（「覆盖」仅在本地同名资源属于你自己时可选）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）
//
// 先说清楚这条**不是**在补一个缺口——这条规则已经有两层实施，且都有测试：
//
//   · `bundle/apply.ts` 的 `bundle-overwrite-not-owned`：事务内、服务端复算行的
//     `ownerUserId`，不信客户端。测在 `rfc271-bundle-engine.test.ts` 与
//     `rfc271-capability-removal.test.ts`；
//   · 各域服务自己的写门（工作组是 `workgroups.ts` 的 `assertPrincipalCanWrite`）。
//     同类原语级围栏另见 `rfc271-mcp-owner-fence.test.ts`，那条连「他人 public 资源
//     id + 正确 hash」的伪造形态和对照组都写了。
//
// 这个文件补的是**上面那层**没被走过的一条路径：从 `buildPackagePreview` 到
// `commitResourcePackage` 的完整导入链，且前置状态是「我有一个 squad，别人也有一个
// squad」。这个前置很关键——只有它才让 `overwrite` **合法地**出现在 `allowedActions`
// 里（判据是 `candidates.some((c) => c.owned)`，我自己那个满足它），而 `candidateIds`
// 同时装着别人那一个（按 `eq(table.name, name)` 跨 owner 匹配，只过可见性）。于是
// `assertActionsAllowed` 的两项检查——动作在不在 `allowedActions`、targetId 在不在
// `candidateIds`——对「targetId = 别人那个」**都通过**，全靠下游拦住。
//
// 这不是缺陷：`candidateIds` 是 reuse 与 overwrite **共用**的，而 reuse 别人的资源是
// 用户明确要的能力（「可见即有读权限」），所以决策面本就不该按归属收窄。但正因为
// 判定被下放，**这条链路必须有自己的端到端锁**——否则哪天有人重构下游、以为上游
// 已经卡过了，越权就会从这条缝里出去。
//
// ③ 是配套的反向锁：谁想靠「把非自有候选从 candidateIds 里滤掉」来"加固"上游，会
// 立刻在 ③ 上变红，因为那等于顺手废掉 reuse 别人的资源。

import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { users, workgroups } from '../src/db/schema'
import { commitResourcePackage } from '../src/services/resourcePackage/commit'
import { parseResourcePackage } from '../src/services/resourcePackage/parse'
import { verifyPreviewToken } from '../src/services/resourcePackage/preview'
import { buildWorkgroupPackageZip } from './fixtures/rfc271Package'
import { buildPackagePreview } from './helpers/resourcePackageProvider'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const box = createSecretBoxFromKey(randomBytes(32))

const actorOf = (id: string): Actor =>
  ({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'daemon',
    permissions: new Set<string>(['workgroups:create', 'workgroups:update']),
  }) as unknown as Actor

const deps = (db: DbClient) => ({
  db,
  appHome: mkdtempSync(join(tmpdir(), 'aw-rfc271-own-')),
  box,
})

async function seedUser(db: DbClient, id: string): Promise<void> {
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'user',
    status: 'active',
    passwordHash: 'x',
    createdAt: 1,
    updatedAt: 1,
  } as never)
}

async function seedWorkgroup(db: DbClient, owner: string, name: string): Promise<string> {
  const id = ulid()
  await db.insert(workgroups).values({
    id,
    name,
    description: `owned by ${owner}`,
    instructions: '',
    mode: 'free_collab',
    leaderMemberId: null,
    shareOutputs: true,
    directMessages: false,
    blackboard: false,
    maxRounds: 20,
    completionGate: false,
    clarifyBudget: 3,
    fanOut: false,
    ownerUserId: owner,
    // public：本文件锁的是**归属**，不是可见性——别人的资源可见是前提，不是缺陷。
    visibility: 'public',
    createdAt: 1,
    updatedAt: 1,
  } as never)
  return id
}

/** 「我有一个 squad，别人也有一个 squad」——让 overwrite 合法出现在 allowedActions。 */
async function seedRivalWorkgroups(): Promise<{ db: DbClient; mine: string; theirs: string }> {
  const db = createInMemoryDb(MIGRATIONS)
  await seedUser(db, 'u1')
  await seedUser(db, 'victim')
  const mine = await seedWorkgroup(db, 'u1', 'squad')
  const theirs = await seedWorkgroup(db, 'victim', 'squad')
  return { db, mine, theirs }
}

async function previewAndCommit(
  db: DbClient,
  action: 'overwrite' | 'reuse',
  targetId: string,
): Promise<{ ok: true; action: string } | { ok: false; code: string }> {
  const pkg = await parseResourcePackage(buildWorkgroupPackageZip())
  const actor = actorOf('u1')
  const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })
  const humanBaseline = verifyPreviewToken(box, preview.previewToken).humanBaseline
  return commitResourcePackage(deps(db), actor, {
    pkg,
    previewToken: preview.previewToken,
    decisions: [{ localSlug: 'workgroup-squad', action, targetId }],
    humanMemberMappings: humanBaseline.map((slot) => ({
      workgroupSlug: slot.workgroupSlug,
      username: slot.username,
      userId: 'u1',
    })),
  }).then(
    (r) => {
      if (r.root === undefined) throw new Error('successful package commit must return its root')
      return { ok: true as const, action: String(r.root.action) }
    },
    (e: unknown) => ({ ok: false as const, code: String((e as { code?: string }).code ?? e) }),
  )
}

describe('AC-15 · 包级导入链上的 overwrite 归属边界', () => {
  test('① 覆盖**别人的**同名可见工作组 ⇒ 拒绝，且对方那一行一个字节没变', async () => {
    const { db, theirs } = await seedRivalWorkgroups()
    const before = db
      .select()
      .from(workgroups)
      .all()
      .find((r) => r.id === theirs)

    const out = await previewAndCommit(db, 'overwrite', theirs)

    // 断言**具体错误码**而不只是「被拒」：码即「哪一层拦的」。今天先撞上工作组域
    // 服务的写门（`workgroups.ts` 的 `assertPrincipalCanWrite`）；把那道门摘掉重跑，
    // 会落到引擎的 `bundle-overwrite-not-owned` —— 已实测，两层都真的在。
    // 若这里变红且实际码是 `bundle-overwrite-not-owned`，说明域服务那道门被动过，
    // 该去确认是有意重构还是回归，而不是顺手把期望值改掉。
    // RFC-324 —— 码从裸 `forbidden` 分流成只读档专用码：覆盖是**内容写**，而这个
    // 导入者对别人那份工作组只有可见性（public ⇒ 全员只读），拒绝理由正是这一条。
    expect(out).toEqual({ ok: false, code: 'resource-read-only' })

    // 不只断言被拒——还要断言**什么都没写下去**。写了一半才抛错的拒绝，与提前拒绝
    // 的，对受害者的数据是两回事。
    const after = db
      .select()
      .from(workgroups)
      .all()
      .find((r) => r.id === theirs)
    expect(after).toEqual(before)
    expect(after?.ownerUserId).toBe('victim')
    expect(after?.description).toBe('owned by victim')
  })

  test('② 覆盖**自己的**照常成功（①不得把正常路径一起收紧）', async () => {
    const { db, mine } = await seedRivalWorkgroups()
    const out = await previewAndCommit(db, 'overwrite', mine)
    // 收据报的是**引擎侧**动作名：导入决策的 `overwrite` 落到引擎是一次 `update`
    // （而 `reuse` 两侧同名，见③）。这层命名差异值得钉住——收据是给人看的交付物。
    expect(out).toMatchObject({ ok: true, action: 'update' })
  })

  test('③ **reuse 别人的仍然成功** —— 「可见即有读权限」是用户明确要的能力', async () => {
    const { db, theirs } = await seedRivalWorkgroups()
    const out = await previewAndCommit(db, 'reuse', theirs)
    expect(out).toMatchObject({ ok: true, action: 'reuse' })
  })

  test('④ 决策面按设计是宽的：别人的在候选里、overwrite 仍在 allowedActions', async () => {
    // 记录**当前分层**，不是主张它应当如此。`candidateIds` 与 reuse 共用，所以决策面
    // 不按归属收窄；判定下放给引擎。若将来把归属判断上移到 `assertActionsAllowed`
    // （一个合理的加固），这条会红——提醒改的人连带更新①的错误码期望与本文件顶部
    // 的分层说明，而不是默默两层都改、留下一份对不上的文档。
    const { db, mine, theirs } = await seedRivalWorkgroups()
    const pkg = await parseResourcePackage(buildWorkgroupPackageZip())
    const preview = await buildPackagePreview(db, actorOf('u1'), pkg, { box, importId: ulid() })
    const entry = preview.entries.find((e) => e.localSlug === 'workgroup-squad')

    expect(entry?.allowedActions).toContain('overwrite')
    expect((entry?.candidates ?? []).map((c) => c.id).sort()).toEqual([mine, theirs].sort())
    // owned 标记本身是对的——它只是没被用来卡 commit 的 targetId。
    expect(entry?.candidates.find((c) => c.id === theirs)?.owned).toBe(false)
    expect(entry?.candidates.find((c) => c.id === mine)?.owned).toBe(true)
  })
})
