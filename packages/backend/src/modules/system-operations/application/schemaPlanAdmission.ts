// RFC-517 — a schema plan handed to the system-operations composition must be the plan of its contract (RFC-294 S10).
// Typed by shape: the check reads only the plan's contract digest and the contract's digest, so this application file takes
// no provider dialect (RFC-359 W5-T17 / RFC-349 provider cutover).
export function requireSchemaPlanForContract(
  plan: { readonly contractDigest: string },
  contract: { readonly digest: string },
): void {
  if (plan.contractDigest !== contract.digest) {
    throw new Error('postgresql-system-operations-schema-plan-mismatch')
  }
}
