# 测试防护缺口审计 — 2026-07-21

> **一句话结论**：这个仓的问题不是测试少，而是**测试网的形状与缺陷的形状不匹配**。
> 1512 个测试文件、9 类 CI 门禁，但它是一张**沿已知路径铺开**的网：每条用例走一条路、断言一个结果。
> 而逃到用户面前的缺陷几乎全长在这张网的三种缝里——**组合空间的交叉格**、**同一语义的第 N 份实现**、以及**「该发生的」之外那半个世界**。

| 项 | 数值 |
| --- | --- |
| 审计方式 | 66 个并行 agent，四阶段（逃逸考古 → 覆盖测绘 → 双人对抗验证 → 前瞻预测 → 综合 + 完备性批评） |
| 消耗 | 8.43M tokens / 4184 次工具调用 / 2h15m |
| 覆盖面 | 后端 279 源文件 9.1 万行、前端 415 源文件 10.4 万行、shared 79 文件 1.9 万行；后端 764 + 前端 617 + shared 126 测试文件；30 个 e2e spec；6 个 CI workflow |
| 原始缺口 | 177 条 |
| **经双人对抗验证后存活** | **131 条**（P0 17 / P1 67 / P2 47） |
| 被驳回 | 46 条（26% 误报率——每条缺口都由两名立场相反的验证者独立审过：一名专门证明「其实已经测了」，一名专门挑「代码不存在 / 死代码 / 严重度夸大 / 补法物理不可行」） |
| 逃逸考古 | 66 条历史逃逸记录 |
| 前瞻预测 | 28 条尚未被报告的高风险点 |

**文档结构**

- `00-SYNTHESIS.md`（本文）— 三问的答案：还有什么没防住 / 为什么会漏到生产 / 怎么防
- [`01-gaps.md`](01-gaps.md) — 131 条存活缺口全表（按域分组，含 `file:line` 锚点与建议防护层）
- [`02-escapes.md`](02-escapes.md) — 66 条逃逸缺陷考古（每条回答「当时那么厚的测试网为什么没拦住」）
- [`03-predictions.md`](03-predictions.md) — 28 条前瞻预测（三个独立视角）

---

## 0. 测试网的形状：四个可量化特征

诊断不靠感觉，靠这四个数：

| 特征 | 数值 | 它导致什么 |
| --- | --- | --- |
| **夹具不收敛** | 764 个后端测试文件里**只有 12 个**复用共享 helper | 每份夹具都是一次独立且未经校验的「生产形状假设」，于是夹具恰好落在两种实现都对的特例上（公有仓 URL 遮住脱敏漂移、capture 测试用被测函数自己造目录名，算法怎么错都必绿） |
| **文本锁冒充行为锁** | **193 个后端 + 208 个前端**测试文件在读源码做文本断言，**79 个**直接读 `styles.css` | 「能通过但不验证行为」的兜底已造成可量化伤害：焦点环四条 CSS 文本锁全绿，用户报到第五次；launch 三字段「只断言源码 spread」因而被静默丢弃 |
| **否定路径整层缺席** | 205 条 API 端点的契约表**只有 `public` 一个安全维度**，28 条有正向夹具、**0 条有拒绝夹具**；764 个后端测试文件里只有 41 个建了第二个用户 | 「授权」这一整层结构上无人过问——`worktree-files` 的 P0 越权正是此形状：它在 registry 里、401 测过，就是没有 `canViewTask` |
| **编译期强制稀缺** | 全仓**只有 22 处** `as const satisfies Record<>` 矩阵 | 而 RFC-053 证明这是唯一一档「结构上不可能再犯」的防护 |

**因此结论不是「补测试」，而是把三件事从人的记性搬进机器**：让分叉维度在类型层可枚举、让否定路径由契约表自动生成、让不变式在每个测试结束时自动检查。

---

## 1. 第一问：前台 / 后台还有哪些功能没被用例防护住

131 条全表见 [`01-gaps.md`](01-gaps.md)。分布：

**按逃逸类别**

| 类别 | 条数 | 含义 |
| --- | --- | --- |
| `no-test-at-all` | 43 | 压根没有任何用例触及 |
| `happy-path-only` | 23 | 只测了正向，错误 / 拒绝 / 边界分支裸奔 |
| `text-assertion-only` | 18 | **只有**源码文本断言，行为层无防护 |
| `harness-cannot-express` | 11 | 这套测试栈物理上表达不了 |
| `contract-drift` | 11 | 两端 / 两处约定已漂移 |
| `cross-module-seam` | 10 | 各模块都测了，接缝无人负责 |
| `concurrency-timing` | 5 | 并发 / 时序 |
| `mock-too-deep` | 4 | mock 把真实路径整段挖空 |
| `env-gated-or-skipped` | 4 | 环境门控导致实际从不执行 |
| `ui-visual-or-layout` | 2 | 布局 / 视觉 |

