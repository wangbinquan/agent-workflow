// RFC-395: frozen epoch-1 mechanism; changes belong to the converter (migration §3).
// FROZEN HISTORY — RFC-371 v1 schema projection, retired by RFC-371 v2
// (design/RFC-371-run-observability/redesign-v2-20261014.md §7). The immutable
// PostgreSQL migration chain (steps 0017–0031) replays plans built from this
// code, so it must stay byte-stable; no live table carries these projections and
// no new caller may use it.
import type { DatabaseProvider } from '../../databaseProviders'

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
const documentExpressions: Readonly<
  Record<DatabaseProvider, (row: 'OLD' | 'NEW', path: readonly string[]) => string>
> = {
  sqlite: (row, path) =>
    `CASE WHEN json_valid(${row}."document") AND json_type(${row}."document",'$.${path.join('.')}')='text' THEN CAST(json_extract(${row}."document",'$.${path.join('.')}') AS TEXT) ELSE NULL END`,
  postgresql: (row, path) =>
    `CASE WHEN pg_input_is_valid(${row}."document",'jsonb') THEN CASE WHEN jsonb_typeof(${row}."document"::jsonb #> '{${path.join(',')}}')='string' THEN ${row}."document"::jsonb #>> '{${path.join(',')}}' ELSE NULL END ELSE NULL END`,
}
export function observationDocumentRouteSQL(
  source: string,
  row: 'OLD' | 'NEW',
  provider: DatabaseProvider,
) {
  return Object.entries(observationDocumentRoutePaths(source)).map(([name, path]) => ({
    name,
    expression: documentExpressions[provider](row, path),
  }))
}
