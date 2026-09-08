import { ValidationError } from '@/util/errors'

/** Callers retain root normalization and their transaction-bound row readers. */
export async function assertAgentDependencyTraversal(
  candidateId: string,
  roots: readonly string[],
  loadDependencies: (id: string) => Promise<readonly string[] | undefined>,
): Promise<void> {
  const visited = new Set<string>()
  const visiting = new Set<string>()
  async function visit(id: string): Promise<void> {
    if (id === candidateId || visiting.has(id)) {
      throw new ValidationError('agent-dependency-cycle', 'agent dependency graph contains a cycle')
    }
    if (visited.has(id)) return
    visiting.add(id)
    const dependencies = await loadDependencies(id)
    if (dependencies === undefined) {
      throw new ValidationError(
        'agent-dependency-not-found',
        `agent dependency '${id}' not found`,
        { notFound: [id] },
      )
    }
    for (const dependency of dependencies) await visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const dependency of roots) await visit(dependency)
}
