import type { DaemonHostLifecyclePort } from './ports/daemonHostLifecycle'

/** Host effects are selected at bootstrap; this application owns their ACK order. */
export interface DaemonHostApplicationOptions {
  readonly host: DaemonHostLifecyclePort
  readonly databaseProvider: string
  readonly readyInfo: () => Parameters<DaemonHostLifecyclePort['publishReady']>[0]
  readonly readBootstrapRequired: () => boolean | Promise<boolean>
  readonly readyBrowserUrl: (bootstrapRequired: boolean) => string
  readonly stopListener: () => void | Promise<void>
  readonly stopApplication: () => void | Promise<void>
  readonly releaseAuthority: () => void | Promise<void>
  readonly releaseAuthorityOnExit: () => void
  readonly describeFailure: (error: unknown) => string
  /**
   * RFC-370 v2 §3.2 — a hosted instance that leaves execution authority (or
   * fails to activate) exits through the same drain with a non-zero status so
   * the platform restarts it as standby. Standalone never requests it.
   */
  readonly exitRequests?: (requestExit: (reason: string) => void) => void
  readonly log: {
    info(message: string, fields?: Record<string, unknown>): void
    warn(message: string, fields?: Record<string, unknown>): void
  }
}

export async function runDaemonHostApplication(
  input: DaemonHostApplicationOptions,
): Promise<never> {
  const waitForHostExit = (): Promise<never> => new Promise(() => {})
  const readinessInFlight = new Set<Promise<void>>()
  let shuttingDown = false
  const shutdown = async (signal: string, terminate = true, exitCode = 0): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    const admittedReadiness = [...readinessInFlight]
    input.log.info('shutting down', { signal, databaseProvider: input.databaseProvider })
    try {
      await input.host.withdrawReady()
    } catch (error) {
      input.log.warn('daemon readiness withdrawal error', {
        databaseProvider: input.databaseProvider,
        error: input.describeFailure(error),
      })
    }
    await input.stopListener()
    try {
      await input.stopApplication()
    } catch (error) {
      // 关机请求已经封住 HTTP/WS 准入、停了监听、排空了任务执行；provider 收尾失败只是
      // 这个正在退场的进程的诊断，不能把一次成功的 dev 代际交接变成 exit 1、让接班进程
      // 卡在仍被持有的 PID 锁后面。
      input.log.warn('daemon shutdown error', {
        databaseProvider: input.databaseProvider,
        error: input.describeFailure(error),
      })
    }
    try {
      await (await controlListener).close()
    } catch (error) {
      input.log.warn('daemon control close error', {
        databaseProvider: input.databaseProvider,
        error: input.describeFailure(error),
      })
    }
    if (admittedReadiness.length > 0) {
      // A ready write admitted before shutdown can commit after the first
      // withdrawal. Settle it and its final withdrawal before the host exits.
      await Promise.allSettled(admittedReadiness)
      try {
        await input.host.withdrawReady()
      } catch (error) {
        input.log.warn('daemon readiness withdrawal error', {
          databaseProvider: input.databaseProvider,
          error: input.describeFailure(error),
        })
      }
    }
    await input.releaseAuthority()
    if (terminate) await input.host.terminate(exitCode)
  }
  input.exitRequests?.((reason) => {
    // The platform restarts this instance only once it exits: a drain that
    // fails still ends the process with the same non-zero status.
    void shutdown(reason, true, 1).catch((error: unknown) => {
      input.log.warn('daemon exit request drain error', {
        databaseProvider: input.databaseProvider,
        reason,
        error: input.describeFailure(error),
      })
      return input.host.terminate(1)
    })
  })
  const controlListener = Promise.resolve().then(() =>
    input.host.subscribeShutdown({
      onShutdown: shutdown,
      onExit: () => input.releaseAuthorityOnExit(),
      onFailure: (error) => {
        input.log.warn('daemon shutdown error', {
          databaseProvider: input.databaseProvider,
          error: input.describeFailure(error),
        })
      },
    }),
  )
  try {
    await controlListener
    if (shuttingDown) return await waitForHostExit()
    const readinessPublication = Promise.resolve().then(() =>
      input.host.publishReady(input.readyInfo()),
    )
    readinessInFlight.add(readinessPublication)
    try {
      await readinessPublication
    } finally {
      readinessInFlight.delete(readinessPublication)
    }
    if (shuttingDown) return await waitForHostExit()
    const bootstrapRequired = await input.readBootstrapRequired()
    if (shuttingDown) return await waitForHostExit()
    const browserUrl = input.readyBrowserUrl(bootstrapRequired)
    await input.host.announceReady(browserUrl)
  } catch (error) {
    // A requested shutdown owns its drain; a late startup error must not exit
    // the process before that drain finishes. Otherwise unwind before returning
    // the original startup failure to the CLI's existing error handler.
    if (shuttingDown) return await waitForHostExit()
    await shutdown('startup-failed', false)
    throw error
  }
  await waitForHostExit()
  throw new Error('daemon-listener-returned')
}
