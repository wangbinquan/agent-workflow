/** Runtime Management asks the resource owner for references in its live write transaction. */
export interface RuntimeProfileUsageReader<Transaction> {
  inspect(
    transaction: Transaction,
    input: { readonly runtimeName: string },
  ): Promise<readonly string[]>
}