**按域**（前 8）：CI 门禁 12 · HTTP 路由契约 11 · 测试框架能力 11 · 任务创建/启动向导 10 · Git/submodule 8 · 运行时执行层 8 · 数据层 8 · 评审多文档 8

### 17 条 P0

| id | 标题 |
| --- | --- |
| `B4-runtime-1` | claude 会话捕获的目录 slug 算法与真实 claude **不一致** → 子代理转写 100% 静默丢失；且测试用生产函数自造 fixture，算法怎么错都必绿 |
| `B3-git-1` | RFC-210 T27「子仓冲突未解 → human resume fail closed」整条链路只有 fixture 字段，零行为用例 |
| `B3-git-2` | 同一仓库有 ≥2 个并列 submodule 时 `poolDir` 是单值 → 第二个子仓的提交推错池；全仓 fixture 都只挂一个 vendor |
| `B1-routes-1` | 账号自服务三条路由（revoke session / delete identity / delete PAT）的跨用户拒绝路径零断言（IDOR） |
| `B5-*`（见 Top 5） | skills / mcps / plugins 三类资源的跨用户否定断言全域为零 |
| `S1-shared-wire-1` | RFC-204「带 query 凭据的 repoUrl 在启动门口被拒」这条安全分支全仓零用例 |
| `M1-lcov-1` | **OIDC / SSO 登录链路整条零行为测试**：token 交换、id_token 验签、发现文档、callback 建会话全部 0% 函数覆盖 |
| `M2-harness-1` | 前端测试栈无布局引擎且不加载 CSS（happy-dom + `css:false`）：已复发三次的「出框/换行」类 bug 只有 CSS 文本断言 |
| `M2-harness-2` | 真实 opencode / git 协议验证只挂 `pull_request` 触发，而本仓是 **main-only 直推** → 提交时刻永不运行；nightly 红了也无通知 |
| `M3-ci-gates-1` | `release.yml` 是一条**完全无测试门**的发布通道；linux-arm64 二进制在 CI 里从未被构建或冒烟 |
| `M3-ci-gates-2` | perf 门的绝对下限（0.1ms）大于全部 5 条基线的中位数 → 数学上要求 6x–100x 退化才会红 |
| `M3-ci-gates-5` | codecov 的 patch 70% 门在「直推 main、无 PR」下**恒不生效**；前端 / shared 从不上传 lcov |
| `M4-test-quality-1` | 登出清客户端私有状态：唯一防护是文件级源码 grep，4 条真实 session 拆除路径全部漏网（跨账号数据泄漏） |
| `F2-canvas-1` | 拖拽连线整条手势在 unit / integration / e2e 三层都无行为防护，只有纯规划器 + 源码文本断言 |
| `F3-review-1` | review 草稿 IndexedDB 门面零测试，且与 clarify 共库版本号冲突会让草稿静默失效 |
| `F4-clarify-1` | 服务端逐题协作草稿的**前端一半**（远端合并 / 本地优先 / 逐题 PUT diff / 403-409 熔断）零行为测试 |
| `F4-clarify-2` | 集中回答面板（RFC-137）只写草稿不读回、不订阅 `clarify.draft.updated`，与 `/clarify` 详情页语义不对称，双向无测试 |
| `F5-tasks-2` | relaunch / editScheduled 的仓库预填被整行清空：反向映射不认 `cachedRepoId` |

### 跨域 Top 25 风险（后果 × 逃逸概率）

