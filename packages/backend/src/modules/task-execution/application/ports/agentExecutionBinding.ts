/** The execution owner issues this participant in the same selected
 * composition as its binding. Implementations keep persistence and receipt
 * dialects private; consumers only forward the opaque participant. */
declare const agentExecutionTaskParticipantBrand: unique symbol
interface AgentExecutionTaskParticipant {
  readonly [agentExecutionTaskParticipantBrand]: 'agent-execution-task-participant'
}

export interface AgentExecutionParticipants {
  readonly taskEffect?: AgentExecutionTaskParticipant
}
