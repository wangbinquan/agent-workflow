// RFC-271 R0 —— **真 DB / 真 FS 的往返**：建资源 → 导出 → 解析 → 预检 → 提交 → 比对。
//
// 这条测试存在的理由很具体。RFC-271 的实现门（2026-08-08）一次抓出四个 P1，其中
// 两个是同一种失败：
//
//   · 技能导出恒为空（`skills` 表**没有** bodyMd / frontmatterExtra 列，内容全在
//     `managedPath` 指向的文件系统里，而序列化器只读行）；
//   · 工作组导出恒为空（开关是各自独立的 boolean 列、成员在 `workgroup_members`
//     表，而序列化器读的是并不存在的 `switchesJson` / `membersJson`）。
//
// 两处**单元测试全绿**——因为它们喂给序列化器的是手写的 fake row，形状正是实现
// 假设的那个形状。测试与实现共享了同一个错误假设，于是互相印证。
//
// 只有一条「从真 schema 出发、走完整条链路、再回到真 schema」的往返能戳破这种
// 自洽：fixture 由**真实的建资源路径**产出，断言落在**真实的行与文件**上。
//
// 新增资源类型 / 新增字段时，请在这里补一条对应的往返断言——而不是只补一个喂
// fake row 的单测。

//
// 覆盖验收条款：AC-5（技能带整棵文件树）/ AC-9（builtin 不入 resources，只入 builtins 声明）/ AC-19（工作组人类席位逐个显式映射，无按 username 自动绑定）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）

import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents,
  mcps,
  skills,
  users,
  workflows,
  workgroupMembers,
  workgroups,
} from '../src/db/schema'
import { decodeZip } from '../src/services/skill-zip'
import { createManagedSkillWithFiles } from '../src/services/skill'
import { exportResourcePackage } from '../src/services/resourcePackage/export'
import { parseResourcePackage } from '../src/services/resourcePackage/parse'
import { buildPackagePreview, verifyPreviewToken } from '../src/services/resourcePackage/preview'
import { commitResourcePackage } from '../src/services/resourcePackage/commit'
import { removeTempDirSync } from './fixtures/tempDir'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const box = createSecretBoxFromKey(randomBytes(32))

const WRITE_ALL = ['agents', 'skills', 'mcps', 'plugins', 'workflows', 'workgroups'].flatMap(
  (t) => [`${t}:create`, `${t}:update`],
)
const SESSION_PERMISSIONS = [...WRITE_ALL, 'users:search']

const actorOf = (id: string, permissions: readonly string[] = SESSION_PERMISSIONS): Actor =>
  ({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'daemon',
    permissions: new Set<string>(permissions),
  }) as unknown as Actor

/** 一个「实例」= 一个 DB + 一个 app home。往返要跨两个实例才有意义。 */
async function makeInstance(): Promise<{ db: DbClient; appHome: string }> {
  const db = createInMemoryDb(MIGRATIONS)
  const appHome = mkdtempSync(join(tmpdir(), 'rfc271-rt-'))
  await db.insert(users).values({
    id: 'u1',
    username: 'alice',
    displayName: 'Alice',
    role: 'user',
    status: 'active',
    passwordHash: 'x',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as never)
  return { db, appHome }
}

// 二进制辅助文件：utf-8 解码会破坏它，所以它同时锁住「字节原样」。
const BINARY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01])

