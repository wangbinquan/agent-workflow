// RFC-533: the session's child-task budget for test compositions. The daemon builds one per Task Execution assembly;
// the test topologies build one per child-budget query object — as the former process singleton was one per query
// source — so a composition that reuses a persistence shares its budget, and separate persistences never do.
import {
  createChildTaskBudgetRuntime,
  type ChildTaskBudgetRuntime,
} from '@/modules/task-execution/infrastructure/childBudget'
import type { ChildTaskBudgetQueries } from '@/modules/task-execution/application/ports/childTaskBudgetQueries'

const budgets = new WeakMap<ChildTaskBudgetQueries, ChildTaskBudgetRuntime>()

export function testChildTaskBudget(queries: ChildTaskBudgetQueries): ChildTaskBudgetRuntime {
  let budget = budgets.get(queries)
  if (budget === undefined) {
    budget = createChildTaskBudgetRuntime(queries)
    budgets.set(queries, budget)
  }
  return budget
}
