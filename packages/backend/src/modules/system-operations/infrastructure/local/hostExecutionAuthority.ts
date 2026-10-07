import type {
  HostExecutionAuthorityDriver,
  HostExecutionAuthorityFactory,
  HostExecutionAuthorityObservation,
  HostExecutionAuthorityReference,
} from '../../application/ports/hostExecutionAuthority'
import type { DaemonStartupLease } from '../../application/ports/daemonStartupLease'

/**
 * Borrow the already acquired startup lease. Runtime retirement must never
 * release its PID; the existing daemon host remains that lease's release owner.
 * Embedded HTTP keeps its original process/Task ownership semantics.
 */
export function createLocalHostExecutionAuthorityFactory(
  input: {
    readonly startupLease?: DaemonStartupLease
  } = {},
): HostExecutionAuthorityFactory {
  return Object.freeze<HostExecutionAuthorityFactory>({
    create({ generation }) {
      // Capture the borrow, without performing a second acquire/release.
      const borrowedLease = input.startupLease
      let reference: HostExecutionAuthorityReference | undefined
      let retired = false
      let closed = false
      const unavailable = (): HostExecutionAuthorityObservation => ({
        kind: 'standby',
        reason: closed ? 'host-execution-closed' : 'local-host-execution-retired',
      })
      const current = (value: HostExecutionAuthorityReference): boolean =>
        !closed && !retired && reference === value
      const driver: HostExecutionAuthorityDriver = {
        claim() {
          if (closed) return unavailable()
          if (!reference || retired) {
            reference = Object.freeze({ generation, borrowedLease })
            retired = false
          }
          return { kind: 'granted', reference }
        },
        renew(value) {
          return current(value) ? { kind: 'granted', reference: value } : unavailable()
        },
        activate({ reference: value }) {
          return current(value) ? { kind: 'granted', reference: value } : unavailable()
        },
        quiesce({ reference: value }) {
          if (reference === value) retired = true
        },
        release(value) {
          if (reference === value) retired = true
        },
        subscribe() {
          if (closed) throw new Error('local-host-execution-closed')
          return Object.freeze({
            close() {
              closed = true
            },
          })
        },
      }
      return Object.freeze(driver)
    },
  })
}
