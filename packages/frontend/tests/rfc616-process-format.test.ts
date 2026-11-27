// RFC-616 §11 (design/RFC-616-process-metrics/design.md) — the pure display
// rules of process metrics and the completeness of its copy.
//
// Locks: "no sample" is a dash and never zero; a change line says whether the
// movement is an improvement for that metric; colour follows the kind of thing
// (a kind of wait, a cause) and never its rank; the heat rules bin by rank; and
// every key the page builds from server vocabulary exists in both languages, so
// a new hint, gate kind, origin or stage kind cannot ship as a raw key.
import { describe, expect, test } from 'vitest'
import {
  NODE_KIND,
  PROCESS_CAUSE_GROUPS,
  PROCESS_GATE_KINDS,
  PROCESS_HINT_IDS,
  PROCESS_HINT_SEVERITIES,
  PROCESS_INSIGHT_SCHEDULES,
  PROCESS_MEMBER_ROLES,
  PROCESS_ORIGINS,
  PROCESS_STAGE_KINDS,
  PROCESS_SUBJECT_KINDS,
  PROCESS_SYSTEM_STAGES,
  PROCESS_TEXT_SOURCES,
  PROCESS_UNATTRIBUTED_STAGE,
  PROCESS_UNIT_FILTERS,
  PROCESS_UNIT_STATUSES,
  WORKGROUP_MODES,
  type ProcessStageRow,
  type ProcessStat,
  type ProcessWorkgroupMemberRow,
  type ProcessWorkItemRow,
} from '@agent-workflow/shared'
import { dutyHeatText, dutyHeatValue } from '../src/components/process-metrics/ProcessDuties'
import { memberHeatValue } from '../src/components/process-metrics/ProcessMembers'
import { trendPoints } from '../src/components/process-metrics/ProcessOverview'
import { stageHeatText, stageHeatValue } from '../src/components/process-metrics/ProcessStages'
import {
  cost,
  count,
  decimal,
  duration,
  durationSpread,
  labelText,
  coloredWaits,
  metricDelta,
  percent,
  timeLegend,
  timeParts,
  tokens,
} from '../src/components/process-metrics/processFormat'
import { heatColumn } from '../src/components/process-metrics/processHeat'
import {
  memberName,
  stageName,
  stageTree,
  systemStageMessageKey,
} from '../src/components/process-metrics/processNames'
import {
  PROCESS_VIEWS,
  PROCESS_VIEWS_OF,
  viewOfHintTarget,
} from '../src/components/process-metrics/processSearch'
import i18n from '../src/i18n'
import { processMetricsEn, processMetricsZh } from '../src/i18n/processMetrics'

const t = i18n.getFixedT('zh-CN')
const H = 3_600_000
const stat = (p50: number | null, p90: number | null = p50, n = 3): ProcessStat => ({
  n: p50 === null ? 0 : n,
  p50,
  p90,
  mean: p50,
})

