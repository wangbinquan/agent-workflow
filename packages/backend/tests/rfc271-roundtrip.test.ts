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
import { agents, mcps, skills, users, workgroupMembers, workgroups } from '../src/db/schema'
import { decodeZip } from '../src/services/skill-zip'
import { createManagedSkillWithFiles } from '../src/services/skill'
import { exportResourcePackage } from '../src/services/resourcePackage/export'
import { parseResourcePackage } from '../src/services/resourcePackage/parse'
import { buildPackagePreview } from '../src/services/resourcePackage/preview'
import { commitResourcePackage } from '../src/services/resourcePackage/commit'
import { removeTempDirSync } from './fixtures/tempDir'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const box = createSecretBoxFromKey(randomBytes(32))

const WRITE_ALL = ['agents', 'skills', 'mcps', 'plugins', 'workflows', 'workgroups'].flatMap(
  (t) => [`${t}:create`, `${t}:update`],
)

const actorOf = (id: string, permissions: readonly string[] = WRITE_ALL): Actor =>
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
        expect(preview.humanMembers.map((m) => m.username)).toEqual(['alice'])
        // 目标实例上恰好有同名用户 ⇒ 预填，但仍要用户拍板。
        expect(preview.humanMembers[0]!.suggestedUserId).toBe('u1')

        await commitResourcePackage({ db: dst.db, appHome: dst.appHome, box }, actorOf('u1'), {
          pkg: parsed,
          previewToken: preview.previewToken,
          decisions: preview.entries.map((e) => ({
            localSlug: e.localSlug,
            action: 'new' as const,
            finalName: e.suggestedName,
          })),
          humanMemberMappings: preview.humanMembers.map((m) => ({
            workgroupSlug: m.workgroupSlug,
            username: m.username,
            userId: m.suggestedUserId,
          })),
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
        expect(members.map((m) => m.displayName).sort()).toEqual(['lead', 'reviewer'])

        const human = members.find((m) => m.memberType === 'human')!
        // username 换成了**本地** user id，而不是原样带着源实例的字符串。
        expect(human.userId).toBe('u1')

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

  test('MCP 的凭据没进包，但结构完整、导入后仍是合法配置', async () => {
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
        await commitResourcePackage({ db: dst.db, appHome: dst.appHome, box }, actorOf('u1'), {
          pkg: parsed,
          previewToken: preview.previewToken,
          decisions: preview.entries.map((e) => ({
            localSlug: e.localSlug,
            action: 'new' as const,
            finalName: e.suggestedName,
          })),
        })

        // ② 结构仍完整：argv 长度不变、可执行档没被替换、env 的**键**还在。
        const landed = dst.db.select().from(mcps).where(eq(mcps.name, 'gh')).get()
        const config = JSON.parse(landed!.config) as {
          command: string[]
          env: Record<string, string>
        }
        expect(config.command).toHaveLength(3)
        expect(config.command[0]).toBe('node')
        expect(config.command[1]).toBe('srv.js')
        expect(config.command[2]).toContain('--token=')
        expect(Object.keys(config.env)).toEqual(['GITHUB_TOKEN'])
        expect(config.env.GITHUB_TOKEN).not.toContain('ghp_')
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
        // 界面上没有 `skills:create` 就没有「新建技能」按钮；本地也没有可复用的
        // 同名技能 ⇒ 一个动作都不剩 ⇒ 整体拒绝，而不是产出一个装了一半的实例。
        await expect(
          buildPackagePreview(dst.db, actorOf('u1', []), parsed, { box, importId: ulid() }),
        ).rejects.toThrow(/skills:create/)
      } finally {
        removeTempDirSync(dst.appHome)
      }
    } finally {
      removeTempDirSync(src.appHome)
    }
  })
})
