#!/usr/bin/env bun
// `bun dev` entry for the dev auth service (see ./server.ts).
//
// Runs as a peer of the daemon and vite under `bun run --filter '*' dev`, so it
// inherits AGENT_WORKFLOW_HOME from the same shell and therefore always seeds
// the database `bun dev` is actually serving. Set AW_DEV_AUTH=0 to skip it.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { runProcess } from '../core/process'
import { pidIsAlive, startOrphanWatchdog } from './lifecycle'
import {
  DEV_AUTH_DEFAULT_APP_ORIGIN,
  DEV_AUTH_DEFAULT_PORT,
  DevAuthPortInUseError,
  startDevAuthServer,
} from './server'
import type { CliResult } from './seed'

if (process.env.AW_DEV_AUTH === '0') {
  process.stdout.write('[dev-auth] disabled via AW_DEV_AUTH=0\n')
  process.exit(0)
}

const repoRoot = resolve(import.meta.dir, '..', '..', '..', '..')
const daemonEntry = join(repoRoot, 'packages', 'backend', 'src', 'main.ts')
const home = process.env.AGENT_WORKFLOW_HOME ?? join(homedir(), '.agent-workflow')
const port = Number(process.env.AW_DEV_AUTH_PORT ?? DEV_AUTH_DEFAULT_PORT)
const appOrigin = process.env.AW_DEV_AUTH_APP_ORIGIN ?? DEV_AUTH_DEFAULT_APP_ORIGIN

function log(message: string): void {
  process.stdout.write(`[dev-auth] ${message}\n`)
}

async function runCli(args: string[]): Promise<CliResult> {
  const result = await runProcess('bun', ['run', daemonEntry, ...args], {
    cwd: repoRoot,
    env: { ...process.env, AGENT_WORKFLOW_HOME: home },
    timeoutMs: 120_000,
  })
  return {
    status: result.exitCode,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
  }
}

const service = await startDevAuthServer({
  home,
  port: Number.isFinite(port) ? port : DEV_AUTH_DEFAULT_PORT,
  appOrigin,
  runCli,
  log,
}).catch((error: unknown) => {
  // A port clash is an operator situation, not a crash: print the remedy, not a
  // stack trace over a `bun dev` that is otherwise starting fine.
  if (error instanceof DevAuthPortInUseError) {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }
  throw error
})

log(`role login page: ${service.url}`)
log(`mock identity provider: ${service.issuerUrl}`)
log(`seeding database: ${home}`)

const stopWatchdog = startOrphanWatchdog({
  parentPid: process.ppid,
  currentParentPid: () => process.ppid,
  isAlive: pidIsAlive,
  onOrphaned: (reason) => {
    log(`${reason}; shutting down so the login port is not left held`)
    void stop(0)
  },
})

let stopping = false
async function stop(code = 0): Promise<void> {
  if (stopping) return
  stopping = true
  stopWatchdog()
  // Shutdown must be bounded. Anything that can keep `close()` pending (a socket
  // that refuses to die, an in-flight seed request) would otherwise leave the
  // port held by a process the developer already told to quit.
  await Promise.race([service.close(), new Promise<void>((resolve) => setTimeout(resolve, 2000))])
  process.exit(code)
}

process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
// Closing the terminal window delivers SIGHUP rather than SIGINT; without this
// the service survives exactly the case people assume kills everything.
process.once('SIGHUP', () => void stop())
await new Promise<void>(() => {})
