/** Original relationship diagnostics keep their full source identities even
 * when none of them contributes to the requested numerical scope. */
export function originalHistoricalDiagnostic(section: string, parent: string | null): boolean {
  return (
    ((section === 'historical-executions' || section === 'historical-records') &&
      parent === 'original-source') ||
    section === 'historical-record-references' ||
    section === 'historical-record-versions' ||
    (section === 'historical-records' && parent?.startsWith('["historical-execution",') === true)
  )
}
