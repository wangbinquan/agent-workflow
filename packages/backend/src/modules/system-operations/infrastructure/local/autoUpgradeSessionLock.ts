import {
  existsSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  renameSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  acquireLock,
  adoptCurrentProcessLock,
  readPidFromLock,
  isProcessAlive,
  DaemonLockHeldError,
  type Lock,
} from '@/util/lock'
import type { SessionLockPort } from '../../application/ports/epochSwitch'
import { writeEpochFile, syncEpochDirectory } from '../epochSwitch/fileJournal'
import { autoUpgradeRoot, liveAutoUpgrade, readActiveAutoUpgrade } from './autoUpgradeState'
import { autoUpgradeTestCheckpoint } from './autoUpgradeTestHooks'

export function createAutoUpgradeSessionLock(input: {
  appHome: string
  delegation?: string
  readonly startMonitor: (onTick: () => Promise<void>) => { stop(): void }
}): SessionLockPort {
  const lockPath = join(input.appHome, '.daemon.lock')
  const activePath = join(autoUpgradeRoot(input.appHome), 'active.json')
  let own: Lock | null = null
  let acquired = false
  let parent: number | null = null
  let operationId: string | null = null
  let monitor: { stop(): void } | undefined
  let takingOver: Promise<void> | null = null
  let takeoverError: unknown
  const writeActive = () =>
    writeEpochFile(
      activePath,
      Buffer.from(JSON.stringify({ pid: process.pid, parent, operationId })),
      false,
    )
  const takeover = async () => {
    if (own || parent === null || isProcessAlive(parent)) return
    await autoUpgradeTestCheckpoint('parent-gone')
    for (;;) {
      const pid = readPidFromLock(lockPath)
      if (pid === process.pid) {
        own = adoptCurrentProcessLock(lockPath)
        const active = liveAutoUpgrade(input.appHome)
        if (active && active.pid !== process.pid) {
          own.release()
          own = null
          await Bun.sleep(1000)
          continue
        }
        return
      }
      if (pid === null ? !existsSync(lockPath) : !isProcessAlive(pid)) {
        const temporary = `${lockPath}.${process.pid}.${crypto.randomUUID()}.tmp`
        const fd = openSync(temporary, 'wx')
        try {
          writeFileSync(fd, String(process.pid))
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        try {
          await autoUpgradeTestCheckpoint('takeover-before-rename')
          // Re-read after any suspension. Fully written temporary file + rename never exposes
          // an empty PID. Every contender rechecks active.json immediately after acquisition.
          const current = readPidFromLock(lockPath)
          if (current === null ? existsSync(lockPath) : isProcessAlive(current)) continue
          renameSync(temporary, lockPath)
          syncEpochDirectory(input.appHome)
        } finally {
          if (existsSync(temporary)) unlinkSync(temporary)
        }
        own = adoptCurrentProcessLock(lockPath)
        const active = liveAutoUpgrade(input.appHome)
        if (active && active.pid !== process.pid) {
          own.release()
          own = null
          await Bun.sleep(1000)
          continue
        }
        await autoUpgradeTestCheckpoint('takeover-acquired')
        return
      }
      await Bun.sleep(1000)
    }
  }
  const ensure = async () => {
    if (takeoverError) throw takeoverError
    if (!takingOver)
      takingOver = takeover().finally(() => {
        takingOver = null
      })
    await takingOver
  }
  return {
    async acquire() {
      if (acquired) return
      for (;;) {
        const active = liveAutoUpgrade(input.appHome)
        if (active && active.pid !== process.pid) {
          await Bun.sleep(2000)
          continue
        }
        if (input.delegation !== undefined) {
          parent = Number(input.delegation)
          writeActive() // The child publishes its liveness before checking delegation.
          if (
            !/^\d+$/.test(input.delegation) ||
            !Number.isSafeInteger(parent) ||
            parent <= 0 ||
            String(parent) !== input.delegation ||
            process.ppid !== parent ||
            readPidFromLock(lockPath) !== parent
          ) {
            if (readActiveAutoUpgrade(input.appHome)?.pid === process.pid) unlinkSync(activePath)
            throw new Error('auto-upgrade-lock-delegation-invalid')
          }
          await autoUpgradeTestCheckpoint('delegated')
          await ensure()
          monitor = input.startMonitor(() =>
            ensure().catch((error: unknown) => {
              takeoverError = error
            }),
          )
          acquired = true
          break
        }
        try {
          own = acquireLock(lockPath)
        } catch (error) {
          if (error instanceof DaemonLockHeldError && liveAutoUpgrade(input.appHome)) {
            await Bun.sleep(2000)
            continue
          }
          throw error
        }
        const after = liveAutoUpgrade(input.appHome)
        if (after && after.pid !== process.pid) {
          own.release()
          own = null
          await Bun.sleep(2000)
          continue
        }
        writeActive()
        acquired = true
        break
      }
    },
    async bind(id) {
      operationId = id
      writeActive()
    },
    async assertHeld() {
      await ensure()
      if (
        own
          ? readPidFromLock(lockPath) !== process.pid
          : parent === null || !isProcessAlive(parent) || readPidFromLock(lockPath) !== parent
      )
        throw new Error('auto-upgrade-session-lock-lost')
    },
    async release() {
      if (!acquired) return
      monitor?.stop()
      await ensure()
      own?.release()
      own = null
      await autoUpgradeTestCheckpoint('lock-released-before-active-remove')
      if (existsSync(activePath) && readActiveAutoUpgrade(input.appHome)?.pid === process.pid)
        unlinkSync(activePath)
      acquired = false
    },
  }
}
