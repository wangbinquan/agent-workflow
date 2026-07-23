// Entry point for the agent-workflow daemon CLI.
// Subcommands:
//   start    P-1-01 ✓
//   stop     P-1-05 ✓
//   status   P-1-05 ✓
//   version  P-1-05 ✓
//   doctor   P-1-05 ✓
//   config   P-1-05 ✓
//   migrate  P-1-05 ✓
//   backup   P-5-02

import { appVersion } from './util/version'
import { backupCommand } from './cli/backup'
import { restoreCommand } from './cli/restore'
import { configGetCommand, configSetCommand } from './cli/config-cli'
import { doctorCommand, formatDoctor } from './cli/doctor'
import { migrateCommand } from './cli/migrate'
import { sandboxCommand } from './cli/sandbox'
import { startCommand } from './cli/start'
import { statusCommand, formatStatus } from './cli/status'
import { stopCommand } from './cli/stop'
import { userCommand } from './cli/user'
import { authCommand } from './cli/auth'

function readFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  const next = argv[i + 1]
  if (next === undefined) {
    console.error(`${name} requires a value`)
    process.exit(2)
  }
  return next
}

function readPortFlag(argv: string[]): number | undefined {
  const raw = readFlag(argv, '--port')
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`invalid --port value: ${raw}`)
    process.exit(2)
  }
  return n
}

async function main(): Promise<void> {
  const sub = Bun.argv[2] ?? 'help'

  switch (sub) {
    case 'start': {
      const opts: { port?: number; host?: string } = {}
      const port = readPortFlag(Bun.argv)
      if (port !== undefined) opts.port = port
      const host = readFlag(Bun.argv, '--host')
      if (host !== undefined) opts.host = host
      await startCommand(opts)
      break
    }

    case 'stop': {
      const result = await stopCommand()
      process.stdout.write(result.message + '\n')
      if (result.status === 'timeout') process.exit(1)
      break
    }

    case 'status': {
      const result = await statusCommand()
      process.stdout.write(formatStatus(result))
      if (result.state !== 'running') process.exit(1)
      break
    }

    case 'doctor': {
      const result = await doctorCommand()
      process.stdout.write(formatDoctor(result))
      if (!result.ok) process.exit(1)
      break
    }

    case 'config': {
      const action = Bun.argv[3]
      const rest = Bun.argv.slice(4)
      if (action === 'get') {
        const { output } = configGetCommand(rest)
        process.stdout.write(output)
      } else if (action === 'set') {
        const { output } = configSetCommand(rest)
        process.stdout.write(output)
      } else {
        console.error('usage: agent-workflow config <get|set> ...')
        process.exit(2)
      }
      break
    }

    case 'migrate': {
      const { output } = migrateCommand()
      process.stdout.write(output)
      break
    }

    case 'version':
      // RFC-213 impl-gate P1-3: real binary identity (build-time injected tag;
      // dev prints 0.0.0-dev) — the same value the pre-migration restore gate
      // compares, so `version` output is what you match backups against.
      console.log(`agent-workflow ${appVersion()}`)
      break

    case 'backup': {
      const result = await backupCommand(Bun.argv.slice(3))
      process.stdout.write(result.output)
      if (result.status !== 'ok') process.exit(1)
      break
    }

    case 'restore': {
      const result = await restoreCommand(Bun.argv.slice(3))
      process.stdout.write(result.output)
      if (result.status !== 'ok') process.exit(1)
      break
    }

    case 'user': {
      const rest = Bun.argv.slice(3)
      const result = await userCommand(rest)
      process.stdout.write(result.output)
      if (result.status !== 'ok') process.exit(1)
      break
    }

    case 'auth': {
      const result = await authCommand(Bun.argv.slice(3))
      process.stdout.write(result.output)
      if (result.status !== 'ok') process.exit(1)
      break
    }

    case 'sandbox': {
      // RFC-216: read-only sandbox preflight. Returns its own exit code (0
      // available/off · 1 unavailable · 2 argv error / unreadable config).
      const result = await sandboxCommand(Bun.argv.slice(3))
      process.stdout.write(result.output)
      process.exit(result.exitCode)
      break
    }

    case 'help':
    case '--help':
    case '-h':
    default:
      console.log('usage: agent-workflow <command> [options]')
      console.log('')
      console.log('commands:')
      console.log('  start [--port N] [--host H]       start daemon foreground')
      console.log('  stop                              send SIGTERM to the running daemon')
      console.log('  status                            print daemon status (PID, /health)')
      console.log('  version                           print version')
      console.log('  doctor                            run health checks (does not start daemon)')
      console.log('  config get [key]                  print full config or a single key')
      console.log(
        '  config set <key> <value>          update a config field; value is parsed as JSON if possible',
      )
      console.log('  migrate                           apply pending DB migrations')
      console.log(
        '  backup                            write a tar.gz snapshot under ~/.agent-workflow/backups/',
      )
      console.log(
        '  restore <tarball> [--yes]         restore state from a backup (daemon must be stopped)',
      )
      console.log(
        '  user create --username <name>     create a user (RFC-036; --admin to set role=admin)',
      )
      console.log(
        "  user reset-password ...           reset a user's password and revoke their sessions",
      )
      console.log('  user list                         list all users (id, username, role, status)')
      console.log('  user disable --username <name>    disable (soft-delete) a user')
      console.log('  auth password-login status       show login policy and bootstrap state')
      console.log('  auth password-login enable       restore local password login only')
      console.log(
        '  sandbox [--require-available]     read-only sandbox preflight (install/fix guidance)',
      )
      if (sub !== 'help' && sub !== '--help' && sub !== '-h') {
        console.error(`unknown subcommand: ${sub}`)
        process.exit(2)
      }
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(msg)
  process.exit(1)
})
