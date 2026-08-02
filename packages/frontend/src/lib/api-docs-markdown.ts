// RFC-247 D17 / T30–T33 — turn the generated API description into the page body.
//
// A pure function over the daemon's `/api/docs/api` payload. Two reasons it is
// not built inside the component:
//
//   · it is the interesting part and can be asserted without a DOM;
//   · it makes the AC-22 derivation lock testable on the FRONT end too — feed
//     it a payload with an extra tool and the page gains a row. A component
//     that hard-coded any of this would satisfy a snapshot test and still lie.
//
// The result is markdown rendered by the shared `Prose` component (AC-27: there
// is exactly one markdown rendering path in this app, and adding a second is
// how two pages start disagreeing about how a code block looks).

export interface ApiDocsPayload {
  role: string
  grantablePermissions: Array<{
    resource: string
    verbs: Array<{ verb: string; permission: string }>
  }>
  alwaysGranted: string[]
  endpoints: Array<{
    method: string
    path: string
    summary: string
    permissions: string[]
    identity?: string
    open: boolean
  }>
  tools: Array<{
    name: string
    title: string
    description: string
    permissions: string[]
    grantable: boolean
  }>
  resourceKinds: Array<{
    kind: string
    operations: Array<{
      operation: string
      method: string
      path: string
      permission: string | null
    }>
    note?: string
  }>
  mcp: { endpoint: string; transport: string; auth: string }
  snippets: Array<{ id: string; label: string; language: string; code: string }>
}

/** Localized headings and prose. Identifiers stay in English on both sides. */
export interface ApiDocsStrings {
  intro: string
  quickStart: string
  quickStartBody: string
  connecting: string
  toolsHeading: string
  toolsIntro: string
  restHeading: string
  restIntro: string
  permissionsHeading: string
  permissionsIntro: string
  alwaysGrantedHeading: string
  alwaysGrantedIntro: string
  resourcesHeading: string
  resourcesIntro: string
  colTool: string
  colNeeds: string
  colDescription: string
  colMethod: string
  colPath: string
  colSummary: string
  colOperation: string
  colPermission: string
  needsNothing: string
  notAvailableToYou: string
  adminOnly: string
  resourceAdminOnly: string
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return ''
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n')
  return `${head}\n${sep}\n${body}`
}

/** Escape the pipe so a value never breaks out of its table cell. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|')
}

function code(value: string): string {
  return `\`${cell(value)}\``
}

export function buildApiDocsMarkdown(docs: ApiDocsPayload, s: ApiDocsStrings): string {
  const parts: string[] = []

  parts.push(s.intro)

  parts.push(`## ${s.quickStart}`)
  parts.push(s.quickStartBody)
  parts.push(
    table(
      ['', ''],
      [
        ['MCP endpoint', code(docs.mcp.endpoint)],
        ['Transport', cell(docs.mcp.transport)],
        ['Authorization', code(docs.mcp.auth)],
      ],
    ),
  )

  parts.push(`## ${s.connecting}`)
  for (const snippet of docs.snippets) {
    parts.push(`### ${snippet.label}`)
    parts.push(`\`\`\`${snippet.language}\n${snippet.code}\n\`\`\``)
  }

  parts.push(`## ${s.toolsHeading}`)
  parts.push(s.toolsIntro)
  parts.push(
    table(
      [s.colTool, s.colNeeds, s.colDescription],
      docs.tools.map((t) => [
        // A tool this role can never hold the points for is listed but marked:
        // hiding it would leave the reader wondering why a capability they read
        // about elsewhere is missing here.
        t.grantable ? code(t.name) : `${code(t.name)} _(${cell(s.notAvailableToYou)})_`,
        t.permissions.length === 0 ? cell(s.needsNothing) : t.permissions.map(code).join(', '),
        cell(t.description),
      ]),
    ),
  )

  parts.push(`## ${s.resourcesHeading}`)
  parts.push(s.resourcesIntro)
  for (const kind of docs.resourceKinds) {
    parts.push(`### ${kind.kind}`)
    if (kind.note !== undefined) parts.push(`> ${kind.note}`)
    parts.push(
      table(
        [s.colOperation, s.colMethod, s.colPath, s.colPermission],
        kind.operations.map((op) => [
          cell(op.operation),
          code(op.method),
          code(op.path),
          op.permission === null ? cell(s.needsNothing) : code(op.permission),
        ]),
      ),
    )
  }

  parts.push(`## ${s.permissionsHeading}`)
  parts.push(s.permissionsIntro)
  parts.push(
    table(
      ['', ...new Set(docs.grantablePermissions.flatMap((g) => g.verbs.map((v) => v.verb)))],
      docs.grantablePermissions.map((g) => {
        const verbs = new Set(g.verbs.map((v) => v.verb))
        const columns = [
          ...new Set(docs.grantablePermissions.flatMap((x) => x.verbs.map((v) => v.verb))),
        ]
        return [cell(g.resource), ...columns.map((v) => (verbs.has(v) ? '✓' : ''))]
      }),
    ),
  )

  parts.push(`### ${s.alwaysGrantedHeading}`)
  parts.push(s.alwaysGrantedIntro)
  parts.push(docs.alwaysGranted.map(code).join(' · '))

  parts.push(`## ${s.restHeading}`)
  parts.push(s.restIntro)
  parts.push(
    table(
      [s.colMethod, s.colPath, s.colNeeds, s.colSummary],
      docs.endpoints.map((e) => [
        code(e.method),
        code(e.path),
        e.open
          ? cell(s.needsNothing)
          : [
              ...e.permissions.map(code),
              ...(e.identity === 'admin'
                ? [`_${cell(s.adminOnly)}_`]
                : e.identity === 'resource-admin'
                  ? [`_${cell(s.resourceAdminOnly)}_`]
                  : []),
            ].join(', '),
        cell(e.summary),
      ]),
    ),
  )

  return parts.filter((p) => p !== '').join('\n\n')
}
