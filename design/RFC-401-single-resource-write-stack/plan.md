# RFC-401 实施计划

**前置**：proposal §5、§7 的用户可见变化逐项确认后才开工（2026-11-02 已确认）。Part B 另需 RFC-398 Done（两边都改迁移面；2026-11-01 已 Done）。
全部实现与用例完成后集中验证一次。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-401-T1 | 按确认结果固定错误矩阵（code / status / message / details / 首错顺序）、技能字节合同与引用去重规则；写成合同测试的期望表 | design §2 |
| RFC-401-T2 | 六类资源的变更计划与 tx 参与者：统一引用、默认值、版本、唯一冲突归一（provider 中立）、成员重建规则；保留 agent 关系与 workflow 索引的原子写入 | design §3 |
| RFC-401-T3 | Intent、资源包、普通 CRUD、demo / fusion 种子、数字员工模板、内建 workflow、动态 workflow 保存全部接入；code-capability 保持 owner 参与者；删除两套 arms 与重复分派；资源包循环改为 `agent-dependency-cycle` | design §3 |
| RFC-401-T4（Part B） | AtomicApply 持久 claim / lease / fencing token、续租与接管、尾部完成标记；目标 schema 与迁移；两种 provider 同一合同；沿用 `intentRecovery` 作业 | design §4 |
| RFC-401-T5（Part B） | 技能 create / save / 文件写删 / ZIP 单项、fusion approve、skill restore 接入 AtomicApply；membership 与版本同事务；fusion 发布失败后的状态一致 | design §5 |
| RFC-401-T6（Part B） | 旧 journal 清零判据与证据；兼容读取器与执行器分开；清零后删除旧 skill operation 生命周期与零调用 legacy 写函数 | design §6 |
| RFC-401-T7 | 用例：三入口 × 两 provider 错误矩阵、变更计划、lease 竞争与崩溃、技能 / fusion / restore 故障点、字节与事件；守卫与账本精确更新 | design §7、§8 |
| RFC-401-T8 | 集中验证：后端全量（含根目录守卫）、P0 变异 lane（触及 owner fence 时）、实现门（只审功能）；推送后跟 CI | — |

**顺序**：Part A = T1 → T2 → T3 → T7（Part A 部分）→ T8；Part B = T4 → T5 → T6 → T7（Part B 部分）→ T8。两部分各自提交。

### Part A 分步（2026-11-02）

Part A 涉及三条写入路径约一万行写入代码（Intent 端口 1582 行、资源包 arms 1569 行与参与者 1287 行、普通 CRUD 仓库与语义约 2500 行、
种子与模板），各资源类的参与者彼此独立、错误矩阵也按资源类成立，按资源类分次提交（CLAUDE.md §RFC workflow 第 5 条）。A3 再按资源类拆成
A3a（workflow）与 A3b（workgroup）：两者的写入栈、场景规则与错误矩阵互不依赖，workflow 一侧还连带 Intent 草稿期图校验与确认页的改动。

| 步 | 范围 | §5 覆盖 |
| --- | --- | --- |
| A1 | agent：参与者合同与唯一实现；普通 CRUD、Intent、资源包、数字员工模板、fusion / demo 种子接入；排序容忍环；引用去重（design §2.4） | 1（agent）、3、4、5、6 |
| A2 | MCP 与 plugin：参与者；同 spec 插件不重装；MCP 配置字段保留规则统一 | 1（MCP / plugin）、10 |
| A3a | workflow：参与者；放开 Intent 的 workflow 重名与保存期完整图校验（草稿期图校验改为提示）；内建 workflow 目录与演示 / 融合种子接入 | 2、8 |
| A3b | workgroup：参与者；成员规则统一 | 1（workgroup）、7 |
| ~~A4~~ | ~~skill（Intent / 资源包的数据库部分）：版本规则与字节合同（design §2.3）；删除剩余 arms 与重复分派；AC-1 结构锁~~ → 并入 Part B（见下） | 1（skill）、9 |

每一步都是完整的需求单元：实现、接线与用例全部写完后集中验证一次，再提交并跟 CI；不在步内反复验证半成品。