| # | id | 域 | 风险 |
| --- | --- | --- | --- |
| 1 | `B4-runtime-1` | 运行时 | claude slug 算法错位 → 子代理转写 100% 静默丢失（已用本机 claude 2.1.215 二进制取证：真实规则是 `replace(/[^a-zA-Z0-9]/g,'-')` + 200 截断，我们只替换 `/`；worktree 路径恒含 `.agent-workflow` 故**必然**错位） |
| 2 | `B3-git-1` | submodule | 子仓冲突 fail-closed 闸门从未被非空 `pendingSubResolves` 驱动过 → 失效即不可回滚的数据丢失 |
| 3 | `B3-git-2` | submodule | 并列子仓 poolDir 单值 → materialize 500 / gitlink 指向不可达对象 |
| 4 | `A-fanout-errors-port` | 文档 | **CLAUDE.md:138 与 proposal.md 宣称 fan-out 自动 errors port 已交付，design.md:783-786 明写 v1 未实现**——每个新 session 的第一入口就是错的 |
| 5 | `B5-ACL-cluster` | ACL | skills 18 条路由 + mcps/plugins 全部 ACL 门只在 daemon token（=admin，直接短路 ACL）下跑过 |
| 6 | `D-ws-revocation` | WebSocket | 7 通道 × 4 类授权撤销 = 28 格只实现 1 格；actor 在 upgrade 时快照后**永不复核** → 成员被移除 / 降级 / token 吊销后旧连接继续收 agent stdout |
| 7 | `D-multirepo-memory` | 记忆 | 多仓任务的 repo 作用域记忆只读 `tasks.cached_repo_id`（= repo[0] 镜像列），注入与蒸馏**双向都错**且无失败信号 |
| 8 | `D-portartifact-wrapper` | 端口归档 | wrapper 自产的 `git_diff` 的 `archive_json` 恒为 NULL → worktree GC 后端口内容永久不可读 |
| 9 | `A-ci-topology` | CI | e2e 与二进制 smoke 被 backend 分片红**静默吞掉**；「守卫没跑」与「守卫跑了没问题」是同一个绿 |
| 10 | `D-runtime-question` | 运行时 | claude 无 opencode `question:deny` 等价物，`AskUserQuestion` 默认超时是 `never` → RFC-073 挂死链条每一环都成立 |
| 11 | `B2-lifecycle-3` | 生命周期 | RFC-207 运行时长记账零行为覆盖 → 限额永不触发 或 人在 `awaiting_human` 期间继续计时被秒杀 |
| 12 | `B6-data-5` | 备份 | 「备份 tarball 不含 `secret.key`」只是一行注释，排除清单测试没断言它 |
| 13 | `D-commitpush-clean-sub` | commit-push | 未被触碰的干净 submodule 也被 `checkout -B` + 无条件 push → 第三方 vendor 仓一次也提交不了 |
| 14 | `B4-runtime-5+6` | 资源 | prompt 走 argv 与 stdout **双向都无体量上限** → Linux `MAX_ARG_STRLEN` 128KB spawn 失败 / daemon OOM |
| 15 | `B1-routes-7` | 路由 | 95 个 route-local 错误码里 **51 个零命中**；契约表 205 条 0 条拒绝夹具 |
| 16 | `B6-data-4` | 记忆蒸馏 | 蒸馏 ticker 缺重入守卫且认领在 for 循环内 → 同一 job 蒸馏两遍（重复记忆 + 双倍 token） |
| 17 | `B3-git-3` | submodule | 递归 submodule（sub-in-sub）的 iso → merge-back → materialize 全链路零覆盖 |
| 18 | `B3-git-4` | submodule | 「gitlink 冲突一律扣住整仓、绝不 salvage」是一条**从没跑过的 if**，它专防的 `rm -rf` 场景从未复现 |
| 19 | `D-terminalsweep` | 人类闸门 | `terminalSweep` 手写枚举 5 张表，RFC-120 的 `task_questions` 三个开放态不在其中 → 死任务的反问永久停在看板 |
| 20 | `B1-routes-2+4+5` | 路由 | fusions 7 条 + OIDC 公开登录 3 条 + OIDC 管理 6 条，共 16 个 endpoint 后端零测试（OIDC 三条是**未认证即可访问**的最外层攻击面） |
| 21 | `B5-security-8` | 安全 | `writeSkillFile` / `deleteSkillFile` 缺少读路径已有的 `realpath` 遏制 → 跟随 symlink 以 daemon uid（本机常为 root）写/删任意宿主路径 |
| 22 | `B6-data-2` | 迁移 | 手写多语句迁移缺 `--> statement-breakpoint` 无全仓守卫（bun:sqlite 只执行第一条且**不报错**） |
| 23 | `A-dedup-residue` | 公共原语 | dedup 审计「已咬人」项中 5 项仍在原地（`redactPushError` 窄脱敏、4 处手抄 resume deps 漏 `subagentLiveCapture`、IDB 双 version…） |
| 24 | `D-errorsummary` | 前后端契约 | 后端 `errorSummary` 字面量集合远大于前端手抄的 15 条翻译表 → 用户看到「任务失败」+ 一行英文机器码 |
| 25 | `A-allowTerminal` | 状态机 | `allowTerminal` 逃生舱注释写「仅 fixup 脚本」，实际 **21 处正常业务流**在用 |

---

## 2. 第二问：之前的问题为什么会遗漏到生产 —— 九类逃逸机制

