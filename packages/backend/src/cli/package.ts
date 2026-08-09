// RFC-271 T40–T42 —— 配置包的 CLI。
//
// **两条命令都强制 `--as-user`**，并构造与 HTTP 侧**同构**的 `Actor`。这不是形式：
// 导出的可见性判定、导入的 owner 归属与「只能覆盖自己的」全部从 actor 出，没有它
// 就没有判据可用。CLI 是本机 break-glass 通道（能读写 DB 的人本来就能改一切），
// 但**不能因此让它绕过判据** —— 那会让「导出/导入按谁的身份发生」变得不可追溯。
//
// 导出支持 `--id`：同一个 owner 可以有两个同名工作流（`workflows.name` 非唯一），
// `--type --name` 在那种情况下选不中确定的一行。

import { openDb } from '@/db/client'
import { Paths } from '@/util/paths'
import { buildActor } from '@/auth/actor'
import { createSecretBox } from '@/auth/secretBox'
import { users } from '@/db/schema'
import { ACL_TABLES } from '@/services/resourceAcl'
import { and, eq } from 'drizzle-orm'
import { writeFileSync, readFileSync } from 'node:fs'
import { exportResourcePackage } from '@/services/resourcePackage/export'
import { parseResourcePackage } from '@/services/resourcePackage/parse'
import { buildPackagePreview } from '@/services/resourcePackage/preview'
import { commitResourcePackage, type ImportDecision } from '@/services/resourcePackage/commit'
import type { AclResourceType } from '@agent-workflow/shared'
import { ulid } from 'ulid'

const USAGE = `usage: agent-workflow package <export|import> --as-user <username> [options]

  package export --as-user <u> --type <agent|skill|mcp|plugin|workflow|workgroup>
                 (--id <id> | --name <name>) --out <file.zip>
      --id is REQUIRED to disambiguate when two rows share a name
      (workflows.name is NOT unique).

  package import --as-user <u> --file <file.zip>
                 [--plan <plan.json> | --on-conflict <new|reuse|overwrite>]
      --plan and --on-conflict are mutually exclusive: one is an explicit
      per-entry decision file, the other a blanket default.

  Break-glass boundary: the CLI runs on this machine's DB directly, but it
  still resolves --as-user into a real Actor and applies the SAME visibility /
  ownership rules as the HTTP API. It is not a way around them.
`

interface Parsed {
  flags: Map<string, string>
  bools: Set<string>
}

function parseArgs(args: readonly string[]): Parsed {
  const flags = new Map<string, string>()
  const bools = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = args[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(key, next)
      i++
    } else {
      bools.add(key)
    }
  }
  return { flags, bools }
}

const RESOURCE_TYPES: readonly AclResourceType[] = [
  'agent',
  'skill',
  'mcp',
  'plugin',
  'workflow',
  'workgroup',
]

export async function packageCommand(
  args: string[],
): Promise<{ output: string; status: 'ok' | 'error' }> {
  const sub = args[0]
  if (sub !== 'export' && sub !== 'import') return { output: USAGE, status: 'error' }
  const { flags } = parseArgs(args.slice(1))

  const username = flags.get('as-user')
  if (username === undefined) {
    return {
      output: '--as-user is required: every package operation happens AS someone.\n',
      status: 'error',
    }
  }

  const db = openDb({ path: Paths.db, migrationsFolder: Paths.migrationsDir })
  const row = db.select().from(users).where(eq(users.username, username)).get()
  if (row === undefined) return { output: `user '${username}' not found\n`, status: 'error' }
  // 与 HTTP 同构：`source: 'daemon'` ⇒ 权限点按角色算，与网页登录的同一条路径。
  const actor = buildActor({
    user: {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      role: row.role,
      status: row.status,
    } as never,
    source: 'daemon',
  })

  try {
    if (sub === 'export') return await runExport(db, actor, flags)
    return await runImport(db, actor, flags)
  } catch (err) {
    const e = err as { code?: string; message?: string }
    return { output: `${e.code ?? 'error'}: ${e.message ?? String(err)}\n`, status: 'error' }
  }
}