**2026-11-02 调整：原 A4 并入 Part B。** 研究 A4 时确认：技能的「内容不变不增版本」（§5 第 9 项）与字节合同（design §2.3）必须在
暂存之前判定内容是否变化，判定点在三套技能工件 owner（本地文件、CrewStation 托管、数据库字节）里；Part B 的 G4 正是把技能写入连同
这些工件迁入 AtomicApply、重写工件合同。在 Part A 里先改一遍，G4 会整段重写。技能的数据库写入（Intent / 资源包两份）、§5 第 1 项的技能
部分（`intent-name-conflict` → `skill-name-in-use`）、名称预检（`occupiedNames`）的整段删除与六类 AC-1 结构锁因此随 G4 一起落地。
§5 第 11 项（资源包已选基线先于资源层 stale）在五类 DB-only 资源上已由 A1–A3b 落实，技能沿用同一顺序。另：按 CLAUDE.md 文首硬规则
第 1 条，Part B 不再按资源细分批次——全部实现与用例写完后集中验证一次。
设计门：本会话自审（只审功能），结论记在各步的「集中验证」。

### A1（agent）落地与集中验证（2026-11-02）

- **实现**（design §9.2）：唯一的 agent 写入参与者 `RC/infrastructure/agentMutationParticipant.ts`（合同 `RC/application/ports/agentMutation.ts`）；
  普通 CRUD、Intent agent 端口、资源包 agent arm、数字员工模板接入，fusion / demo 种子经其种子插入；Intent 排序与资源包规划器不再在环上
  抛错；资源包 agent 载荷的 external 引用只解码为 id；`domain/agentDependencies.ts` 删去 `intent` 判据；四类引用去重（design §2.4）；
  闭包库存改在调用方事务里读（`createTransactionAgentResourceInventoryReadPort`），本批新建的技能视为可用。
- **用例**：新增 `T/rfc401-agent-error-matrix.test.ts`（14 组输入 × 三入口 × 两种 provider）与结构锁
  `T/architecture/rfc401-agent-write-participant.test.ts`（含负例，登记 guard-manifest）；依赖旧差异的既有断言按统一合同改写：
  RFC-395 A5 写入者用例与账本、`rfc271-bundle-planner`（环不再抛错）、`rfc271-import-commit`（external 引用改报普通编辑的码）、
  `rfc234-resolve-bundle`（agent 不再预检名称）、`rfc395-a5-reference-ports`（删去 `intent` 判据）、W20 / W44 依赖遍历对拍
  （只剩参与者一处）、RFC-345 / RFC-349 / RFC-395 的源码锁与 T29、表归属两本账。
- **集中验证**：
  - 静态：typecheck 0 错误，eslint（`--max-warnings 0`）与 prettier 通过。
  - 第一轮：针对性验证集 496 个文件（凡涉及 agent 写入、Intent apply、资源包、数字员工模板、种子、闭包与依赖校验的用例，全部架构守卫与
    读源码 / 账本的守卫），5 进程，本地 tmpfs PostgreSQL，SQLite + PostgreSQL 两种 provider：489 个通过。
  - 查出本 RFC 引入的问题 5 处，均已修，都是用例或账本没跟上搬迁：T29 唯一插入账本（Intent 端口 7 → 6、demo 种子 2 → 1）；表归属账本
    删去 Intent 端口对 `runtimes` 的一条；W20 / W44 按函数名抽取的依赖遍历对拍改指参与者；错误矩阵 stale 一例的 details 期望写错
    （三入口实测相同，是期望少写了 `{ resource: 'agent' }`）。
  - 其余 3 个文件（`admin-only-gate`、`agents`、`rfc190-overview-route`）是 PostgreSQL 的 application-lifetime 钩子在负载 20～28 下
    5 s 超时；第二轮 2 进程复跑与上面 5 处一起共 30 个文件全部通过（含全部读 guard-manifest 的守卫）。
  - 按已提交源码出报告的用例：在「HEAD `0707c87c7` + 本候选」的导出仓库里，138 个架构守卫与 `rfc370-committed-architecture-source`
    全部通过。
  - 本步不触及 owner fence，按 T8 不跑 P0 变异 lane。
- **实现门**：本会话按路径限定自审（只审功能）。三入口经同一参与者，错误矩阵逐条相同；模板的执行合同端口对账对现有模板是恒等变换
  （启动期同步不会每次改写）；资源包 / Intent 的场景基线仍先于资源层（§5 第 11 项）。已知代价：资源包与 Intent 的每个 agent 写入现在
  都做一次 RFC-228 闭包校验（读全量库存），与普通编辑每次保存相同。PASS。
