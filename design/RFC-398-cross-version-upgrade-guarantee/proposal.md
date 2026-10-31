# RFC-398 跨版本升级保障：启动时自动完成数据库 epoch 切换 + 发布版升级矩阵用例

- **状态**：In Progress（2026-10-31 用户批准 v6，C1～C12 逐项确认；其中 C4 自动建库、C11 纳入 v0.18.18 / v0.18.19 PG 桥接、C12 留存 v0.19.3 产物均选推荐项。设计门六轮，第 6 轮 PASS，处置见 design §10）
- **来由**：用户 2026-10-30 报告生产环境（单二进制 + PostgreSQL）从 v0.19.2 升级到 v0.19.3 时「数据库没有触发自动迁移」
  「数据库迁移失败」，要求「在用例里固化验证跨版本的数据迁移能力，确保以后不会出现跨版本数据无法迁移的问题」。
  同日用户裁决：①跨 epoch 升级改为**启动时自动完成**（无阻塞项则自动执行并继续启动，有阻塞项才拒绝并逐项给出指引）；
  ②用例采用**两层**：每个 PR 用仓内冻结迁移链按每个已发布版本造库并灌入覆盖全部表的业务数据，再走当前代码升级并逐项核对；
  发版门 / 夜间从 GitHub Releases 下载正式版二进制真实造库并跑任务，再用候选二进制升级并做 API 级验收。
  用户另说明实现阶段可以用 Codex 作为执行 agent。
- **修订关系**：修订 RFC-395 migration §1「每次正式执行必须生成可审阅的 MigrationPlan……用户批准具体实例的执行后再进入
  维护窗口」与 §3「目标二进制遇到旧库进入迁移说明 / 维护入口」——单机部署默认改为自动执行（可配置回到人工流程）。
  RFC-395 的转换规则、校验判据与回执模型不变。

## 1. 背景

### 1.1 复现（本机，2026-10-30）

旧库一律用 GitHub Releases 的**正式版二进制**产出（macOS arm64；v0.19.2 SHA-256 `60f781d7…dfa61d7`），业务数据由
v0.19.2 二进制配合仓内 stub runtime 真实跑出（2 个任务停在 `awaiting_review`、1 个 `failed`、1 个 `canceled`，
外加记忆蒸馏作业等）。被测的 v0.19.3 为 tag `v0.19.3` 对应源码（`d7b5d9da6`，与当前 `main` 的产品代码相同）。

| # | 旧库形态 | v0.19.3 行为 |
| --- | --- | --- |
| S1 | v0.19.2 SQLite，仅种子数据 | `start` 拒绝：`This is an epoch-1 installation. Run db migration plan…`；手工 `plan → run --approve → start` 成功 |
| S2 | v0.19.2 SQLite，上述业务数据 | 同 S1；手工切换后批准迁移前挂起的评审，任务跑到 `done` |
| S3 | v0.10.0 → v0.14 → v0.16 → v0.17 → v0.18.0 → v0.18.10 → v0.19.2 逐级升级的 SQLite 库 | 手工 `plan` 无阻塞项 |
| S4 | v0.19.2 SQLite，库为 WAL 模式但目录里没有 `-wal/-shm`（干净关闭、拷贝到新机器、从备份恢复后都是这种形态） | `start` 直接以一句 `unable to open database file` 退出；`db migration plan` 在 `freeze: live source snapshot` 失败 |
| S5 | 已切换到 epoch 2 的 SQLite 库同样缺 `-wal/-shm` | `start` 误报 **database corruption detected**，并建议 `restore` 旧备份（照做会丢数据） |
| S6 | v0.19.2 PostgreSQL：经 v0.19.2 的一键迁移（`db migrate --to postgresql --auto`）从 SQLite 迁来，迁移操作停在 `accepting-writes`（v0.19.2 下不 finalize 也一直正常运行） | `start` 拒绝：`Finish or roll back RFC-349 operation … before planning the epoch switch.`；`db migration plan` 报 `v3-rfc349-in-flight`；v0.19.3 的 `db migration status / finalize <op>` 把 v1 指针当 v2 解析，zod 报错——**v0.19.3 自己没有任何出路** |
| S7 | S6 先用 v0.19.2 二进制 `finalize` | 还须由人另建**空目标库**与**空 scratch 库**并导出两个环境变量，才能 `plan --target postgresql --target-url-env … --scratch-url-env …` → `run` → `start`；切换后 daemon 必须永久带着目标库的环境变量 |
| S8 | v0.18.19 PostgreSQL（同样经一键迁移而来；v0.18.18 同理） | v0.19.0、v0.19.2 启动即报 `database generation schema digest does not match this binary`；v0.19.3 转换器报 `Unknown source fingerprint`：这两版的 PG 基线在 v0.19.0 前被改写过，之后的版本都不认——**自 v0.19.0 起就没有升级路径**（既有缺口，不是 v0.19.3 引入） |

