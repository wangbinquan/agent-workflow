// RFC-359 W4-B6 批 c —— source-control 仓库传输凭据仓库合一，两个引擎各跑一遍：发布连接投影的 upsert 与
// 凭据修订推进、个人凭据的 upsert / 修订 / 计数 / 删除、绑定变化时个人凭据级联清除、管理员连接的围栏式同步与删除。

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { users } from '@/db/schema'
import { DrizzleRepositoryTransportCredentialRepository } from '@/modules/source-control/infrastructure/repositoryTransportCredentialRepository'
import { describeEachProvider } from './helpers/eachProvider'

async function seedUser(db: ProviderNeutralDatabase): Promise<string> {
  const id = `u_b6c_${ulid()}`
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'user',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
  return id
}

/** SQLite 的 CHECK：绑定摘要必须是 64 位十六进制，token 提示定长 4。 */
function digest(seed: string): string {
  return seed.charCodeAt(0).toString(16).padStart(2, '0').repeat(32)
}

function projection(overrides: { generation: string; digest: string; token: string; now: number }) {
  return {
    provider: 'github' as const,
    connectionGeneration: overrides.generation,
    endpointBindingDigest: digest(overrides.digest),
    apiBaseUrl: 'https://api.github.invalid',
    rejectUnauthorized: true,
    transportMappings: [],
    allowedHttpBaseUrls: ['https://github.invalid'],
    globalTokenEnc: overrides.token,
    globalTokenHint: 'hint',
    updatedAt: overrides.now,
    updatedBy: null,
  }
}