完整考古（66 条实例）见 [`02-escapes.md`](02-escapes.md)。归纳为九类机制：

### ① 组合空间无归属（笛卡尔积缺陷）

缺陷不落在任何单个模块里，而落在**两个各自独立增长的集合的交叉格**上。路径式测试对积空间的覆盖率是 `O(用例数) / O(|A|×|B|)`，随两集合增长趋近于零。每次修复只补被用户报出来的那一格，另一格继续裸奔，**所以补丁永远慢一轴**。

- RFC-206：外扩焦点环 36 条 × `overflow != visible` 容器 100+ 条，**复发 5 次、补丁 4 次**
- RFC-074：三套 freshness picker × 拓扑；17 场景探测一次抓 4 红，其中最常见的 S8 只是最普通拓扑
- 7 个 WS 通道 × 4 类授权撤销 = 28 格，只实现 1 格

**为什么补了还会再犯**：积空间只存在于人的脑子里，**没有任何机器持有这张表**。
**现状防护**：全仓仅 22 处 `satisfies Record<>` 矩阵。
**根治**：把「分叉维度」提升为一等对象——凡同一语义按枚举分叉，必须落成 `as const satisfies Record<Enum, Spec>`，新增成员不表态即**编译失败**，再配遍历矩阵的表驱动测试。同时禁止用 `if (kind === 'review')` 式散射特判承载分叉语义。

### ② 单一事实源建了，但绕过它仍然合法

抽出公共原语只降低了「用原语」的成本，**没有提高「不用原语」的成本**。旧的手写一份在类型层与 lint 层依然完全合法且更便宜。

- RFC-058 → RFC-064：两个 clarify 计数器，合表 + 合 prompt 层之后**仍出血 4 个 patch**，直到合掉字段维度才止住
- `c84ff79f`：3 个 SKILL.md reader 只修了 1 个，另两口仍可 symlink 读宿主 `~/.ssh/id_rsa`
- `f04c94ed`：一个 `globalSem.acquire` 站点从三个正确兄弟的队形漂出去，**卡死整个 daemon**（用户原话「整个系统都卡死了，只能重启解决」）

**根治**：两步必须都走——① **消灭维度**（把可绕过的入参改成只接受具名 ADT，让「手写一份」在类型层不可表达）；② 对暂不能消灭的，统一 inventory 棘轮框架（共享 AST lexer + 白名单只减不增）。**只做②不做①就是 RFC-058 的重演**。

### ③ 只测「该发生的」，不测「不该发生的」

功能作者的自然验收标准是「正向能跑通」。否定路径（403/404/422、非法输入、越权、重复提交、空集合、退出与善后）没有产品需求驱动，也没有任何机器强制作者声明，于是整层缺席，**且缺席本身不产生任何信号**。

- 51/95 个 route-local 错误码零命中；registry 205 条端点 0 条拒绝夹具
- `bda0d4fb`：一次 7 路人工权限审计挖出 5 个洞
- `6faca0ab`：`loadConfig('')` 分支零覆盖，21 个测试两个月泄 **11493 个文件**到仓库根、全绿

**为什么会这样**：`EndpointSpec` 只有 `public` 一个安全维度——契约表能强制「新路由必须登记」，却**不能强制「作者说明这条路由的授权语义」**。
**根治**：给 `EndpointSpec` 加**必填**的 authz 判别式，由 registry 按 kind **自动生成否定用例**。改一个类型定义，O(205) 覆盖全部端点——**本报告性价比最高的一条**。

### ④ 夹具与 mock 比生产形状更干净（假绿）

测试作者按自己的心智模型手搓夹具，而**这个心智模型正是缺陷所在**。夹具于是恰好落在「两种实现都对」的特例上，或干脆**用被测函数自己生成期望值**，形成自证循环。

- `B4-runtime-1`：capture 测试用生产的 `cwdSlug` 造 fixture 目录，算法怎么错都必绿
- `33fe7061` / `6fb34d10`：公有仓 URL 恰好脱敏前后相等，遮住私有仓 memory scope 与 relaunch 全线断裂——**同一根因同一天被独立发现两次**
- RFC-184：`runHostNode` 被 stub 掉，leader 自动派发**从没跑通过一次**，DB 里 6 个工作组任务 0 个 done

**根因数据**：764 个后端测试文件里**只有 12 个** import 共享 helper。
**根治**：建夹具工厂层并强制复用（`seedTask({repoCount})` / `seedActors(['owner','grantee','stranger','admin'])` / `seedRepoWithSubmodules(n,{nested})` / `workflowFromCanvas()`），加一条规则：**测试不得从被测模块 import 纯函数来生成夹具键或期望值**。

