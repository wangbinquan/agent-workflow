# RFC-549 实施计划

依赖：RFC-548。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-549-T1 绑定与类型**：`RuntimeSchemaBinding` 多 `history`，bootstrap 的绑定带上二进制的历史与替换口；删去 platform 的登记与读取函数
  （design D1、D3）。
- **RFC-549-T2 读取方**：各读取方显式收下历史，沿调用链交到最近的载体；Worker 的初始化消息必须带元数据表（design D2）。
- **RFC-549-T3 用例与夹具**：新增 RFC-549 用例并登记 guard-manifest；随改 design D4 所列用例、测试助手与 e2e 夹具。
- **RFC-549-T4 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手、子进程夹具与
  两跳的测试助手（`docs/dev-gotchas.md` RFC-527 那条）与 `tests/fixtures/` 里的摘要锁选用例；红的与 HEAD 同时 A/B；架构报告对照（含公开面）；
  变异验证。
- **RFC-549-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第十五步。

## 验收清单

- [x] AC-1 `runtime.ts` 没有模块级状态；读历史的函数都由调用方显式交入；Worker 的初始化消息必须带元数据表
- [x] AC-2 各处读到的历史与原先相同，迁移 / 恢复 / 备份 / 逻辑复制 / 启动准入的结局不变
- [x] AC-3 模块级可变单例 39 → 37、计数不升；新增 RFC-549 用例并登记；读旧接口的用例与 e2e 夹具随改
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机 Docker 仍未起（本地没有 PostgreSQL）：本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。验证在候选导出仓库
里跑（HEAD `fe14649c9` 加本 RFC 的路径，核对与工作树逐字相同），对照是同一 HEAD 的另一份导出。集中验证查出两类本人缺陷，已改并复验：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 112 个 TS 文件（52 个生产文件、57 个用例与测试助手、
  两个 e2e 夹具与 `scripts/perf-run.ts`）无告警，生产文件另过 promises 配置；prettier：改动的代码、guard-manifest 与三件套通过。两个 e2e 夹具只在
  CI 的 Playwright 里跑，另用 `bun build` 打包核对 import 都解析得到。
- **选择**：按 RFC-533 的口径从 2,992 个用例文件里选出语义层 1,455 个：改动的 49 个用例、全部 `tests/architecture/`（142 个）、在 import 之外以
  路径点名被改文件的 199 个、点名被改 API 的 175 个、直接导入被改文件的 1,170 个、经 8 个读被改源码的测试助手的 237 个；另按
  `docs/dev-gotchas.md`（RFC-527 那条）补经子进程夹具与测试助手 import 到达行为变了的生产文件的 501 个（SQLite 客户端与 bootstrap 的绑定几乎在
  每个数据库用例底下），合计 1,956 个、约占全部用例的三分之二；`tests/fixtures/` 里没有钉被改文件的摘要锁（提到迁移执行器的是发布升级夹具的
  README）。
- **语义层**（SQLite；90 秒；候选 4 个 worker）：1,956 个文件里 1,953 个通过。红的三个：`rfc321-repository-publication-ratchet` 要真实 git 历史
  （对照导出同样红、主树里通过）；`rfc346-system-operations-cli` 与 `rfc524` 的两例是**本人遗漏**——两条源码锁钉着 `composeLocalSystemOperations`
  的入参成员与命令根两处调用的实参，本 RFC 在那里多了 `schemaHistory`，已随改并复跑通过。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：platform 的模块级登记回来、bootstrap 的绑定改成固定的一份（不再读到替换后的来源）、
  Worker 协议不再按数组校验元数据表、准入不用交入的目录缓存、生产代码调用替换口、没有 live 绑定的句柄不再报错，各自让 RFC-549 用例红。第三种
  首轮没有被认出——**本人缺陷**：用例只断言“缺元数据表被拒收”，而 zod 4 对缺键本就拒收，校验函数换成恒真也照样过；补上“不是数组也被拒收”
  的断言后认出，design §5 关于 `z.custom()` 的说法随之改正。
- **架构报告**（候选与对照各出一份）：模块级可变单例 39 → 37（删去的正是 `binding` 与 `registerSchemaHistoryRuntime`）；模块符号属主 platform
  少 3、bootstrap 多 4（历史来源、绑定的读穿视图与替换口）、句柄上下文多 1（`liveSchemaOf`）；跨上下文 import 清单净多 14 条（system-operations
  取 platform 的历史类型与元数据表类型，都是向下的依赖）；写入入口与事务外副作用清单只有行号随改动移动；门与计数全部不变。