describe('RFC-616 number formats', () => {
  test('no sample is a dash for every kind of number', () => {
    expect([percent(null), decimal(null), tokens(null), cost(null), count(null, 'zh-CN')]).toEqual([
      '—',
      '—',
      '—',
      '—',
      '—',
    ])
    expect(duration(null, t)).toBe('—')
    expect(durationSpread(stat(null), t)).toBe('—')
    // …and a real zero is a zero.
    expect([percent(0), decimal(0), tokens(0), count(0, 'zh-CN')]).toEqual(['0%', '0', '0', '0'])
  })

  test('rates, small decimals and compact token counts', () => {
    expect([percent(0.314), percent(1), percent(0.005)]).toEqual(['31%', '100%', '1%'])
    expect([decimal(2.64), decimal(3), decimal(0.449), decimal(1.25, 2)]).toEqual([
      '2.6',
      '3',
      '0.4',
      '1.25',
    ])
    expect([tokens(950), tokens(12_400), tokens(820_000), tokens(2_900_000)]).toEqual([
      '950',
      '12.4K',
      '820K',
      '2.9M',
    ])
    expect([tokens(1_000), tokens(1_450_000), tokens(31_000_000)]).toEqual(['1K', '1.45M', '31M'])
    expect(cost(41_200_000_000)).toBe('¥41.20')
  })

  test('durations use the product wording; a spread shows the P90 only when it adds something', () => {
    expect(duration(9 * H + 40 * 60_000, t)).toBe('9 小时 40 分')
    expect(durationSpread(stat(H, 3 * H), t)).toBe('1 小时 0 分 / 3 小时 0 分')
    expect(durationSpread(stat(H, 3 * H, 1), t)).toBe('1 小时 0 分')
    expect(durationSpread(stat(H, null), t)).toBe('1 小时 0 分')
  })

  test('a name from an employee type is shown in the reader language', () => {
    const label = { 'zh-CN': '修复检视问题', 'en-US': 'Fix review issues' }
    expect([
      labelText(label, 'zh-CN'),
      labelText(label, 'en-US'),
      labelText('plain', 'en'),
    ]).toEqual(['修复检视问题', 'Fix review issues', 'plain'])
  })
})

describe('RFC-616 change against a baseline', () => {
  test('nothing is shown without a comparison, a baseline, or a movement', () => {
    expect(metricDelta('leadP50', { value: 10, baseline: 12 }, 'off', t)).toBeNull()
    expect(metricDelta('leadP50', undefined, 'period', t)).toBeNull()
    expect(metricDelta('leadP50', { value: 10, baseline: null }, 'period', t)).toBeNull()
    expect(metricDelta('leadP50', { value: null, baseline: 12 }, 'period', t)).toBeNull()
    expect(metricDelta('leadP50', { value: 12, baseline: 12 }, 'period', t)).toBeNull()
  })

  test('whether a movement is good depends on the metric', () => {
    expect(metricDelta('leadP50', { value: 86, baseline: 100 }, 'period', t)).toEqual({
      direction: 'down',
      tone: 'good',
      text: '降 14% · 较上一时段（变好）',
    })
    expect(metricDelta('tokensPerUnit', { value: 120, baseline: 100 }, 'period', t)).toMatchObject({
      direction: 'up',
      tone: 'bad',
      text: '升 20% · 较上一时段（变差）',
    })
    expect(metricDelta('firstPassRate', { value: 0.31, baseline: 0.26 }, 'version', t)).toEqual({
      direction: 'up',
      tone: 'good',
      text: '升 19% · 较分界之前（变好）',
    })
    expect(metricDelta('successRate', { value: 0.7, baseline: 0.9 }, 'period', t)).toMatchObject({
      direction: 'down',
      tone: 'bad',
    })
  })

  test('more or fewer units is not judged; a baseline of zero has no percentage', () => {
    expect(metricDelta('units', { value: 12, baseline: 8 }, 'period', t)).toEqual({
      direction: 'up',
      tone: 'neutral',
      text: '升 50% · 较上一时段',
    })
    expect(metricDelta('blockedRate', { value: 0.2, baseline: 0 }, 'period', t)).toEqual({
      direction: 'up',
      tone: 'bad',
      text: '基线为 0 · 较上一时段（变差）',
    })
  })
})