async function runExport(
  db: ReturnType<typeof openDb>,
  actor: ReturnType<typeof buildActor>,
  flags: Map<string, string>,
): Promise<{ output: string; status: 'ok' | 'error' }> {
  const type = flags.get('type') as AclResourceType | undefined
  if (type === undefined || !RESOURCE_TYPES.includes(type)) {
    return { output: `--type must be one of ${RESOURCE_TYPES.join('|')}\n`, status: 'error' }
  }
  const out = flags.get('out')
  if (out === undefined) return { output: '--out <file.zip> is required\n', status: 'error' }

  let id = flags.get('id')
  if (id === undefined) {
    const name = flags.get('name')
    if (name === undefined)
      return { output: 'either --id or --name is required\n', status: 'error' }
    const table = ACL_TABLES[type]
    const matches = db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.name, name), eq(table.ownerUserId, actor.user.id)))
      .all()
    if (matches.length === 0)
      return { output: `no ${type} named '${name}' for you\n`, status: 'error' }
    if (matches.length > 1) {
      // ⚠️ 这正是 `--id` 存在的理由：同 owner 可以有两个同名工作流。**不猜**。
      return {
        output:
          `${matches.length} ${type}s named '${name}' belong to you; pass --id to pick one:\n` +
          matches.map((m) => `  ${m.id}\n`).join(''),
        status: 'error',
      }
    }
    id = matches[0]!.id
  }

  const pkg = await exportResourcePackage(db, actor, { type, id }, { exportedAt: Date.now() })
  writeFileSync(out, pkg.zip)
  return { output: `wrote ${out} (${pkg.zip.byteLength} bytes)\n`, status: 'ok' }
}

async function runImport(
  db: ReturnType<typeof openDb>,
  actor: ReturnType<typeof buildActor>,
  flags: Map<string, string>,
): Promise<{ output: string; status: 'ok' | 'error' }> {
  const file = flags.get('file')
  if (file === undefined) return { output: '--file <file.zip> is required\n', status: 'error' }
  const planPath = flags.get('plan')
  const onConflict = flags.get('on-conflict')
  if (planPath !== undefined && onConflict !== undefined) {
    // 二者互斥：一个是逐条显式决策，一个是一刀切默认。同时给就说明用户没想清楚
    // 哪个说了算——与其挑一个，不如让他明确。
    return { output: '--plan and --on-conflict are mutually exclusive\n', status: 'error' }
  }

  const pkg = await parseResourcePackage(new Uint8Array(readFileSync(file)))
  const box = createSecretBox(Paths.secretKeyFile)
  const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })

  let decisions: ImportDecision[]
  if (planPath !== undefined) {
    decisions = JSON.parse(readFileSync(planPath, 'utf8')) as ImportDecision[]
  } else {
    const want = onConflict ?? 'new'
    decisions = preview.entries.map((e) => {
      // 一刀切的默认值也要落在**允许**的动作里：例如别人的资源没有 overwrite，
      // 那就退回 reuse（能看见即可复用），再退回 new。
      const action = e.allowedActions.includes(want as never)
        ? (want as ImportDecision['action'])
        : e.allowedActions.includes('reuse')
          ? 'reuse'
          : 'new'
      return action === 'new'
        ? { localSlug: e.localSlug, action, finalName: e.suggestedName }
        : { localSlug: e.localSlug, action, targetId: e.candidates[0]?.id }
    })
  }

  const receipt = await commitResourcePackage({ db, appHome: Paths.root, box }, actor, {
    pkg,
    previewToken: preview.previewToken,
    decisions,
  })
  return {
    output:
      `imported ${receipt.applied.length} resource(s)\n` +
      receipt.applied.map((a) => `  ${a.resourceType} ${a.name} (${a.action})\n`).join(''),
    status: 'ok',
  }
}