用户的生产即 S6（单二进制 + PostgreSQL，`start` 直接拒绝）。

### 1.2 根因

- **R1 设计**：RFC-395 把 epoch 切换定为每实例人工 `plan → 审阅批准 → 离线 run`；`start` 与 `migrate` 遇到 epoch-1 安装
  只抛指引（`bootstrap/daemonStart.ts:265-269`、`modules/system-operations/domain/epochSwitch/classification.ts:93-99`）。
  对「换二进制、重启」的常规升级动作来说，这等于升级必然失败。
- **R2 PostgreSQL**：单机 PG 源必须额外提供 scratch 库（`bootstrap/epochMigration.ts:387`，`v3-scratch-required`）与独立
  目标库；未 finalize 的 RFC-349 操作直接阻断计划（`modules/system-operations/application/epochSwitch/planner.ts:83-84`），
  而 v0.19.3 的 RFC-349 `status / finalize` 路径读不了 v1 指针。原生建在 PG 上的安装还要人工设置
  `AGENT_WORKFLOW_SOURCE_BORN_ON_POSTGRESQL=1`（`bootstrap/epochMigrationEntry.ts:30`）。v0.18.18 / v0.18.19 的 PG 基线
  不在冻结的支持源里（S8）。
- **R3 缺陷**：多个 SQLite 读路径以 `{ readonly: true }` 打开磁盘上的库。WAL 库缺 `-shm` 时只读连接无法创建它，于是：
  转换快照（`platform/persistence/migration/legacy/sqliteSnapshot.ts:7`）、启动分类
  （`modules/system-operations/infrastructure/epochSwitch/bootAdmission.ts:99`）、epoch-2 启动完整性门与 schema history
  读取（`platform/persistence/databaseProviderRuntime.ts:596,611`）都会失败。v0.19.2 的完整性门在已读写打开的连接上执行
  `quick_check`（v0.19.2 `packages/backend/src/db/client.ts:309-337`），没有这个问题；RFC-395 II-b（`045abf20a`）改成单独的
  只读连接后引入 S5 的回归。`db/integrity.ts:32-48` 已有 `allowWalSidecarCreation` 开关，只有原始快照用了它。
- **R4 测试与流程**：唯一的端到端切换用例（`e2e/rfc319-ops-doctor-and-migrate.spec.ts` OPS-015，仅夜间）用仓内冻结链造的
  **空库**（`e2e/fixtures/epoch1-switch-home.ts`）、走人工 CLI；滚动升级用例（`packages/backend/tests/upgrade-rolling.test.ts`）
  只有 SQLite、冻结点与发布版无关、数据极少。没有任何用例用「真实发布版二进制产出的库」去启动新版本，没有 PG 源的端到端
  切换，发版流程（`.github/workflows/release.yml`）也没有升级门。S4～S7 因此全部漏过。

## 2. 目标

- **G1 自动切换**：单机部署的 `start` 与 `migrate` 遇到 epoch-1 安装时自动完成 epoch 切换并继续；计划无阻塞项时零人工。
  有阻塞项时拒绝启动，逐项列出原因与处理命令。切换中断后再次启动从原操作续做。
- **G2 PostgreSQL 零准备**：自动处理停在 `accepting-writes` 的 RFC-349 遗留操作；自动在源库所在服务器上准备目标库与 scratch 库；
  自动判定「原生建在 PG 上」；切换后不要求运维新增任何环境变量。权限不足时给出一次性的 DBA 指令，DBA 建库后再次启动即自动继续。
  v0.18.18 / v0.18.19 的 PG 实例经桥接纳入支持（S8）。
- **G3 修复只读打开缺陷**：所有可能遇到「WAL 库缺 sidecar」的磁盘库读路径统一处理，S4、S5 不再出现。
- **G4 两层升级用例**：
  - **L1（每个 PR）**：发布版升级矩阵——对**每个**已发布版本，按该版本真实写入的迁移收据（含发布后被改写过的迁移的原始字节）
    用冻结链造出它的库，并通过「种子账本」（每条迁移附带的种子行）让该版本 schema 的**每一张表**都有业务数据，然后经当前代码升级，
    逐行核对回执与落位、逐列核对保留表、按 API 核对业务投影；SQLite 与 PostgreSQL 两种 provider，epoch 1 与 epoch 2 分开装配。
  - **L2（发版门 + 夜间）**：下载正式版二进制真实造库、跑任务（含 S4、S6 形态），用候选二进制启动升级并做 API 级验收；
    发版门不通过则 release 保持草稿；夜间覆盖登记表中全部有产物的发布版。