describe('RFC-616 where the time went', () => {
  test('running, each kind of waiting, and the rest; colour follows the kind of wait', () => {
    const parts = timeParts(
      {
        autoMs: 3 * H,
        waits: [
          { kind: 'review', ms: 4 * H },
          { kind: 'clarify', ms: H },
        ],
        otherMs: 2 * H,
      },
      t,
    )
    expect(parts.map((part) => [part.key, part.label, part.fill, part.amount])).toEqual([
      ['auto', '自动执行', 'cat-1', 3 * H],
      ['review', '等待评审', 'cat-2', 4 * H],
      ['clarify', '等待反问回答', 'cat-3', H],
      ['other', '排队与中断', 'other', 2 * H],
    ])
    expect(parts[1]!.valueText).toBe('4 小时 0 分')
    // The same wait has the same colour whatever else is on the bar.
    expect(
      timeParts({ autoMs: H, waits: [{ kind: 'clarify', ms: H }], otherMs: 0 }, t).map(
        (part) => part.fill,
      ),
    ).toEqual(['cat-1', 'cat-3'])
  })

  test('two kinds of waiting that share a colour are never drawn as two parts', () => {
    const parts = timeParts(
      {
        autoMs: H,
        waits: [
          { kind: 'completion', ms: 2 * H },
          { kind: 'plan-confirm', ms: 3 * H },
        ],
        otherMs: H,
      },
      t,
    )
    expect(parts.map((part) => [part.key, part.fill, part.amount])).toEqual([
      ['auto', 'cat-1', H],
      ['completion', 'cat-4', 2 * H],
      // The later one joins the muted part instead of repeating the colour.
      ['other', 'other', 4 * H],
    ])
    expect(new Set(parts.map((part) => part.fill)).size).toBe(parts.length)
    // Regression: the muted part then holds three hours of waiting on people; calling it
    // "queueing and interruptions" alone would hide them.
    expect(parts.at(-1)!.label).toBe('排队、中断与其他等待')
  })

  test('bars that share a legend share one colour assignment, and the legend lists every part any of them shows', () => {
    // Regression: the legend of the task list was built from its first row, so a kind of waiting
    // only later rows had was drawn without ever being named.
    const rows = [
      { autoMs: H, waits: [], otherMs: H },
      { autoMs: H, waits: [{ kind: 'clarify' as const, ms: 2 * H }], otherMs: 0 },
      { autoMs: H, waits: [{ kind: 'review' as const, ms: H }], otherMs: H },
      // A blocked digital-employee case: `blocked` shares its colour with `clarify`.
      { autoMs: H, waits: [{ kind: 'blocked' as const, ms: 3 * H }], otherMs: 0 },
    ]
    const scheme = coloredWaits(rows)
    expect([...scheme.colored]).toEqual(['review', 'clarify'])
    expect(scheme.folds).toBe(true)
    expect(timeLegend(rows, t, scheme).map((part) => [part.key, part.label, part.fill])).toEqual([
      ['auto', '自动执行', 'cat-1'],
      ['review', '等待评审', 'cat-2'],
      ['clarify', '等待反问回答', 'cat-3'],
      ['other', '排队、中断与其他等待', 'other'],
    ])
    // The blocked row draws its three hours in the muted part: never in clarify's colour.
    expect(
      timeParts(rows[3]!, t, scheme).map((part) => [part.key, part.fill, part.amount]),
    ).toEqual([
      ['auto', 'cat-1', H],
      ['other', 'other', 3 * H],
    ])
    // On its own the same row would have coloured `blocked`: the scheme is per view.
    expect(timeParts(rows[3]!, t).map((part) => part.key)).toEqual(['auto', 'blocked'])
    // Nothing folded: the muted part keeps its plain name.
    expect(timeLegend(rows.slice(0, 3), t).at(-1)!.label).toBe('排队与中断')
    expect(timeLegend([], t)).toEqual([])
  })

  test('a unit without a running-time record has no running part', () => {
    expect(
      timeParts({ autoMs: null, waits: [], otherMs: null }, t).map((part) => part.key),
    ).toEqual(['other'])
  })
})

