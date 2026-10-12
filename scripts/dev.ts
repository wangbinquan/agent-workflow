#!/usr/bin/env bun
// Start dependent development services only after this backend is serving.
// The original package scripts remain responsible for their own configuration.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  waitForDaemon,
  type DaemonInfo,
  type WaitForDaemonOptions,
} from '../packages/system-mocks/src/dev-auth/daemon'

export type DevService = 'backend' | 'frontend' | 'system-mocks'

export interface DevChild {
  readonly service: DevService
  readonly exited: Promise<number>
  signal(signal: NodeJS.Signals): void | Promise<void>
}

export interface DevOptions {
  readonly root?: string
  readonly home?: string
  readonly authEnabled?: boolean
  readonly signal?: AbortSignal
  readonly shutdownGraceMs?: number
  readonly launch?: (service: DevService, root: string) => DevChild
  readonly waitUntilReady?: (home: string, options: WaitForDaemonOptions) => Promise<DaemonInfo>
  readonly log?: (message: string) => void
}

function launchService(service: DevService, root: string): DevChild {
  const child = Bun.spawn([process.execPath, 'run', 'dev'], {
    cwd: join(root, 'packages', service),
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    detached: true,
  })
  return {
    service,
    exited: child.exited,
    async signal(signal) {
      if (process.platform === 'win32') {
        // A package runner can own grandchildren; close the complete owned tree.
        const killer = Bun.spawn(['taskkill', '/PID', String(child.pid), '/T', '/F'], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
        await killer.exited
        return
      }
      try {
        process.kill(-child.pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // Exiting an already-closed tree is idempotent.
        }
      }
    },
  }
}

async function closeServices(children: DevChild[], signal: NodeJS.Signals, graceMs: number) {
  const send = async (value: NodeJS.Signals) =>
    await Promise.allSettled(children.map(async (child) => await child.signal(value)))
  const force = setTimeout(() => void send('SIGKILL'), graceMs)
  try {
    await send(signal)
    await Promise.allSettled(children.map((child) => child.exited))
  } finally {
    clearTimeout(force)
    // A runner may have exited before its grandchildren; finish its owned group.
    await send('SIGKILL')
  }
}

export async function runDev(options: DevOptions = {}): Promise<number> {
  const root = options.root ?? resolve(import.meta.dir, '..')
  const home = options.home ?? process.env.AGENT_WORKFLOW_HOME ?? join(homedir(), '.agent-workflow')
  const launch = options.launch ?? launchService
  const waitUntilReady = options.waitUntilReady ?? waitForDaemon
  const log = options.log ?? ((message) => console.log(`[dev] ${message}`))
  const controller = new AbortController()
  const children: DevChild[] = []
  let code = 0
  let stopping = false
  let ready = false
  const cancel = () => controller.abort(options.signal?.reason)
  const stopped = new Promise<void>((done) => {
    controller.signal.addEventListener('abort', () => done(), { once: true })
  })
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) cancel()

  const start = (service: DevService) => {
    controller.signal.throwIfAborted()
    const child = launch(service, root)
    children.push(child)
    const finish = (exitCode: number) => {
      if (stopping || controller.signal.aborted) return
      code = exitCode === 0 && !ready ? 1 : exitCode
      log(`${service} exited with code ${exitCode}; closing development services`)
      controller.abort()
    }
    void child.exited.then(finish, () => finish(1))
  }

  try {
    const notBefore = Date.now()
    start('backend')
    log(
      'waiting for backend readiness (database backup/checks/migrations may take several minutes)',
    )
    const daemon = await waitUntilReady(home, {
      timeoutMs: null,
      signal: controller.signal,
      notBefore,
    })
    controller.signal.throwIfAborted()
    ready = true
    log(`backend ready at ${daemon.baseUrl}; starting dependent services`)
    start('frontend')
    if (options.authEnabled ?? process.env.AW_DEV_AUTH !== '0') start('system-mocks')
    else log('development login disabled via AW_DEV_AUTH=0')
    await stopped
  } catch (error) {
    if (!controller.signal.aborted) {
      code = 1
      log(`startup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  } finally {
    stopping = true
    controller.abort()
    options.signal?.removeEventListener('abort', cancel)
    const stopSignal = options.signal?.reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM'
    await closeServices(children, stopSignal, options.shutdownGraceMs ?? 35_000)
  }
  return code
}

if (import.meta.main) {
  const controller = new AbortController()
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  const handlers = signals.map((signal) => {
    const handler = () => controller.abort(signal)
    process.on(signal, handler)
    return { signal, handler }
  })
  try {
    process.exitCode = await runDev({ signal: controller.signal })
  } finally {
    for (const { signal, handler } of handlers) process.off(signal, handler)
  }
}
