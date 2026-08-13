// RFC-298 — derive one safe, user-facing source link from a task's frozen
// webhook context. This is deliberately a shared pure function: backend
// projection, wire validation and regression tests must not grow separate
// event/fallback matrices.

import { z } from 'zod'
import type { TriggerContext, WebhookTriggerFields } from './triggerContext'
import { webhookFieldsOf } from './triggerContext'

export const WEBHOOK_TASK_SOURCE_LINK_KINDS = [
  'comment',
  'merge_request',
  'pipeline',
  'commit',
  'project',
] as const

export type WebhookTaskSourceLinkKind = (typeof WEBHOOK_TASK_SOURCE_LINK_KINDS)[number]

export const WEBHOOK_TASK_SOURCE_URL_MAX = 8192

// The shared package intentionally typechecks without the DOM lib. Use the
// standards-global URL constructor through a tiny structural type so this leaf
// stays browser/Bun/Node compatible without importing a Node-only module.
interface ParsedWebUrl {
  protocol: string
  hostname: string
  username: string
  password: string
  pathname: string
  search: string
  hash: string
  toString(): string
}

interface WebUrlConstructor {
  new (value: string): ParsedWebUrl
}

const WebUrl = (globalThis as unknown as { URL: WebUrlConstructor }).URL

/**
 * Accept only absolute HTTP(S) web URLs without embedded credentials.
 *
 * The original spelling is returned on success so comment anchors, deployment
 * subpaths and meaningful query strings survive byte-for-byte. Callers that
 * need to construct another URL parse that accepted value separately.
 */
export function safeWebhookTaskSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  if (value.length > WEBHOOK_TASK_SOURCE_URL_MAX) return null

  let parsed: ParsedWebUrl
  try {
    parsed = new WebUrl(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.hostname.length === 0) return null
  if (parsed.username !== '' || parsed.password !== '') return null
  return value
}

export const SafeWebhookTaskSourceUrlSchema = z
  .string()
  .refine((value) => safeWebhookTaskSourceUrl(value) !== null, 'unsafe webhook task source URL')

export const WebhookTaskSourceLinkSchema = z
  .object({
    kind: z.enum(WEBHOOK_TASK_SOURCE_LINK_KINDS),
    url: SafeWebhookTaskSourceUrlSchema,
  })
  .strict()

export type WebhookTaskSourceLink = z.infer<typeof WebhookTaskSourceLinkSchema>

type Candidate = readonly [kind: WebhookTaskSourceLinkKind, url: unknown]

function firstSafe(candidates: readonly Candidate[]): WebhookTaskSourceLink | null {
  for (const [kind, candidate] of candidates) {
    const url = safeWebhookTaskSourceUrl(candidate)
    if (url !== null) return { kind, url }
  }
  return null
}

const COMMIT_SHA = /^[0-9a-f]{7,64}$/i
const ALL_ZERO_SHA = /^0+$/

function commitUrlOf(fields: WebhookTriggerFields): string | null {
  const projectUrl = safeWebhookTaskSourceUrl(fields.project_web_url)
  const sha = fields.commit_sha
  if (projectUrl === null || typeof sha !== 'string') return null
  if (!COMMIT_SHA.test(sha) || ALL_ZERO_SHA.test(sha)) return null
  if (fields.provider !== 'github' && fields.provider !== 'gitlab') return null

  const parsed = new WebUrl(projectUrl)
  parsed.search = ''
  parsed.hash = ''
  const projectPath = parsed.pathname.replace(/\/+$/, '')
  const providerPath = fields.provider === 'github' ? 'commit' : '-/commit'
  parsed.pathname = `${projectPath}/${providerPath}/${encodeURIComponent(sha)}`
  return safeWebhookTaskSourceUrl(parsed.toString())
}

function unreachableEventType(value: never): never {
  throw new Error(`unhandled webhook event type: ${String(value)}`)
}

/**
 * Select the most precise safe source target for every closed webhook event
 * type. The returned kind describes the selected fallback target, not merely
 * the incoming event, so UI copy can never claim "comment" while linking to an
 * MR or project page.
 */
export function webhookTaskSourceLinkOf(context: TriggerContext): WebhookTaskSourceLink | null {
  const fields = webhookFieldsOf(context)
  switch (fields.event_type) {
    case 'note':
      return firstSafe([
        ['comment', fields.comment_url],
        ['merge_request', fields.mr_url],
        ['project', fields.project_web_url],
      ])
    case 'mr_opened':
    case 'mr_updated':
    case 'mr_merged':
    case 'mr_closed':
      return firstSafe([
        ['merge_request', fields.mr_url],
        ['project', fields.project_web_url],
      ])
    case 'pipeline_failed':
    case 'pipeline_succeeded':
      return firstSafe([
        ['pipeline', fields.pipeline_url],
        ['merge_request', fields.mr_url],
        ['project', fields.project_web_url],
      ])
    case 'push':
    case 'tag_push':
      return firstSafe([
        ['commit', commitUrlOf(fields)],
        ['project', fields.project_web_url],
      ])
  }
  return unreachableEventType(fields.event_type)
}
