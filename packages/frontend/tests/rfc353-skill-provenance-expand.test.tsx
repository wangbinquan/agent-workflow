// RFC-353 T10 —— 技能版本行的「来源」展开区。
//
// 这条测试存在的理由（重构时别删）：
//   ① 展开区只对 **fusion** 版本出现。其余来源（编辑 / 导入 / 回滚 / 初始）不吃记忆，
//      给它们一个永远空的展开箭头，用户会以为数据丢了。
//   ② 来源数据**整份一次取回**，不按行请求：展开三四行会打出四五个并发请求，
//      折叠再展开又重来。这条断言锁的就是「请求次数」。
//   ③ 默认视图不该为一个折叠区多打一次请求——没人展开时 provenance 不发请求。
//   ④ 空态要说清楚「不是坏了」：知识可能已被回滚，或对当前用户不可见。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SkillProvenance, SkillVersion } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } }
})

import { api } from '../src/api/client'
import { SkillVersionHistory } from '../src/components/skill/SkillVersionHistory'
import '../src/i18n'

const mockedGet = vi.mocked(api.get)

const version = (versionIndex: number, source: SkillVersion['source']): SkillVersion => ({
  id: `v${versionIndex}`,
  skillName: 'lint',
  versionIndex,
  source,
  summary: null,
  fusionId: source === 'fusion' ? `fus_${versionIndex}` : null,
  restoredFromVersion: null,
  authorUserId: null,
  contentHash: 'hash',
  createdAt: 1,
})

const PROVENANCE: SkillProvenance = {
  skillId: 'skill-1',
  versions: [
    {
      versionIndex: 2,
      source: 'fusion',
      fusionId: 'fus_2',
      restoredFromVersion: null,
      createdAt: 1,
      memories: [
        { id: 'm1', title: '缓存要按仓库分片', scopeType: 'repo', scopeId: 'repo-1' },
        { id: 'm2', title: '别在事务里发网络请求', scopeType: 'global', scopeId: null },
      ],
    },
    {
      versionIndex: 3,
      source: 'fusion',
      fusionId: 'fus_3',
      restoredFromVersion: null,
      createdAt: 2,
      memories: [],
    },
  ],
}

function renderHistory(versions: SkillVersion[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  mockedGet.mockImplementation(((path: unknown) => {
    if (String(path).endsWith('/provenance')) return Promise.resolve(PROVENANCE)
    return Promise.resolve(versions)
  }) as unknown as typeof api.get)
  return render(
    <QueryClientProvider client={client}>
      <SkillVersionHistory skillId="skill-1" currentVersion={4} canRestore={false} />
    </QueryClientProvider>,
  )
}

const provenanceCalls = (): number =>
  mockedGet.mock.calls.filter(([path]) => String(path).endsWith('/provenance')).length

beforeEach(() => mockedGet.mockReset())
afterEach(() => cleanup())

describe('RFC-353 T10 技能版本来源展开区', () => {
  test('只有融合版本带展开箭头', async () => {
    renderHistory([version(3, 'fusion'), version(2, 'restore'), version(1, 'initial')])
    await screen.findByTestId('skill-version-provenance-toggle-3')
    expect(screen.queryByTestId('skill-version-provenance-toggle-2')).toBeNull()
    expect(screen.queryByTestId('skill-version-provenance-toggle-1')).toBeNull()
  })

  test('没人展开时不请求来源——默认视图不为折叠区多打一次请求', async () => {
    renderHistory([version(2, 'fusion')])
    await screen.findByTestId('skill-version-provenance-toggle-2')
    expect(provenanceCalls()).toBe(0)
  })

  test('展开后列出这一版吃进的知识，带 scope 徽标', async () => {
    renderHistory([version(2, 'fusion')])
    fireEvent.click(await screen.findByTestId('skill-version-provenance-toggle-2'))
    expect(await screen.findByText('缓存要按仓库分片')).toBeTruthy()
    expect(screen.getByText('别在事务里发网络请求')).toBeTruthy()
    await waitFor(() => expect(provenanceCalls()).toBe(1))
  })

  test('整份一次取回：展开第二行不再发第二次请求', async () => {
    renderHistory([version(3, 'fusion'), version(2, 'fusion')])
    fireEvent.click(await screen.findByTestId('skill-version-provenance-toggle-2'))
    await screen.findByText('缓存要按仓库分片')
    fireEvent.click(screen.getByTestId('skill-version-provenance-toggle-3'))
    await waitFor(() => expect(screen.queryByText('缓存要按仓库分片')).toBeNull())
    expect(provenanceCalls()).toBe(1)
  })

  test('这一版已无在册知识时给空态，而不是空白', async () => {
    renderHistory([version(3, 'fusion')])
    fireEvent.click(await screen.findByTestId('skill-version-provenance-toggle-3'))
    // 文案要说清「可能已被回滚 / 对你不可见」，不能只写「暂无数据」。
    expect(await screen.findByText(/回滚|rolled back/)).toBeTruthy()
  })

  test('再次点击折叠', async () => {
    renderHistory([version(2, 'fusion')])
    const toggle = await screen.findByTestId('skill-version-provenance-toggle-2')
    fireEvent.click(toggle)
    await screen.findByText('缓存要按仓库分片')
    fireEvent.click(screen.getByTestId('skill-version-provenance-toggle-2'))
    await waitFor(() => expect(screen.queryByText('缓存要按仓库分片')).toBeNull())
  })
})