describeEachProvider('RFC-359 W4-B6c —— 仓库传输凭据仓库', (harness) => {
  test('连接投影 / 个人凭据 / 绑定变化级联 / 管理员连接的围栏式同步与删除', async () => {
    const db = harness.db
    const repository = new DrizzleRepositoryTransportCredentialRepository(db)
    const userId = await seedUser(db)

    await repository.synchronizeConnection(
      projection({ generation: 'g1', digest: 'd1', token: 'tok1', now: 1 }),
    )
    expect(await repository.findConnection('github')).toMatchObject({
      connectionGeneration: 'g1',
      endpointBindingDigest: digest('d1'),
      credentialRevision: 1,
      transportMappings: [],
      allowedHttpBaseUrls: ['https://github.invalid'],
    })
    expect((await repository.listConnections()).map((row) => row.provider)).toContain('github')
    expect(await repository.findConnection('gitlab')).toBeNull()

    const personal = await repository.putPersonal({
      userId,
      provider: 'github',
      connectionGeneration: 'g1',
      endpointBindingDigest: digest('d1'),
      tokenEnc: 'ptok1',
      tokenHint: 'ptk1',
      now: 5,
    })
    expect(personal).toMatchObject({
      credentialRef: `personal:${userId}:github:1`,
      credentialRevision: 1,
      createdAt: 5,
    })
    const rotated = await repository.putPersonal({
      userId,
      provider: 'github',
      connectionGeneration: 'g1',
      endpointBindingDigest: digest('d1'),
      tokenEnc: 'ptok2',
      tokenHint: 'ptk2',
      now: 6,
    })
    expect(rotated).toMatchObject({ credentialRevision: 2, createdAt: 5, updatedAt: 6 })
    expect((await repository.findPersonal(userId, 'github'))?.tokenEnc).toBe('ptok2')
    expect(await repository.findPersonal(userId, 'gitlab')).toBeNull()
    expect((await repository.listPersonal(userId)).length).toBe(1)
    const personalCount = await repository.personalCount('github')
    expect(typeof personalCount).toBe('number')
    expect(personalCount).toBe(1)

    // 同一绑定、同一 token ⇒ 修订不动；换 token ⇒ 修订 +1；换绑定 ⇒ 个人凭据级联清除。
    await repository.synchronizeConnection(
      projection({ generation: 'g1', digest: 'd1', token: 'tok1', now: 7 }),
    )
    expect((await repository.findConnection('github'))?.credentialRevision).toBe(1)
    await repository.synchronizeConnection(
      projection({ generation: 'g1', digest: 'd1', token: 'tok2', now: 8 }),
    )
    expect((await repository.findConnection('github'))?.credentialRevision).toBe(2)
    expect(await repository.personalCount('github')).toBe(1)
    await repository.synchronizeConnection(
      projection({ generation: 'g2', digest: 'd2', token: 'tok2', now: 9 }),
    )
    expect(await repository.personalCount('github')).toBe(0)
    expect(await repository.removePersonal(userId, 'github')).toBe(false)

    // 管理员连接：围栏对得上才写；投影随之同步。
    const configured = {
      provider: 'github' as const,
      connectionGeneration: 'g3',
      baseUrl: 'https://github.invalid',
      rejectUnauthorized: true,
      repositoryUrlPrefixesJson: '[]',
      transportMappingsJson: '[]',
      tokenEnc: 'admin-tok',
      tokenHint: 'admn',
      lastTestJson: null,
      updatedAt: 10,
      updatedBy: null,
    }
    const stale = {
      personalCredentialCount: 0,
      currentConnectionGeneration: 'g1',
      currentEndpointBindingDigest: digest('d1'),
    }
    const fresh = {
      personalCredentialCount: 0,
      currentConnectionGeneration: 'g2',
      currentEndpointBindingDigest: digest('d2'),
    }
    expect(
      await repository.synchronizeConfiguredConnection(
        configured,
        projection({ generation: 'g3', digest: 'd3', token: 'tok3', now: 10 }),
        stale,
      ),
    ).toBe(false)
    expect(await repository.findConfiguredConnection('github')).toBeNull()
    expect(
      await repository.synchronizeConfiguredConnection(
        configured,
        projection({ generation: 'g3', digest: 'd3', token: 'tok3', now: 10 }),
        fresh,
      ),
    ).toBe(true)
    expect(await repository.findConfiguredConnection('github')).toMatchObject({
      connectionGeneration: 'g3',
      tokenEnc: 'admin-tok',
    })
    expect((await repository.listConfiguredConnections()).map((row) => row.provider)).toContain(
      'github',
    )
    expect(await repository.findConnection('github')).toMatchObject({
      connectionGeneration: 'g3',
      credentialRevision: 3,
    })
    await repository.recordConfiguredConnectionTest('github', '{"ok":true}')
    expect((await repository.findConfiguredConnection('github'))?.lastTestJson).toBe('{"ok":true}')

    expect(await repository.removeConfiguredConnection('github', fresh)).toBe('stale')
    expect(
      await repository.removeConfiguredConnection('github', {
        personalCredentialCount: 0,
        currentConnectionGeneration: 'g3',
        currentEndpointBindingDigest: digest('d3'),
      }),
    ).toBe('removed')
    expect(await repository.findConfiguredConnection('github')).toBeNull()
    expect(await repository.findConnection('github')).toBeNull()
    expect(
      await repository.removeConfiguredConnection('github', {
        personalCredentialCount: 0,
        currentConnectionGeneration: null,
        currentEndpointBindingDigest: null,
      }),
    ).toBe('missing')
    expect(await repository.removeConnection('github')).toBe(false)
    await repository.synchronizeConnection(
      projection({ generation: 'g4', digest: 'd4', token: 'tok4', now: 11 }),
    )
    expect(await repository.removeConnection('github')).toBe(true)
  })
})

test('源码锁：provider 命名的孪生实现不得复活', () => {
  const infra = resolve(import.meta.dir, '..', 'src', 'modules', 'source-control', 'infrastructure')
  for (const provider of ['sqlite', 'postgresql']) {
    expect(
      existsSync(resolve(infra, `${provider}RepositoryTransportCredentialRepository.ts`)),
    ).toBe(false)
  }
})
