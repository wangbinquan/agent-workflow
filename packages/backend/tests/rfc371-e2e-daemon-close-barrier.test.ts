// RFC-371 CI recovery: Windows crash-recovery restarted the same home after
// exit while the old daemon's pipes were still open. No live daemon is used:
// the observable exit/close ordering is controlled independently of the helper.
import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { harnessTestApi } from '../../../e2e/harness'

type DaemonChild = Parameters<typeof harnessTestApi.trackChildClose>[0]

class ChildFixture extends EventEmitter {
  readonly pid = 371
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly signals: NodeJS.Signals[] = []
  onSignal: (signal: NodeJS.Signals) => void = () => {}

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal)
    this.onSignal(signal)
    return true
  }

  exited(signal: NodeJS.Signals = 'SIGKILL'): void {
    this.signalCode = signal
    this.emit('exit', null, signal)
  }

  closed(): void {
    this.emit('close', this.exitCode, this.signalCode)
  }
}

function fixture(): { child: ChildFixture; daemon: DaemonChild } {
  const child = new ChildFixture()
  const daemon = child as unknown as DaemonChild
  harnessTestApi.trackChildClose(daemon)
  return { child, daemon }
}

describe('RFC-371 same-home daemon restart waits for close', () => {
  test('exit alone does not release the caller; close does', async () => {
    const { child, daemon } = fixture()
    child.onSignal = (signal) => child.exited(signal)
    let finished = false
    const operation = harnessTestApi.signalChildAndWait(daemon, 'SIGKILL', 5000)
    const observed = operation.then(() => {
      finished = true
    })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(child.signalCode).toBe('SIGKILL')
      expect(finished).toBe(false)
      expect(child.signals).toEqual(['SIGKILL'])
    } finally {
      child.closed()
    }
    await observed
    expect(finished).toBe(true)
  })

  test('a child that already exited still waits for its open pipes', async () => {
    const { child, daemon } = fixture()
    child.exited()
    let finished = false
    const operation = harnessTestApi.signalChildAndWait(daemon, 'SIGKILL', 5000)
    const observed = operation.then(() => {
      finished = true
    })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(finished).toBe(false)
      expect(child.signals).toEqual([])
    } finally {
      child.closed()
    }
    await observed
    expect(finished).toBe(true)
  })

  test('an already closed child needs no additional signal', async () => {
    const { child, daemon } = fixture()
    child.exited()
    child.closed()
    await harnessTestApi.signalChildAndWait(daemon, 'SIGKILL', 5000)
    await harnessTestApi.waitForChildExit(daemon, 5000)
    expect(child.signals).toEqual([])
  }, 10_000)

  test('control shutdown deadline is a failure when no close arrives', async () => {
    const { child, daemon } = fixture()
    child.exited('SIGTERM')
    try {
      await expect(harnessTestApi.waitForChildExit(daemon, 20)).rejects.toThrow(
        'daemon 371 did not close within 20ms',
      )
    } finally {
      child.closed()
    }
    expect(child.signals).toEqual([])
  })

  test('graceful fallback joins the actual close without another timer', async () => {
    const { child, daemon } = fixture()
    child.onSignal = (signal) => {
      if (signal === 'SIGKILL') {
        child.exited(signal)
        child.closed()
      }
    }
    await harnessTestApi.signalChildAndWait(daemon, 'SIGTERM', 20)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(child.listenerCount('close')).toBe(0)
  })

  test('a signal failure cannot be reported as successful termination', async () => {
    const { child, daemon } = fixture()
    child.onSignal = () => {
      throw new Error('controlled signal failure')
    }
    try {
      await expect(harnessTestApi.signalChildAndWait(daemon, 'SIGKILL', 5000)).rejects.toThrow(
        'controlled signal failure',
      )
    } finally {
      child.closed()
    }
    expect(child.signals).toEqual(['SIGKILL'])
  })
})
