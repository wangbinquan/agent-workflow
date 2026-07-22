// RFC-036 — `agent-workflow user …` CLI. Direct sqlite access; never uses
// HTTP. The CLI is a break-glass path for admin / first-time bootstrap.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { extractMigrationsTo, IS_EMBEDDED } from '@/embed'
import { Paths } from '@/util/paths'
import {
  createUser,
  disableUser,
  enableUser,
  findByUsername,
  listAllUsers,
  resetPassword,
} from '@/services/users'
import { RoleSchema, type Role } from '@agent-workflow/shared'

interface ParsedFlags {
  username?: string
  displayName?: string
  email?: string
  password?: string
  newPassword?: string
  /** RFC-222 (P2-4): raw --role string, validated with RoleSchema at use time. */
  role?: string
  admin?: boolean
}

function parseFlags(argv: string[]): ParsedFlags {
  const out: ParsedFlags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    const consume = () => {
      i++
      return next
    }
    switch (a) {
      case '--username':
        out.username = consume()
        break
      case '--display':
        out.displayName = consume()
        break
      case '--email':
        out.email = consume()
        break
      case '--password':
        out.password = consume()
        break
      case '--new-password':
        out.newPassword = consume()
        break
      case '--role':
        out.role = consume()
        break
      case '--admin':
        out.admin = true
        break
      default:
        // Ignore unknown flags so future additions don't break.
        break
    }
  }
  return out
}

async function ensureDb() {
  let migrationsFolder = Paths.migrationsDir
  if (IS_EMBEDDED) {
    migrationsFolder = join(Paths.root, 'runtime', 'migrations')
    if (!existsSync(migrationsFolder)) {
      await extractMigrationsTo(migrationsFolder)
    }
  }
  const dbVersion = existsSync(migrationsFolder)
    ? readdirSync(migrationsFolder).filter((f) => f.endsWith('.sql')).length
    : 0
  const db = openDb({ path: Paths.db, migrationsFolder })
  return { db, dbVersion }
}

export async function userCommand(
  args: string[],
): Promise<{ output: string; status: 'ok' | 'error' }> {
  const sub = args[0]
  const rest = args.slice(1)
  if (!sub) {
    return {
      output:
        'usage: agent-workflow user <create|reset-password|list|disable|enable> [options]\n' +
        '  user create --username <name> [--admin] [--role admin|user|manager]\n' +
        '               [--display "Name"] [--email <em>] [--password <pw>]\n' +
        '  user reset-password --username <name> --new-password <pw>\n' +
        '  user list\n' +
        '  user disable --username <name>\n' +
        '  user enable --username <name>\n',
      status: 'error',
    }
  }

  const flags = parseFlags(rest)
  const { db } = await ensureDb()

  try {
    if (sub === 'create') {
      if (!flags.username) return badUsage('--username is required')
      // RFC-222 (P2-4): validate --role at runtime instead of a blind `as Role`
      // cast — an unknown role string must be rejected, never silently written.
      let role: Role = 'user'
      if (flags.admin) {
        role = 'admin'
      } else if (flags.role !== undefined) {
        const parsed = RoleSchema.safeParse(flags.role)
        if (!parsed.success) {
          return badUsage(`invalid --role '${flags.role}' (expected admin|user|manager)`)
        }
        role = parsed.data
      }
      const created = await createUser(db, {
        username: flags.username,
        displayName: flags.displayName ?? flags.username,
        email: flags.email,
        role,
        password: flags.password,
      })
      const noteStatus = created.status === 'invited' ? ' (status=invited, no password)' : ''
      return {
        output: `created user ${created.username} (id=${created.id}, role=${created.role})${noteStatus}\n`,
        status: 'ok',
      }
    }
    if (sub === 'reset-password') {
      if (!flags.username || !flags.newPassword) {
        return badUsage('--username and --new-password are required')
      }
      const row = await findByUsername(db, flags.username)
      if (!row) return { output: `user ${flags.username} not found\n`, status: 'error' }
      await resetPassword(db, row.id, { newPassword: flags.newPassword, force: true })
      return {
        output: `reset password for ${flags.username}; sessions revoked; force_password_change=1\n`,
        status: 'ok',
      }
    }
    if (sub === 'list') {
      const rows = await listAllUsers(db)
      const lines = rows.map(
        (r) => `${r.id}\t${r.username}\t${r.role}\t${r.status}\t${r.displayName}`,
      )
      return { output: `${lines.join('\n')}\n`, status: 'ok' }
    }
    if (sub === 'disable') {
      if (!flags.username) return badUsage('--username is required')
      const row = await findByUsername(db, flags.username)
      if (!row) return { output: `user ${flags.username} not found\n`, status: 'error' }
      await disableUser(db, row.id)
      return { output: `disabled ${flags.username}\n`, status: 'ok' }
    }
    if (sub === 'enable') {
      if (!flags.username) return badUsage('--username is required')
      const row = await findByUsername(db, flags.username)
      if (!row) return { output: `user ${flags.username} not found\n`, status: 'error' }
      await enableUser(db, row.id)
      return { output: `enabled ${flags.username}\n`, status: 'ok' }
    }
    return badUsage(`unknown subcommand: ${sub}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { output: `error: ${msg}\n`, status: 'error' }
  }
}

function badUsage(msg: string): { output: string; status: 'error' } {
  return { output: `${msg}\n`, status: 'error' }
}