- **CI**：`b00be9c37` 主 CI `41491898920` 67/70，git-protocols-e2e 通过。红的两格都不归 A1（证据见 `docs/audit-backlog.md`
  「第九条」2026-11-02 后端腿补记与「第十二条」）：
  - shard 16/44：`rfc311-perf-guards` AC-11 塌方探测，PG 的 G1 过滤视图 P95 10522ms（该用例整条 71.4s，同分片其余 PG 性能用例各约 8s），
    测量窗口里 runner / PG 停顿；本机在该候选上两侧 P95 33ms / 32ms，25/25 通过；A1 不触及任务目录读路径。
  - shard 20/44：`rfc359-w8-t28-lost-update` L6 [postgresql] 并发删兄弟任务时维护 claim 转移漏出 40001；A1 不触及任务删除、维护 claim 与
    事务原语，相关生产文件最近的实质改动在 RFC-395。
  按 CLAUDE.md 不以重跑为据：A1 的 CI 以后继 A2 提交的 CI 作证据。

### A2（MCP 与 plugin）落地与集中验证（2026-11-02）

- **实现**（design §9.3）：唯一的 MCP / plugin 写入参与者（`RC/infrastructure/mcpMutationParticipant.ts`、`pluginMutationParticipant.ts`，
  合同 `RC/application/ports/mcpMutation.ts`、`pluginMutation.ts`；MCP 配置校验迁入 `RC/domain/mcps/mcpConfig.ts`）；普通 CRUD 仓库、Intent
  端口、资源包 arm 接入；资源包覆盖保持规格不变时事务前不安装（`currentPluginSpecReader`，proposal §5 第 10 项）；Intent 名称预检对
  MCP / plugin 也交给参与者。
- **用例**：新增 `T/rfc401-mcp-plugin-error-matrix.test.ts`（MCP 名称冲突 / 类型不可变 / stale / no-op，plugin 名称冲突 / stale；三入口 ×
  两 provider）与 W12 plugin 发布对拍里的「覆盖保持规格不变不重装」；A1 的结构锁推广为 `T/architecture/rfc401-resource-write-participants
  .test.ts`（agent / MCP / plugin 三类，含负例；guard-manifest 换条）；依赖旧形状的用例与源码锁按参与者改写：W4-D16 / D17、W12 MCP /
  plugin、W19、RFC-271 的 MCP 围栏与插件更新、RFC-285 B6、RFC-349 两份、T29 账本（Intent 端口 6 → 4）。
- **集中验证**：
  - 静态：typecheck 0 错误，eslint 与 prettier 通过。
  - 第一轮：针对性验证集 443 个文件（凡涉及 MCP / plugin 写入、Intent apply、资源包的用例，全部架构守卫与读源码 / 账本的守卫），4 进程，
    SQLite + PostgreSQL：435 个通过。查出本步引入的问题 7 处，均已修，都是源码锁 / 账本描述的是写点搬走之前的位置（Intent 端口直接写
    `mcps` / `plugins` 与其 await、提交期重读 owner、W19 的插入语句、B6 的 private 铸造计数、T29 处数）；其余 1 个（`admin-only-gate`）
    是负载超时。
  - 第二轮：上面 8 个文件加矩阵、结构锁与全部读 guard-manifest 的守卫共 32 个文件，2 进程，全部通过。
  - 按已提交源码出报告的用例：在「HEAD `b00be9c37` + 本候选」的导出仓库里 139 个全部通过。
- **实现门**：本会话按路径限定自审（只审功能）。三入口经同一参与者，矩阵逐条相同；CRUD 的因果时钟（RFC-201）对语义 no-op 照旧观测
  一次；Intent 的 OAuth 回填留在场景（模型产物的还原）；资源包同规格覆盖不调用安装器、installedAt 不动，换规格照常安装。PASS。
- **CI**：`d90b2de9e` 主 CI `41499630442` 68/70：Playwright e2e（macos-latest shard 1/4）排队 25 分钟后被取消，始终没分到 runner
  （runner 为空、零步骤），`CI required` 因此判红；没有任何测试失败。A1 / A2 以后继 A3a 提交的 CI 作证据（A3a 以二者为祖先）。

### A3a（workflow）落地与集中验证（2026-11-02）

