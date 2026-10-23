export interface AgentDependencyReadPort {
  load(id: string): Promise<readonly string[] | undefined>
}