### ⑤ 用源码文本断言冒充行为防护

当断言面够不着缺陷所在的物理层（无布局引擎 / 编译后二进制 / 真 CLI 进程 / 跨模块接线），本仓的默认动作是 grep 源码字面量。这类锁能通过、永远绿、写完有交付感，**但物理上无法发现行为错误**。

- 量化：193 后端 + 208 前端测试文件读源码断言，79 个直接读 `styles.css`
- RFC-206 自陈「jsdom 没有布局引擎，这类测试永远无法发现实际被切了」
- `c29d063c` 的 commit message 直接点名：「旧 launch 字段测试**只断言源码 spread、从不验证落到 wire**，这正是丢字段一直没被发现的根因」
- RFC-194：CSS 约束了一个 DOM 从未挂过的 class，**恒绿且零价值**

**根治**：① 所有源码文本断言必须经 `sourceLock({ reason, behavioralTestRef })`，元测试强制每条锁要么指向真实行为断言、要么进只减不增的豁免表——**把「这是唯一防护」变成必须显式承认的事**；② 建**变异测试 job**：守卫 id → 定向劣化补丁 → 期望变红的测试 id，守卫不变红即失败。

### ⑥ 门与分支在测试 / CI 环境恒不激活

生产行为依赖某个只在真实环境成立的前提，测试环境永远走另一支。**CI 拓扑还让「守卫被 skip」与「守卫跑了没发现问题」呈现为同一个绿。**

- `27479fa4`：RFC-170 可用性门在真实 daemon 数秒即开，单测从不跑 boot-verify → ZIP 导入新建技能**测试恒绿、线上 100% 失败**（commit message 自陈）
- 5 个 `RUN_*` 套件 + 3 个 nightly workflow 只有 `schedule` / `pull_request` 触发，**而本仓 main-only 开发从不开 PR** → 只剩每日 cron，与具体提交完全解耦
- `e2e → build-binary → test-backend` 串行 needs：他人分片红直接吞掉我的几何守卫（RFC-206 收官当天即中招）

**根治**：CI 拓扑改造（e2e 加 `if: always()` 或 needs 只留 build-binary；漂移哨兵改 `push` 触发）+ 增设「守卫已执行」汇总 required check + `ALLOWED_SKIP_COUNTS` 的 value 从 `number` 升成 `{count, reason, trackingRef, expiresAt}`，**过期即红**。

### ⑦ 后端能力与用户可达面之间的断线

分层测试各测各层，「这个字段 / 能力**有没有到达用户**」不在任何一层的断言面内。

- `c29d063c`：`buildLaunchBody` 白名单 **DROP 掉** `workingBranch`/`autoCommitPush`/`collaboratorUserIds`，三条启动路径静默禁用（同款坑 RFC-125 已抓过一次）
- RFC-156：`mergeAgentRuntime` 从未获得任何 UI + `ConfigPatchSchema` 漏 `.nullable()` + 前端唯一入口保存必 403，**三重半截落地**

**根治**：多入口共享单一 builder，并把断言从「逐条手抄」改成**穷举**：遍历 `Object.keys(LaunchCommon)`，每个 key 必须出现在真实 HTTP body 上。再建三条「能力可达性清单」守卫（config 字段必须在某设置页可达 / 每个 errorSummary token 必须有 zh-en 词条 / 每个 task kind 的 relaunch 深链参数集非空）。

### ⑧ 散文与索引充当契约载体（知识不在机器里）

关键约束写在注释、design 文档、STATE.md、plan.md 状态列里。**文档没有编译器**。

- `CLAUDE.md:138` 与 `proposal.md` 宣称 fan-out 自动 errors port 已交付，`design.md:783-786` 明写 v1 未实现
- `limits.ts:102` 注释声称 fan-out 子行已镜像进 parent，而镜像根本不存在——**今天恰好因为没镜像而结果正确，谁照注释补上即 token 双计、任务被提前误杀**
- `lifecycle.ts:156` 注释写 `ONLY for fixup scripts — never in normal flows`，实际 21 处正常业务流在用
- `docs/performance-notes.md:114` 声称 `node_run_events.node_run_id` 无索引并要求加，而 `schema.ts:1464` 早已有 `idx_events_node`（**本次审计当场发现的第 N 例**）

**现状防护**：无。**根治**：散文契约可执行化（写点棘轮）+ 文档-实现反向锁（文档描述的未实现特性加 grep 反断言；标 Draft 的 RFC 关键标识符不得在 src 命中）。

