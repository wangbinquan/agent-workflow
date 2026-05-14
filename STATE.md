# 当前执行状态

> 这份文件让新 session 能立刻接上进度。每完成一批 issue 就更新它，与远端同步推送。

**最近更新**：2026-05-14

---

## 路线图全局视图

文档：
- `design/proposal.md` — 产品规格（权威）
- `design/design.md` — 技术设计（权威）
- `design/plan.md` — 81 个 issue 的实施计划，按 M0 → M5 排
- `CLAUDE.md` — 仓约定与索引

```
M0 准备       [5/5  ✅]
M1 骨架       [9/18 🚧]  ← 当前位置
M2 编辑器     [0/16]
M3 编排核心   [0/14]
M4 高级编排   [0/11]
M5 打磨       [0/12]
```

---

## 已完成 issue（13 个）

### M0 全部完成（5/5）

| ID | 标题 | 关键产出 |
| --- | --- | --- |
| P-0-01 | opencode 兼容性验证 | 1.14.25 上 4 个隔离实验全过；最低版本 1.14.0 写入 `design.md` §18 |
| P-0-02 | monorepo 初始化 | Bun workspaces / `packages/{frontend,backend,shared}` / tsconfig / prettier |
| P-0-03 | CI skeleton | `.github/workflows/ci.yml`（matrix: ubuntu+macos，跑 format/lint/typecheck/test） |
| P-0-04 | ESLint + Prettier | `eslint.config.js` flat config + 跨包 import 边界规则（backend↮frontend 互斥） |
| P-0-05 | Drizzle schema | 8 张表完整定义 + WAL/NORMAL/busy_timeout + 启动时自动 migrate + in-memory 测试辅助 |

### M1 已完成（9/18）

| ID | 标题 | 关键产出 |
| --- | --- | --- |
| P-1-01 | Daemon CLI start + flock 单实例 | `start` 前台启动 / PID 文件 flock / SIGTERM graceful / `.daemon.info` 写盘 |
| P-1-02 | Token 鉴权 | 32 字节 hex token 自动生成（mode 0600）+ Hono middleware（Bearer 或 `?token=`）+ 常时比较 |
| P-1-03 | Config load/save + REST | `~/.agent-workflow/config.json` 完整 zod schema + 默认值回填 + atomic write；GET/PUT `/api/config` |
| P-1-04 | /health + opencode 版本探测 | 启动时 `opencode --version` semver 检查；`/health` 返 `{ok, opencodeVersion, dbVersion, uptime, runningTasks}` |
| P-1-05 | CLI 子命令 stop/status/doctor/config/migrate | 完整工具集；status 调 /health；doctor 6 项检查 |
| P-1-06 | 结构化 logger | level + ts + service + child + stdout + `~/.agent-workflow/logs/daemon.log`（10MB×5 rotate） |
| P-1-07 | API 错误统一 schema | `DomainError / NotFoundError(404) / ValidationError(422) / ConflictError(409) / UnauthorizedError(401)` + Hono `onError` |
| P-1-08 | Agents CRUD | 6 个 endpoint；DB 是真值源；frontmatter 字段拆 DB 列；JSON 字段在 service 层 marshal；删除/重命名引用拒绝 |
| P-1-09 | Skills CRUD + 文件树 | fs 真值源；managed + external 两种 source；SKILL.md frontmatter 通过 `yaml` 包解析；safeJoin 路径遍历防御；引用拒绝；12 个 endpoint |

---

## 测试积累

后端测试 ~90 个 case，全部用 `bun test` 跑（in-memory SQLite，每 case <100ms）。daemon 启动相关测试 spawn 子进程，~1-2s 每 case。

测试文件：
```
packages/backend/tests/
├── agents.test.ts          (17 case)
├── auth-token.test.ts      (11 case)
├── cli.test.ts             (13 case)
├── config.test.ts          (9 case)
├── daemon-start.test.ts    (5 case，含 e2e daemon spawn)
├── db.test.ts              (2 case)
├── errors.test.ts          (6 case)
├── log.test.ts             (7 case)
├── lock.test.ts            (6 case，跨进程 fork)
├── opencode-version.test.ts (4 case)
├── skills.test.ts          (22 case)
└── smoke.test.ts           (1 case)
```

---

## 后端代码地图

