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
//
// RFC-427: the entry root parses arguments, selects the deployment and dispatches. Command dependencies are assembled
// in `bootstrap/` and handed to the `cli/` handlers here; the deployment-level commands are operations of the selected
// deployment.

import { appVersion } from './util/version'
import { runGitCredentialSubcommand } from './util/gitCredentialLease'
import { backupCommand } from './cli/backup'
import { restoreCommand, parseRestoreArguments, RESTORE_USAGE } from './cli/restore'
import { configGetCommand, configSetCommand } from './cli/config-cli'
import { dbCompactCommand } from './cli/dbCompact'
import { databaseCommand } from './cli/database'
import { selectDeployment } from './bootstrap/deployment'
import {
  composeBackupCommandOperations,
  composeConfigCommandPersistence,
  composeLocalDatabaseMigrationCommandOperations,
  composeMigrationReportCommandDependencies,
  composePackageCommandBootstrap,
  composeRestoreCommandOperations,
  composeUserCommandBootstrap,
  runDoctorCommand,
} from './bootstrap/commandBootstraps'
import { runManagedProcessOutputProbe } from './bootstrap/managedProcessOutputProbe'
import { migrationReportCommand } from './cli/migrationReport'
import { startCommand } from './bootstrap/daemonStart'
import {
  type DevelopmentOverlay,
  createDevelopmentDaemonState,
  reloadDevelopmentDaemon,
  type DevelopmentDaemonState,
} from './bootstrap/developmentReload'
import { statusCommand, formatStatus } from './cli/status'
import { stopCommand } from './cli/stop'
import { packageCommand } from './cli/package'
import { runUserCommand } from './cli/userBootstrap'
import { authCommand } from './cli/auth'
import { logicalSchemaContract } from './bootstrap/persistenceSchema'
import {
  MANAGED_PROCESS_LAUNCHER_SUBCOMMAND,
  MANAGED_PROCESS_LAUNCH_NONCE_ENV,
  runManagedProcessLauncher,
} from './platform/execution/local/managedProcessLauncher'
import { Paths } from './util/paths'
import { createLogger } from './util/log'

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
    case '__hosted-git-credential': {
      const { runHostedGitCredentialCommand } = await import('./bootstrap/hostedGitCommands')
      const out = await runHostedGitCredentialCommand(
        Bun.argv[3] ?? '',
        await Bun.stdin.text().catch(() => ''),
        process.env,
      )
      if (out) process.stdout.write(out)
      process.exit(0)
      break
    }
    case '__hosted-git-ssh': {
      const { runHostedGitSshCommand } = await import('./bootstrap/hostedGitCommands')
      process.exit(await runHostedGitSshCommand(Bun.argv.slice(3), process.env))
      break
    }
    case 'workspace': {
      const { runWorkspaceTaskImageCommand } = await import('./bootstrap/workspaceTaskImage')
      process.exit(await runWorkspaceTaskImageCommand(Bun.argv.slice(3)))
      break
    }
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
      const probe = await runManagedProcessOutputProbe(target, process.env)
      console.log(probe.output)
      process.exit(probe.exitCode)
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
      const launch: { port?: number; host?: string } = {}
      const port = readPortFlag(Bun.argv)
      if (port !== undefined) launch.port = port
      const host = readFlag(Bun.argv, '--host')
      if (host !== undefined) launch.host = host
      // RFC-370 v2 §3.1: the deployment selects its adapters once; flags still win.
      const profile = await selectDeployment(process.env).profile()
      const start = (development?: DevelopmentOverlay) => startCommand(profile, launch, development)
      if (process.env.AGENT_WORKFLOW_DEV_HOT_RELOAD === '1') {
        const retained = globalThis as typeof globalThis & {
          agentWorkflowDevelopment?: DevelopmentDaemonState
        }
        const state = (retained.agentWorkflowDevelopment ??= createDevelopmentDaemonState())
        await reloadDevelopmentDaemon(state, start)
      } else {
        await start()
      }
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
      const { ok, output } = await runDoctorCommand()
      process.stdout.write(output)
      if (!ok) process.exit(1)
      break
    }

    // RFC-311 T20 —— 停机回收 DB 内部空洞。只提供 CLI:VACUUM 持写锁重写整库,
    // 几 GB 上是分钟级,跑在 daemon 的单条同步连接上等于全站冻结那么久。
    case 'db': {
      if (
        Bun.argv[3] === 'migration' &&
        ['status', 'finalize'].includes(Bun.argv[4] ?? '') &&
        Bun.argv[5]?.startsWith('dbm_') &&
        !Bun.argv[5]?.startsWith('dbm_e2_')
      ) {
        const { legacyEpochMigrationCommand } = await import('./cli/epochMigrationLegacy')
        const { createLegacyMigrationFinalize } = await import('./bootstrap/epochMigrationEntry')
        const legacy = await legacyEpochMigrationCommand({
          appHome: Paths.root,
          createApplication: () =>
            createLegacyMigrationFinalize({ appHome: Paths.root, env: process.env }),
          argv: Bun.argv.slice(4),
        })
        if (legacy) {
          process.stdout.write(legacy.output)
          if (legacy.status !== 'ok') process.exit(legacy.status === 'usage-error' ? 2 : 1)
          break
        }
      }
      if (
        Bun.argv[3] === 'migration' &&
        !['resume', 'cancel', 'finalize', 'artifact'].includes(Bun.argv[4] ?? '') &&
        (!['status', 'rollback'].includes(Bun.argv[4] ?? '') ||
          !Bun.argv[5] ||
          Bun.argv[5].startsWith('--') ||
          Bun.argv[5].startsWith('dbm_e2_'))
      ) {
        const { composeEpochMigrationCommand, runAutomaticEpochUpgrade } =
          await import('./bootstrap/epochMigrationEntry')
        const { epochMigrationCommand } = await import('./cli/epochMigration')
        const result = await epochMigrationCommand(Bun.argv.slice(4), {
          get application() {
            return composeEpochMigrationCommand()
          },
          autoUpgrade: runAutomaticEpochUpgrade,
        })
        process.stdout.write(result.output)
        if (result.status !== 'ok')
          process.exit(result.exitCode ?? (result.status === 'usage-error' ? 2 : 1))
        break
      }
      if (Bun.argv[3] === 'compact') {
        const result = dbCompactCommand(logicalSchemaContract)
        process.stdout.write(result.output)
        if (result.status !== 'ok') process.exit(1)
        break
      }
      const result = await databaseCommand(
        Bun.argv.slice(3),
        composeLocalDatabaseMigrationCommandOperations(),
      )
      process.stdout.write(result.output)
      if (result.status !== 'ok') process.exit(result.status === 'usage-error' ? 2 : 1)
      break
    }

    case 'config': {
      const action = Bun.argv[3]
      const rest = Bun.argv.slice(4)
      if (action === 'get') {
        const { output } = await configGetCommand(rest, composeConfigCommandPersistence())
        process.stdout.write(output)
      } else if (action === 'set') {
        const { output } = await configSetCommand(rest, composeConfigCommandPersistence())
        process.stdout.write(output)
      } else {
        console.error('usage: agent-workflow config <get|set> ...')
        process.exit(2)
      }
      break
    }

    case 'migrate': {
      const { output } = await selectDeployment(process.env).migrate()
      process.stdout.write(output)
      break
    }

    case 'verify-database-restore': {
      process.stdout.write(await selectDeployment(process.env).verifyDatabaseRestore())
      break
    }

    case 'migration-report': {
      const { output } = await migrationReportCommand(
        Bun.argv.slice(3),
        composeMigrationReportCommandDependencies(),
      )
      process.stdout.write(output)
      break
    }

    case 'verify-database-migration': {
      process.stdout.write(await selectDeployment(process.env).verifyDatabaseMigration())
      break
    }

    case 'version':
      // RFC-213 impl-gate P1-3: real binary identity (build-time injected tag;
      // dev prints 0.0.0-dev) — the same value the pre-migration restore gate
      // compares, so `version` output is what you match backups against.
      console.log(`agent-workflow ${appVersion()}`)
      break

    case 'backup': {
      const operations = await composeBackupCommandOperations()
      try {
        const result = await backupCommand(Bun.argv.slice(3), operations)
        process.stdout.write(result.output)
        if (result.status !== 'ok') process.exit(1)
      } finally {
        await operations.shutdown()
      }
      break
    }

    case 'restore': {
      const { classifyRestoreArtifact, composeEpochMigrationCommand } =
        await import('./bootstrap/epochMigrationEntry')
      const { artifact, contentRoot } = parseRestoreArguments(Bun.argv.slice(3))
      if (!artifact) {
        process.stdout.write(RESTORE_USAGE)
        process.exit(1)
      }
      if (
        (await classifyRestoreArtifact(
          artifact,
          Bun.argv.includes('--stage') ? 'stage' : 'restore',
        )) === 'epoch1'
      ) {
        if (Bun.argv.includes('--stage'))
          throw new Error(
            'epoch-1 backup requires offline db migration restore-backup; --stage is unavailable',
          )
        const plan = await composeEpochMigrationCommand().restoreBackup({
          artifact,
          restoreConfig: Bun.argv.includes('--restore-config'),
          contentRoot,
        })
        process.stdout.write(
          `${JSON.stringify(plan, null, 2)}\nRun db migration run ${plan.operationId} --approve ${plan.plan.approvalDigest} after reviewing this conversion plan.\n`,
        )
        break
      }
      const operations = composeRestoreCommandOperations()
      try {
        const result = await restoreCommand(Bun.argv.slice(3), operations)
        process.stdout.write(result.output)
        if (result.status !== 'ok') process.exit(1)
      } finally {
        await operations.shutdown()
      }
      break
    }

    case 'package': {
      const result = await packageCommand(Bun.argv.slice(3), composePackageCommandBootstrap)
      process.stdout.write(result.output)
      if (result.status !== 'ok') process.exit(1)
      break
    }

    case 'user': {
      const rest = Bun.argv.slice(3)
      const result = await runUserCommand(rest, await composeUserCommandBootstrap())
      process.stdout.write(result.output)
      if (result.status !== 'ok') process.exit(1)
      break
    }

    case 'auth': {
      const bootstrap = await composeUserCommandBootstrap()
      try {
        const result = await authCommand(Bun.argv.slice(3), bootstrap.auth)
        process.stdout.write(result.output)
        if (result.status !== 'ok') process.exit(1)
      } finally {
        await bootstrap.shutdown()
      }
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
      console.log()
      console.log()
      console.log('  config get [key]                  print full config or a single key')
      console.log(
        '  config set <key> <value>          update a config field; value is parsed as JSON if possible',
      )
      console.log('  migrate                           install or upgrade the epoch-2 database')
      console.log('  verify-database-migration         verify the hosted epoch switch')
      console.log(
        '  db compact                        reclaim free pages (VACUUM; daemon must be stopped)',
      )
      console.log(
        '  db migrate --to postgresql --url-env NAME --auto',
        'migrate SQLite to external PostgreSQL',
      )
      console.log(
        '  db migration auto [--json] [--retry] automatically upgrade or resume an epoch-1 install',
      )
      console.log(
        '  db migration plan|acknowledge|withdraw-acknowledgement|run|status|trace|verify',
        'plan, approve, run or inspect an epoch switch',
      )
      console.log(
        '  db migration rollback|complete|discard|receipt|restore-backup',
        'recover, finish or restore an epoch switch',
      )
      console.log(
        '  db migration resume|cancel|finalize|artifact ID',
        'operate an existing provider move',
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
  // Keep the failing development generation's stack in both the terminal and daemon log.
  if (process.env.AGENT_WORKFLOW_DEV_HOT_RELOAD === '1') {
    createLogger('dev').error('development startup failed', {
      error: msg,
      stack: err instanceof Error ? err.stack : undefined,
    })
    console.error(err)
  } else {
    console.error(msg)
  }
  process.exit(1)
})