describe('RFC-616 heat', () => {
  test('levels come from rank, with the lowest and highest value for the legend', () => {
    expect(heatColumn([10, null, 500, 20, 10])).toEqual({
      levels: [1, 0, 5, 3, 1],
      min: 10,
      max: 500,
    })
    expect(heatColumn([null, null])).toEqual({ levels: [0, 0], min: null, max: null })
    // One distinct value sits in the middle, not at either end.
    expect(heatColumn([7, 7]).levels).toEqual([3, 3])
  })

  const stage = (over: Partial<ProcessStageRow>): ProcessStageRow =>
    ({
      key: 'design',
      label: 'Design',
      kind: 'agent-single',
      parentKey: null,
      order: 0,
      removed: false,
      units: 3,
      runsPerUnit: 1,
      durationMs: stat(H),
      tokensPerUnit: 1_000,
      costNanoPerUnit: 10,
      tokenShare: 0.5,
      failureRate: 0.25,
      autoRetryRate: 0,
      topFailureCode: null,
      topFailureShare: null,
      rejectRate: 0.6,
      clarifyRate: null,
      reworkTokenShare: null,
      gateRoundsPerUnit: null,
      gateWaitMsPerUnit: null,
      gateFirstPassRate: null,
      loop: null,
      fanout: null,
      baseline: null,
      ...over,
    }) as ProcessStageRow

  test('a workflow node is coloured by the chosen metric, or not at all where it does not apply', () => {
    const node = stage({})
    expect(stageHeatValue(node, 'duration')).toBe(H)
    expect(stageHeatValue(node, 'tokens')).toBe(1_000)
    expect(stageHeatValue(node, 'wait')).toBeNull()
    expect(stageHeatValue(node, 'reject')).toBe(0.6)
    expect(stageHeatValue(node, 'failure')).toBe(0.25)
    // A node that spent no tokens (a script, a review) is not the "cheapest agent".
    expect(stageHeatValue(stage({ tokensPerUnit: 0 }), 'tokens')).toBeNull()
    expect(stageHeatValue(stage({ gateWaitMsPerUnit: 2 * H }), 'wait')).toBe(2 * H)
    expect([
      stageHeatText(H, 'duration', t),
      stageHeatText(1_450_000, 'tokens', t),
      stageHeatText(0.6, 'reject', t),
      stageHeatText(null, 'failure', t),
    ]).toEqual(['1 小时 0 分', '1.45M', '60%', '—'])
  })

  const member = (over: Partial<ProcessWorkgroupMemberRow>): ProcessWorkgroupMemberRow => ({
    key: 'member:m-a',
    name: 'coder-a',
    role: 'member-agent',
    roleNote: null,
    assignmentsPerUnit: 5.2,
    durationMs: stat(24 * 60_000),
    tokensPerUnit: 940_000,
    failureRate: 0.08,
    protocolRetryRate: 0.04,
    clarifyPerUnit: 0.6,
    deliveryMs: stat(null),
    ...over,
  })

  test("a human member's delivery time is never ranked with agents' running time", () => {
    const human = member({
      role: 'member-human',
      durationMs: stat(null),
      deliveryMs: stat(2 * H),
      tokensPerUnit: null,
    })
    expect(memberHeatValue(member({}), 'duration')).toBe(24 * 60_000)
    expect(memberHeatValue(human, 'duration')).toBeNull()
    expect(memberHeatValue(human, 'tokens')).toBeNull()
    expect(memberHeatValue(human, 'assignments')).toBe(5.2)
  })

  const item = (over: Partial<ProcessWorkItemRow>): ProcessWorkItemRow => ({
    key: 'implement',
    label: { 'zh-CN': '分析与实现', 'en-US': 'Implement' },
    kind: 'work-item-tool',
    regionId: 'delivery',
    laneId: 'main',
    order: 0,
    rework: false,
    units: 4,
    roundsPerUnit: 1.6,
    roundMs: stat(52 * 60_000),
    attemptsPerRound: 1.2,
    tokensPerUnit: 1_610_000,
    failureRate: 0.09,
    autoRetryRate: 0.1,
    gateRoundsPerUnit: null,
    gateWaitMsPerUnit: null,
    ...over,
  })

  test('a work item is coloured by time per round, rounds, tokens or failures', () => {
    const work = item({})
    expect(dutyHeatValue(work, 'duration')).toBe(52 * 60_000)
    expect(dutyHeatValue(work, 'rounds')).toBe(1.6)
    expect(dutyHeatValue(work, 'tokens')).toBe(1_610_000)
    expect(dutyHeatValue(work, 'failure')).toBe(0.09)
    // System work items spend no tokens: not applicable rather than "cheapest".
    expect(dutyHeatValue(item({ tokensPerUnit: 0 }), 'tokens')).toBeNull()
    expect([
      dutyHeatText(1.6, 'rounds', t),
      dutyHeatText(52 * 60_000, 'duration', t),
      dutyHeatText(null, 'tokens', t),
    ]).toEqual(['1.6 轮', '52 分钟', '—'])
  })
})

