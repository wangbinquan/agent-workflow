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
| A4 | skill（Intent / 资源包的数据库部分）：版本规则与字节合同（design §2.3）；删除剩余 arms 与重复分派；AC-1 结构锁 | 1（skill）、9、11 |

每一步都是完整的需求单元：实现、接线与用例全部写完后集中验证一次，再提交并跟 CI；不在步内反复验证半成品。
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

## 冲突面

- resource-catalog 全域、intent apply、knowledge-evolution fusion、`services/resourcePackage/**`、`services/bundle/**`、资源 routes 与 MCP 资源工具；
- `bootstrap/daemonHttpComposition.ts`、`bootstrap/maintenanceWorkerGraph.ts`、`bootstrap/daemonLifecycleProgram.ts`；
- Part B 的 schema 与迁移：`platform/persistence/**`、目标 schema 合同、迁移规则（与 RFC-398 重叠，故排在其后）。

## 验收清单

- [x] proposal §5、§7 确认（2026-11-02，全部按推荐，见 proposal §7）
- [ ] proposal AC-1～AC-5
- [ ] 推送后 exact SHA 的 CI 全绿（AC-6）
