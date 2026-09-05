// RFC-345 T4c — bootstrap binding for integration-trigger resource snapshots.
//
// RFC-359 W4-D1：一份实现，两个 provider 共用——Integration owner 持有统一事务原语的事务句柄，并交来它自己的
// 数字员工参与者；Resource Catalog 把每一次 ACL 与内容读绑定到这一个句柄与这一对已准入的 authority。
// SQLite 侧此前经 dbTxSync 的同步绑定（`inTransaction(tx: DbTxSync, pair)`）随之退役。

import type { Actor } from '@/auth/actor'
import type { DigitalEmployeeIntegrationTriggerParticipant } from '@/modules/digital-employee/public/participants'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import {
  createIntegrationTriggerResourceSnapshotReader,
  type IntegrationTriggerResourceDependencies,
  type IntegrationTriggerResourceSnapshotReader,
} from '../infrastructure/aggregateAdapters/integrationTriggerResourceSnapshots'
import type { ResourceRequestContext } from '../public/participants'

export interface IntegrationTriggerResourceAuthorityPair {
  readonly authority: ResourceRequestContext
  readonly actor: Actor
}

export interface IntegrationTriggerResourceSnapshotFactory {
  inTransaction(
    transaction: DatabaseTransaction,
    pair: IntegrationTriggerResourceAuthorityPair,
    digitalEmployees: DigitalEmployeeIntegrationTriggerParticipant,
  ): IntegrationTriggerResourceSnapshotReader
}

/**
 * The Integration owner reserves the transaction and supplies its owner-native
 * Digital Employee participant; Resource Catalog binds every ACL and content
 * read to that exact transaction and exact admitted authority pair.
 */
export function composeIntegrationTriggerResourceSnapshotFactory(
  dependencies: IntegrationTriggerResourceDependencies,
): IntegrationTriggerResourceSnapshotFactory {
  return Object.freeze({
    inTransaction(
      transaction: DatabaseTransaction,
      pair: IntegrationTriggerResourceAuthorityPair,
      digitalEmployees: DigitalEmployeeIntegrationTriggerParticipant,
    ) {
      return createIntegrationTriggerResourceSnapshotReader(
        {
          transaction,
          authority: pair.authority,
          actor: pair.actor,
          digitalEmployees,
        },
        dependencies,
      )
    },
  })
}

/** RFC-359：两个 provider 共用一份；旧名保留为装配别名，bootstrap 收敛后删除。 */
export const composePostgresqlIntegrationTriggerResourceSnapshotFactory =
  composeIntegrationTriggerResourceSnapshotFactory
export type PostgresqlIntegrationTriggerResourceSnapshotFactory =
  IntegrationTriggerResourceSnapshotFactory
