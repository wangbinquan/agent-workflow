// RFC-395 II-b —— 夹具复位对大种子表「行身份没变就留着」。
//
// 为什么这条测试存在：epoch-2 的 `agent_workflow_meta.schema_history` 带一行约 4.2MB 的目录工件，
// `describeEachProvider` 每个用例前把它截掉再种回，PostgreSQL 用例因此每条多 ~100ms（CI 运行
// 40298205725 上 PostgreSQL 用例整体比激活前慢约一半）。`resetToSnapshot` 改为先比行身份
// （`ctid:xmin`），没变就不截不种。这里锁住三件事：没动过时真的没重种（身份不变）；改过、删过、
// 多插过、截过时照样复原成初装内容；留着那张表的同时，别的表照常被清空。
import { SQL } from 'bun'
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'

import { describeEachProvider, resolvePostgresqlTestUrlEnv } from './helpers/eachProvider'
import { readWorkflowFixtures, workflowFixture } from './helpers/model'

const HISTORY = '"agent_workflow_meta"."schema_history"'

describeEachProvider('RFC-395 harness stable seed reset', (harness) => {
  test('unchanged schema history stays in place; every change is restored to the installed rows', async () => {
    // SQLite 泳道每个用例新建内存库，没有截表种回这一步。
    if (harness.capabilities.provider === 'sqlite') return
    const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
    expect(urlEnv, 'PostgreSQL 泳道必须有库').toBeDefined()
    const sql = new SQL({ url: process.env[urlEnv!]!, max: 1 })
    try {
      const identity = async () =>
        String(
          (
            await sql.unsafe(
              `select coalesce(string_agg(ctid::text || ':' || xmin::text, ',' order by ctid), '') as identity from ${HISTORY}`,
            )
          )[0]!.identity,
        )
      const content = async () =>
        await sql.unsafe(
          `select version, contract_digest, sqlite_plan_digest, postgresql_plan_digest, applied_at,
                  md5(artifact_json) as artifact, length(artifact_json) as artifact_length
             from ${HISTORY} order by version`,
        )

      const installed = await content()
      expect(installed.length, '初装必须种下 schema history').toBeGreaterThan(0)
      // 工件不够大，夹具就不走「留着」这条路，下面的判据也就失去意义。
      expect(Number(installed[0]!.artifact_length)).toBeGreaterThanOrEqual(64 * 1024)

      const untouched = await identity()
      await harness.restoreFixture()
      expect(await identity(), '没动过就不该重种').toBe(untouched)
      expect(await content()).toEqual(installed)

      await sql.unsafe(`update ${HISTORY} set applied_at = applied_at + 1`)
      await harness.restoreFixture()
      expect(await content(), 'UPDATE 之后复原成初装内容').toEqual(installed)
      const reseeded = await identity()
      expect(reseeded, '改过就必须重种').not.toBe(untouched)
      await harness.restoreFixture()
      expect(await identity(), '重种之后再没动过，又该留着').toBe(reseeded)

      await sql.unsafe(`delete from ${HISTORY}`)
      await harness.restoreFixture()
      expect(await content(), 'DELETE 之后复原').toEqual(installed)

      await sql.unsafe(
        `insert into ${HISTORY} select version + 1000, contract_digest, sqlite_plan_digest,
                postgresql_plan_digest, applied_at, 'extra' from ${HISTORY}`,
      )
      await harness.restoreFixture()
      expect(await content(), '多插的行必须被清掉').toEqual(installed)

      await sql.unsafe(`truncate ${HISTORY}`)
      await harness.restoreFixture()
      expect(await content(), 'TRUNCATE 之后复原').toEqual(installed)

      const workflowId = ulid()
      await workflowFixture(harness.db, {
        id: workflowId,
        name: `stable-seed-${workflowId.slice(-8).toLowerCase()}`,
        definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      expect(await readWorkflowFixtures(harness.db, { id: workflowId })).toHaveLength(1)
      const kept = await identity()
      await harness.restoreFixture()
      expect(await identity(), 'schema history 没动，继续留着').toBe(kept)
      expect(await readWorkflowFixtures(harness.db, { id: workflowId }), '别的表照常清空').toEqual(
        [],
      )
    } finally {
      await sql.close()
    }
  })
})