### ⑨ 资源与时序的静默态（无 oracle 可断言）

失败形态是慢性泄漏、偶发重入、或「任务照样 green 但内容错了」，**不产生任何异常信号**。正确的断言是**不变式**而非结果，而本仓的测试形状是路径式 + 结果式。

- `f04c94ed` permit 泄漏卡死 daemon；`6faca0ab` 两个月泄 11493 文件全绿；`86670a9c` 进程级计数器跨文件污染
- `B6-data-4` 蒸馏 ticker 重入；`B6-data-7` 归档 append+delete 非原子；`B3-git-7`/`B6-data-8` 池 ref 与端口归档**只增不减**

**根治**：利用已有的 `bunfig preload` 加**全局 afterEach 不变式**（cwd/tmp 无新增文件、信号量 `available===capacity`、无残留 timer/子进程、进程级计数器归零）——**O(1) 投入覆盖 764 个文件**。

---

## 3. 第三问：怎样防护 —— 15 条结构守卫

原则：**O(1) 投入覆盖 O(n) 面**。参考 RFC-206 的成功路线：把修法从 O(容器数) 改成 O(1) → 建静态 + 几何双层守卫 → 基线白名单止血 → 逐条清零 → 转硬失败。

### P0（先做这五条）

| # | 守卫 | 层 | 成本 | 一次性堵住 |
| --- | --- | --- | --- | --- |
| G1 | **契约表增设必填 `authz` 判别式，自动生成否定用例** — `EndpointSpec` 加 `authz: {kind:'permission'\|'resource-acl'\|'task-member'\|'admin'\|'authenticated-only', …}`，registry 按 kind 自动生成：缺 scope→403 / 陌生人访问私有→与不存在**逐字节同形**的 404 / 非成员→403 / 畸形 id→先 404 且不改状态。同时修好发现器对变量 path 的失明（12 条 `/:key/acl` 端点整体逃逸） | ci-gate | 中 | 19 条缺口 + 整个「只测该发生的」类 |
| G2 | **全局测试后置不变式钩子** — 在 `packages/backend/tests/setup.ts`（已 preload）与前端 `tests/setup.ts`（已 setupFiles）里加 afterEach/afterAll：cwd 与 tmp 无新增文件、信号量归位、无残留 timer/子进程、进程级计数器归零 | test-infra | **小** | 泄漏 / 污染 / 重入整类 |
| G3 | **夹具工厂层 + 禁止自举夹具** — `tests/factories/`：`seedTask({repoCount,private,members})`、`seedActors([...])`、`seedRepoWithSubmodules(n,{nested})`、`workflowFromCanvas()`、`recordedOpencodeOutput()`；加规则禁止用被测模块的纯函数生成夹具键 | test-infra | 中 | 13 条缺口 + 整个「假绿」类 |
| G4 | **分叉维度矩阵化** — 六张表优先：`WsChannelKind × 撤销复核策略`、`RuntimeKind × 交互式提问禁用`、`NodeKind × 时间语义`、`InternalAgentKind × {configKey,nullable,设置页入口}`、`HUMAN_GATE_SURFACES` 注册表、`path 端口生产者 × 强制归档` | type-system | 中 | 组合空间整类 |
| G5 | **CI 拓扑改造 + 「守卫已执行」汇总门** — e2e/build-binary 加 `if: always()`（或 needs 只留 build-binary）；漂移哨兵改 `push` 触发；汇总 required check 断言「实跑数 = 应跑数」 | ci-gate | **小** | **其余所有守卫可信度的前提** |

### P1

| # | 守卫 | 层 | 成本 |
| --- | --- | --- | --- |
| G6 | 变异测试基建：守卫 id → 定向劣化补丁 → 期望变红的测试 id，守卫不变红即失败 | ci-gate | 中 |
| G7 | `sourceLock()` 帮助函数 + 文本锁配对断言棘轮（存量只对新增强制，逐条清零后转硬失败） | test-infra | 小 |
| G8 | 共享 AST 扫描原语 + inventory 棘轮框架（6 个各写一份 lexer 的守卫迁过去；3 行声明一条新棘轮） | test-infra | 小 |
| G9 | 外部依赖契约哨兵：`tests/integration-claude/`；opencode 私有表 `PRAGMA table_info` 哨兵；`OPENCODE_CONFIG_CONTENT` 压过 repo 本地同名 agent 的行为验证（**平台安全模型的基石，目前零行为验证**） | ci-gate | 中 |
| G10 | 多入口单一 builder + **穷举** wire 断言 + 能力可达性清单 | test-infra | 中 |
| G11 | 散文契约可执行化：写点棘轮 + 文档反向锁 + `allowTerminal` ratchet + `trySetTaskStatus` 吞掉的 false 分支加 warn | ci-gate | 小 |
| G12 | ~~单一机器可读 backlog~~ → **改写为：给现有索引加机器校验**（见 §4 批评 ⑦） | process | 小 |
| G13 | 状态与闸口写点收敛到具名 ADT（`allowedFrom` 只接受 `TaskTransitionEvent`，让 66 处手抄在类型层不可表达） | type-system | 中 |
| G14 | 资源上限与 ticker 共享原语：prompt/stdout 显式上限；13 个 `start*Loop` 收敛成 `createTicker()`；**迁移 SQL 全仓 breakpoint 守卫**；持久化资源回收注册表 | runtime-invariant | 中 |

