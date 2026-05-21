# RFC-054 — 测试防护加固：真实 opencode + 崩溃恢复 + 多用户协作 + 视觉/a11y/perf 全套（产品视角）

## 背景

agent-workflow 已落地 53 个 RFC、~370 个生产源文件、~600 个单测、6 个
Playwright spec（backend 263 / frontend 280 / shared 50 / e2e 6）。每个
RFC 自己带回归测试（CLAUDE.md §Test-with-every-change 已强制），**单点
稳健性**已经很好。

但项目进入"M5 已 ready 发版 + 仍持续重构"的阶段，用户实际反馈"随着
开发推进，越来越多过去的功能被改坏"。系统性评估后定位的根因：

> **代码层不变量（lifecycle / envelope / migration）防护扎实，但系统层
> 用户骨牌（真实 opencode × 真实浏览器 × 多用户 × 崩溃恢复 × 升级兼容）
> 防护稀疏**。

具体地，15 个测试盲点按 blast × coverage 二维评估：

| #    | 盲点                                                         | 风险                                                                  |
| ---- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| B-1  | **真实 opencode 从未在 CI 跑**（全部走 `stub-opencode*.sh`） | 协议变更 / opencode 升级直接生产暴雷（RFC-053 后续 1.14.51 PWD 教训） |
| B-2  | xyflow 编辑器真实拖拽 / 缩放 / 多选 0 e2e                    | 画布交互回归只能人眼兜底                                              |
| B-3  | 多用户 / 多 tab WS 并发 e2e 缺                               | RFC-036 协作已上线但端到端不锁                                        |
| B-4  | 崩溃恢复 / interrupted / daemon 重启完整链 0 e2e             | 用户报"卡死"后没自动复现路径                                          |
| B-5  | 性能 / 容量 / 内存基线 0                                     | 慢退化无法在 PR 看到                                                  |
| B-6  | 二进制 build 只校验产物存在                                  | embed frontend / SQLite / 版本探测无烟测                              |
| B-7  | Migration 链式滚动升级未测                                   | 旧 home 升新 binary 不一定能跑                                        |
| B-8  | Visual regression 0 个                                       | CSS 改一行半页烂 CI 不知                                              |
| B-9  | a11y 0 自动检测                                              | Dialog / Select 自实现 focus trap 回归靠人眼                          |
| B-10 | git 协议仅 `file://`                                         | https / ssh / SSL / 私钥 / 大 repo 没覆盖                             |
| B-11 | OutputKinds 并发写真实文件 IO 浅                             | readonly:false 节点同文件冲突未仿                                     |
| B-12 | GC / 长期运行"时间魔法"未仿真                                | 7 天后 GC 行为靠想象                                                  |
| B-13 | i18n 运行时键缺失静默                                        | 缺 key 渲染为键名串                                                   |
| B-14 | 安全边界 e2e 缺                                              | PAT / 过期 token / 跨用户越权 e2e 未锁                                |
| B-15 | wire 类型契约 shared ↔ backend ↔ frontend 无双校验           | `as T` 打破契约只在生产暴露                                           |

RFC-053 把"node_run 生命周期"修到了**结构上不可能再犯**；本 RFC 把
"系统层测试防护"修到**用户骨牌不再无声倒下**。

## 目标

把上面 15 个盲点用 **3 波 20 个 PR** 全部消解到 CI 主动发现而非用户上门
报告。

### Wave 1（W1-1 … W1-8，约 11 人日）—— 最高 ROI

让"敢动 runner / scheduler / lifecycle / routes 大块代码"的信心立刻
提升一档：

- **W1-1** 真实 opencode 录制 fixture + 协议守门快测（解 B-1 一半）
- **W1-2** API 契约总册：所有 route × {happy, 4xx, 5xx} 强制 shared Zod schema（解 B-15）
- **W1-3** 崩溃恢复 e2e：launch → SIGKILL daemon → resume → done（解 B-4 核心）
- **W1-4** task lifecycle 全状态 e2e（B-4 续，pending/running/done/failed/canceled/interrupted/exhausted 7 个 status 各 1 条到达路径）
- **W1-5** 跨用户权限 e2e（解 B-14 核心）
- **W1-6** 滚动升级测试：旧 home → 新 binary 自动迁移（解 B-7）
- **W1-7** dep-cruiser + 路由禁 `as T` grep 守门（解 B-15 续）
- **W1-8** CI e2e shard + webkit 矩阵（基础设施 — 让上面不爆时间）

### Wave 2（W2-1 … W2-7，约 6 周）—— 向"信心可重构"靠拢

- **W2-1** 真实 opencode 完整集成套件（matrix: pin / latest）
- **W2-2** WS broadcast 黄金测试 + SQLite 并发 fuzz（解 B-3 + 锁 lifecycle invariant 随机序列稳定）
- **W2-3** xyflow 编辑器交互 e2e（解 B-2）
- **W2-4** 多用户协作 e2e（双 browser context；解 B-3 续）
- **W2-5** 关键页面 visual regression × 10 快照（解 B-8）
- **W2-6** axe-core 注入到主线 e2e + 键盘流程 spec（解 B-9）
- **W2-7** import / export 真文件路径 e2e（解 B-10 part 1：file 路径 + yaml / agent.md / skill.zip）