- **G5 制度化**：每个发布版登记进升级矩阵并录制数据集；发版门检查上一个发布版已经登记，未登记即拒绝发布。
- **G6 可诊断**：`doctor` 对 epoch-1 安装说明下一次启动会做什么（含 PG 建库权限检查），不再报 `ENOENT`；RFC-349 遗留操作的
  `status / finalize` 在新版本上可用。

## 3. 非目标

- 不改 RFC-395 转换器的转换规则、行处置、校验判据与回执格式；本 RFC 只改入口编排、源库打开方式、PG 目标定位与遗留操作收尾。
- 自动模式不跨 provider（SQLite 仍转 SQLite，PostgreSQL 仍转 PostgreSQL）；PostgreSQL → SQLite 仍不支持。
- 不自动确认「可确认项」（无法再推进的旧代码工作归档）：沿用 RFC-395 用户裁决，逐项人工确认。
- CrewStation 托管的切换仍由平台迁移 Job 驱动，不改托管流程；L2 不覆盖托管形态。
- 不在本 RFC 内发布新版本；修复版的发布时机由用户另行决定。
- 不改正常运行期的读写路径与任务执行语义。

## 4. 用户故事

1. 作为单机 SQLite 部署的运维，我停掉旧版本、换上新二进制、`start`；日志里看到自动备份、转换、校验的进度，几分钟后服务照常可用，
   历史任务、等待中的评审与反问都在，批准后任务继续跑完。
2. 作为单机 PostgreSQL 部署的运维（经旧版一键迁移而来，从没 finalize 过），我同样只换二进制再 `start`；新版本自己收尾旧迁移操作、
   在同一台 PG 上建好新库并切过去，`config.json` 与环境变量都不用改。
3. 同上，但 AW 的数据库账号没有建库权限：`start` 退出并打印两条可直接交给 DBA 执行的 `CREATE DATABASE` 语句；建好后再 `start`
   即自动完成。
4. 作为需要人工审阅的运维，我在 `config.json` 设 `autoEpochMigration: false`，行为回到 RFC-395 的人工流程。
5. 作为维护者，我改了任何持久化相关代码，PR 的 CI 会把「每个已发布版本的库 + 覆盖全部表的数据」升级到当前代码并核对；发版时，
   候选二进制还要通过「真实旧版本二进制造库 → 升级 → API 验收」的门，否则 release 不会公开。

## 5. 能力 / 行为影响清单（请逐项确认）

| # | 变化 | 影响 |
| --- | --- | --- |
| C1 | 单机 `start` / `migrate` 遇到 epoch-1 安装默认**自动切换**，不再停下等人工批准 | 可设 `autoEpochMigration: false` 回到人工流程；托管不受影响 |
| C2 | 自动模式自动接受计划里的 restrictions（终态历史中无法证明的行记为 history-only，依赖它们的重试 / 恢复被拒绝，查看不受影响） | 写入自动升级回执与启动日志；有 restrictions 时日志用 WARN 逐条列出 |
| C3 | 切换在 `start` 内完成后 daemon 立即启动并产生首次业务写入，**首写前撤回窗口**在自动模式下实际不可用 | 源库与切换备份照旧保留；回到旧版本只能用切换前备份 + 旧二进制（丢失切换后的新数据），与 RFC-395 首写后语义一致 |
| C4 | PostgreSQL 自动模式在源库所在服务器上**新建数据库**：目标库 `<源库名>_epoch2`、scratch 库 `<源库名>_epoch2_scratch`（按源库的 locale provider 与字符集建库） | 业务数据此后在 `<源库名>_epoch2`；源库与 scratch 库原样保留（scratch 供迁移追溯重放使用，保留期后可由运维手工删除）；外部的备份 / 监控若按库名配置，需要改指新库（`doctor`、`status` 与启动日志都会给出实际库名） |
| C5 | 停在 `accepting-writes` 的 RFC-349 操作被自动 finalize（与 v0.19.2 `db migration finalize` 的效果相同） | 关闭回到 SQLite 的撤回窗口：PG 有首次写入后该窗口本就不可用；PG 尚无写入时，这等于放弃一次只有旧二进制才能执行的撤回。其余阶段的 RFC-349 操作仍拒绝并给出指引 |
| C6 | 自动模式下 PG 源是否「原生建在 PG 上」由程序判定（无 RFC-349 迁移记录即视为原生），不再需要 `AGENT_WORKFLOW_SOURCE_BORN_ON_POSTGRESQL=1` | 转换器仍按源 catalog 事实核对（6 张归档表必须不存在），判定错误时阻塞而非静默通过 |
| C7 | 读 SQLite 磁盘库时，若库为 WAL 模式且没有 `-wal` 文件，改为「读写打开、不写任何数据」以便 SQLite 创建 sidecar | 不改变库内容；与 `db/integrity.ts` 已有的 `allowWalSidecarCreation` 语义相同 |
| C8 | 发版流程新增升级门；上一个发布版未登记进升级矩阵时拒绝发布 | 发版多一个约 15～30 分钟的作业；每次发版后用一条命令把该版本登记进登记表 |
| C9 | 自动切换的校验失败时，在首次业务写入前**自动撤回**并拒绝启动，之后的启动不再自动重试 | 源库保持原状、旧二进制仍可用；修复后用 `agent-workflow db migration auto --retry` 重新开始 |
| C10 | 开发约定：新增迁移或 epoch-2 schema history 版本时，必须同时提交覆盖新表的种子行与映射预言，否则用例失败 | 写在 `CLAUDE.md` 与 `docs/dev-gotchas.md`；守卫自动检查 |
| C11 | v0.18.18 / v0.18.19 的 PG 实例经「按该版本原始合同读回 SQLite@0223 再转换」的桥接升级（S8） | 这些实例自 v0.19.0 起首次获得升级路径；桥接前后逐表行数与逻辑摘要不等即阻塞 |
| C12 | 发版工作流改为先过升级门再上传 release 资产；已撤下的 v0.19.3 产物复制到一个**不公开的草稿 release** 长期留存，供升级用例使用 | 草稿 release 对外不可见；这是一次 GitHub 操作，需你确认；不同意则改用 tag 源码构建（证据等级较低） |