```
packages/backend/src/
├── main.ts                 # CLI 入口；路由所有子命令
├── server.ts               # Hono app 工厂；接 AppDeps；挂载路由
├── auth/token.ts           # token 生成 / Hono middleware / 常时比较
├── cli/
│   ├── start.ts            # daemon 入口；装配 lock+log+config+opencode probe+db+token+http+signals
│   ├── stop.ts             # 读 lock PID → SIGTERM → 等 lock 文件 unlinked
│   ├── status.ts           # 读 lock + daemon.info → 调 /health
│   ├── doctor.ts           # 6 项健康检查
│   ├── config-cli.ts       # config get/set
│   └── migrate.ts          # 手动跑 drizzle migration
├── config/index.ts         # loadConfig / applyConfigPatch（atomic write）
├── db/
│   ├── client.ts           # openDb + createInMemoryDb（auto-migrate）
│   └── schema.ts           # 8 张表 Drizzle 定义
├── routes/
│   ├── health.ts
│   ├── config.ts
│   ├── agents.ts
│   └── skills.ts
├── services/
│   ├── agent.ts            # Agents CRUD
│   └── skill.ts            # Skills CRUD + 文件树 + frontmatter
└── util/
    ├── errors.ts           # DomainError 家族 + Hono onError handler
    ├── frontmatter.ts      # YAML frontmatter 解析（用 yaml 包）
    ├── lock.ts             # 单实例 PID 文件锁
    ├── log.ts              # 结构化 logger
    ├── opencode.ts         # 版本探测 + semver 比较 + 最低版本常量
    ├── paths.ts            # Paths.{db,lock,daemonInfo,...}
    └── safePath.ts         # 路径遍历防御
```

---

## 下一步：M1 剩余 9 个 issue

按 `design/plan.md` 依赖顺序，**下一轮推荐做 P-1-10 + P-1-12**（独立可并行）：

| ID | 标题 | 依赖 | 复杂度 |
| --- | --- | --- | --- |
| **P-1-10** | 仓最近列表 + `/api/repos/{recent,refs,files}` | P-1-07, P-0-05 | M |
| **P-1-11** | Workflow CRUD（基础，不含 5 项校验） | P-0-05, P-1-07 | M |
| **P-1-12** | Worktree helper（`git worktree add/remove` + slug） | P-0-05 | S |
| P-1-13 | opencode 子进程 spawn + envelope 解析（runner） | P-0-05, P-1-09, P-1-12 | L |
| P-1-14 | Task 启动 + DAG 调度（线性版本） | P-1-08, P-1-11, P-1-12, P-1-13 | L |
| P-1-15 | Cancel task | P-1-14 | S |
| P-1-16 | 前端骨架：路由 / Layout / API client | P-0-02 | M |
| P-1-17 | 前端 Agents / Skills 列表 + 编辑界面 | P-1-08, P-1-09, P-1-16 | L |
| P-1-18 | 前端 Tasks 简化版（无编辑器） | P-1-14, P-1-16 | M |

M1 验收：跑通 `创 agent → 创 skill → 通过 API/curl 创线性 workflow → 启 task → 看 opencode 子进程跑完 → 输出 envelope 解析为 ports`。

---

## 已知 caveat / 后续 tech debt

1. **opencode 最低版本** 现在保守地写为 1.14.0（P-0-01 仅在 1.14.25 实测过）。如需放宽，下沉到更老版本 bisect 即可（design.md §18 #1）。
2. **drizzle-orm 0.36.4 的 extraConfig 用对象形式**（`(t) => ({...})`）；如果未来升 ≥0.39，数组形式才支持，schema.ts 需要回看。
3. **bun.lock 文本格式** Bun 现在用 text JSON 而非二进制 bun.lockb。`.gitignore` 留 `bun.lockb` 仅为防御性。
4. **路由 `mountSkillRoutes` 在 mount 时捕获 `Paths.root`**，所以测试里改 `AGENT_WORKFLOW_HOME` 必须在 `createApp` 之前。如果未来要支持 daemon 运行中修改 home（不会），需要把它放到 AppDeps。
5. **没装 `Bun.Subprocess` 类型注解**（一些测试里）— Bun 类型签名版本敏感，让 TS 推断更稳。
6. **Skill 文件全是 utf-8** — v1 不支持二进制；plan.md §18 #8 已记录。
7. **eslint-plugin-react 在 flat config 下的 plugin recommended 没用**（仅手动添加 hooks 规则）—— frontend 实质工作开始（P-1-16）时再回看。

---

## Git 状态

- 远端：`git@github.com:wangbinquan/agent-workflow.git`
- 分支：`main`
- 当前提交：见仓最新 commit（每次本文件更新时贴回这里）
- CI：M0 (P-0-03) 已经配，但还没在 PR 流程中触发过

---

## 给新 session 的 onboarding 清单

1. 读 `CLAUDE.md`、本文件、`design/plan.md`
2. `bun install` → `bun test` 验证开发环境
3. 看 `TaskList`（如果当前 session 有持久任务，否则按本文件"下一步"接力）
4. 选 issue → 创 TaskCreate → 进 in_progress
5. 完成一批 issue 后：commit + push + 更新本文件