- **实现**（design §9.4）：唯一的 workflow 写入参与者（`RC/infrastructure/workflowMutationParticipant.ts`，合同
  `RC/application/ports/workflowMutation.ts`，只有它驱动定义 + 依赖索引的写入原语）；普通 CRUD 的新建 / 复制 / 保存、Intent workflow 端口、
  资源包 workflow arm、内建 workflow 目录（系统写入）接入，演示 / 融合种子经参与者模块的种子写入。Intent 不再预检 workflow 名称（§5
  第 2 项）；提交期不再跑图校验，草稿期的图校验 error 改存 `validation.graphErrors`，INTENT.md 单列、照旧触发图修复，确认页提示、不禁用
  提交（§5 第 8 项，取代 RFC-358 D3 / D7 的阻断部分）。
- **用例**：新增 `T/rfc401-workflow-error-matrix.test.ts`（重名允许、图校验不拦、按名字调用不可见 workflow、不可见 agent、脚本作者门、缺规范
  agent id、stale；三入口 × 两 provider）；结构锁加 workflow 一类并锁退役的码与函数；改写依赖旧形状的用例与源码锁：RFC-358 图校验（提交
  不拦、INTENT.md 的图校验一节）、RFC-355 apply 码清单、RFC-199 写入清单、RFC-395 写入边界、RFC-349 三份适配器锁、T29 账本（Intent 端口
  4 → 3，演示种子与复制路径出账）；前端 `intent-detail-inline` 锁图校验 error 与「不可用」不禁用提交。
- **集中验证**：
  - 静态：三个包 typecheck 0 错误，eslint（`--max-warnings 0`）与 prettier 通过；前端 Intent / i18n 用例 30 个文件 271 条通过。
  - 第一轮：针对性验证集 458 个文件（凡涉及 workflow 写入、Intent turn / apply、资源包、内建目录与种子的用例，全部架构守卫与读源码 / 账本
    的守卫），5 进程，SQLite + PostgreSQL：449 个通过。查出本步引入的问题 5 处，均已修：
    - 首错顺序：普通编辑此前「规范 agent id 先于改名校验」（`rfc359-w16-workflow-boundary-conformance` 锁定），参与者把场景 guard 放在了
      规范化之前；改为规范化与回填之后、作者门之前（Intent 此前也是规范 agent id 先于 owner-only / 禁止改名）。
    - 源码锁与账本描述的是写点搬走之前的位置：RFC-349 三份、T29。
    - 矩阵期望写错两处：资源包缺 agent 引用由 wire 格式先拒（`package-invalid`）、无脚本作者权时预览不提供「新建」
      （`package-decision-not-allowed`），都是先于共同写入层的场景码；design §9.4 关于资源包缺 agent id 的一句随之更正。
    - 其余 3 个（`admin-only-gate`、W5 路由面、T19 迁移准备）是 PostgreSQL 的 5 s 钩子在负载 20～35 下超时。
  - 第二轮：上面 9 个文件加全部改名 / 保存路径与读 guard-manifest 的用例共 112 个文件，3 进程：111 个通过，`admin-only-gate` 再次负载超时、
    单独复跑通过。
  - 按已提交源码出报告的用例：在「HEAD `d90b2de9e` + 本候选」的导出仓库里 139 个全部通过。
- **实现门**：本会话按路径限定自审（只审功能）。三入口经同一参与者，矩阵逐条相同、场景码先于共同层；普通编辑的
  code / message / details 与首错顺序不变（W16 / W12 / RFC-199 / RFC-231 / RFC-270 的既有用例照旧通过），校验改对事务内被写的那一行
  执行；Intent 的 owner-only 与禁止改名仍在共同规则之前报出（规范 agent id 除外，与此前 prepare 期相同）；本变更之前生成、图校验
  error 混在 `errors` 里的草稿仍按阻断显示，重新生成一轮即可。PASS。
- **CI**：`61f705dbd` 主 CI `41509059552` 70/70，windows-platform 与 visual-regression-nightly 通过。`61f705dbd` 以 A1 / A2 为祖先、
  二者的产出原样保留，同时是 A1、A2 的后继证据。

### A3b（workgroup）落地与集中验证（2026-11-02）

