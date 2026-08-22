#!/usr/bin/env bun
// `bun dev` entry for the dev auth service (see ./server.ts).
//
// Runs as a peer of the daemon and vite under `bun run --filter '*' dev`, so it
// inherits AGENT_WORKFLOW_HOME from the same shell and therefore always seeds
// the database `bun dev` is actually serving. Set AW_DEV_AUTH=0 to skip it.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { runProcess } from '../core/process'
import { DEV_AUTH_DEFAULT_APP_ORIGIN, DEV_AUTH_DEFAULT_PORT, startDevAuthServer } from './server'
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
})

log(`role login page: ${service.url}`)
log(`mock identity provider: ${service.issuerUrl}`)
log(`seeding database: ${home}`)

let stopping = false
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  await service.close()
  process.exit(0)
}

process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
await new Promise<void>(() => {})