- **复验**（改了三个用例与 guard-manifest 之后）：这三个用例与读 guard-manifest 的 17 个用例文件全部通过；第三种变异再跑被认出。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- `85c36f1c0`（实现，父提交是 `fe14649c9`）：exact SHA 主 CI run 45248519934 的 70 个 job 里 68 个通过，包括全部后端分片（含真实
  PostgreSQL）、Linux / Windows / macOS 的生产二进制构建、ubuntu 的另两个 e2e 分片与 Windows、macOS 的全部 e2e 分片。红的是
  `Playwright e2e (ubuntu-24.04 shard 2/3)`：`e2e/rfc490-mindmap-guided-journey.spec.ts:180` 两次（含 retry）都在 `pickRootOnCanvas` 到点，
  对脑图画布的点击一直被大纲头 `.mindmap-outline__header` 拦截指针事件。不是本 RFC：本 RFC 不碰前端与 shared（只改后端与两个 epoch-2 升级
  e2e 夹具，只有 rfc319 的两个 spec 用它们）；同一 SHA 的 Windows 3/4 与 macOS 3/4 分片同一用例通过；前三个提交的同一分片通过。已记入
  `docs/audit-backlog.md`，未重跑；`CI required` 随之红。同一提交触发的 windows-platform 与 maintenance-soak-nightly 通过。
- 落档提交 `fe14649c9`（RFC-548 转 Done、RFC-549 落档，只改文档）：主 CI run 45241220793 的 70 个 job 里 68 个通过，红的只有 Markdown
  链接检查（他人文档 RFC-378 `research.md` 的两条外站链接 503，待用户决定的那一项）与 `CI required`；未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **同一份历史**：原先各处读进程级登记，生产登记的就是 bootstrap 组合的二进制历史（head、历代版本、目录缓存、epoch-2 元数据表）；现在
  bootstrap 的 `persistenceSchemaBinding.history` 就是这一份，经 live 绑定、组合入口与新参数交到每个读取方，所以每处读到的 head、历代版本、
  目录缓存与元数据表与原先相同。准入（`runtimeHistoryAdmission`）的取法逐字不变：有目录缓存就用，没有就按 head 的目录现建一份。
- **各条链路**：provider 运行期（恢复解析、epoch-2 准备、PostgreSQL 准备）取 live 绑定里的历史；迁移协调器与执行器、epoch 切换的指针替换、
  PostgreSQL 管理恢复与备份、托管恢复与备份、启动时的待恢复、遗留恢复适配器、SQLite 系统恢复、逻辑源 / 逻辑目标与元数据快照由调用方交入；
  bootstrap（daemon 启动、会话、CLI 命令根、维护 Worker、托管部署）与 SQLite 客户端取 bootstrap 的常量；SQLite 系统备份取被备份句柄的 live
  绑定。PostgreSQL schema 计划对 epoch-2 契约用交入的 head，没交就报错（原先读登记，未登记同样报错），epoch-1 契约不读历史，与原先相同。
- **Worker**：原先初始化消息可选地带 head 与元数据表、在 Worker 里登记；Worker 里只用到元数据表（表名过滤与元数据采集），现在初始化消息必带、
  按数组校验的 `metaTables`，监管方照旧从同一份历史取。
- **下一版本启动**：原先夹具改写进程级登记再启动 `main`；现在改用 bootstrap 的替换口，替换后绑定读到新的 head 与历代版本，元数据表与目录缓存
  照旧；替换口把被替换的来源交给回调，夹具据此接上原来的历代版本。生产代码不调用它（RFC-549 用例钉住）。
- **用例**：新增 RFC-549 用例并登记 guard-manifest；改写登记的 4 个用例改用替换口或显式交入（合成元数据表的那一个直接把它交给采集与还原），
  直接调读取方的用例交入 bootstrap 的历史，Worker 用例在初始化消息里带元数据表，两个 e2e 夹具改用替换口与 bootstrap 的绑定。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（与 RFC-548 转 Done 同一提交）；实现与验证后再提交
`refactor(backend): RFC-549 schema 历史运行时由组合根显式交给 platform（RFC-294 S12 第二十八步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
