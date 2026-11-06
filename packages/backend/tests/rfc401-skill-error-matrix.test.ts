// RFC-401 T5 —— skill 写入的错误矩阵与版本规则（RFC-401 proposal §6 错误收敛一条的 skill 部分，design §10.2）。
// 覆盖验收条款：RFC-271 的 AC-25（资源包技能经写入内核产出完整 v1 快照与 content hash，过得了启动快照复核）/ AC-25b（技能覆盖
// 不留部分提交）——RFC-401 T5 起写入内核是唯一的 skill 写入参与者，四段拆分随之删除。
//
// 同一输入经三条入口、两种 provider 得到同一结果：普通编辑（`createManagedSkill` / `saveSkillWithToken`）、Intent（确认后的
// apply）、资源包（parse → preview → commit）。
//   · proposal §5 第 1 项：Intent 新建与已有技能同名此前在解析期报 `intent-name-conflict`（422），现在与普通编辑、资源包一样报
//     `skill-name-in-use`（409）「skill 'x' already exists」；
//   · proposal §5 第 9 项：内容不变的更新不推进 contentVersion（Intent 与资源包此前每次 +1），description 变化时 metaRevision
//     + 1（普通编辑此前从不推进）；
//   · RFC-271 AC-25 / AC-25b 在单写入栈上的形态：资源包导入的技能经唯一参与者产出完整 v1 快照与 content hash、过得了启动快照复核；
//     同一个包里两个技能覆盖、第三个 op 在提交事务里失败时，两个技能都没被改（不留部分提交），暂存全部补偿。
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ResourceBundle } from '@agent-workflow/shared'

import { buildActor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { composeIntentApplyOperations } from '@/modules/intent/composition/apply'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { encodeSkillToken } from '@/modules/resource-catalog/application/skills/skillToken'
import {
  createManagedSkill,
  readSkillContent,
  saveSkillWithToken,
} from '@/modules/resource-catalog/infrastructure/legacy/skill'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { first } from '@/platform/persistence/queryHelpers'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { parseResourcePackage } from '@/modules/resource-catalog/application/package/parse'
import { collectPackageRequirements } from '@/modules/resource-catalog/application/package/requirements'
import { encodeZip } from '@/util/zip'
import { removeTempDirSync } from './fixtures/tempDir'
import { describeEachProvider } from './helpers/eachProvider'
import { composeSkillCatalogBoot } from '@/modules/resource-catalog/composition/skillCatalogBoot'
import { resetSkillBootVerifyForTest } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { commitResourcePackageForTest } from './helpers/resourcePackageApply'
import { buildPackagePreview } from './helpers/resourcePackageProvider'

const OWNER = 'rfc401-t5-owner'
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)
const roots: string[] = []

const actor = buildActor({
  user: { id: OWNER, username: OWNER, displayName: OWNER, role: 'user', status: 'active' },
  source: 'session',
})

interface Projection {
  readonly code: unknown
  readonly status: unknown
  readonly message: unknown
}

async function failureOf(run: () => Promise<unknown>): Promise<Projection> {
  try {
    await run()
  } catch (error) {
    const value = error as { code?: unknown; status?: unknown; message?: unknown }
    return { code: value.code, status: value.status, message: value.message }
  }
  throw new Error('expected the write to be rejected')
}

afterEach(() => {
  resetSkillBootVerifyForTest()
  while (roots.length > 0) removeTempDirSync(roots.pop()!)
})