## 6. 验收标准

- **AC-1**：S1～S6 与 S8 每种旧库形态，用候选版本**只换二进制再 `start`**（不执行任何迁移命令）即可启动；历史数据、等待中的评审在
  升级后可见，批准评审后任务跑到 `done`，新建任务跑到 `done`；重启一次仍正常。S6 在建库权限充足时零人工。
- **AC-2**：PG 账号无建库权限时，`start` 以非零码退出，输出包含可直接执行的两条 `CREATE DATABASE` 语句；DBA 执行后再次 `start`
  自动完成切换。
- **AC-3**：计划有阻塞项时 `start` 拒绝启动，逐项输出阻塞原因与处理命令，源库与指针不变；`autoEpochMigration: false` 时行为与
  RFC-395 人工流程一致。
- **AC-4**：在切换的任一阶段杀掉子进程、父进程或两者，再次 `start` 从同一自动会话续做到完成（父进程被杀时子进程自行做完，
  新 `start` 等待其结束），不新建第二个操作、不重复建库、不产生重复数据；`activated` 之后中断的会话仍会补做校验与回执。
- **AC-5**：S4、S5 形态（WAL 库缺 sidecar）在启动分类、转换快照、epoch-2 启动完整性门、schema history 读取等全部读路径上
  均不再失败；源库字节不变。
- **AC-6**：L1 发布版升级矩阵在每个 PR 的 CI 上运行并全绿：登记表中**每个**发布版（按真实收据去重）都有带数据的升级用例，
  SQLite 全覆盖、PostgreSQL 覆盖 v0.18.18 起的 epoch-1 版本与全部 epoch-2 版本；每个版本构建后该版本 schema 的**每一张表**都有数据，
  豁免清单经用户确认、每条写明原因；核对包含逐行回执与落位、保留表逐列值与业务 API 投影。
- **AC-7**：L2 在发版工作流中位于构建与公开之间：ubuntu（SQLite + PostgreSQL）、macOS（SQLite）、Windows（SQLite）全部通过才
  公开；夜间工作流对 `main` 覆盖登记表中全部有产物的发布版。以 v0.19.3 产物作候选时 L2 必须失败，且失败发生在候选启动阶段、签名与
  本次事故一致（证明这道门能拦住它）。
- **AC-8**：发版门在上一个发布版未登记或缺种子覆盖时失败并说明缺什么。
- **AC-9**：`doctor` 在 epoch-1 安装上给出「下一次启动将自动升级」的说明（PG 另报建库权限），不再报 `ENOENT`；
  `db migration status / finalize <RFC-349 操作>` 在新版本上可用，且不会写出 v2 指针。
- **AC-10**：校验失败时首写前自动撤回、拒绝自动重试，`db migration auto --retry` 可重新开始。
- **AC-11**：既有用例、架构守卫（含 `rfc395-v3-dormancy`）与主 CI 全绿；Codex 设计门与实现门（只审功能）已处置。