describe('RFC-616 trend', () => {
  const trend = [
    {
      week: '2026-10-05',
      units: 3,
      leadP50: 12 * H,
      tokensPerUnit: 3_400_000,
      firstPassRate: 0.22,
    },
    { week: '2026-10-12', units: 0, leadP50: null, tokensPerUnit: null, firstPassRate: null },
    { week: '2026-10-19', units: 5, leadP50: 9 * H, tokensPerUnit: 2_900_000, firstPassRate: 0.31 },
  ]

  test('lead time is drawn in whole hours (or days, or minutes), never in milliseconds', () => {
    const hours = trendPoints(trend, 'leadP50', t)
    expect(hours.points.map((point) => [point.label, point.value, point.valueText])).toEqual([
      ['10-05', 12, '12 小时 0 分'],
      ['10-12', null, '—'],
      ['10-19', 9, '9 小时 0 分'],
    ])
    expect(hours.formatTick(15)).toBe('15 小时')
    const days = trendPoints([{ ...trend[0]!, leadP50: 72 * H }], 'leadP50', t)
    expect([days.points[0]!.value, days.formatTick(3)]).toEqual([3, '3 天'])
    const minutes = trendPoints([{ ...trend[0]!, leadP50: 30 * 60_000 }], 'leadP50', t)
    expect([minutes.points[0]!.value, minutes.formatTick(30)]).toEqual([30, '30 分'])
  })

  test('tokens and the first-pass rate keep their own units; a week without a sample stays empty', () => {
    const perUnit = trendPoints(trend, 'tokensPerUnit', t)
    expect(perUnit.points.map((point) => point.valueText)).toEqual(['3.4M', '—', '2.9M'])
    expect(perUnit.formatTick(4_000_000)).toBe('4M')
    const rate = trendPoints(trend, 'firstPassRate', t)
    expect(rate.points.map((point) => [point.value, point.valueText])).toEqual([
      [22, '22%'],
      [null, '—'],
      [31, '31%'],
    ])
    expect(rate.formatTick(40)).toBe('40%')
  })
})

