/** Nine existing business operations, independent of their execution backend. */
export interface DevelopmentAdapterOperationInput {
  readonly operation:
    | { readonly kind: 'acquire'; readonly externalId: string }
    | {
        readonly kind: 'questions.writeback'
        readonly externalId: string
        readonly questionsJson: string
      }
    | {
        readonly kind: 'answers.collect'
        readonly externalId: string
        readonly correlationRef: string
      }
    | {
        readonly kind: 'pipeline.collect'
        readonly headSha: string
        readonly targetSha: string
        readonly gateKeysCsv: string
      }
    | {
        readonly kind: 'pipeline.trigger'
        readonly headSha: string
        readonly gateKeysCsv: string
        readonly idempotencyKey: string
      }
    | {
        readonly kind: 'pipeline.rerun'
        readonly runRef: string
        readonly gateKey: string
        readonly headSha: string
        readonly idempotencyKey: string
      }
    | {
        readonly kind: 'approval.submit'
        readonly stepRunRef: string
        readonly draftRef: string
        readonly deadlineAt: string
        readonly idempotencyKey: string
        readonly intentDigest: string
      }
    | { readonly kind: 'approval.lookup'; readonly idempotencyKey: string }
    | { readonly kind: 'approval.observe'; readonly correlationRef: string }
}

export type DevelopmentAdapterOperation = DevelopmentAdapterOperationInput['operation']