### Wave 3（W3-1 … W3-5，约 6-12 周）—— 可重构 + 可扩展

- **W3-1** 混沌注入：磁盘满 / kill 中途 / 外部 rm worktree / SQLite WAL 截断（解 B-11 续 + 故障韧性）
- **W3-2** perf baseline + PR diff（解 B-5）
- **W3-3** config.json / workflow $schema_version 向下兼容矩阵（解 B-7 续 + B-12 一部分）
- **W3-4** 真实 git 协议（https + ssh + 私钥，via gitea container；解 B-10 part 2）
- **W3-5** 安全 fuzz：URL 注入 / 路径穿越 / SSRF（解 B-14 续）

## 非目标

- **不重写既有测试**：当前 595 单测 + 6 e2e 全部保留，本 RFC 只新增不
  删除（除非测试本身错或与新断言冗余，且需要在 PR 描述里逐条解释）。
- **不改产品行为**：所有新测试都是"锁现状 / 锁契约"，发现的产品 bug
  应另立 RFC（如 RFC-053 那种结构性修复）。
- **不引入新业务依赖**：测试层可引入 `axe-core` / `dependency-cruiser` /
  `knip` / `lefthook` 等纯测试工具，但**产品代码不准依赖**它们。
- **不做覆盖率硬门**：保留 `bun test --coverage` 仪表盘但**不强制阈值**
  ——避免"凑覆盖率"反模式。趋势 > 绝对值。
- **不替换 happy-dom**：前端单测继续 happy-dom；layout / 真实事件依赖
  搬到 Playwright，分层清晰。
- **不引入 Cypress / WebdriverIO**：Playwright 已经验证可用且已在 CI，
  不平行第二套 e2e 框架。
- **不上 Windows CI**：产品定位 macOS + Linux，不引入第三个 OS 矩阵。
- **不动 CLAUDE.md §Test-with-every-change 原则**：本 RFC 把现有原则
  **可执行化**，而不是替换它。

## 用户故事

- **重构者**：拿到 W1 完工的 main，敢拆 `runner.ts` / `scheduler.ts`
  大手术；按"红 → 绿"循环改完即可合并，**不必担心 6 个月前 RFC-005 的
  review iterate 链被悄悄改坏**——契约总册 + 崩溃恢复 e2e + 全状态 e2e
  把"我以为这条还工作"挪到 CI 失败行。
- **PR 评审者**：看到一个改 `routes/tasks.ts` 的 PR，CI 红的不是孤立
  那行单测，而是"API 契约总册的 5 条 happy/4xx 用例"——契约破坏直接
  对话级清晰。
- **CI 值班者**：W1-3 崩溃恢复 e2e 一红，立刻知道是 resume 链坏了
  而不是 flaky；不再有"重跑就过"的灰色地带（CLAUDE.md 已要求零容忍，
  本 RFC 用 flaky 雷达 + sharding 配合落实）。
- **opencode 升级负责人**：看 W1-1 / W2-1 协议守门是否绿，决定是否
  把 `MAX_OPENCODE_VERSION_EXCLUSIVE` 往上抬；不再需要在用户报"对话
  不显示"后才发现协议变了（1.14.51 PWD bug 教训）。
- **新功能作者**：W3-2 perf baseline 让"我这个 RFC 加了 30% 启动时间"
  在 PR 阶段被指出，而不是用户感知后回滚。
- **未来添加新 route / 新 NodeKind 的开发者**：契约总册 + dep-cruiser
  在新加入口时编译期 / lint 期报错"你没注册到契约总册"——结构上不
  可能漏。

## 验收标准

按波交付，每波独立 DoD。波内 PR 之间允许并行评审；波间严格串行
（前波全合并后才解锁下波第一个 PR）。

### Wave 1 DoD（W1-1 … W1-8 全合并）

1. **W1-1** `tests/fixtures/opencode-recordings/<version>.ndjson` 至少
   2 个版本落地（当前 pin + 1 个历史）；`packages/backend/tests/
opencode-recording-parser.test.ts` 跑 recordings 喂解析器、断言产出
   与录制元数据一致；commit hook 阻止 recording 文件被随意修改。
2. **W1-2** `packages/backend/tests/api-contract.test.ts` 覆盖全部
   `src/routes/*.ts` 端点 × {happy, 4xx, 5xx} 三连；每条断言响应符合
   shared Zod schema；新加 route 必须同步加 contract case，否则 grep
   守卫报红。
3. **W1-3** `e2e/crash-recovery.spec.ts` 跑通：launch → SIGKILL daemon
   → restart → task 落 `interrupted` → click resume → 节点回滚到
   pre_snapshot → 完成。
4. **W1-4** `e2e/task-lifecycle-states.spec.ts` 覆盖 7 个 status 各
   至少 1 条到达路径；每条带 `// LOCKS: task-state-<status>` 注释。
