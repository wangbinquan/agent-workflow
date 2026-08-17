// RFC-309 T19 — starting a round from a template, inside the platform.
//
// The gap this closes, stated plainly: before this file there was NO WAY to
// start a capability round except a real webhook delivery from the code host.
// `openRound` has three callers and every one of them traces back to
// `webhookDispatch`. RFC-304's plan records the debt itself — T46b promised
// three entrances for `requirement` and delivered the issue-label one.
//
// ## What this command does NOT do
//
// It does not build a second orchestration path. The work item, the round, the
// leases, pre-emption and settlement are the existing ones; all that is new is
// who pressed start. A parallel launcher would be a second definition of "a
// round" and the two would disagree the first time either changed.
//
// ## Why it does not require the matrix cell to be enabled
//
// The matrix answers "respond to webhooks automatically for this repository".
// A manual launch carries its own template and is not asking for that. Making
// it a prerequisite would mean "try this template once" required configuring a
// trigger first — which is the friction the entrance exists to remove (D4).
//
// What IS checked, in order, each with its own code so the caller is told which
// thing to go fix rather than "forbidden":
//
//   repo-unresolvable            the repository has no code-host endpoint
//   template-not-visible         404-shaped: invisible is indistinguishable
//                                from missing (RFC-099 existence isolation)
//   template-capability-mismatch the template drives a different capability
//   template-incomplete          a stage's agent slot has nobody in it — WITH
//                                the slot names, because "incomplete" alone
//                                moves the question rather than answering it
//   agent-not-visible            the template names an agent this person
//                                cannot see

import { ulid } from 'ulid'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { agents } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { lookupStageContract } from '@/modules/code-capability/domain/capabilityRegistry'
import { parseCodeCapabilityId } from '@/modules/code-capability/domain/stageContract'
import {
  anchorFor,
  isPlatformOrigin,
  type LaunchInput,
} from '@/modules/code-capability/domain/launchInput'
import { resolveRepoEndpoint } from '@/modules/code-capability/application/resolveRepoEndpoint'
import {
  ensureWorkItem,
  openRound,
} from '@/modules/code-capability/infrastructure/sqliteMonitorStore'
import { getTemplateRow } from '@/services/capabilityTemplates'
import { canViewResource } from '@/services/resourceAcl'

export type LaunchRoundFailure =
  | 'repo-unresolvable'
  | 'template-not-visible'
  | 'template-capability-mismatch'
  | 'template-incomplete'
  | 'agent-not-visible'

export type LaunchRoundResult =
  | { ok: false; code: LaunchRoundFailure; message: string }
  | { ok: true; workItemId: string; roundId: string; roundSeq: number }

export interface LaunchRoundInput {
  repoId: string
  templateId: string
  input: LaunchInput
  actor: Actor
}

export function createLaunchRoundCommand(
  db: DbClient,
  now: () => number = Date.now,
  mintId: () => string = ulid,
) {
  return {
    async run(args: LaunchRoundInput): Promise<LaunchRoundResult> {
      const capability = parseCodeCapabilityId(args.input.capability)
      const contract = capability === undefined ? undefined : lookupStageContract(capability)
      if (capability === undefined || contract === undefined) {
        return {
          ok: false,
          code: 'template-capability-mismatch',
          message: `'${args.input.capability}' is not a capability this platform can run`,
        }
      }

      const endpoint = await resolveRepoEndpoint(db, args.repoId)
      if (!endpoint.ok) {
        return { ok: false, code: 'repo-unresolvable', message: endpoint.message }
      }

      const template = await getTemplateRow(db, args.templateId)
      if (
        template === null ||
        !(await canViewResource(db, args.actor, 'capability_template', template))
      ) {
        // Same shape as "no such template": a visible 403 on an invisible row
        // is an existence oracle.
        return {
          ok: false,
          code: 'template-not-visible',
          message: `template '${args.templateId}' not found`,
        }
      }
      if (template.capability !== capability) {
        return {
          ok: false,
          code: 'template-capability-mismatch',
          message: `that template drives '${template.capability}', not '${capability}'`,
        }
      }

      // Every AI stage's slot must have somebody in it. Checked against the
      // CONTRACT rather than against the template's own keys: a template that
      // maps a slot the sequence never asks for is harmless, while a slot the
      // sequence WILL ask for and the template does not fill fails halfway
      // through — after the round has already taken the merge-request lease.
      const agentBySlot = JSON.parse(template.agentBySlotJson) as Record<string, string>
      const needed = [
        ...new Set(contract.stages.flatMap((s) => (s.kind === 'ai' ? [s.agentSlot] : []))),
      ]
      const unfilled = needed.filter((slot) => (agentBySlot[slot] ?? '') === '')
      if (unfilled.length > 0) {
        return {
          ok: false,
          code: 'template-incomplete',
          message: `this template has no agent for: ${unfilled.join(', ')}`,
        }
      }

      for (const slot of needed) {
        const agentId = agentBySlot[slot] ?? ''
        const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
        if (agent === undefined || !(await canViewResource(db, args.actor, 'agent', agent))) {
          return {
            ok: false,
            code: 'agent-not-visible',
            message: `the agent this template uses for '${slot}' is not available to you`,
          }
        }
      }

      const anchor = anchorFor(args.input, mintId)
      const item = await ensureWorkItem({
        db,
        codeHostEndpointId: endpoint.endpointId,
        stableProjectId: args.repoId,
        capability,
        anchorKind: anchor.anchorKind,
        anchorId: anchor.anchorId,
        initiatorUserId: args.actor.user.id,
        now: now(),
      })

      const round = await openRound({
        db,
        workItemId: item.id,
        epoch: item.epoch,
        workPackage: {
          // The launch input travels with the round so it stays replayable —
          // the same reason `workPackage` exists for the webhook path.
          launch: args.input,
          // `platform` here is what `clarifyRouting` reads to decide a question
          // goes to the platform's own surface rather than to an issue that
          // does not exist. Recorded at launch because it is a fact about the
          // ENTRANCE, and the entrance is not knowable later.
          clarifyOrigin: isPlatformOrigin(args.input) ? 'platform' : 'issue',
        },
        templateSnapshot: {
          templateId: template.id,
          name: template.name,
          agentBySlot,
          promptBySlot: JSON.parse(template.promptBySlotJson) as Record<string, string>,
          params: JSON.parse(template.paramsJson) as Record<string, unknown>,
        },
        stageContractVer: contract.version,
        now: now(),
      })

      return { ok: true, workItemId: item.id, roundId: round.roundId, roundSeq: round.roundSeq }
    },
  }
}