- **实现**（design §9.5）：唯一的 workgroup 写入参与者（`RC/infrastructure/workgroupMutationParticipant.ts`，合同
  `RC/application/ports/workgroupMutation.ts`，唯一写 workgroup 行与成员行的地方）；普通 CRUD 的新建 / 复制 / 保存、Intent workgroup 端口、
  资源包 workgroup arm 接入；三条入口的新建请求经 `workgroupCreateSnapshot` 落成快照；Intent 不再预检 workgroup 名称（§5 第 1 项）、人类
  成员无效改报 `workgroup-member-user-invalid`（§5 第 7 项）；事务外的成员预检（`resolveAgentIdsUsable`）与仓库的初始 ACL 入参删除。
- **用例**：新增 `T/rfc401-workgroup-error-matrix.test.ts`（重名、无效人类成员、不可见 agent、不存在的 agent、stale、Intent 不改名单时保留
  成员行；三入口 × 两 provider）；结构锁加 workgroup 一类（扫描原始行写入）并锁 `workgroup-human-inactive`；改写依赖旧形状的用例与源码锁：
  RFC-225 写入清单、RFC-231 私有新建、RFC-285 B6 导入 private、RFC-345 / RFC-349 ×2 源码锁、T29 账本（Intent 端口 3 → 1）、表归属账本
  （Intent 端口两条债还清，`users` 一处随搬迁记为后继身份）、W4-D18 / W15（初始 ACL 入参）；W24 / W26 / W28 的对拍去掉已删除的 Intent / 资源包
  私有快照与成员构造（三处都改用普通编辑的那一份）。
- **集中验证**：
  - 静态：typecheck 0 错误，eslint（`--max-warnings 0`）与 prettier 通过。
  - 第一轮：针对性验证集 461 个文件（凡涉及 workgroup 写入、Intent apply、资源包、成员与快照对拍的用例，全部架构守卫与读源码 / 账本的守卫），
    5 进程，SQLite + PostgreSQL：451 个通过。查出本步引入的问题 8 处，均已修，都是源码锁 / 账本 / 对拍描述的是写点搬走或删除之前的形状
    （表归属账本、T29、RFC-285 B6、RFC-349 两份、W24 / W26 / W28 的私有构造）；其余 2 个（W5 路由面、W26 空扫描）是 PostgreSQL 的 5 s 钩子
    在负载下超时。
  - 第二轮：上面 10 个文件加全部改过的用例与读表归属账本的守卫共 18 个文件，3 进程：14 个通过；余下 4 个是第二轮才暴露的同类锁
    （B6 的「无 public 字面量」扫到了 workflow 参与者里内建目录的系统分支、RFC-349 两处断言已删的辅助函数）与 W26 空扫描的负载超时，
    修后与 W26 一起单进程复跑 5 个全部通过。
  - 按已提交源码出报告的用例：在「HEAD `61f705dbd` + 本候选」的导出仓库里 139 个全部通过。
- **实现门**：本会话按路径限定自审（只审功能）。三入口经同一参与者，矩阵逐条相同、场景码先于共同层；普通编辑的 code / message /
  details、首错顺序与时钟 / 成员 id 的消耗次序不变（W15 / W4-D18 / RFC-164 的既有用例照旧通过）；复制沿用 fail-closed 与
  `workgroup-copy-name-conflict`；Intent 与资源包改用普通编辑的当前快照后，没有身份的成员行按占位 id 处理（design §9.5 已记）。PASS。

- **CI**：`8b58a8e5d` 主 CI 67/70：backend shard 2/44 的 `rfc401-resource-write-participants`「整语料负例」在带覆盖率的 runner 上用时
  5.6 s，超过缺省 5 s 超时（本步引入，`CI required` 随之判红）；macOS e2e shard 1/4 没分到 runner、零步骤被取消（基础设施）。超时由
  `0ad2c71ec` 放宽到 30 s，其 CI 70/70；`0ad2c71ec` 只改这条用例的超时，A3b 原样在其祖先里，作 A3b 的后继证据。

## Part B 落地（T4 持久 claim / lease、T5 技能 / fusion / restore 与原 A4、T6 旧引擎退役）

按文首硬规则第 1 条，T4–T6 全部写完后集中验证一次、一次提交。设计见 design §10。

- **T4**：`atomic_apply_claims`（epoch-2 history 0001，owner `platform/atomic-apply`）；`stateMachine` 的 claim 同事务落持久 claim，每次状态写以
  令牌 fencing，执行期每 20 s 续租，committed 记尾部 pending、完成后 complete 并释放；恢复先接管（只接管过期或没有 claim 的记录）再补偿 /
  前滚，十分钟窗口删除。Intent 与资源包两个场景接入；用例 `T/rfc401-atomic-apply-lease.test.ts`。
