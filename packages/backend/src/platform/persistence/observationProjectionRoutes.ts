/** Only identities needed to route a committed row; no numeric document is
 * copied into the source outbox. Preserve old identities on UPDATE/DELETE. */
const paths: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  observation_invocations: {
    $invocation: ['invocationId'],
    $attempt: ['nodeRunId'],
    $agent: ['agentId'],
    $runtime: ['authority', 'runtime', 'registrationId'],
  },
  observation_usage_current: {
    $invocation: ['measurement', 'invocationId'],
    $root: ['measurement', 'scope', 'root'],
  },
  observation_usage_events: {
    $invocation: ['invocationId'],
    $task: ['taskId'],
    $root: ['scope', 'root'],
  },
  observation_usage_captures: { $root: ['evidence', 'capture', 'rootSessionId'] },
  observation_platform_sources: {
    $platformSource: ['binding', 'sourceId'],
    $platformProject: ['binding', 'projectId'],
    $platformTask: ['binding', 'taskId'],
  },
}
export const observationDocumentRoutePaths = (source: string) => paths[source] ?? {}
export function originalObservationRoute(
  source: string,
  row: Readonly<Record<string, string | null>>,
) {
  if (!row.document) return row
  const document: unknown = JSON.parse(row.document),
    route: Record<string, string | null> = { ...row }
  delete route.document
  for (const [name, path] of Object.entries(observationDocumentRoutePaths(source))) {
    let value = document
    for (const member of path)
      value = value && typeof value === 'object' ? (value as Record<string, unknown>)[member] : null
    route[name] = typeof value === 'string' ? value : null
  }
  return route
}
export function observationDocumentRouteSQL(
  source: string,
  row: 'OLD' | 'NEW',
  provider: 'sqlite' | 'postgresql',
) {
  return Object.entries(observationDocumentRoutePaths(source)).map(([name, path]) => ({
    name,
    expression:
      provider === 'sqlite'
        ? `CASE WHEN json_valid(${row}."document") AND json_type(${row}."document",'$.${path.join('.')}')='text' THEN CAST(json_extract(${row}."document",'$.${path.join('.')}') AS TEXT) ELSE NULL END`
        : `CASE WHEN pg_input_is_valid(${row}."document",'jsonb') THEN CASE WHEN jsonb_typeof(${row}."document"::jsonb #> '{${path.join(',')}}')='string' THEN ${row}."document"::jsonb #>> '{${path.join(',')}}' ELSE NULL END ELSE NULL END`,
  }))
}