describeEachProvider('RFC-401 T5 skill error matrix', (harness) => {
  let db: PersistenceDb
  let appHome: string
  const box = createSecretBoxFromKey(randomBytes(32))

  beforeEach(async () => {
    db = harness.db
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc401-t5-'))
    roots.push(appHome)
    mkdirSync(join(appHome, 'skills'), { recursive: true })
    const { users } = tablesOf(db)
    await insertOne(db, users, {
      id: OWNER,
      username: OWNER,
      displayName: OWNER,
      role: 'user',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    } as PersistenceTables['users']['$inferInsert'])
  })

  const ordinaryCreate = (name: string) =>
    createManagedSkill(
      db,
      { appHome },
      { name, description: 'd', bodyMd: 'body', frontmatterExtra: {} },
      { ownerUserId: OWNER, actor },
    )

  async function skillRow(id: string) {
    const { skills } = tablesOf(db)
    return first(db.select().from(skills).where(eq(skills.id, id)))
  }

  // ── Intent ────────────────────────────────────────────────────────────────
  async function intentApply(
    op:
      | { readonly action: 'create' }
      | { readonly action: 'update'; readonly id: string; readonly token: string },
    payload: { readonly name: string; readonly description: string; readonly bodyMd: string },
  ): Promise<unknown> {
    const manifest =
      op.action === 'update'
        ? [
            {
              handle: 'res#skill#1',
              resourceType: 'skill',
              resourceId: op.id,
              root: true,
              detail: true,
              fence: { kind: 'skill', token: op.token },
            },
          ]
        : []
    const changeset = {
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: op.action,
          resourceType: 'skill',
          ...(op.action === 'create' ? { tempRef: '$new:skill' } : { target: 'res#skill#1' }),
          payload: { ...payload, files: [] },
        },
      ],
    }
    const sessionId = ulid()
    const draftId = ulid()
    const changesetJson = JSON.stringify(changeset)
    const draftHash = `sha256:${createHash('sha256').update(changesetJson, 'utf8').digest('hex')}`
    const { intentSessions, intentDrafts } = tablesOf(db)
    await insertOne(db, intentSessions, {
      id: sessionId,
      ownerUserId: OWNER,
      title: 'rfc401-t5',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as PersistenceTables['intentSessions']['$inferInsert'])
    await insertOne(db, intentDrafts, {
      id: draftId,
      sessionId,
      revision: 1,
      changesetJson,
      validationJson: '{"errors":[],"credentialFindings":[]}',
      draftHash,
      contextRevision: 0,
      createdAt: Date.now(),
    } as PersistenceTables['intentDrafts']['$inferInsert'])
    await db
      .update(intentSessions)
      .set({ currentDraftId: draftId, contextManifestJson: JSON.stringify(manifest) })
      .where(eq(intentSessions.id, sessionId))
    const { authority: requestAuthority } = composeIdentityAccess(
      db,
    ).contexts.fromAuthenticatedPrincipal({ userId: OWNER, source: 'session' }, 'http')
    return composeIntentApplyOperations({
      db,
      appHome,
      aclIdentities: composeResourceCatalogFor({ db }).persistence.identities,
    }).apply({
      actor,
      authority: requestAuthority,
      command: {
        sessionId,
        clientMutationId: ulid(),
        draftRevision: 1,
        draftHash,
        decisions: [],
      },
    })
  }

  // ── 资源包 ────────────────────────────────────────────────────────────────
  interface PackageSkill {
    readonly slug: string
    readonly name: string
    readonly bodyMd: string
  }
  function packageBytes(entries: readonly PackageSkill[]): Uint8Array {
    const bundle = {
      bundleVersion: 1,
      ops: entries.map((entry, index) => ({
        opId: `op-${index + 1}`,
        kind: 'skill-create',
        slug: entry.slug,
        payload: {
          name: entry.name,
          description: 'd',
          frontmatterExtra: {},
          bodyMd: entry.bodyMd,
          files: [],
        },
      })),
      rootRef: `local:${entries[0]!.slug}`,
    }
    const requirements = collectPackageRequirements(bundle as unknown as ResourceBundle)
    const resources = entries
      .map((entry) => `  - slug: ${entry.slug}\n    type: skill\n    name: ${entry.name}`)
      .join('\n')
    return encodeZip([
      {
        path: 'manifest.yaml',
        bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: ${entries[0]!.slug}
  type: skill
  name: ${entries[0]!.name}
resources:
${resources}
requirements: ${JSON.stringify(requirements)}
secrets: []
danglingCallRefs: []
builtins: []
`),
      },
      { path: 'bundle.json', bytes: utf8(JSON.stringify(bundle)) },
    ])
  }

  async function packageApplyMany(
    entries: readonly PackageSkill[],
    decide: (slug: string) => { action: 'new' } | { action: 'overwrite'; targetId: string },
    beforeCommit?: () => Promise<unknown>,
  ): Promise<unknown> {
    const pkg = await parseResourcePackage(packageBytes(entries))
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })
    await beforeCommit?.()
    return commitResourcePackageForTest({ db, appHome, box }, actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: entries.map((entry) => ({ localSlug: entry.slug, ...decide(entry.slug) })),
      humanMemberMappings: [],
    })
  }

  async function packageApply(name: string): Promise<unknown> {
    // 预览之后、提交之前别人占了这个名字：冲突只能由提交事务里的参与者报出。
    return packageApplyMany(
      [{ slug: 'candidate', name, bodyMd: 'body' }],
      () => ({ action: 'new' }),
      () => ordinaryCreate(name),
    )
  }

  test('a name the owner already uses → skill-name-in-use / 409 on every entry (proposal §5 #1)', async () => {
    await ordinaryCreate('taken')
    const expected = {
      code: 'skill-name-in-use',
      status: 409,
      message: "skill 'taken' already exists",
    }
    expect(await failureOf(() => ordinaryCreate('taken'))).toEqual(expected)
    expect(
      await failureOf(() =>
        intentApply({ action: 'create' }, { name: 'taken', description: 'd', bodyMd: 'body' }),
      ),
    ).toEqual(expected)
    expect(await failureOf(() => packageApply('late'))).toEqual({
      ...expected,
      message: "skill 'late' already exists",
    })
    const { skills } = tablesOf(db)
    expect(
      (await db.select({ id: skills.id }).from(skills).where(eq(skills.name, 'taken'))).length,
    ).toBe(1)
  })

  test('unchanged content does not advance the version; a description change bumps metaRevision (proposal §5 #9)', async () => {
    const created = await ordinaryCreate('rules')
    // Intent 用与当前相同的内容更新：不推进版本。
    const unchanged = await readSkillContent(db, { appHome }, created.id)
    await intentApply(
      { action: 'update', id: created.id, token: unchanged.token! },
      { name: 'rules', description: 'd', bodyMd: 'body' },
    )
    expect(await skillRow(created.id)).toMatchObject({ contentVersion: 1, metaRevision: 0 })
    // Intent 改 description：推进一版，metaRevision + 1。
    await intentApply(
      {
        action: 'update',
        id: created.id,
        token: encodeSkillToken({ skillId: created.id, contentVersion: 1, metaRevision: 0 }),
      },
      { name: 'rules', description: 'd2', bodyMd: 'body' },
    )
    expect(await skillRow(created.id)).toMatchObject({
      contentVersion: 2,
      metaRevision: 1,
      description: 'd2',
    })
    // 普通编辑：description 变化同样推进 metaRevision；内容不变的保存不推进任何东西。
    const current = await readSkillContent(db, { appHome }, created.id)
    const saved = await saveSkillWithToken(
      db,
      { appHome },
      created.id,
      { description: 'd3' },
      current.token!,
      OWNER,
    )
    expect(saved).toMatchObject({ contentVersion: 3, metaRevision: 2, description: 'd3' })
    const again = await saveSkillWithToken(
      db,
      { appHome },
      created.id,
      { description: 'd3' },
      saved.token!,
      OWNER,
    )
    expect(again).toMatchObject({ contentVersion: 3, metaRevision: 2 })
    const { skillVersions } = tablesOf(db)
    expect(
      (await db.select().from(skillVersions).where(eq(skillVersions.skillId, created.id))).map(
        (row) => row.source,
      ),
    ).toEqual(['initial', 'editor', 'editor'])
  })

  test('AC-25: a package-imported skill lands through the participant with a complete v1 snapshot and passes boot verification', async () => {
    await packageApplyMany(
      [{ slug: 'imported', name: 'imported', bodyMd: 'imported body' }],
      () => ({
        action: 'new',
      }),
    )
    const { skills, skillVersions } = tablesOf(db)
    const [row] = await db.select().from(skills).where(eq(skills.name, 'imported'))
    expect(row).toMatchObject({
      reservationState: 'ready',
      versionState: 'snapshot-authoritative',
      contentVersion: 1,
    })
    const versions = await db.select().from(skillVersions).where(eq(skillVersions.skillId, row!.id))
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ versionIndex: 1, source: 'initial' })
    expect(versions[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(join(appHome, 'skills', row!.id, 'files', 'SKILL.md'), 'utf8')).toContain(
      'imported body',
    )
    const boot = composeSkillCatalogBoot({ db, appHome })
    expect(await boot.reverifySnapshots()).toMatchObject({ quarantined: 0 })
    expect((await skillRow(row!.id))?.versionState).toBe('snapshot-authoritative')
  })

  test('AC-25b: two skill overwrites and a failing third op leave neither skill changed', async () => {
    const first = await ordinaryCreate('first')
    const second = await ordinaryCreate('second')
    const failure = await failureOf(() =>
      packageApplyMany(
        [
          { slug: 'first', name: 'first', bodyMd: 'first overwritten' },
          { slug: 'second', name: 'second', bodyMd: 'second overwritten' },
          { slug: 'third', name: 'third', bodyMd: 'third body' },
        ],
        (slug) =>
          slug === 'first'
            ? { action: 'overwrite', targetId: first.id }
            : slug === 'second'
              ? { action: 'overwrite', targetId: second.id }
              : { action: 'new' },
        // 第三个 op 的名字在预览之后被占：提交事务里的参与者报 409，整个事务回滚。
        () => ordinaryCreate('third'),
      ),
    )
    expect(failure).toMatchObject({ code: 'skill-name-in-use', status: 409 })
    // 补偿后 `versions/v2` 可能留下空目录（资源包 owner 只删本次的候选与暂存）；判据是没有任何 v2 内容。
    for (const skill of [first, second]) {
      expect(await skillRow(skill.id)).toMatchObject({ contentVersion: 1, metaRevision: 0 })
      expect(
        readFileSync(join(appHome, 'skills', skill.id, 'files', 'SKILL.md'), 'utf8'),
      ).toContain('body')
      expect(
        readFileSync(join(appHome, 'skills', skill.id, 'files', 'SKILL.md'), 'utf8'),
      ).not.toContain('overwritten')
      // 暂存与候选全部补偿，没有留下操作期的目录。
      expect(
        readdirSync(join(appHome, 'skills', skill.id)).filter((entry) => entry.includes('.op-')),
      ).toEqual([])
      const v2 = join(appHome, 'skills', skill.id, 'versions', 'v2')
      expect(existsSync(v2) ? readdirSync(v2) : []).toEqual([])
    }
  })
})
