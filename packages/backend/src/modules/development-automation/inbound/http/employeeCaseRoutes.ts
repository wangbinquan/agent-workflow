// RFC-436 —— development-automation 自己挂载的案例范围路由。
//
// 此前这两组路由由数字员工的 HTTP 绑定托管：图驱动研发的设计路由
// （`graph.mountRoutes`）与活动操作 `POST /api/employee-cases/worker/run-one`。context DAG
// 只允许 development-automation → digital-employee，数字员工绑定归入本 context 之后不能再
// 反向 import 它们，于是改由本 context 挂载；案例授权是数字员工的案例访问判据，由 bootstrap
// 连接（本文件按结构声明，不 import digital-employee 内部）。`server.ts` 的路由组
// `developmentCases` 紧随 `digitalEmployees` 调用这里。

import type { Hono } from 'hono'

import { actorOf, type Actor } from '@/auth/actor'
import type { DirectAuthorityBinding } from '@/modules/identity-access/public/participants'
import { directOperationAuthority } from '@/routes/operationAuthority'
import { registerOperationRoute } from '@/routes/operationRoute'
import {
  createDevelopmentActivityOperation,
  type DevelopmentActivityOperations,
} from '../../application/activityOperations'

/** Visible-case (read) or operator (edit) authorization for one employee case. */
export interface EmployeeCaseRouteAccess {
  authorize(actor: Actor, caseId: string, edit: boolean): Promise<unknown>
}

export interface DevelopmentCaseRoutes {
  /** The graph-driven development composition; it owns the design route bindings. */
  readonly graph: { mountRoutes(app: Hono, access: EmployeeCaseRouteAccess): void }
  readonly caseAccess: EmployeeCaseRouteAccess
  readonly activity: {
    readonly operations: DevelopmentActivityOperations
    readonly contexts: DirectAuthorityBinding
  }
}

export function mountDevelopmentCaseRoutes(app: Hono, routes: DevelopmentCaseRoutes): void {
  routes.graph.mountRoutes(app, routes.caseAccess)
  registerOperationRoute(app, {
    descriptor: createDevelopmentActivityOperation(routes.activity.operations),
    method: 'POST',
    path: '/api/employee-cases/worker/run-one',
    executionGroup: 'digital-employee',
    tokenAccess: 'never',
    decode: () => ({}),
    context: (c) => directOperationAuthority(routes.activity.contexts, actorOf(c)),
    encode: (c, output) => c.json(output),
  })
}
