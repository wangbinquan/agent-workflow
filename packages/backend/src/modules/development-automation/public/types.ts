// The external-approval subject codec is a real cross-context contract: the
// development type package mints the opaque subject, while Integration's
// observer decodes it before calling the registered approval provider. Keep
// that seam exact instead of letting Integration import development internals.
export {
  decodeDevelopmentApprovalSubject,
  encodeDevelopmentApprovalSubject,
  type DevelopmentApprovalSubject,
} from '../domain/approvalSubject'