5. **W1-5** `e2e/auth-isolation.spec.ts` 创 user A + user B，断言：
   (a) A 的 sessionToken 拿不到 B 的 `/api/tasks/:id`（403）、(b) A
   拿不到 B 的 `/api/worktree-files`、(c) PAT revoke 后 A 不能继续。
6. **W1-6** `packages/backend/tests/upgrade-rolling.test.ts` 加载至少
   3 个旧 home fixture（migration 0001 / 0014 / 0020），启 daemon 自动
   迁移到 0028，跑一个 toy task → 完成。
7. **W1-7** 根目录 `.dependency-cruiser.cjs` 禁止 `frontend → backend`
   / `services → routes` / shared 反向；CI 加 `bun run depcheck`；路由
   `as T` 0 命中（grep 测试 / ESLint custom rule 双保险）。
8. **W1-8** `playwright.config.ts` 增加 `webkit` project + CI e2e 拆
   4 shard 并行；新 spec 在 4 shard 上总 wall-clock < 15 min。

### Wave 2 DoD（W2-1 … W2-7 全合并）

9. **W2-1** 新 CI workflow `integration-opencode.yml`（每日触发 + 改
   `runner.ts / scheduler.ts / protocol.ts / opencode-plugin/**` 时也
   触发），matrix `opencode ∈ {pin, latest}` × ubuntu，≥ 5 个端到端 case
   （multi-process / `OPENCODE_CONFIG_CONTENT` 优先级 / `task` 工具子
   代理 / readonly:true|false 写入 / `errors` port）。
10. **W2-2** `packages/backend/tests/ws-broadcast-golden.test.ts` 双
    客户端最终态一致；`packages/backend/tests/sqlite-concurrency-fuzz
.test.ts` 用 fast-check 跑 10000 序列断言 lifecycle invariant 不破
    （直接复用 RFC-053 PR-D 的 invariant 表）。
11. **W2-3** `e2e/workflow-editor.spec.ts` 覆盖拖节点 / 连边 / 删除 /
    复制粘贴 / 多选 / wrapper-nest / undo；视觉契约（label fit / handle
    位置）+ 数据契约（onChange → POST body 正确）都断言。
12. **W2-4** `e2e/collab-multi-user.spec.ts` 双 browser context 同编
    一 workflow → WS 同步 + 冲突 dialog；双用户同启同 repo task →
    worktree 隔离。
13. **W2-5** `e2e/visual-regression.spec.ts` 锁 10 个关键页面，ubuntu-
    only baseline；阈值 0.2% 像素差；改 UI 的 RFC 必须同步更新快照。
14. **W2-6** 主线 spec 末尾注入 `axe-core`，0 critical / serious 违规；
    常驻 Dialog / Select / ChipsInput 键盘流程独立 spec。
15. **W2-7** `e2e/import-export.spec.ts` 真 yaml / agent.md / skill.zip
    文件路径走通；含坏文件 / 冲突 dialog 边角。

### Wave 3 DoD（W3-1 … W3-5 全合并）

16. **W3-1** `packages/backend/tests/chaos-*.test.ts` 三组（disk-full
    / external-rm-worktree / SQLite-WAL-truncate），每组都验"daemon
    restart 后 task 落 failed 或 resume 成功，不破 DB"。
17. **W3-2** `tests/perf/baseline.json` + CI 在 main 上自动更新 + PR
    diff 报告（> 20% 退化标 warning，不强制 fail）；workload 包括
    500-node DAG / 10MB envelope / 100 并发 task / 10K events。
18. **W3-3** `packages/backend/tests/compat-config-versions.test.ts` +
    `packages/shared/tests/compat-workflow-schema.test.ts` 加载历史
    config / workflow schema fixtures 全跑通。
19. **W3-4** docker-compose 启 gitea container，e2e 通过 https + ssh
    拉公开 + 私钥仓 → 真 task 跑通；CI 独立 job（不阻塞主 PR）。
20. **W3-5** `packages/backend/tests/security-fuzz.test.ts` 跑 URL
    注入 / 路径穿越 / SSRF 各 100+ 随机 payload，断言 redact / 拒绝
    / 不外联。

### 横切验收（每波都必须满足）

- `bun run typecheck && bun run lint && bun run format:check && bun test
&& bun run --filter @agent-workflow/frontend test && bun run e2e` 全绿。
- 每个 PR 必须保持已合并波的所有新测试为 baseline，不引入新 flake。
- **不削减既有测试**：当前 595 单测 + 6 e2e 中任何一条；如有测试要改，
  需在 PR 描述里说明"锁住的契约现在变成 X"。
- `STATE.md` 在每个 PR 合并后更新；`design/plan.md` 的 RFC-054 状态
  从 Draft → In Progress → Done（W3 全合并后）。
- CI run id 必须在 commit message 引用（与既有 RFC 实践一致）。
- 新 spec / 新 contract case 必须带 `// LOCKS: <PR-#> / <RFC-#> / <一句话
回归意图>` 注释。