async function seedSource(db: DbClient, appHome: string): Promise<{ skillId: string; wg: string }> {
  const skill = await createManagedSkillWithFiles(
    db,
    { appHome },
    { name: 'helper', description: 'a helper', ownerUserId: 'u1', actor: actorOf('u1') },
    (filesDir) => {
      writeFileSync(
        join(filesDir, 'SKILL.md'),
        '---\nname: helper\ndescription: a helper\nallowed-tools: [read]\n---\n\n# Helper\n\nbody text\n',
      )
      writeFileSync(join(filesDir, 'ref.md'), '# aux\n')
      writeFileSync(join(filesDir, 'logo.png'), BINARY)
    },
  )

  const mcpId = ulid()
  await db.insert(mcps).values({
    id: mcpId,
    name: 'gh',
    description: '',
    type: 'local',
    // argv 内嵌 token + env 里的密钥：脱敏后**结构不变、值没了**。
    config: JSON.stringify({
      command: ['node', 'srv.js', '--token=ghp_realsecretvalue123456'],
      env: { GITHUB_TOKEN: 'ghp_anotherrealsecret9876' },
    }),
    enabled: true,
    ownerUserId: 'u1',
    visibility: 'private',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as never)

  const agentId = ulid()
  await db.insert(agents).values({
    id: agentId,
    name: 'auditor',
    description: '',
    skills: JSON.stringify([{ kind: 'managed', skillId: skill.id }]),
    mcp: JSON.stringify([mcpId]),
    plugins: '[]',
    dependsOn: '[]',
    outputs: '[]',
    permission: '{}',
    bodyMd: '# auditor',
    frontmatterExtra: '{}',
    ownerUserId: 'u1',
    visibility: 'private',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as never)

  // 工作组：**非默认**开关 + 一个 agent 成员 + 一个 human 成员。默认值会让
  // 「开关根本没被导出」和「导出了恰好等于默认」无法区分。
  const wg = ulid()
  const leaderMemberId = ulid()
  await db.insert(workgroups).values({
    id: wg,
    name: 'squad',
    description: '',
    instructions: 'charter text',
    mode: 'leader_worker',
    leaderMemberId,
    shareOutputs: false,
    directMessages: true,
    blackboard: true,
    maxRounds: 7,
    completionGate: true,
    clarifyBudget: 5,
    fanOut: true,
    ownerUserId: 'u1',
    visibility: 'private',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as never)
  await db.insert(workgroupMembers).values([
    {
      id: leaderMemberId,
      workgroupId: wg,
      memberType: 'agent',
      agentId,
      agentName: 'auditor',
      displayName: 'lead',
      roleDesc: 'leads',
      sortOrder: 0,
      createdAt: Date.now(),
    },
    {
      id: ulid(),
      workgroupId: wg,
      memberType: 'human',
      userId: 'u1',
      displayName: 'reviewer',
      roleDesc: 'reviews',
      sortOrder: 1,
      createdAt: Date.now(),
    },
    {
      id: ulid(),
      workgroupId: wg,
      memberType: 'human',
      userId: 'u1',
      displayName: 'observer',
      roleDesc: 'observes',
      sortOrder: 2,
      createdAt: Date.now(),
    },
  ] as never)

  return { skillId: skill.id, wg }
}

describe('R0 · 真 DB 往返：导出 → 导入，内容必须对得上', () => {
  test('技能的文件树整棵过去了（含二进制，字节原样）', async () => {
    const src = await makeInstance()
    const { skillId } = await seedSource(src.db, src.appHome)
    try {
      const pkg = await exportResourcePackage(
        src.db,
        actorOf('u1'),
        { type: 'skill', id: skillId },
        { appHome: src.appHome },
      )

      // ① zip 里真的有文件（P1-3 的直接反例：这里曾经只有三个固定条目）。
      const entries = decodeZip(pkg.zip)
      const paths = entries.map((e) => e.path).sort()
      expect(paths).toContain('skills/skill-helper/files/ref.md')
      expect(paths).toContain('skills/skill-helper/files/logo.png')
      // SKILL.md 结构化进 payload，不重复打包一份。
      expect(paths).not.toContain('skills/skill-helper/files/SKILL.md')

      // ② 导入到**另一个实例**。
      const dst = await makeInstance()
      try {
        const parsed = await parseResourcePackage(pkg.zip)
        const preview = await buildPackagePreview(dst.db, actorOf('u1'), parsed, {
          box,
          importId: ulid(),
        })
        await commitResourcePackage({ db: dst.db, appHome: dst.appHome, box }, actorOf('u1'), {
          pkg: parsed,
          previewToken: preview.previewToken,
          decisions: preview.entries.map((e) => ({
            localSlug: e.localSlug,
            action: 'new' as const,
            finalName: e.suggestedName,
          })),
        })

        const landed = dst.db.select().from(skills).where(eq(skills.name, 'helper')).get()
        expect(landed).toBeDefined()
        const filesDir = join(dst.appHome, 'skills', landed!.id, 'files')

        // ③ 正文与 frontmatter 过来了（曾经恒为空字符串）。
        const skillMd = readFileSync(join(filesDir, 'SKILL.md'), 'utf-8')
        expect(skillMd).toContain('body text')
        expect(skillMd).toContain('allowed-tools')

        // ④ 辅助文件逐字节相同 —— 二进制那条尤其重要：utf-8 往返会破坏它。
        expect(readFileSync(join(filesDir, 'ref.md'), 'utf-8')).toBe('# aux\n')
        expect(new Uint8Array(readFileSync(join(filesDir, 'logo.png')))).toEqual(BINARY)
      } finally {
        removeTempDirSync(dst.appHome)
      }
    } finally {
      removeTempDirSync(src.appHome)
    }
  })

  test('工作组的开关与成员过去了，human 成员按用户选的映射落地', async () => {
    const src = await makeInstance()
    const { wg } = await seedSource(src.db, src.appHome)
    try {
      const pkg = await exportResourcePackage(
        src.db,
        actorOf('u1'),
        { type: 'workgroup', id: wg },
        { appHome: src.appHome },
      )

      const dst = await makeInstance()
      try {
        const parsed = await parseResourcePackage(pkg.zip)
        const preview = await buildPackagePreview(dst.db, actorOf('u1'), parsed, {
          box,
          importId: ulid(),
        })

        // human 成员必须被列成待映射的槽（P1-4 复现 B：它曾经原样透传 username）。
        expect(preview.humanMembers.map((m) => m.username)).toEqual(['alice', 'alice'])
        expect(preview.humanMembers.map((m) => m.displayName).sort()).toEqual([
          'observer',
          'reviewer',
        ])
        // 目标实例上恰好有同名用户 ⇒ 预填，但仍要用户拍板。
        expect(preview.humanMembers[0]!.suggestedUserId).toBe('u1')
        // 签名与提交按源用户 tuple 收口，不能因为两个 alias 要求/接受两条重复 mapping。
        expect(verifyPreviewToken(box, preview.previewToken).humanBaseline).toEqual([
          { workgroupSlug: 'workgroup-squad', username: 'alice', required: false },
        ])

        await commitResourcePackage({ db: dst.db, appHome: dst.appHome, box }, actorOf('u1'), {
          pkg: parsed,
          previewToken: preview.previewToken,
          decisions: preview.entries.map((e) => ({
            localSlug: e.localSlug,
            action: 'new' as const,
            finalName: e.suggestedName,
          })),
          humanMemberMappings: [
            {
              workgroupSlug: preview.humanMembers[0]!.workgroupSlug,
              username: 'alice',
              userId: 'u1',
            },
          ],
        })

        const landed = dst.db.select().from(workgroups).where(eq(workgroups.name, 'squad')).get()
        expect(landed).toBeDefined()
        // ⚠️ 逐个断言**非默认**值：曾经这些全部丢失，落地的是一组默认开关。
        expect(landed!.shareOutputs).toBe(false)
        expect(landed!.directMessages).toBe(true)
        expect(landed!.blackboard).toBe(true)
        expect(landed!.maxRounds).toBe(7)
        expect(landed!.completionGate).toBe(true)
        expect(landed!.instructions).toBe('charter text')

        const members = dst.db
          .select()
          .from(workgroupMembers)
          .where(eq(workgroupMembers.workgroupId, landed!.id))
          .all()
        expect(members.map((m) => m.displayName).sort()).toEqual(['lead', 'observer', 'reviewer'])

        const humans = members.filter((m) => m.memberType === 'human')
        // username 换成了**本地** user id，而不是原样带着源实例的字符串。
        expect(humans).toHaveLength(2)
        expect(humans.every((m) => m.userId === 'u1')).toBe(true)

        // leader 指向的仍是那个 agent 成员（leaderMemberId 是本地行 id，靠
        // displayName 这个组内稳定键重新绑定）。
        const leader = members.find((m) => m.id === landed!.leaderMemberId)
        expect(leader?.displayName).toBe('lead')
      } finally {
        removeTempDirSync(dst.appHome)
      }
    } finally {
      removeTempDirSync(src.appHome)
    }
  })

  test('MCP 的凭据没进包；留空后安全省略并进入导入报告', async () => {
    const src = await makeInstance()
    await seedSource(src.db, src.appHome)
    const agentRow = src.db.select().from(agents).where(eq(agents.name, 'auditor')).get()
    try {
      const pkg = await exportResourcePackage(
        src.db,
        actorOf('u1'),
        { type: 'agent', id: agentRow!.id },
        { appHome: src.appHome },
      )

      // ① 原值一个字节都不在包里（P1-2：argv / env 曾经原样进包）。
      const raw = new TextDecoder().decode(pkg.zip)
      expect(raw).not.toContain('ghp_realsecretvalue123456')
      expect(raw).not.toContain('ghp_anotherrealsecret9876')

      const dst = await makeInstance()
      try {
        const parsed = await parseResourcePackage(pkg.zip)
        const preview = await buildPackagePreview(dst.db, actorOf('u1'), parsed, {
          box,
          importId: ulid(),
        })
        const receipt = await commitResourcePackage(
          { db: dst.db, appHome: dst.appHome, box },
          actorOf('u1'),
          {
            pkg: parsed,
            previewToken: preview.previewToken,
            decisions: preview.entries.map((e) => ({
              localSlug: e.localSlug,
              action: 'new' as const,
              finalName: e.suggestedName,
            })),
          },
        )

        // ② 留空不是把占位符当真值落库：可选 argv/env 槽被删除，可执行档保持不变，
        // 且回执逐字段报告，方便用户知道还要去哪里补。
        const landed = dst.db.select().from(mcps).where(eq(mcps.name, 'gh')).get()
        const config = JSON.parse(landed!.config) as {
          command: string[]
          env: Record<string, string>
        }
        expect(config.command).toHaveLength(2)
        expect(config.command[0]).toBe('node')
        expect(config.command[1]).toBe('srv.js')
        expect(Object.keys(config.env)).toEqual([])
        expect(receipt.skippedSecrets).toEqual(
          expect.arrayContaining([
            { resourceType: 'mcp', resourceName: 'gh', field: 'config.command[2]' },
            { resourceType: 'mcp', resourceName: 'gh', field: 'config.env.GITHUB_TOKEN' },
          ]),
        )
      } finally {
        removeTempDirSync(dst.appHome)
      }
    } finally {
      removeTempDirSync(src.appHome)
    }
  })
})

describe('R0 · 写权限（用户规则：令牌有写权限才能导入，和界面操作一致）', () => {
  test('没有 skills:create 的令牌导不进一个含技能的包', async () => {
    const src = await makeInstance()
    const { skillId } = await seedSource(src.db, src.appHome)
    try {
      const pkg = await exportResourcePackage(
        src.db,
        actorOf('u1'),
        { type: 'skill', id: skillId },
        { appHome: src.appHome },
      )
      const dst = await makeInstance()
      try {
        const parsed = await parseResourcePackage(pkg.zip)
        // 预检仍完整返回，UI 才能逐条说明被什么权限挡住；真正 commit 仍服务端拒绝。
        const preview = await buildPackagePreview(dst.db, actorOf('u1', []), parsed, {
          box,
          importId: ulid(),
        })
        expect(preview.entries[0]).toMatchObject({
          allowedActions: [],
          defaultAction: null,
          missingPermissions: ['skills:create'],
        })
        await expect(
          commitResourcePackage({ db: dst.db, appHome: dst.appHome, box }, actorOf('u1', []), {
            pkg: parsed,
            previewToken: preview.previewToken,
            decisions: [{ localSlug: preview.entries[0]!.localSlug, action: 'new' }],
          }),
        ).rejects.toThrow(/new/)
      } finally {
        removeTempDirSync(dst.appHome)
      }
    } finally {
      removeTempDirSync(src.appHome)
    }
  })
})

describe('R0 · 导出产物与源系统 id 无关（导入后由新实例重建 id）', () => {
  test('完整闭包导出：bundle.json 里既无 `external:` 也无任何源 ULID', async () => {
    // 这是包能跨实例搬运的**前提**：包内身份只用 `local:<slug>`，源库的 ULID 在另一
    // 台机器上没有任何意义。
    //
    // ⚠️ 守的是一条**静默**失败：`refWire` 在「引用不在闭包里」时会退回
    // `external:<源 id>`（serialize.ts）。闭包完整时它永远走不到，可一旦
    // `directRefsOf` 将来漏掉某类引用出边，导出就会**不报错地**产出一个带源库 id
    // 的包——导入侧解析那个 id 要么失败、要么撞上同 id 的无关资源。
    const src = await makeInstance()
    const { skillId, wg } = await seedSource(src.db, src.appHome)
    try {
      const agentRow = src.db.select().from(agents).where(eq(agents.name, 'auditor')).get()
      const wfRow = { id: wg } // workgroup 也走同一条断言
      for (const root of [
        { type: 'agent' as const, id: agentRow!.id },
        { type: 'skill' as const, id: skillId },
        { type: 'workgroup' as const, id: wfRow.id },
      ]) {
        const pkg = await exportResourcePackage(src.db, actorOf('u1'), root, {
          appHome: src.appHome,
        })
        // ⚠️ 扫**整个 zip**，不是只扫 bundle.json。第一版只查 bundle.json，于是
        // `manifest.danglingCallRefs[].from` 里泄漏的源 ULID 完全没被发现。
        const whole = decodeZip(pkg.zip)
          .map((e) => `${e.path}\n${new TextDecoder().decode(e.bytes())}`)
          .join('\n')
        expect({ root: root.type, hasExternal: whole.includes('external:') }).toEqual({
          root: root.type,
          hasExternal: false,
        })
        // ⚠️ 枚举**六类**资源的源 id，不是只枚举 agents。第一版只查 agents 表，
        // 工作流 / 技能 / MCP / 工作组的 id 泄漏一律看不见。
        const sourceIds = [
          ...src.db
            .select()
            .from(agents)
            .all()
            .map((r) => r.id),
          ...src.db
            .select()
            .from(workflows)
            .all()
            .map((r) => r.id),
          ...src.db
            .select()
            .from(skills)
            .all()
            .map((r) => r.id),
          ...src.db
            .select()
            .from(mcps)
            .all()
            .map((r) => r.id),
          ...src.db
            .select()
            .from(workgroups)
            .all()
            .map((r) => r.id),
        ]
        for (const id of sourceIds) {
          expect({ root: root.type, id, leaked: whole.includes(id) }).toEqual({
            root: root.type,
            id,
            leaked: false,
          })
        }
      }
    } finally {
      removeTempDirSync(src.appHome)
    }
  })
  test('dangling call 目标：manifest 的 `from` 写包内 slug，不泄漏源 ULID', async () => {
    // 这是实现门实测到的泄漏点：`manifest.danglingCallRefs[].from` 直接写了
    // `callRefs.fromId`（源库 ULID）。而上面那条守卫的第一版只扫 bundle.json，
    // 完全看不到 manifest —— 所以这条用例必须**单独**造出 dangling ref。
    const src = await makeInstance()
    try {
      await src.db.insert(workflows).values({
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        name: 'caller',
        description: '',
        definition: JSON.stringify({
          $schema_version: 4,
          inputs: [],
          edges: [],
          nodes: [{ id: 'c1', kind: 'call-workflow', workflowName: 'does-not-exist' }],
        }),
        ownerUserId: 'u1',
        visibility: 'private',
        createdAt: 1,
        updatedAt: 1,
      } as never)

      const pkg = await exportResourcePackage(
        src.db,
        actorOf('u1'),
        { type: 'workflow', id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
        { appHome: src.appHome },
      )
      const manifest = new TextDecoder().decode(
        decodeZip(pkg.zip)
          .find((e) => e.path === 'manifest.yaml')!
          .bytes(),
      )
      // dangling 条目确实产出了（否则这条用例什么都没测）。
      expect(manifest).toContain('does-not-exist')
      // 但源库 id 不得出现。
      expect(manifest).not.toContain('01ARZ3NDEKTSV4RRFFQ69G5FAV')
      // `from` 用的是包内 slug。
      expect(manifest).toContain('workflow-caller')
    } finally {
      removeTempDirSync(src.appHome)
    }
  })
})

describe('Q6 · 框架 built-in：照常导出、标记出来、导入时自动忽略', () => {
  // 用户拍板的语义。反面是**复制一份**：对端会多出一个 owner 是导入者、
  // `builtin=false` 的同名副本，而真正的 built-in 仍在那儿 —— 两个同名资源共存，
  // 正好撞上运行时「执行闭包内不得同名」那条约束。
  const seedBuiltin = async (db: DbClient): Promise<void> => {
    await db.insert(agents).values({
      id: 'BUILTIN_AGENT',
      name: '__skill_merger__',
      description: '',
      outputs: '[]',
      permission: '{}',
      skills: '[]',
      dependsOn: '[]',
      mcp: '[]',
      plugins: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
      ownerUserId: '__system__',
      visibility: 'public',
      builtin: true,
      createdAt: 1,
      updatedAt: 1,
    } as never)
  }

  test('导出：built-in 不入 ops / resources，只入 manifest.builtins，引用改写成 builtin:', async () => {
    const src = await makeInstance()
    await seedBuiltin(src.db)
    await src.db.insert(workflows).values({
      id: 'WF',
      name: 'mine',
      description: '',
      definition: JSON.stringify({
        $schema_version: 4,
        inputs: [],
        edges: [],
        nodes: [{ id: 'n1', kind: 'agent-single', agentId: 'BUILTIN_AGENT' }],
      }),
      ownerUserId: 'u1',
      visibility: 'private',
      createdAt: 1,
      updatedAt: 1,
    } as never)
    try {
      const pkg = await exportResourcePackage(
        src.db,
        actorOf('u1'),
        { type: 'workflow', id: 'WF' },
        { appHome: src.appHome },
      )
      const entry = (p: string): string =>
        new TextDecoder().decode(
          decodeZip(pkg.zip)
            .find((e) => e.path === p)!
            .bytes(),
        )
      const bundle = entry('bundle.json')
      const manifest = entry('manifest.yaml')

      // built-in 没有 create op —— 导入侧因此「自动忽略」它。
      expect(bundle).not.toContain('agent-create')
      // 引用改写成按名字，而不是 local:（会复制）或 external:<源 id>（对端无意义）。
      expect(bundle).toContain('builtin:agent/__skill_merger__')
      expect(bundle).not.toContain('BUILTIN_AGENT')
      // manifest：不在 resources、在 builtins。
      expect(manifest).toContain('builtins')
      const resourcesSection = manifest.slice(
        manifest.indexOf('resources:'),
        manifest.indexOf('builtins:'),
      )
      expect(resourcesSection).not.toContain('__skill_merger__')
    } finally {
      removeTempDirSync(src.appHome)
    }
  })

  test('导入：绑到对端自己 seed 的 built-in，不新建副本', async () => {
    const src = await makeInstance()
    await seedBuiltin(src.db)
    await src.db.insert(workflows).values({
      id: 'WF',
      name: 'mine',
      description: '',
      definition: JSON.stringify({
        $schema_version: 4,
        inputs: [],
        edges: [],
        nodes: [{ id: 'n1', kind: 'agent-single', agentId: 'BUILTIN_AGENT' }],
      }),
      ownerUserId: 'u1',
      visibility: 'private',
      createdAt: 1,
      updatedAt: 1,
    } as never)
    try {
      const pkg = await exportResourcePackage(
        src.db,
        actorOf('u1'),
        { type: 'workflow', id: 'WF' },
        { appHome: src.appHome },
      )
      const dst = await makeInstance()
      // 对端有它**自己的** built-in，id 与源库完全不同。
      await dst.db.insert(agents).values({
        id: 'DST_BUILTIN',
        name: '__skill_merger__',
        description: '',
        outputs: '[]',
        permission: '{}',
        skills: '[]',
        dependsOn: '[]',
        mcp: '[]',
        plugins: '[]',
        frontmatterExtra: '{}',
        bodyMd: '',
        ownerUserId: '__system__',
        visibility: 'public',
        builtin: true,
        createdAt: 1,
        updatedAt: 1,
      } as never)
      try {
        const parsed = await parseResourcePackage(pkg.zip)
        const preview = await buildPackagePreview(dst.db, actorOf('u1'), parsed, {
          box,
          importId: ulid(),
        })
        // built-in 不产 op ⇒ 它根本不出现在需要用户决策的条目里（「自动忽略」）。
        expect(preview.entries.map((e) => e.name)).not.toContain('__skill_merger__')

        await commitResourcePackage({ db: dst.db, appHome: dst.appHome, box }, actorOf('u1'), {
          pkg: parsed,
          previewToken: preview.previewToken,
          decisions: preview.entries.map((e) => ({
            localSlug: e.localSlug,
            action: 'new' as const,
            finalName: e.suggestedName,
          })),
        })

        // 没有多出副本：仍然只有对端那一个 built-in。
        const merged = dst.db.select().from(agents).all()
        expect(merged).toHaveLength(1)
        expect(merged[0]!.id).toBe('DST_BUILTIN')
        // 工作流的节点绑到了**对端**的 id。
        const wf = dst.db.select().from(workflows).where(eq(workflows.name, 'mine')).get()
        expect(JSON.stringify(wf!.definition)).toContain('DST_BUILTIN')
      } finally {
        removeTempDirSync(dst.appHome)
      }
    } finally {
      removeTempDirSync(src.appHome)
    }
  })
})

describe('AC-9 · built-in 作**依赖**：完整链路 + 绑到对端自己的那一个', () => {
  // 这一段的历史值得留着。`builtin:` 这第五种 wire 形态最初只加进了 `bundle/payload.ts`
  // 的私有 regex，没进统一的 `ResourceRefAst` / 域 codec，于是 serializer 生成它、而
  // `RootRefSchema` 与 `parse.ts` 不认它——导出一个 built-in 根，产物被**自己的 parser**
  // 判 `package-invalid`。
  //
  // 我第一次"修好"它时只跑了 `export → parse` 就宣布通了。实现门随后指出：后面还有
  // `preview` 只遍历 ops、`commit` 的 `translatedBundle`、`finalizeInTx` 三道 `local:`
  // 硬门——**整条导入链根本走不通**。而我为那个修复写的"真实往返"用例，恰好也停在
  // parse，盲区与缺陷完全重合。
  //
  // 教训比这条 AC 本身更通用：**一个只覆盖到你改动那一层的往返测试，不叫往返测试**。
  // 同文件其他往返用例都跑到 commit，唯独那条没有。
  //
  // （built-in 作**根**的完整跨实例导入由 `rfc271-resource-package-hardening.test.ts`
  // 覆盖——preview 空 entries、commit `action: 'reuse'` 绑对端真 built-in、重放幂等、
  // 同名非-builtin 行 fail-closed。这里补的是它的另一半：built-in 作**依赖**。）

  test('built-in 作为**依赖** ⇒ 完整走通 export → parse → preview → commit，并绑到对端自己的 built-in', async () => {
    // 这条是上面那个教训的正面兑现：跑完**整条链**，而且用**两个实例**——目标实例的
    // built-in 是另一个 id，只有按名字绑定才可能对上。只到 parse 为止的版本发现不了
    // 「preview 零 entry」「commit 拒 local 根」这类下游断裂。
    const src = await makeInstance()
    const dst = await makeInstance()
    try {
      const srcBuiltin = ulid()
      await src.db.insert(agents).values({
        id: srcBuiltin,
        name: 'aw-skill-merger',
        description: '',
        outputs: '[]',
        permission: '{}',
        skills: '[]',
        dependsOn: '[]',
        mcp: '[]',
        plugins: '[]',
        frontmatterExtra: '{}',
        bodyMd: '',
        ownerUserId: '__system__',
        visibility: 'public',
        builtin: true,
        createdAt: 1,
        updatedAt: 1,
      } as never)
      const wfId = ulid()
      await src.db.insert(workflows).values({
        id: wfId,
        name: 'uses-builtin',
        description: '',
        definition: JSON.stringify({
          $schema_version: 4,
          inputs: [],
          edges: [],
          nodes: [{ id: 'n1', kind: 'agent-single', agentId: srcBuiltin }],
        }),
        ownerUserId: 'u1',
        visibility: 'private',
        createdAt: 1,
        updatedAt: 1,
      } as never)

      const pkg = await exportResourcePackage(
        src.db,
        actorOf('u1'),
        { type: 'workflow', id: wfId },
        { appHome: src.appHome },
      )
      const parsed = await parseResourcePackage(pkg.zip)

      // built-in 不产 op、不入 resources，只留一条依赖声明。
      expect(parsed.manifest.builtins).toEqual([{ type: 'agent', name: 'aw-skill-merger' }])
      expect(parsed.manifest.resources.map((r) => r.type)).toEqual(['workflow'])
      expect(parsed.bundle.rootRef).toBe(`local:${parsed.manifest.root.slug}`)

      // 目标实例的同名 built-in 是**另一个 id**。
      const dstBuiltin = ulid()
      expect(dstBuiltin).not.toBe(srcBuiltin)
      await dst.db.insert(agents).values({
        id: dstBuiltin,
        name: 'aw-skill-merger',
        description: '',
        outputs: '[]',
        permission: '{}',
        skills: '[]',
        dependsOn: '[]',
        mcp: '[]',
        plugins: '[]',
        frontmatterExtra: '{}',
        bodyMd: '',
        ownerUserId: '__system__',
        visibility: 'public',
        builtin: true,
        createdAt: 1,
        updatedAt: 1,
      } as never)

      const preview = await buildPackagePreview(dst.db, actorOf('u1'), parsed, {
        box,
        importId: ulid(),
      })
      const receipt = await commitResourcePackage(
        { db: dst.db, appHome: dst.appHome, box },
        actorOf('u1'),
        {
          pkg: parsed,
          previewToken: preview.previewToken,
          decisions: preview.entries.map((e) => ({
            localSlug: e.localSlug,
            action: 'new' as const,
          })),
        },
      )
      expect(receipt.root).toMatchObject({ resourceType: 'workflow', action: 'create' })

      // 落地的 definition 必须指向**目标实例**的 built-in id，不是源实例那个。
      const landed = dst.db
        .select()
        .from(workflows)
        .all()
        .find((r) => r.name === 'uses-builtin')
      const def = JSON.parse(String(landed?.definition ?? '{}')) as {
        nodes?: Array<{ agentId?: unknown }>
      }
      expect(def.nodes?.[0]?.agentId).toBe(dstBuiltin)
      expect(def.nodes?.[0]?.agentId).not.toBe(srcBuiltin)
    } finally {
      removeTempDirSync(dst.appHome)
      removeTempDirSync(src.appHome)
    }
  })
})

describe('AC-9 · 包声明的 built-in，本实例缺失时必须在**预检**就报错', () => {
  // AC-9 原文要求「本地没有 → 预检页报错」。此前要到 commit 才由 `resolveIdentityRef`
  // 抛 `bundle-builtin-missing`——用户已经逐条选完动作、填完凭据、点了提交，才被告知
  // 这个包在本实例根本装不了。
  //
  // 这个区别不是「早点报错更友好」而已：built-in 缺失是**环境前提不满足**，用户能做的
  // 只有升级/修复对端实例，在这个包里改什么都没用。所以它必须出现在「要不要导入」这个
  // 决策之前，而不是决策之后。
  const exportPkgUsingBuiltin = async (src: {
    db: DbClient
    appHome: string
  }): Promise<Uint8Array> => {
    const builtinId = ulid()
    await src.db.insert(agents).values({
      id: builtinId,
      name: 'aw-skill-merger',
      description: '',
      outputs: '[]',
      permission: '{}',
      skills: '[]',
      dependsOn: '[]',
      mcp: '[]',
      plugins: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
      ownerUserId: '__system__',
      visibility: 'public',
      builtin: true,
      createdAt: 1,
      updatedAt: 1,
    } as never)
    const wfId = ulid()
    await src.db.insert(workflows).values({
      id: wfId,
      name: 'needs-builtin',
      description: '',
      definition: JSON.stringify({
        $schema_version: 4,
        inputs: [],
        edges: [],
        nodes: [{ id: 'n1', kind: 'agent-single', agentId: builtinId }],
      }),
      ownerUserId: 'u1',
      visibility: 'private',
      createdAt: 1,
      updatedAt: 1,
    } as never)
    const pkg = await exportResourcePackage(
      src.db,
      actorOf('u1'),
      { type: 'workflow', id: wfId },
      { appHome: src.appHome },
    )
    return pkg.zip
  }

  test('对端没有该 built-in ⇒ preview 即 422，并点名缺了哪一个', async () => {
    const src = await makeInstance()
    const dst = await makeInstance() // 目标实例**没有** seed 任何 built-in
    try {
      const parsed = await parseResourcePackage(await exportPkgUsingBuiltin(src))
      const err = await buildPackagePreview(dst.db, actorOf('u1'), parsed, {
        box,
        importId: ulid(),
      }).then(
        () => null,
        (e: unknown) => e as { code?: string; message?: string },
      )
      expect(err?.code).toBe('package-builtin-missing')
      expect(err?.message).toContain('agent/aw-skill-merger')
    } finally {
      removeTempDirSync(dst.appHome)
      removeTempDirSync(src.appHome)
    }
  })

  test('同名但 **builtin=false** 的用户自建资源不算数（否则等于把别人的资源当框架件）', async () => {
    // 判据必须与导入期 `resolveIdentityRef` 的 built-in 分支一致：同名 + builtin=true。
    // 只按名字查会绑到一行 owner 不是 __system__、builtin 为 false 的普通 agent 上。
    const src = await makeInstance()
    const dst = await makeInstance()
    try {
      await dst.db.insert(agents).values({
        id: ulid(),
        name: 'aw-skill-merger', // 同名
        description: '',
        outputs: '[]',
        permission: '{}',
        skills: '[]',
        dependsOn: '[]',
        mcp: '[]',
        plugins: '[]',
        frontmatterExtra: '{}',
        bodyMd: '',
        ownerUserId: 'u1', // 但是用户自建的
        visibility: 'public',
        builtin: false,
        createdAt: 1,
        updatedAt: 1,
      } as never)

      const parsed = await parseResourcePackage(await exportPkgUsingBuiltin(src))
      const err = await buildPackagePreview(dst.db, actorOf('u1'), parsed, {
        box,
        importId: ulid(),
      }).then(
        () => null,
        (e: unknown) => e as { code?: string },
      )
      expect(err?.code).toBe('package-builtin-missing')
    } finally {
      removeTempDirSync(dst.appHome)
      removeTempDirSync(src.appHome)
    }
  })

  test('对端有该 built-in ⇒ preview 正常通过（不误伤）', async () => {
    const src = await makeInstance()
    const dst = await makeInstance()
    try {
      await dst.db.insert(agents).values({
        id: ulid(),
        name: 'aw-skill-merger',
        description: '',
        outputs: '[]',
        permission: '{}',
        skills: '[]',
        dependsOn: '[]',
        mcp: '[]',
        plugins: '[]',
        frontmatterExtra: '{}',
        bodyMd: '',
        ownerUserId: '__system__',
        visibility: 'public',
        builtin: true,
        createdAt: 1,
        updatedAt: 1,
      } as never)

      const parsed = await parseResourcePackage(await exportPkgUsingBuiltin(src))
      const preview = await buildPackagePreview(dst.db, actorOf('u1'), parsed, {
        box,
        importId: ulid(),
      })
      expect(preview.entries.map((e) => e.name)).toEqual(['needs-builtin'])
    } finally {
      removeTempDirSync(dst.appHome)
      removeTempDirSync(src.appHome)
    }
  })
})
