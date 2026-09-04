# RFC-357：任务分解

## 1. 依赖与顺序

四个 PR 顺序执行。关键约束：**真库 lane 必须先于 PostgreSQL 目录源切换落地**——它是那一刀
唯一的执行级安全网（`docs/dev-gotchas.md` §「SQL 长得一样」证明不了「两个 provider 行为一样」）。

```
PR-1 骨架 + SQLite 切过去（零行为变化）
  └─ PR-2 真库 CI lane + 方言差异清单断言
        └─ PR-3 PostgreSQL 切过去（C-1 / C-2 的行为变化在这里发生）+ 两侧 oracle + 守卫
              └─ PR-4 前端 WS 增量更新
```

## 2. 子任务

### PR-1 —— 归一骨架，SQLite 先切（行为必须零变化）

- **T1** 建 `modules/task-execution/infrastructure/taskListPage/`：`dialect.ts` / `filters.ts` /
  `query.ts` / `projection.ts` / `page.ts`，内容从 `services/taskOperations.ts` **平移**
  （逐字搬，不趁机改语义），SQL 里所有方言敏感点改走 `dialect.*`。
- **T2** `sqlite.ts` 绑定 `DbClient` + SQLite dialect；`sqliteTaskCatalogSources.ts` 改调它。
  守住：`rfc311-task-page-fastpath` / `rfc311-task-page-filtered-fastpath` / `rfc244-task-operations`
  / `rfc310-task-catalog*` / `rfc301-task-launch-origin-architecture` 全绿且**不改断言**
  （改了就说明不是平移）。
  - 例外：`rfc301` 那条按文件名钉死的 `col('launch_origin')` 文本断言必须随文件移动而改
    路径——这是 STATE.md 记过的「改实现名会连累按名字钉死的多层守卫」，改的时候在断言上写明。
- **T3** 授权谓词合一（design §5）：`authorization.ts` + `collaboratorTaskIds(userId)` 注入。
  **先写三态用例**（owner=me / owner=other / owner IS NULL）分别钉住两侧现有行为，再合并；
  `shared` 统一取 `IS DISTINCT FROM`。
- **T4** 删除 `services/taskOperations.ts`，更新 12 处引用（1 处生产 + 11 处测试）。
- **T5** PR-1 收口：架构 canonical 重采 + 账本（删 1,196 行会让若干账本**降**，正常）。

### PR-2 —— 真库 lane 与方言清单

- **T6** `.github/workflows/ci.yml` 新增 job `test-backend-postgresql`：
  `runs-on: ubuntu-latest` + `services: postgres:17`，跑 `packages/backend/tests/rfc357-*.test.ts`；
  加进 `CI required` 的 `needs` 与结果矩阵（`ci.yml:775-800`）。目标单 job < 5 分钟。
  - 复用既有环境变量约定（`RFC349_DATABASE_URL` 同族），不新造一套。
  - lane **不**跑全量 backend 套件——它要证的是「这一页的 SQL 在真 PostgreSQL 上跑得动且结果对」。
- **T7** `rfc357-postgresql-dialect.test.ts`：design §6 的九条逐条断言，其中「前提」侧
  （SQLite 的 `LIKE` 不敏感、`branch_started_at` 是 NOT NULL）在 `bun:sqlite` 里可执行地钉住。
- **T8** `rfc357-postgresql-page.test.ts`：真库上跑通页查询的最小集（首页 / 翻页 / facets /
  子页 / 搜索 / 每个 origin / 每个 view），断言返回**值**而不是 SQL 文本。

### PR-3 —— PostgreSQL 切过去

- **T9** `postgresql.ts` 绑定 `PostgresqlDatabaseClient` + PG dialect + PG 侧富化查询
  （owners / childCounts / failureCodes 批量版）。
- **T10** `postgresqlTaskCatalogSources.ts` 改薄：删除内存过滤 / 排序 / 分页 / facets / `limit: 10_000`；
  `postgresqlTaskRouteOperations.ts` 的 `listItems` 不再被目录源使用，其 `SELECT *` 与逐行
  `failedCode` 按 `/api/tasks` 的实际需要**同步收窄**（它自己也在拖 `workflow_snapshot`）。
