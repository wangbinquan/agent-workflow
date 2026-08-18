// RFC-310 T14 —— digital employee / automation policy 的 application 命令面。
//
// application 不 import infrastructure（RFC-294 矩阵）：store 以 port 形式注入，
// 由 composition/路由装配（PR-1B 集成批）。actor 授权（permission/ACL）在
// inbound 层统一接（fork C 的 permission catalog 落地后），这里只承载编排与
// 输入形状；publish 的跨资源 lookup 同样由装配方注入——本模块不 import
// ActionTemplate store 的实现。

import type { EmployeePublishLookup } from '../../domain/digitalEmployee'

export interface DevelopmentResourceSummary {
  readonly id: string
  readonly name: string
  readonly publishedRevision: number | null
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly archivedAt: number | null
}

export interface DigitalEmployeeStorePort {
  create(input: {
    name: string
    ownerUserId: string | null
    draft: unknown
  }): Promise<DevelopmentResourceSummary>
  reviseDraft(input: { id: string; draft: unknown }): Promise<void>
  publish(input: {
    id: string
    publishedBy: string | null
    lookup: EmployeePublishLookup
  }): Promise<{ revision: number; contentDigest: string }>
  archive(id: string): Promise<void>
  get(id: string): Promise<DevelopmentResourceSummary | null>
  list(): Promise<DevelopmentResourceSummary[]>
}

export interface AutomationPolicyStorePort {
  create(input: {
    name: string
    ownerUserId: string | null
    draft: unknown
  }): Promise<DevelopmentResourceSummary>
  reviseDraft(input: { id: string; draft: unknown }): Promise<void>
  publish(input: {
    id: string
    publishedBy: string | null
  }): Promise<{ revision: number; contentDigest: string }>
  get(id: string): Promise<DevelopmentResourceSummary | null>
}

export interface DigitalEmployeeCommands {
  createEmployee(input: {
    name: string
    ownerUserId: string | null
    draft: unknown
  }): Promise<DevelopmentResourceSummary>
  reviseEmployeeDraft(input: { id: string; draft: unknown }): Promise<void>
  publishEmployee(input: {
    id: string
    publishedBy: string | null
  }): Promise<{ revision: number; contentDigest: string }>
  archiveEmployee(id: string): Promise<void>
}

export function createDigitalEmployeeCommands(deps: {
  store: DigitalEmployeeStorePort
  publishLookup: EmployeePublishLookup
}): DigitalEmployeeCommands {
  return {
    createEmployee: (input) => deps.store.create(input),
    reviseEmployeeDraft: (input) => deps.store.reviseDraft(input),
    publishEmployee: (input) => deps.store.publish({ ...input, lookup: deps.publishLookup }),
    archiveEmployee: (id) => deps.store.archive(id),
  }
}