- **T5**：
  - 唯一 skill 写入参与者 `RC/infrastructure/skillMutationParticipant.ts`（合同 `RC/application/ports/skillMutation.ts`）：普通 CRUD、ZIP、restore、
    fusion、Intent、资源包都经它写 `skills` / `skill_versions`；新建重名 409 `skill-name-in-use`（含唯一约束归一）、复合前置条件、
    版本号必须是 contentVersion + 1、内容不变 already-current、description 变化 metaRevision + 1、删除前事务内复查引用。
  - skill 写入场景 `RC/infrastructure/skillAtomicApply.ts`（journal `skill_apply_journal`，epoch-2 history 0002，scene `skill`）：claim 事务取技能锁
    （被占 409 `skill-operation-busy`），终态结算释放；新建先暂存 v1 再写 ready 行（没有 `reserving`）；提交后失败由 AtomicApply 恢复前滚，
    维护作业 `intentRecovery` 与启动步骤 `skill-operation-recovery`（先排空旧记录再收敛）都收敛本场景（`RC/infrastructure/skillApplyRecovery.ts`）。
  - fusion approve 经场景：版本、记忆标记与 applying → done 同一事务，发布与候选清理是尾部；提交后发布失败时融合仍是 done（§5 第 12 项）。
    `SkillTreeVersionOperations` 的 stage / inTransaction / publish / abort 合并为 `applyVersion`，tx-bound capability 删除。restore 经场景，
    退回记忆在同一事务。
  - 字节合同：`RC/infrastructure/skillMarkdown.ts` 一份序列化器（lineWidth 0），与当前 SKILL.md 解析等价时保留原字节；普通编辑、ZIP、Intent、
    资源包、CrewStation 三套 owner 都用它。Intent / 资源包内容不变不推进版本，已提交 journal 里未写入的一代按未发布清理（处置
    `cleanup-unwritten`；旧格式操作仍按缺失代际报错）。
  - Intent 删除名称预检（`occupiedNames`、`intent-name-conflict`、端口 `listOwnedNames`）；AC-1 结构锁加 skill 一类。
- **T6**：旧漏斗的四段（stage / commitInTx / publish / abort）、`createManagedSkillWithFiles` 的 reserve 生命周期、`deleteManagedSkillOp` 删除；保留
  兼容执行器（`recoverSkillOperations` 启动排空、`composeLegacyIntentSkillArtifactCompat`、`resourcePackageOperationRecovery`）；锁 GC 不回收
  未结算 journal 的锁。
- **用例**：新增 `T/rfc401-skill-write-stack.test.ts`（参与者、场景、恢复、字节合同、锁 GC）、`T/rfc401-skill-error-matrix.test.ts`（三入口 × 两
  provider 的重名与版本规则）、fusion 发布失败用例（`T/rfc370-v20-fusion-orchestration.test.ts`）、跨版本行桥（`T/rfc401-epoch2-history-bridge.test.ts`；
  t19h 的原始工件改在 history root 构建）；旧生命周期的用例改写为 journal 语义，旧记录
  的兼容排空保留手工构造的用例（`T/helpers/legacySkillVersionWrite.ts`）；四段拆分的 `rfc271-skill-version-split` 随四段删除。
