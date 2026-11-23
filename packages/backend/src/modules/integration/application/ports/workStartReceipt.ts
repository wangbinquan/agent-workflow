// RFC-550 (RFC-294 S9): what a webhook-dispatched start returns; it sat on `public/participants` with only this
// module's dispatch using it.
export type WorkStartReceipt =
  | { readonly kind: 'orchestration'; readonly taskId: string }
  | { readonly kind: 'digital-employee'; readonly caseId: string }
