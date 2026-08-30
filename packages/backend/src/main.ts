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
import { runGitCredentialSubcommand } from './util/gitCredentialLease'
import { backupCommand } from './cli/backup'
import { restoreCommand } from './cli/restore'
import { configGetCommand, configSetCommand } from './cli/config-cli'
import { dbCompactCommand } from './cli/dbCompact'
import { doctorCommand, formatDoctor } from './cli/doctor'
import { migrateCommand } from './cli/migrate'
import { migrationReportCommand } from './cli/migrationReport'
import { startCommand } from './cli/start'
import { statusCommand, formatStatus } from './cli/status'
import { stopCommand } from './cli/stop'
import { packageCommand } from './cli/package'
import { runUserCommand } from './cli/userBootstrap'
import { authCommand } from './cli/auth'
import { rfc295DowngradeAuditCommand } from './cli/rfc295-downgrade-audit'
import {
  MANAGED_PROCESS_LAUNCHER_SUBCOMMAND,
  MANAGED_PROCESS_LAUNCH_NONCE_ENV,
  runManagedProcessLauncher,
} from './services/execution/managedProcessLauncher'
import { runManagedProcess } from './services/execution/managedProcess'

declare const AW_E2E_BUILD: boolean | undefined

function isE2eBuild(): boolean {
  return typeof AW_E2E_BUILD === 'boolean' && AW_E2E_BUILD
}

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
  // Bun's compiled Windows executable can re-enter itself without preserving
  // application argv. The private nonce marker is therefore the authoritative
  // launcher entry signal; the post-receipt frame carries the complete request.
  if ((process.env[MANAGED_PROCESS_LAUNCH_NONCE_ENV]?.length ?? 0) > 0) {
    process.exit(await runManagedProcessLauncher(Bun.argv))
  }
  const sub = Bun.argv[2] ?? 'help'

  switch (sub) {
    case MANAGED_PROCESS_LAUNCHER_SUBCOMMAND: {
      // RFC-328: hidden pre-activation process gate. It intentionally bypasses
      // every daemon/bootstrap concern and exits with the target's code.
      process.exit(await runManagedProcessLauncher(Bun.argv))
      break
    }

    case '__managed-process-output-probe': {
      // Test-only compiled-chain oracle for hosted Windows. A source `bun test`
      // parent cannot reproduce the production hop (compiled daemon -> compiled
      // launcher -> compiled runtime), so the e2e artifact owns this narrow
      // executable check. Production builds reject it before spawning anything.
      if (!isE2eBuild()) {
        console.error('managed-process output probe is available only in e2e builds')
        process.exit(2)
      }
      const target = readFlag(Bun.argv, '--target')
      if (target === undefined) process.exit(2)
      const env = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => {
          return typeof entry[1] === 'string'
        }),
      )
      const attempts = await Promise.all(
        Array.from({ length: 8 }, () =>
          runManagedProcess({
            argv: [target, '--version'],
            cwd: process.cwd(),
            env: { ...env, AW_STUB_MODE: 'basic' },
            requireSpawnReceipt: true,
            captureRawStdout: true,
            onSpawned: () => {},
          }),
        ),
      )
      const expected = 'stub-opencode custom-build'
      const failures = attempts
        .map((result, index) => ({ index, result }))
        .filter(
          ({ result }) =>
            result.outcome !== 'exited' ||
            result.exitCode !== 0 ||
            !result.rawStdout.includes(expected) ||
            result.stderrTail.includes('AW_MANAGED_PROCESS_LAUNCH_'),
        )
      console.log(
        JSON.stringify({
          standaloneHost: {
            processExecPath: process.execPath,
            argv0: Bun.argv[0],
            argv1: Bun.argv[1],
            main: Bun.main,
          },
          attempts: attempts.length,
          failures: failures.map(({ index, result }) => ({
            index,
            outcome: result.outcome,
            exitCode: result.exitCode,
            rawStdout: result.rawStdout,
            stderrTail: result.stderrTail,
            spawnError: result.spawnError,
            pumpError: result.pumpError,
            launcherOutputBytes: result.launcherOutputBytes,
          })),
        }),
      )
      process.exit(failures.length === 0 ? 0 : 1)
      break
    }

    case '__git-credential': {
      // RFC-254 T20 (D11): git credential-helper protocol. `get`/`store`/`erase`
      // in argv[3]; request fields on stdin. Answers a `get` for the lease host
      // only (exact protocol + authority + path from AW_GIT_CRED_FILE). Silent success otherwise —
      // never prompts, never logs (a stray log line would land in git's stderr).
      const operation = Bun.argv[3] ?? ''
      const stdin = await Bun.stdin.text().catch(() => '')
      const out = runGitCredentialSubcommand(operation, stdin)
      if (out.length > 0) process.stdout.write(out)
      process.exit(0)
      break
    }

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
      // RFC-254 T7: `forced` means the daemon was killed rather than drained.
      // It exits non-zero for the same reason `timeout` does — a caller that
      // scripts `stop && start` must not treat "I had to terminate it" as a
      // clean stop, because the next start has interrupted rows to reap.
      if (result.status === 'timeout' || result.status === 'forced') process.exit(1)
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

    // RFC-311 T20 —— 停机回收 DB 内部空洞。只提供 CLI:VACUUM 持写锁重写整库,
    // 几 GB 上是分钟级,跑在 daemon 的单条同步连接上等于全站冻结那么久。
    case 'db': {
      if (Bun.argv[3] !== 'compact') {
        console.error('usage: agent-workflow db compact')
        process.exit(2)
      }
      const result = dbCompactCommand()
      process.stdout.write(result.output)
      if (result.status !== 'ok') process.exit(1)
      break
    }

    case 'downgrade-audit': {
      if (Bun.argv[3] !== 'rfc-295') {
        console.error('usage: agent-workflow downgrade-audit rfc-295')
        process.exit(2)
      }
      const result = rfc295DowngradeAuditCommand()
      process.stdout.write(result.output)
      if (result.status !== 'ok') process.exit(1)
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
      const { output } = await migrateCommand()
      process.stdout.write(output)
      break
    }

    case 'migration-report': {
      const { output } = await migrationReportCommand(Bun.argv.slice(3))
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

    case 'package': {
      const result = await packageCommand(Bun.argv.slice(3))
      process.stdout.write(result.output)
      if (result.status !== 'ok') process.exit(1)
      break
    }

    case 'user': {
      const rest = Bun.argv.slice(3)
      const result = await runUserCommand(rest)
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
      console.log(
        '  downgrade-audit rfc-295            read-only compatibility gate before RFC-295 rollback',
      )
      console.log('  config get [key]                  print full config or a single key')
      console.log(
        '  config set <key> <value>          update a config field; value is parsed as JSON if possible',
      )
      console.log('  migrate                           apply pending DB migrations')
      console.log(
        '  db compact                        reclaim free pages (VACUUM; daemon must be stopped)',
      )
      console.log(
        '  migration-report [--json]         RFC-310 legacy asset migration analysis (read-only)',
      )
      console.log(
        '  backup                            write a tar.gz snapshot under ~/.agent-workflow/backups/',
      )
      console.log(
        '  restore <tarball> [--yes]         restore state from a backup (daemon must be stopped)',
      )
      console.log('  package export|import --as-user U  export/import a config package (RFC-271;')
      console.log('                                     runs AS a real user — same visibility and')
      console.log(
        '                                     ownership rules as the HTTP API, not a way around them)',
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