- **集中验证**：
  - 静态：typecheck 0 错误，eslint（`--max-warnings 0`）与 prettier 通过，`db:schema-history --check` 与 registry 一致。
  - 第一轮：针对性验证集 761 个文件（凡涉及技能、Intent apply、资源包、fusion、维护收敛、升级矩阵的用例与全部架构守卫），6 进程，SQLite +
    PostgreSQL：732 个通过。查出本步引入的问题（均已修）：参与者没有沿用内容 owner 给出的 live / 版本引用（Intent 与资源包的选定存储）；
    唯一冲突归一改用 `uniqueViolationTarget`（T29 账本 Intent 端口一条销账）；续租的直接 `setInterval` 违反 RFC-376 棘轮，改为自排程链；
    `platform/atomic-apply/composition.ts` 缺失；版本号改在取锁之后读；序列化器每个字段只读一次；用例与锁的旧形状——旧字节（W40 / W47 /
    W12）、尾部每轮重放与十分钟窗口（RFC-234 / RFC-343 / W8）、`reserving` 中间态、相同摘要的夹具、AC-1 / A6 / T29 / 源码锁、夹具边界；
    RFC-271 的 AC-24g / AC-25 / AC-25b 随四段删除失去点名，改由新用例锁定（资源包两个技能覆盖 + 第三个 op 失败不留部分提交）。
  - 第二轮：除升级矩阵外 693 个文件，6 进程：684 个通过；余下 4 个是本轮才暴露的同类问题（AC 锚点、维护作业对拍的第三个场景、
    composition.ts 的非运行角色登记、AC-25b 断言过严），修后与其余 5 个（PostgreSQL application-lifetime 钩子在负载 25 左右 5 s 超时）一起
    2 进程复跑；仍超时的 3 个（`skills`、`rfc223-pr1-impl-gate`、`rfc370-m2-task-archive`）单进程复跑全部通过，非运行角色计数的守卫同批通过。
  - 按已提交源码出报告的用例：在「HEAD `f91a60f3e` + 本候选」的导出仓库里 139 个中 138 个通过，余 1 个是非运行角色登记的计数，修后在工作树
    复跑通过。
  - 第三轮（全量：余下的后端用例按内容分两批，665 + 1446 个文件，2～6 进程；与前两轮合计覆盖全部 2873 个后端用例文件）：查出的本步问题
    均已修——用例与锁的旧形状（维护作业 owner command 改为三个场景、AtomicApply 回放对拍以持久 claim 表达在途、锁的回收、资源包
    PostgreSQL 源码锁里随参与者移走的 `visibility: 'private'`、备份的 active 表数、按 history 头版本取 PostgreSQL catalog），以及下一条的
    跨版本行桥；其余是 PostgreSQL application-lifetime 钩子与 5 s 默认超时在负载 20～40 下超时、git 操作超时与随之而来的连接关闭 / 死锁。
  - 跨版本行桥（design §10.4）：t19h 逻辑恢复与迁移状态只读两个用例暴露——0001 / 0002 之后 history root 不再是 head，平台行桥只折叠
    epoch-1 steps，任何跨版本的桥都失败，PostgreSQL 逻辑恢复也拒收升级前的备份。修正后新增 `rfc401-epoch2-history-bridge`，t19h 的原始
    工件改在 root 构建（含真实 PostgreSQL 的旧备份恢复）；恢复、迁移与 history 相关的 46 个文件 3 进程全部通过。
  - 复跑：上面各轮的失败文件、全部 138 个架构守卫与本步新增 / 改动的用例共 196 个文件 2 进程复跑，182 个通过；余下 14 个里 1 个是资源包
    PostgreSQL 源码锁的第二处 `visibility` 断言（已修），13 个是同类负载超时，单进程复跑全部通过。typecheck 0 错误，123 个改动文件 eslint
    通过。导出仓库（HEAD `f91a60f3e` + 最终候选）里按已提交源码出报告的 139 个用例与恢复 / 行桥的 3 个用例全部
    通过。
  - 本步不触及 task-execution 的 owner fence；CI 的 P0 变异 lane 照常运行（含技能启动恢复与复核两条）。
- **实现门**：本会话按路径限定自审（只审功能）。普通编辑、ZIP、restore、fusion、Intent、资源包都经唯一 skill 写入参与者；无栅栏的普通写入
  在锁内读版本基线，不会把 claim 之前别人提交的版本当成 stale；内容不变的写入照样过栅栏；提交后失败的锁由 journal 持有、恢复终态写回同一
  事务释放，锁 GC 不回收；fusion 的 `before` 先于栅栏、提交后发布失败仍是 done。已知限制写入 design §10.2（维护 Worker 前滚时主进程的
  启动可用判定要等下一次写入或重启）。跨版本行桥：只有 epoch-2 版本带 edge，epoch-1 的 steps 折叠不变；带 edge 的版本逐步与下一版本
  合同比对，改标签或改合同都被拒；index-only 桥仍拒新增表；恢复源解析只接受 history 内的旧摘要且目标须为完整 head，恢复循环对新增表
  计零行。PASS。

