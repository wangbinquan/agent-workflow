import type {
  IntentApplyResourceParticipantInTx,
  ResourceRequestContext,
} from '../../public/participants'
import type {
  IntentResourceChangesetReceipt,
  VersionedIntentResourceChangesetPlan,
} from '../../public/types'
import type { CatalogSelectorKind } from '../../domain/resourceKinds'

type PlanOf<K extends CatalogSelectorKind> = Extract<
  VersionedIntentResourceChangesetPlan,
  { readonly kind: K }
>
type ReceiptOf<K extends CatalogSelectorKind> = Extract<
  IntentResourceChangesetReceipt,
  { readonly kind: K }
>
type CommitPort<K extends CatalogSelectorKind> = (
  authority: ResourceRequestContext,
  plan: PlanOf<K>,
) => ReceiptOf<K>

export interface IntentApplyResourceCommitPorts {
  readonly agent: CommitPort<'agent'>
  readonly skill: CommitPort<'skill'>
  readonly mcp: CommitPort<'mcp'>
  readonly plugin: CommitPort<'plugin'>
  readonly workflow: CommitPort<'workflow'>
  readonly workgroup: CommitPort<'workgroup'>
}

const trustedIntentApplyParticipants = new WeakSet<IntentApplyResourceParticipantInTx>()

export function createIntentApplyResourceParticipantInTx(
  ports: IntentApplyResourceCommitPorts,
): IntentApplyResourceParticipantInTx {
  const participant = Object.freeze({
    authorizeAndCommit(
      authority: ResourceRequestContext,
      plan: VersionedIntentResourceChangesetPlan,
    ) {
      switch (plan.kind) {
        case 'agent':
          return ports.agent(authority, plan)
        case 'skill':
          return ports.skill(authority, plan)
        case 'mcp':
          return ports.mcp(authority, plan)
        case 'plugin':
          return ports.plugin(authority, plan)
        case 'workflow':
          return ports.workflow(authority, plan)
        case 'workgroup':
          return ports.workgroup(authority, plan)
      }
    },
  }) as unknown as IntentApplyResourceParticipantInTx
  trustedIntentApplyParticipants.add(participant)
  return participant
}