describe('RFC-616 names', () => {
  test('platform work and unattributed consumption get product names; canvas nodes keep theirs', () => {
    expect(
      PROCESS_SYSTEM_STAGES.map((key) =>
        stageName({ key, label: key, kind: 'system' }, t, 'zh-CN'),
      ),
    ).toEqual(['仓库准备', '提交与推送', '合并冲突处理', '动态编排', '其它系统工作'])
    expect(
      stageName(
        { key: PROCESS_UNATTRIBUTED_STAGE, label: 'unattributed', kind: 'unattributed' },
        t,
        'zh-CN',
      ),
    ).toBe('未归属的消耗')
    expect(stageName({ key: 'design', label: 'Design', kind: 'agent-single' }, t, 'zh-CN')).toBe(
      'Design',
    )
    // A removed node keeps its id as its name.
    expect(stageName({ key: 'old', label: 'old', kind: 'unattributed' }, t, 'zh-CN')).toBe('old')
    // A colon in a key would be read as a message namespace.
    expect(systemStageMessageKey('system:repo-prep')).toBe('system-repo-prep')
  })

  test('a stage the server could not name is called by its role, never by its key', () => {
    // Regression: the task detail of a workgroup showed the raw keys `member-human` and `leader`.
    expect(
      stageName({ key: 'member-human', label: 'member-human', kind: 'member-human' }, t, 'zh-CN'),
    ).toBe('人类成员')
    expect(stageName({ key: 'leader', label: 'leader', kind: 'leader' }, t, 'zh-CN')).toBe('Leader')
    expect(stageName({ key: 'members', label: 'members', kind: 'member-agent' }, t, 'zh-CN')).toBe(
      'Agent 成员',
    )
    // A real name wins.
    expect(
      stageName({ key: 'member:m1', label: 'coder-a', kind: 'member-agent' }, t, 'zh-CN'),
    ).toBe('coder-a')
  })

  test('stages read as a tree: a wrapper before what runs inside it, at any depth', () => {
    // Regression: rows came in the order the definition stores its nodes, where a wrapper drawn
    // around existing nodes sits after them, and nesting was one level deep at most.
    const stage = (key: string, parentKey: string | null = null) => ({ key, parentKey })
    const rows = stageTree([
      stage('design'),
      stage('code', 'loop'),
      stage('test', 'loop'),
      stage('loop', 'git'),
      stage('git'),
      stage('report'),
    ])
    expect(rows.map((row) => `${'  '.repeat(row.depth)}${row.stage.key}`)).toEqual([
      'design',
      'git',
      '  loop',
      '    code',
      '    test',
      'report',
    ])
    // A parent that is not listed leaves the stage at the top; nothing is ever dropped.
    expect(
      stageTree([stage('a', 'gone'), stage('b', 'b')]).map((row) => [row.stage.key, row.depth]),
    ).toEqual([
      ['a', 0],
      ['b', 0],
    ])
    // Two stages naming each other still get a row each.
    expect(
      stageTree([stage('x', 'y'), stage('y', 'x')])
        .map((row) => row.stage.key)
        .sort(),
    ).toEqual(['x', 'y'])
    expect(stageTree([])).toEqual([])
  })

  test('a member the viewer may not name is called by its role', () => {
    expect(memberName({ key: 'leader', name: 'planner', role: 'leader' }, t)).toBe('planner')
    expect(memberName({ key: 'member-human', name: null, role: 'member-human' }, t)).toBe(
      '人类成员',
    )
    expect(memberName({ key: 'unattributed', name: 'x', role: 'unattributed' }, t)).toBe(
      '归不到具体成员',
    )
  })
})

describe('RFC-616 views', () => {
  test('each subject kind has its own views, all of them known to the URL', () => {
    expect(PROCESS_VIEWS_OF).toEqual({
      workflow: ['overview', 'stages', 'gates', 'units', 'insights'],
      workgroup: ['overview', 'rounds', 'members', 'gates', 'units', 'insights'],
      'digital-employee': ['overview', 'duties', 'gates', 'units', 'insights'],
    })
    for (const views of Object.values(PROCESS_VIEWS_OF))
      for (const view of views) expect(PROCESS_VIEWS).toContain(view)
  })

  test('a hint points at a view that exists for the subject kind', () => {
    expect(viewOfHintTarget('workflow', 'stages')).toBe('stages')
    expect(viewOfHintTarget('digital-employee', 'stages')).toBe('duties')
    expect(viewOfHintTarget('workgroup', 'members')).toBe('members')
    expect(viewOfHintTarget('workgroup', 'rounds')).toBe('rounds')
    expect(viewOfHintTarget('workflow', 'gates')).toBe('gates')
    // A workflow has no members view: the hint then stays on the overview.
    expect(viewOfHintTarget('workflow', 'members')).toBe('overview')
    expect(viewOfHintTarget('digital-employee', 'overview')).toBe('overview')
  })
})