- **CI**：`9498cca64`（run 41578061019）第一次 68/70：Windows e2e shard 1/4 的 `crash-recovery.spec.ts:370`（多次 SIGKILL 重启）
  两次都在首个任务的 10 s「等 running」上超时，`:307`（SIGTERM）同样超时后重试通过（flaky），`keyboard-flows` 一条 flaky；同一
  job 里同一场景 `:237` 用同样的 10 s 等待两次都通过，此前 6 次 main CI 该 shard 全绿；本步没有改动从建任务到 running 的路径
  （启动步骤 `skill-operation-recovery` 的阶段与接线未变，agent 不带技能），归因 Windows runner 的时序而非本步。只重跑失败 job 一次
  （attempt 2）全绿；这次重跑只作佐证，不单独作为通过依据。windows-platform 通过。

## T6 收尾：零生产调用的 legacy 资源写函数（proposal G5）

Part B 只完成了 G5 的技能部分；agent / workflow / workgroup 的零调用 legacy 写函数与 YAML 导入写入者在本步删除（design §10.3
「零调用 legacy 写函数」）。

- **删除**：`legacy/agent.ts` 的 create / update / rename（含两段式 prepare / commitInTx）、`legacy/workflow.ts` 的 create / update /
  copy / `insertWorkflowInTx` / `prepareWorkflowSave` / `commitWorkflowSaveInTx`、`legacy/workgroups.ts` 的 create / copy / save /
  rename（含 prepare / commitInTx）与 `broadcastWorkgroupCreated`、`legacy/workflow.yaml.ts` 的 `importWorkflowYaml`；随之不可达的
  `RC/application/agents/agentReferences.ts`、`RC/infrastructure/legacy/importRefs.ts`。四个 legacy 文件 3457 → 628 行，只剩读取（src 净删 3522 行）。
- **用例**：新增 `T/helpers/model/resourceWrites.ts`（夹具写入只调用生产入口），107 个用例文件改为从这里导入；断言旧专有语义的
  用例按生产合同改写，只锁两段式接缝 / YAML 导入的用例随被测代码删除（`rfc223-import-refs` 整个文件，W14 / W31 / W32、RFC-223
  写入围栏、RFC-243、RFC-395 A2、RFC-282 的相应用例），源码锁改锁生产参与者（RFC-203、RFC-270、RFC-231、RFC-282）。
- **集中验证**：typecheck 0 错误，136 个改动路径 eslint（`--max-warnings 0`）与 prettier 通过。
  - 改写的 108 个用例文件（SQLite + PostgreSQL，3 进程）：91 个通过；17 个里本步问题均已修——夹具名称不合生产规则（大写
    agent / MCP / plugin 名）、owner 为空的断言、旧专有错误码（disabled plugin、workgroup schema 错误）、旧「系统」写入者在
    workflow 上的内建只读与 workgroup 保存后的广播（夹具改为 admin 身份走目录操作）、两段式竞态窗口的期望、指向已删代码的源码锁；
    其余是负载 40～97 下的钩子 / 5 s 超时。17 个单进程复跑全部通过。
  - 定稿批次：108 个用例 + 全部 138 个架构守卫，3 进程：245 个通过，余 1 个（`agents`）负载超时、单进程复跑通过。守卫里查出并已改：
    AC-1 结构锁旧导入方、RFC-395 引用边界、表归属债三条、测试引擎写死账本一条。
  - 读取或导入 legacy 模块源码的另外 26 个用例：21 个通过；查出的本步问题已修（RFC-199 / RFC-225 写入清单、W12 写入程序锁、
    RFC-104 源码锚、RFC-282 D2 与 RFC-345 facade 锁），连同负载超时的共 11 个单进程复跑全部通过。
  - 导出仓库（HEAD `9498cca64` + 本候选）：按已提交源码出报告的 141 个用例全部通过。

## 冲突面

- resource-catalog 全域、intent apply、knowledge-evolution fusion、`services/resourcePackage/**`、`services/bundle/**`、资源 routes 与 MCP 资源工具；
- `bootstrap/daemonHttpComposition.ts`、`bootstrap/maintenanceWorkerGraph.ts`、`bootstrap/daemonLifecycleProgram.ts`；
- Part B 的 schema 与迁移：`platform/persistence/**`、目标 schema 合同、迁移规则（与 RFC-398 重叠，故排在其后）。

## 验收清单

- [x] proposal §5、§7 确认（2026-11-02，全部按推荐，见 proposal §7）
- [ ] proposal AC-1～AC-5
- [ ] 推送后 exact SHA 的 CI 全绿（AC-6）
