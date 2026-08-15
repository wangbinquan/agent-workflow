// RFC-304 — the code-host surface a capability is allowed to reach.
//
// Deliberately narrower than `services/codeHost/call.ts`. That module resolves
// connections, renders templates, retries, redacts tokens and bounds responses;
// none of that is a capability's concern, and depending on its types directly
// would drag connection resolution into the stage logic and make every stage
// test need a code-host connection row.
//
// What a capability needs is: name an action, hand over string params, get back
// either a body or a named refusal. The adapter in `infrastructure/` supplies
// the rest.

export type CodeHostResult =
  | {
      readonly ok: true
      readonly status: number
      readonly body: string
      readonly truncated: boolean
    }
  | { readonly ok: false; readonly code: string; readonly message: string }

export interface CodeHostCall {
  readonly action: string
  readonly params: Readonly<Record<string, string>>
  /**
   * Raise the response cap for this call.
   *
   * Diff reads need it: the client's 256 KiB default cuts a large MR's diff
   * mid-body, and a cut body is refused rather than parsed (see
   * `readMrDiffResponse`), so an un-raised cap turns "a big MR" into "a review
   * that cannot run".
   */
  readonly maxResponseBytes?: number
}

export interface CodeHostPort {
  call(call: CodeHostCall): Promise<CodeHostResult>
}