describe('RFC-616 copy', () => {
  const keysOf = (value: unknown, prefix = ''): string[] =>
    typeof value === 'string'
      ? [prefix]
      : Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
          keysOf(child, prefix === '' ? key : `${prefix}.${key}`),
        )
  const zh = new Set(keysOf(processMetricsZh))
  const has = (key: string) => zh.has(key)

  test('both languages have exactly the same keys, and none is empty', () => {
    expect(keysOf(processMetricsEn).sort()).toEqual([...zh].sort())
    expect(zh.size).toBeGreaterThan(400)
    const blank = (tree: unknown) =>
      keysOf(tree).filter((key) => {
        const value = key
          .split('.')
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree)
        return typeof value !== 'string' || value.trim() === ''
      })
    expect(blank(processMetricsZh)).toEqual([])
    expect(blank(processMetricsEn)).toEqual([])
  })

  test('every key built from server vocabulary exists', () => {
    const missing: string[] = []
    const need = (key: string) => {
      if (!has(key)) missing.push(key)
    }
    for (const kind of PROCESS_SUBJECT_KINDS) {
      for (const group of [
        'kind',
        'unit',
        'back',
        'noSubject',
        'deleted',
        'partial',
        'scope.all',
        'scope.own',
        'view.units',
        'list.caption',
        'list.empty',
        'list.foot',
        'tile.units',
        'tile.lead',
        'units.foot',
        'units.col.name',
      ])
        need(`${group}.${kind}`)
    }
    for (const id of PROCESS_HINT_IDS) {
      need(`hint.${id}.title`)
      need(`hint.${id}.body`)
    }
    for (const severity of PROCESS_HINT_SEVERITIES) need(`hints.severity.${severity}`)
    for (const kind of PROCESS_GATE_KINDS) {
      need(`wait.${kind}`)
      need(`gate.${kind}`)
    }
    for (const origin of PROCESS_ORIGINS) need(`origin.${origin}`)
    for (const cause of PROCESS_CAUSE_GROUPS) need(`cause.${cause}`)
    for (const kind of PROCESS_STAGE_KINDS) need(`stageKind.${kind}`)
    for (const stage of [...PROCESS_SYSTEM_STAGES, PROCESS_UNATTRIBUTED_STAGE])
      need(`systemStage.${systemStageMessageKey(stage)}`)
    for (const mode of WORKGROUP_MODES) need(`mode.${mode}`)
    for (const role of PROCESS_MEMBER_ROLES) need(`member.${role}`)
    for (const source of PROCESS_TEXT_SOURCES) {
      need(`themes.source.${source}`)
      need(`themes.items.${source}`)
    }
    for (const schedule of PROCESS_INSIGHT_SCHEDULES) need(`themes.schedule.${schedule}`)
    for (const filter of PROCESS_UNIT_FILTERS) need(`units.filter.${filter}`)
    for (const status of PROCESS_UNIT_STATUSES) need(`status.${status}`)
    for (const view of PROCESS_VIEWS) if (view !== 'units') need(`view.${view}`)
    expect(missing).toEqual([])
    // The stage kinds include every canvas node kind.
    for (const kind of NODE_KIND) expect(PROCESS_STAGE_KINDS).toContain(kind)
  })

  test('the alternative sentences of a hint exist where its numbers can be missing', () => {
    expect(has('hint.wait-dominant.bodyPlain')).toBe(true)
    expect(has('hint.auto-retry-high.bodyPlain')).toBe(true)
  })

  test('the namespace is mounted in both languages', () => {
    expect(i18n.getFixedT('zh-CN')('processMetrics.entry')).toBe('查看度量')
    expect(i18n.getFixedT('en-US')('processMetrics.entry')).toBe('View metrics')
    expect(i18n.getFixedT('zh-CN')('runObservability.tabProcess')).toBe('过程度量')
    expect(i18n.getFixedT('en-US')('runObservability.kind.process-insight')).toBe(
      'Process theme analysis',
    )
  })
})
