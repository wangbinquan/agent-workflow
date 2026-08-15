// RFC-304 — the registry of built-in stage contracts.
//
// One entry per capability, defined in platform code. This is where the
// "deterministic scheduling" constitution becomes inspectable: you can read the
// whole of what a capability does, in order, and see at a glance which steps
// involve a model (`kind: 'ai'`) and which are plain program code.
//
// `assertRegistryIsSelfConsistent` runs in tests, not on the hot path. A fixed
// sequence cannot become invalid at runtime — what it catches is a person
// adding or reordering a stage whose inputs nothing upstream produces, or an
// `invoke` range that does not exist in its target. Catching that at author
// time is the point; catching it on someone's MR is the failure.
//
// PR-1a registers ONE minimal contract. The remaining capabilities land with
// their own PRs, and each is checked by the same assertion the day it is added.

import {
  validateStageContract,
  type CodeCapability,
  type StageContract,
  type StageContractIssue,
} from '@/modules/code-capability/domain/stageContract'

/**
 * The minimal end-to-end shape: prepare a worktree, do one unit of work, write
 * the ledger. Every capability is a longer version of this, and PR-1a uses it
 * to prove the engine, the stage rows and the hook boundaries work before any
 * capability depends on them.
 *
 * Deliberately all-`program`: PR-1a has no determinism guard yet, and a
 * contract with an `ai` stage would imply one exists.
 */
export const MINIMAL_CONTRACT: StageContract = {
  capability: 'mr-review',
  version: 1,
  stages: [
    {
      kind: 'program',
      name: 'prepare-worktree',
      requires: [],
      produces: ['worktree'],
    },
    {
      kind: 'program',
      name: 'collect-context',
      requires: ['worktree'],
      produces: ['context'],
      // A team may prepend material to the work — the first real injection
      // point, and the reason `injectable` exists on StageBase.
      injectable: ['extraContext'],
    },
    {
      kind: 'program',
      name: 'ledger',
      requires: ['context'],
      produces: ['ledgerEntry'],
    },
  ],
}

const BUILTIN_CONTRACTS: readonly StageContract[] = [MINIMAL_CONTRACT]

const BY_CAPABILITY = new Map<CodeCapability, StageContract>(
  BUILTIN_CONTRACTS.map((c) => [c.capability, c]),
)

export function lookupStageContract(capability: CodeCapability): StageContract | undefined {
  return BY_CAPABILITY.get(capability)
}

export function registeredCapabilities(): readonly CodeCapability[] {
  return [...BY_CAPABILITY.keys()]
}

export type RegistryIssue = StageContractIssue & { capability: CodeCapability }

/**
 * Validate every registered contract against the registry itself, so `invoke`
 * ranges resolve against the real targets rather than a test fixture.
 */
export function checkBuiltinContracts(): RegistryIssue[] {
  const issues: RegistryIssue[] = []
  for (const contract of BUILTIN_CONTRACTS) {
    for (const issue of validateStageContract(contract, lookupStageContract)) {
      issues.push({ ...issue, capability: contract.capability })
    }
  }
  return issues
}