- **T11** 两侧共跑的 page oracle `rfc357-page-parity.test.ts`：同一批随机森林，
  ① 新实现 vs RFC-311 穷举管线（SQLite，沿用既有对照手法）；② SQLite vs PostgreSQL 逐页 byte-equal
  （在真库 lane 里跑）。
- **T12** 守卫 `rfc357-narrow-projection.test.ts`：投影列清单逐字相等；仓内不存在第二处
  view/origin/subject/statuses/q → 条件的翻译；PostgreSQL 路径上不出现 `limit: 10_000`
  与逐行 failureCode（AC-1 / AC-2）。
- **T13** 规模守卫（AC-3）：真库 lane 里种 N 与 10N 两档，断言**查询条数与返回行数**上界不随
  库大小变化（不断言墙钟时间——CI 上不稳）。
- **T14** C-1 / C-2 的用户可见行为变化写进 `docs/dev-gotchas.md` 与 release note 草稿。

### PR-4 —— 前端 WS 增量

- **T15** `useTaskOperationsSync`：`task.status` / `task.deleted` 就地 patch（含 facets 增量修正），
  其余帧仍失效；新增 30s 低频对账。patch 逻辑抽成**纯函数**（`applyTaskListFrame(pages, frame)`）
  以便直接断言。
- **T16** 前端测试：纯函数逐帧断言（状态改写 / 删除 / facets 四桶增量与全量重算一致）；
  组件级锁住三条既有 UX 回归（不空屏 / 不回顶部 / 不折叠已展开分支）。

## 3. PR 拆分建议

| PR   | 范围    | 风险                                 | 回滚                             |
| ---- | ------- | ------------------------------------ | -------------------------------- |
| PR-1 | T1–T5   | 低（平移，既有 oracle 守住）         | 单笔 revert                      |
| PR-2 | T6–T8   | 低（只加 lane 与用例）               | 单笔 revert                      |
| PR-3 | T9–T14  | **中**（用户可见排序变化 C-1 / C-2） | 单笔 revert；PG 目录源回到旧实现 |
| PR-4 | T15–T16 | 低                                   | 单笔 revert                      |

## 4. 验收清单

- [ ] AC-1 一份实现（守卫）
- [ ] AC-2 窄投影 / 无 10k / 无 N+1（守卫）
- [ ] AC-3 查询条数与行数上界与库大小无关（真库两档）
- [ ] AC-4 每源一次、共三次、每次 `limit+1` 上界
- [ ] AC-5 oracle：新 vs 旧、SQLite vs PostgreSQL
- [ ] AC-6 真库 lane 进 `CI required`
- [ ] AC-7 方言清单九条逐条断言 + 前提可执行钉住
- [ ] AC-8 前端按帧 patch + 三条 UX 回归
- [ ] AC-9 wire 输出逐字不变
- [ ] AC-10 exact-SHA CI 全绿，sha / run id 写回 proposal

## 5. 本 RFC 明确不做、留下的债

- task-catalog 仍收 full `Actor` + string filter，route 仍直取 composition
  （RFC-294 `design.md:181` / `:629` 的 typed query contract）——留给 task-catalog 自己的一步。
- cursor 仍是 base64url JSON + 过滤指纹，不上 RFC-294 `design.md:819` 的 HMAC 版本。
- `postgresqlTaskRouteOperations.listItems` 服务的 `/api/tasks`（legacy）在 T10 里只做投影收窄，
  不归一到 page query——它的过滤面与列表页不同（`workflowId` / `repoPath` / `scheduledTaskId`）。
- digital-employee 源不动。

## 6. 过程记录（落地时如实追加）

> 红过就写在这里，不抹掉：哪一笔、哪条 job、根因、修法。

### 6.1 四个 PR 的落地链

