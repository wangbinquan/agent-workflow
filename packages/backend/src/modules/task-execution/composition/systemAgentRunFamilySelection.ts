// RFC-531 — the deployment's System Agent run family selection (RFC-294 design §9.3): typed by what the session hands it
// and the binding it returns, not by the local factory's signature. Standalone: the native family (bootstrap pairs it
// with runtime-management's providers); hosted: the CrewStation family, which still runs a fixture on the native one.
import type { SystemAgentRunFamily } from '../application/ports/systemAgentRunFamily'
import type {
  SystemAgentRunOptions,
  SystemAgentRunResult,
} from '../infrastructure/local/nativeSystemAgentRun'
import type { SystemAgentRunFamilySelectionInput } from '../infrastructure/local/systemAgentRunFamily'

export type { SystemAgentRunFamilySelectionInput }

/** What a selection hands back: the family, the runtime binding it keeps unchanged, and the same over a fake run. */
export interface SystemAgentRunFamilyBinding<Bind> {
  readonly family: SystemAgentRunFamily
  readonly bindRuntime: Bind
  withFixture(runFn: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>): {
    readonly family: SystemAgentRunFamily
    readonly bindRuntime: Bind
  }
}

export type SystemAgentRunFamilySelection<Bind> = (
  input: SystemAgentRunFamilySelectionInput,
) => SystemAgentRunFamilyBinding<Bind>
