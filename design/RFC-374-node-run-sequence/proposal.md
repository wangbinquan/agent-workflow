# RFC-374 NodeRun 每任务单调序号：先后判定与 ULID、主机时钟脱钩（RFC-294 S1 / W7-A）

- **状态**：Done（2026-10-19）——`291a5c3f3`，主 CI `39377617276` success（含 PostgreSQL 双引擎分片）。实现由 Codex 完成，本会话审核：铸造值里 `seq` 移到 record 展开之后；追平作业加「整批无进展即失败」；W8 唯一键账本与 PostgreSQL 聚合解码各登记一处假阳性；随新规则更新迁移头 260、RFC-187 驱动入口锁、W26 参与者原文哈希、两处 PostgreSQL 假驱动夹具，以及两处直接插入「更新代」行的测试（改经 `allocateNodeRunSeq` 取号——没有 `seq` 的行按新规则是旧行）。前置：RFC-370 于 2026-10-19 Done，0259 / 0035 冻结（design §8）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S1、design §6.1；review-2026-10-16 F6；
  `docs/audit-backlog.md` 中「scheduler 与前端共用同一先后序」的系统级条目
- **基线**：HEAD `e569bb5c8`（2026-10-19 复核；行号仅作定位提示）
- **落位**：task-execution（铸造分配、追平作业、读者切换）、shared（唯一比较器）、platform/persistence（PostgreSQL 加列迁移种类）、
  各 consumer 自身的读侧

## 1. 背景

「哪一条 node_run 更新」今天按 ULID 字符串序判定（`services/freshness.ts` 的 `isFresherNodeRun` 比较 `candidate.id > incumbent.id`），
而铸造用的是普通 `ulid()`：

- 同一毫秒内约一半逆序——`tests/scheduler-audit-s13-freshest-fork-source-guards.test.ts` 实测 2000 对同毫秒 ULID 中 989 对逆序，
  `taskRouteOperations.ts` 也因此在一处改用 `retryIndex`；
- 若干调用方先选定 id、后提交（工作组 host run 的 `operation.runId`、review rerun 的 `rerunNodeRunId`、仓库准备重试的 `nextId()`），
  后提交的行可能带更小的 id；
- 托管部署（RFC-370）下执行权会在实例间切换，id 先后还依赖不同主机的时钟一致。

`node_runs` 没有序号列，生产代码中约 16 处 SQL `ORDER BY nodeRuns.id`、20 余处手写 id 比较、若干「按查询顺序取最后一个」的
隐式判定，以及前端 4 处镜像后端的判定，都建立在这个不成立的前提上。

## 2. 目标

- **G1** `node_runs` 增加每任务单调的 `seq`，在唯一铸造程序的同一事务内分配，`UNIQUE(task_id, seq)`；分配不引入 RFC-369
  消除的同任务并发冲突。
- **G2** 所有生产「新旧 / 先后」判定只用一个比较器：两行都有 `seq` 比 `seq`；都没有比 id（历史判定）；只有一行有时，没有的那行更旧。
  前后端共用 shared 中的同一实现。
- **G3** 存量与旧二进制写入的行由一个可重复、幂等、可中断的追平步骤补上 `seq`，并保持既有判定不变。
- **G4** 结构门锁定：生产代码不再按 node_run id 判定先后（例外逐条有理由）。
- **G5** 两种 provider 的 fresh / upgrade、逻辑复制与备份恢复都正确；在途任务 resume 兼容。

## 3. 非目标

- 不建模 RunRole、scope / container、generationSeq、attemptIndex、逐边 provenance（W7 余项）。
- 不改 `startedAt` 为先的前端「最新」选择器（另行决定）。
- 不在本 RFC 删除 id 回退（S1b：待所有受支持二进制都晚于本 RFC、并扫过测试夹具之后）。
- 不做任何安全相关改动。

## 4. 验收标准

- **AC-1** 同一毫秒连续铸造 200+ 条、以及「后铸造的行 id 更小」（显式更小 id、工作组 host 预选 id、review rerun id）、时钟偏移
  （`ulid(now − 60s)` 晚铸造）三类场景，所有 picker 都选中最后铸造的行；RFC-369 的 merge 围栏与重放排除作用于被取代的那一代。
- **AC-2** RFC-369 AC-2（两个 SERIALIZABLE 同任务铸造各只执行一次）与 W47（铸造程序零 update）、rfc144（铸造程序只有一次
  `.from(nodeRuns)`）锁保持原样通过；READ COMMITTED 下两个并发铸造都成功、无 23505。
- **AC-3** 追平：全为空的任务得到 ≤ 0 的值且保持 id 序；旧二进制写入的空行按 id 序得到高于既有值的分配值；重复执行幂等；
  中断后可续；失败时守护进程拒绝启动（与启动恢复语义一致）；托管下只在获得执行权后运行；追平后每个任务按 `seq` 排序与按 id
  排序在存量行上完全一致（mismatch = 0）。
- **AC-4** SQLite fresh / upgrade、PostgreSQL fresh / upgrade、PG 历史前缀重放、SQLite → PG 逻辑迁移、旧版逻辑归档恢复全部通过。
- **AC-5** 结构门带负例：`orderBy(desc(nodeRuns.id))`、`gt(newer.id, target.id)`、对 node-run 形类型的 `.id >`、`localeCompare`、
  把 `isFresherNodeRun` 改回 id 比较的文本副本都会被抓到；合规样例不报。
- **AC-6** 前端导航、历史、注入记忆卡片、工作组房间在 `seq` 与 id 顺序相反的夹具下与后端判定一致；DTO 带与不带 `seq` 都能解析。
- **AC-7** 在途任务（wrapper 中断、iso pending-merge、fanout 分片复用、review 等待、clarify 谱系）经迁移、追平、启动恢复与 resume
  后的选取与结果与迁移前的基准运行一致。

## 5. 能力影响

无产品能力变化。新旧判定只在原判据出错的情形下不同（这正是要修的缺陷）。`GET /api/tasks/:id/node-runs` 与 MCP
`list_node_runs` 的 NodeRun DTO 增加可空字段 `seq`（加性，旧客户端忽略、旧服务端缺省为 null）。

## 6. 已作出的取舍

用户授权本会话设计、交 Codex 实施并审核（免设计门与实现门），以下事项由本会话决定，可在执行期间推翻：

1. **执行时机**：用户 2026-10-19 告知 RFC-370 已结束，随即派发。本 RFC 的迁移为 SQLite 0260 / PostgreSQL 0036，链接在 RFC-370
   已冻结的 0259 / 0035 之后。
2. **追平失败则守护进程拒绝启动**：采纳。追平是启动恢复的第 0 步，与其余四步同样 fail closed；托管下失败即把该实例的执行权
   置为 `frozen`（`execution-initialization-failed`，`bootstrap/executionInitialization.ts`），与启动恢复失败的既有处理一致。