| PR   | commit      | 内容                                                                                        |
| ---- | ----------- | ------------------------------------------------------------------------------------------- |
| —    | `d7b2fab72` | 前置单笔修复：origin 筛选按 `launch_origin` 下推（非 RFC，见 STATE.md）                     |
| PR-1 | `05851f4ec` | 骨架 + SQLite 平移；`services/taskOperations.ts` 1196 行整文件删除                          |
| PR-2 | `2aa60750d` | 真 PostgreSQL CI lane + 共享场景（一份期望、两个 provider 各跑一遍）                        |
| PR-3 | `87d080300` | PostgreSQL 目录源切过去（C-1 / C-2 的行为变化在这一笔）；`/api/tasks` 投影收窄 + 批量失败码 |
| PR-4 | `dfbfb3a91` | 收 lane 抓到的第二个 PG-only 缺陷；收 PR-2 推红的两条；前端按帧就地更新                     |

### 6.2 真库 lane 抓到的两个缺陷（它存在的理由）

两条都在假 pool（只断言渲染出的 SQL 文本）那一层完全看不见，症状都不是报错而是**静默错值**：

1. **`json_type` 词汇表**（PR-2 的 lane 首跑抓到）：PG shim 转发 `jsonb_typeof`，JSON 字符串
   返回 `'string'` 而 SQLite 返回 `'text'` ⇒ `= 'text'` 恒假 ⇒ **工作组名恒为 NULL**。
   修在查询侧（两种拼法都收），不改 shim（会让存量 PG 部署 `schema-drift` 起不来）。
   通用教训进 `docs/dev-gotchas.md`。
2. **分页游标的数值**（PR-3 的 lane 抓到）：`page.ts` 从裸行取 `branch_started_at` 直接编码，
   PG 上是字符串 ⇒ **翻第二页时解不开自己刚发的游标**（422）。这一处正是 PR-2 的静态守卫
   逐字列举字段时漏掉的；守卫因此改成从 `OperationsSqlRow` 的**类型声明**推导数值列。

### 6.3 我推红过的（如实记账）

- `05851f4ec`（PR-1）→ CI run 33857714315：`RFC-305 identity-access` 的已审消费者账本没跟上
  （`server.ts` 注入 owner 端口是新消费）。PR-2 收掉。
- `2aa60750d`（PR-2）→ CI run 33859487150：① shellcheck SC2016——lane 的连通性探针写成
  `bun --eval '…JS…'`，shellcheck 按 shell 展开去读单引号内容；② `test-suite-policy` 的
  skip 账本没登记新的环境门控 skip。两条都在 PR-4 收掉。
- 同一类坑**踩了两次**：源码文本判据被解释缺陷的注释自己命中（rfc301 棘轮一次、
  rfc357-narrow-projection 一次）。第二次装了统一的 `codeOf()` 取样器（剥注释再匹配）。

### 6.4 与设计不符、如实修订的两处

- **没有引入 `dialect.ts`**（design §6 的实现后修订）：逐条核对下来每个方法都退化成恒等。
- **前端不就地算 facets**（design §9 原文说要增量修正四个页签计数）：分母含当前页看不见的
  行与子行，缓存里没有，据此加减必然在一部分情况下算错；而「页签数字乱跳」正是用户报的
  第一个问题。改为「patch 只做确定正确的两件事，数字仍由服务端给、只是给得稀疏」，
  合并窗口 1s → 10s。判据写进测试。

### 6.5 欠着的两笔

- **`architecture/` canonical 重采**：PR-4 落地时工作树装着并发 session 的 RFC-358 在制品
  （三个未跟踪模块文件 + 十来个已跟踪文件的未提交修改）。census 走 `readdirSync` 读工作树，
  重采出来的账本大半是他们的符号——那样的产物在干净 checkout 上必然对不上，也不该由我替他们
  记账。同时欠着的还有 `test-suite-allowed-skips` 的 41 → 42（PR-4 新登记了一条环境门控 skip）。
  两者一起，留给下一笔在能代表主干的树上做。
- **AC-3 的规模档**：见 `proposal.md §6.1`。

### 6.6 验收清单的落地状态

逐条状态见 `proposal.md §6`（AC-1/2/5/6/7/9 达成，AC-3 未做，AC-4/AC-8 部分，AC-10 待取证）。
