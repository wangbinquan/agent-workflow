// Entirely synthetic design-review data. Prices are illustrative, not provider quotes.
export type Usage = { input: number; read: number; write: number; output: number }
export type Attempt = {
  id: string
  agent: string
  activity: string
  model: string
  start: number
  end: number
  status: 'done' | 'failed' | 'running' | 'interrupted' | 'canceled'
  retry: number
  round: number
  usage: Usage | null
  partial?: boolean
  critical?: boolean
}
export type Task = {
  id: string
  name: string
  repo: string
  source: string
  status: string
  ago: number
  duration: number
  queue: number
  human: number
  attempts: Attempt[]
}
export const SNAPSHOT = new Date('2026-09-28T15:36:00+08:00').getTime()
export const agents = [
  { id: 'lead', name: 'Orchestrator', role: '计划与统筹', revision: 'v12' },
  { id: 'research', name: 'Research Analyst', role: '方案与依赖分析', revision: 'v4' },
  { id: 'backend', name: 'Backend Engineer', role: '代码实现', revision: 'v8' },
  { id: 'test', name: 'Test Engineer', role: '回归验证', revision: 'v6' },
  { id: 'security', name: 'Security Reviewer', role: '权限审查', revision: 'v3' },
  { id: 'review', name: 'Code Reviewer', role: '结果评审', revision: 'v5' },
]
export const models = [
  { id: 'reasoner', name: 'Reasoner Large', input: 8, output: 32, read: 0.8, write: 10 },
  { id: 'coder', name: 'Code Balanced', input: 4, output: 16, read: 0.4, write: 5 },
  { id: 'fast', name: 'Review Fast', input: 1, output: 4, read: 0.1, write: 1.25 },
]
export const total = (u: Usage | null) => (u ? u.input + u.read + u.write + u.output : 0)
export const cost = (r: Attempt) => {
  const m = models.find((x) => x.id === r.model)!
  return r.usage
    ? (r.usage.input * m.input +
        r.usage.output * m.output +
        r.usage.read * m.read +
        r.usage.write * m.write) /
        1e6
    : 0
}
export const sumUsage = (rs: Attempt[]): Usage =>
  rs.reduce(
    (a, r) => ({
      input: a.input + (r.usage?.input ?? 0),
      read: a.read + (r.usage?.read ?? 0),
      write: a.write + (r.usage?.write ?? 0),
      output: a.output + (r.usage?.output ?? 0),
    }),
    { input: 0, read: 0, write: 0, output: 0 },
  )