### P2

| # | 守卫 | 层 | 成本 |
| --- | --- | --- | --- |
| G15 | 前端换参重置规则：`useDraftFromQuery` 增加必填 `entityKey`；枚举 15 条 `$param` 路由断言各自声明 remountDeps 或带 `key={param}` | lint-rule | 小 |

---

## 4. 完备性批评：本次审计自身的盲区

一名独立批评 agent 复审了综合结论。**它的 6 条补充我逐条核实后，4 条成立、2 条被证伪**——后两条正是它自己警告的「复述而不核实」：

### 成立的补充（应补审 / 补防护）

1. **灾难恢复整类缺席**：`services/backup.ts` 只导出 `createBackup`，**没有任何 restore/import**（全仓 grep `restore` 在路由层只命中技能版本回滚）。这个 tar **从未被任何测试解包 → 迁移 → 启动验证过**，用户拿它恢复能不能起来是纯未知。同族：无 down migration、`__drizzle_migrations` 已落记录导致迁移不可重放、SQLite WAL 崩溃/损坏无演练。
2. **性能退化被窄化成「OOM 与 E2BIG」，规模退化零门**：perf 门只 diff **5 个纯函数微基准**（零 DB、零 HTTP、零并发、零内存、零 bundle）；`docs/performance-notes.md` 列的 5 条已知规模问题无门；前端无 bundle-size 门。15 条结构守卫里**没有一条是性能守卫**。
3. **可访问性层被整个漏扫**：`e2e/a11y.spec.ts`（426 行，axe `wcag2a`+`wcag2aa`，13 个页面态）审计一字未提。它自陈**只 gate `critical`+`serious`、主动放掉 moderate/minor**；且 a11y 与视觉基线全部只活在 e2e 层——正好落在 `A-ci-topology` 指出的「被 backend 分片红静默吞掉」的最下游。
4. **「多用户」只做了授权维度，缺并发写丢更新维度**：`routes/workflows.ts:203` 的 `assertExactWorkflowRevision` + `workflow-version-mismatch` 是真实存在的**乐观锁**——两个人同时开画布自动保存（debounce 1s）撞版本，是这个产品最典型的多用户数据丢失形态，Top25 零条。
5. **`.github/` 目录未被扫描**：`ci.yml:13-18` 注释自陈 `OPENCODE_VERSION` "Must stay >= MIN_OPENCODE_VERSION … Bump together"——**跨文件双写、唯一约束载体是注释、无任何断言**，失效后果是 CI 用低于最低门的 opencode 跑集成而不报错。
6. **其余缺席的 bug 类**：时区/时钟、大数据量 UI（无虚拟列表）、离线/断连（WS 重连语义）、可观测性本身（告警可达性）、浏览器兼容（webkit 只在非阻塞 nightly）。

### 被证伪的批评（不要照做）

- ❌「i18n 缺全局 key parity 穷举」——**存在**：`packages/frontend/tests/i18n-batch-extraction.test.ts:40-47` 已做 zh/en 扁平化 key 树全等断言 + 每个叶子非空字符串断言，另有编译期 `Resources` 接口（`i18n/en-US.ts:6`）。批评所依据的「grep `zh-CN`/`en-US` 在测试文件零命中」明显错误（实际 105 个文件命中）。
- ❌「`node_run_events.node_run_id` 无索引」——**有**：`schema.ts:1464` `idx_events_node` on `(nodeRunId, id)`。批评看的 `schema.ts:588` 是 `workgroup_assignments` 表。真正的问题是 **`docs/performance-notes.md:114-118` 这份文档过期了**——它本身是机制 ⑧「散文失真」的又一个实例。

### 批评的元结论（我认同）

