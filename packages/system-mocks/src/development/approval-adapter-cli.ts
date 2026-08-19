// Executable approval-gateway adapter used by RFC-310 system tests.

export {}

function iso(value: string): string {
  return value.endsWith('Z') ? value.replace('Z', '+00:00') : value
}

async function submit(): Promise<number> {
  const base = process.env.AW_APPROVAL_MOCK_URL
  const key = process.env.AW_IDEMPOTENCY_KEY
  const intentDigest = process.env.AW_APPROVAL_INTENT_DIGEST
  if (!base || !key || !intentDigest) return 2
  const response = await fetch(`${base}/approvals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stepRunRef: process.env.AW_APPROVAL_STEP_RUN,
      draftRef: process.env.AW_APPROVAL_DRAFT_REF,
      deadlineAt: process.env.AW_APPROVAL_DEADLINE,
      idempotencyKey: key,
      intentDigest,
    }),
  })
  // Response lost: the submit may have committed. Query by the same key before
  // ever attempting another POST.
  const settled =
    response.status >= 500
      ? await fetch(`${base}/approvals/by-key/${encodeURIComponent(key)}`)
      : response
  if (!settled.ok) return 5
  const body = (await settled.json()) as {
    correlationRef: string
    externalRequestRef: string
    submittedRevision: string
    submittedAt: string
    intentDigest: string
  }
  console.log(
    JSON.stringify({
      protocol: 'aw-adapter@1',
      operation: 'approval.submit',
      intentDigest,
      correlationRef: body.correlationRef,
      externalRequestRef: body.externalRequestRef,
      submittedRevision: body.submittedRevision,
      submittedAt: iso(body.submittedAt),
    }),
  )
  return 0
}

async function lookup(key: string): Promise<number> {
  const base = process.env.AW_APPROVAL_MOCK_URL
  if (!base) return 2
  const response = await fetch(`${base}/approvals/by-key/${encodeURIComponent(key)}`)
  if (response.status === 404) {
    console.log(
      JSON.stringify({ protocol: 'aw-adapter@1', operation: 'approval.lookup', found: false }),
    )
    return 0
  }
  if (!response.ok) return 5
  const body = (await response.json()) as {
    correlationRef: string
    externalRequestRef: string
    submittedRevision: string
    submittedAt: string
    intentDigest: string
  }
  console.log(
    JSON.stringify({
      protocol: 'aw-adapter@1',
      operation: 'approval.lookup',
      found: true,
      intentDigest: body.intentDigest,
      correlationRef: body.correlationRef,
      externalRequestRef: body.externalRequestRef,
      submittedRevision: body.submittedRevision,
      submittedAt: iso(body.submittedAt),
    }),
  )
  return 0
}

async function observe(correlationRef: string): Promise<number> {
  const base = process.env.AW_APPROVAL_MOCK_URL
  if (!base) return 2
  const response = await fetch(`${base}/approvals/${encodeURIComponent(correlationRef)}`)
  if (!response.ok) return 5
  const body = (await response.json()) as Record<string, unknown>
  console.log(
    JSON.stringify({
      protocol: 'aw-adapter@1',
      operation: 'approval.observe',
      ...body,
      observedAt: iso(String(body.observedAt)),
    }),
  )
  return 0
}

const [mode, argument] = process.argv.slice(2)
const exit =
  mode === '--submit-approval'
    ? await submit()
    : mode === '--lookup-approval' && argument
      ? await lookup(argument)
      : mode === '--observe-approval' && argument
        ? await observe(argument)
        : 2
process.exit(exit)