export const isPartial = (rs: Attempt[]) => rs.some((r) => !r.usage || r.partial)
const u = (input: number, output: number, read: number, write: number): Usage => ({
  input,
  output,
  read,
  write,
})
export const mainTask: Task = {
  id: 'RUN-0928-018',
  name: '认证模块重构与回归验证',
  repo: 'agent-workflow',
  source: '工作组',
  status: 'done',
  ago: 1.5,
  duration: 1242,
  queue: 15,
  human: 120,
  attempts: [
    {
      id: 'run-plan-01',
      agent: 'lead',
      activity: '任务拆解',
      model: 'reasoner',
      start: 15,
      end: 150,
      status: 'done',
      retry: 0,
      round: 1,
      usage: u(5000, 1000, 7000, 1000),
      critical: true,
    },
    {
      id: 'run-research-01',
      agent: 'research',
      activity: '依赖分析',
      model: 'reasoner',
      start: 150,
      end: 450,
      status: 'done',
      retry: 0,
      round: 1,
      usage: u(15000, 3000, 12000, 1000),
      critical: true,
    },
    {
      id: 'run-backend-01',
      agent: 'backend',
      activity: '实现认证接口',
      model: 'coder',
      start: 150,
      end: 620,
      status: 'failed',
      retry: 0,
      round: 1,
      usage: u(12000, 3000, 10000, 0),
    },
    {
      id: 'run-backend-02',
      agent: 'backend',
      activity: '修复并重新执行',
      model: 'coder',
      start: 630,
      end: 930,
      status: 'done',
      retry: 1,
      round: 1,
      usage: u(21000, 6000, 18000, 2000),
    },
    {
      id: 'run-test-01',
      agent: 'test',
      activity: '合约与回归验证',
      model: 'coder',
      start: 450,
      end: 960,
      status: 'done',
      retry: 0,
      round: 1,
      usage: u(18000, 4000, 20000, 3000),
      critical: true,
    },
    {
      id: 'run-security-01',
      agent: 'security',
      activity: '访问边界审查',
      model: 'reasoner',
      start: 450,
      end: 720,
      status: 'done',
      retry: 0,
      round: 1,
      usage: u(8000, 3000, 12000, 1000),
    },
    {
      id: 'run-review-01',
      agent: 'review',
      activity: '最终评审',
      model: 'fast',
      start: 1080,
      end: 1140,
      status: 'done',
      retry: 0,
      round: 2,
      usage: u(4000, 1500, 5000, 500),
      critical: true,
    },
    {
      id: 'run-plan-02',
      agent: 'lead',
      activity: '整理交付',
      model: 'reasoner',
      start: 1140,
      end: 1242,
      status: 'done',
      retry: 0,
      round: 2,
      usage: u(3000, 1000, 5000, 0),
      critical: true,
    },
  ],
}
const one = (
  id: string,
  agent: string,
  end: number,
  usage: Usage | null,
  status: Attempt['status'] = 'done',
): Attempt => ({
  id,
  agent,
  activity: '执行任务',
  model: agent === 'review' ? 'fast' : 'coder',
  start: 8,
  end,
  usage,
  status,
  retry: 0,
  round: 1,
})
export const tasks: Task[] = [
  mainTask,
  {
    id: 'RUN-0928-017',
    name: '资源中心筛选与导航优化',
    repo: 'CrewStation',
    source: '工作流',
    status: 'running',
    ago: 0.25,
    duration: 900,
    queue: 8,
    human: 0,
    attempts: [
      {
        ...one('run-ui-01', 'backend', 900, u(16000, 4200, 20000, 1000), 'running'),
        partial: true,
      },
      one('run-ui-review', 'review', 310, u(5000, 1800, 7000, 500)),
    ],
  },
  {
    id: 'RUN-0928-016',
    name: '集群资源配额方案评审',
    repo: 'CrewStation',
    source: '工作组',
    status: 'awaiting_human',
    ago: 2.2,
    duration: 7920,
    queue: 8,
    human: 7220,
    attempts: [
      one('run-quota-plan', 'lead', 250, u(9000, 2100, 11000, 1000)),
      { ...one('run-quota-review', 'security', 700, u(11000, 3200, 16000, 1500)), start: 250 },
    ],
  },
  {
    id: 'RUN-0928-015',
    name: '数据库迁移兼容性检查',
    repo: 'agent-workflow',
    source: '工作流',
    status: 'failed',
    ago: 3,
    duration: 610,
    queue: 8,
    human: 0,
    attempts: [
      one('run-migrate-01', 'backend', 300, u(6000, 2400, 9000, 1000), 'failed'),
      { ...one('run-migrate-02', 'test', 610, null, 'failed'), start: 310 },
    ],
  },
  {
    id: 'RUN-0928-014',
    name: 'API 文档与示例同步',
    repo: 'agent-workflow',
    source: '单 Agent',
    status: 'done',
    ago: 4,
    duration: 240,
    queue: 8,
    human: 0,
    attempts: [one('run-docs-01', 'research', 240, u(4500, 1500, 5000, 1000))],
  },
  {
    id: 'RUN-0928-013',
    name: '开发会话恢复回归',
    repo: 'CrewStation',
    source: '工作流',
    status: 'done',
    ago: 5.5,
    duration: 720,
    queue: 8,
    human: 0,
    attempts: [
      one('run-session-test', 'test', 650, u(21000, 5000, 30000, 2000)),
      { ...one('run-session-review', 'review', 720, u(10000, 2400, 11000, 600)), start: 650 },
    ],
  },
  {
    id: 'RUN-0928-012',
    name: '工作组编排恢复检查',
    repo: 'agent-workflow',
    source: '工作组',
    status: 'interrupted',
    ago: 7,
    duration: 430,
    queue: 8,
    human: 0,
    attempts: [one('run-orphan-01', 'lead', 430, null, 'interrupted')],
  },
  {
    id: 'RUN-0928-011',
    name: '代码变更影响分析',
    repo: 'agent-workflow',
    source: '单 Agent',
    status: 'canceled',
    ago: 8,
    duration: 188,
    queue: 8,
    human: 0,
    attempts: [one('run-canceled-01', 'review', 188, u(6000, 1600, 8000, 400), 'canceled')],
  },
  ...Array.from(
    { length: 6 },
    (_, i): Task => ({
      id: `RUN-092${7 - i}-009`,
      name: ['工作流运行例行回归', '任务调度依赖审查', '资源中心访问评审'][i % 3],
      repo: i % 2 ? 'CrewStation' : 'agent-workflow',
      source: i % 2 ? '工作组' : '工作流',
      status: i === 4 ? 'failed' : 'done',
      ago: 26 + i * 24,
      duration: 600 + i * 100,
      queue: 8,
      human: 0,
      attempts: [
        one(
          `run-history-${i}-1`,
          'backend',
          420 + i * 70,
          u(10000 + i * 1800, 3000 + i * 200, 15000 + i * 2500, 1000),
          i === 4 ? 'failed' : 'done',
        ),
        {
          ...one(
            `run-history-${i}-2`,
            'review',
            600 + i * 100,
            u(5000 + i * 500, 2000, 8000, 500),
            i === 4 ? 'failed' : 'done',
          ),
          start: 420 + i * 70,
        },
      ],
    }),
  ),
]
export const statusNames: Record<string, string> = {
  done: '已完成',
  failed: '失败',
  running: '运行中',
  awaiting_human: '待人工',
  interrupted: '已中断',
  canceled: '已取消',
}
export const num = (n: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)
export const short = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(2)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n % 1000 ? 1 : 0)}K`
      : `${n}`
export const dur = (s: number) =>
  s >= 3600
    ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
    : s >= 60
      ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
      : `${Math.round(s)}s`
export const money = (v: number) =>
  new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 4,
    maximumFractionDigits: 6,
  }).format(v)
export const startTime = (t: Task) => SNAPSHOT - t.ago * 3600000
export const percentile = (values: number[], q: number) =>
  values.length
    ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)]
    : null