> 这份报告是一份优秀的**缺陷考古学**，但被当成了**覆盖率审计**交付。要补的不是更多守卫，而是先补一份**「功能面 × 覆盖层（unit / 集成 / e2e / 仅源码文本 / 无）」的枚举底座**——没有底座，「还有哪些没防住」永远只能靠抽样回答。

抽样偏差确有：Top25 里前端只占 4 条，而前端有 617 个测试文件。**建立枚举底座应作为 G0 与 G1 并列。**

---

## 5. 加固路线

按「性价比 × 阻塞关系」排序。G5 排最前是因为**它决定其余所有守卫的可信度**。

| 批次 | 内容 | 判据 |
| --- | --- | --- |
| **W0 快赢** | G5 CI 拓扑 · G2 全局不变式钩子 · 迁移 breakpoint 全仓守卫（`B6-data-2`）· 备份 `secret.key` 断言（`B6-data-5`）· fan-out errors port 文档反向锁（Top-4）· `docs/performance-notes.md` 纠偏 | 全是小改动，当天可完成，各自堵住一整类 |
| **W1 安全底座** | G1 契约表 authz 判别式 + 自动否定用例 · `writeSkillFile` realpath 遏制 · OIDC 链路行为测试 · 账号自服务 IDOR 三条 | 覆盖 205 条端点的授权层，一次到位 |
| **W2 真相层** | G3 夹具工厂 · `B4-runtime-1` claude slug 取证修正 · G9 外部依赖哨兵 | 消灭「假绿」；claude slug 是**确定性**的生产缺陷，不是概率 |
| **W3 结构** | G4 分叉维度矩阵化（先落 WS 撤销 + RuntimeKind + HUMAN_GATE）· G13 状态写点 ADT · G14 资源上限与 ticker | 把复发变成编译期不可能 |
| **W4 有牙** | G6 变异测试 · G7 sourceLock 棘轮 · G8 共享 AST 原语 | 验证守卫本身有没有牙 |
| **W5 补盲** | 枚举底座（功能面 × 覆盖层）· DR 恢复演练 · 规模性能门 · a11y 门槛收紧 · 并发写丢更新 | 批评指出的六类缺席 |

---

## 6. 加固过程中现场发生的一次事故（共享工作树，值得单列）

落 W0/W1 的过程中我自己撞了一次，形态正是机制⑦「多入口 / 共享载体」的变体，记在这里当作规程补丁：

**经过**：提交 `tests/contracts/registry.ts`（一个所有功能都往里追加条目的**共享登记表**）时，用 `git commit -- <path>` 提交了整份文件，把并发 session **尚未提交**的 8 条 `/api/onboarding/*` 条目一并带进 HEAD；而其 `routes/onboarding.ts` 当时还是未追踪文件 ⇒ CI 红（7 条 zombie registration + 2 条 happy-path 404）。

**第二次红**：我按「绝不删除他人代码」的规矩把条目从 HEAD 撤回、原样留在工作树。这在孤立地看是对的——但**在我的「带走」和「撤回」之间，对方把 RFC-211 正式提交了**，而那次提交**不含** registry.ts，恰恰是因为经我第一步之后他们工作树里的该文件已与 HEAD 一致、看不出差异。于是我的撤回把一个刚合入的功能打成了「路由存在但未登记」。第三次提交补回条目才收口。

**结论（已同步进 per-user memory）**：

- 一旦把别人的行带进 HEAD，就等于接管了一个**移动中的目标**——之后无论撤不撤，都在和对方的下一次提交抢时序。
- 因此**提交前要按 hunk 查归属**，不能只查跨文件符号依赖：`git diff HEAD -- <file>`，凡有不属于自己的 hunk，就重建「基线 + 只有我的 hunk」再提交，而不是「先整份带走、事后清理」。
- 廉价的识别信号：**registry / index / 表格类**文件（人人往里追加）几乎必然是混合文件。

这条与本报告的主论点自洽：**「靠人记得做的事」迟早会漏，能变成机器强制的就该变成机器强制的**——这里缺的正是一条「提交前按 hunk 校验归属」的自动检查。

---

## 附：方法论备注

- 每条缺口由**两名立场相反的验证者**独立审过，任一驳回即出局；26% 的误报率说明「本仓测试按 RFC 编号命名、不按被测模块命名」确实极易导致误报——这也是任何后续审计必须保留对抗验证环节的理由。
- 所有断言要求 `file:line` 锚点 + 列出实际 grep 过的关键词（至少 3 个不同角度）。
- 本报告自身也犯了它批评的错误（见 §4 两条被证伪项）：**任何审计结论在落地前都应当再核一遍锚点**。
