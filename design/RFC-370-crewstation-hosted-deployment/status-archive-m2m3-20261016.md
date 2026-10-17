# RFC-370 M2/M3 在制品历史记录（2026-10-15 ～ 16，已被 v3 修订取代）

> 本文件逐字保存 status.md 在 2026-10-16 接手审视前的 M2/M3 开发记录与「集中验证与发布候选」一节，仅作历史。
> 这些段落描述的 v2 在制品已按 [v2 重设计](./redesign-v2-20261014.md) §9 审视并重新实现：
> 其中的恢复 hold／保留卷／检查卷、工作卷捕获、事件来源切换、六套对象发布日志、逐写 schema digest 与 18 对未发布迁移已按 §9.3 删除，
> 迁移已按 V11 收敛为 SQLite 0259／PG 0035。文中的计数、迁移号、证据路径与「待完成」均只对应当时的候选，不再代表当前状态；当前状态见 [status.md](./status.md)。

## 2026-10-16 集中验证与发布候选

作者已明确“按推荐实现”：RFC-040 的独立子模型平台映射、RFC-042 的独立空库恢复与显式维护切换均已完成生产实现和测试用例编写。下方开发记录保留原时点，后续“未运行”“待裁定”等历史描述以本节为准；RFC 仍为 In Progress。

- AW 固定 Bun 1.4.3 的 RFC-370 集中后端验证覆盖 229 个文件、SQLite 与独立 PostgreSQL，共 2236 项：首轮 2204 pass / 32 fail。32 项失败归因后完成修复，9 个失败文件的全部 74 项已逐一复验通过；这是首轮加修复复验的合并证据，并非一次全绿全量运行。保留原失败日志和中途挂起记录。
- 共享合同 15 项、前端相关 39 项及编译 Worker／损坏归档边界 3 项已完成针对性验证；后端、前端类型和修复路径 lint／promise lint 通过。旧 Bun 1.3.13 的不完整运行不计为通过。
- 新合同为 SQLite 0277 / PostgreSQL 0053，227 source / 221 active / 6 archive-only。新增不可变 V7 迁移边只允许同列唯一索引从全量约束放宽为带条件约束，并验证投影 SQL；历史迁移不改。恢复前的执行记录与 hold 原样保留，只有精确匹配新受理命令的显式独立重启可以越过历史预约，普通续跑仍被阻止。迁移尚未应用到正式 AW。
- CS RFC-040/042 的 `3c1d2eab1a71430045f18624139991834f5bb8b2` 已推送，GitHub CI `38887997096` 全部 9 个作业 success，8 个平台部署 Ready，正式 AW 两个 Pod 身份不变。实际页面／API 验收发现纯摘要镜像档位复制与生产数据库列表范围问题，已完成修复和用例，修复候选的完整门禁继续。真实 OpenCode 不同模型委派、独立数据库恢复与显式切换尚未通过；隔离服务 v0.1.3 的迁移任务因单节点 CPU 请求额度不足而排队，原数据库未切换。
- AW 的 3 个 M1 本地提交及后续 M2/M3 候选尚未推送。之前共享 main 发布被自动审批拒绝；本候选的准确 SHA CI、GitLab 发布、正式新版本与端到端验收均未获得，不以局部验证替代。
- 正式 M0 的两个 Pod 继续 Running/Ready、0 restarts，UID `67808ecd-2cb8-418b-98f1-4e7ce338bce3` 与 `0039a97f-e2ae-4647-9913-a99b4839c1cc` 保持；没有停止、删除或替换正式服务。

机器证据：`/private/tmp/aw-rfc370-central-validation-reconciled.json`、`aw-rfc370-central-validation-v143.log`、`aw-rfc370-v143-recheck.log`、`aw-rfc370-v143-recheck-remaining.log`、`aw-rfc370-skill-artifacts-final.log`、`aw-rfc370-repair-static.log`。后续按真实部署及准确 SHA CI 继续补齐证据。

补充关联验证（2026-10-16）：6 个原有业务／数据库测试文件共 53 项，首轮 49 pass／4 fail；直接和 CS 转发 ISSUE 流程在 SQLite／PG 四个 System Mock 端到端全部通过。表数断言随 227 source／221 active 合同更新；Drizzle thenable 的拒绝校验改为确认原始 guard Error 身份，保留事务／未发生业务写入的所有断言。修复后连同 schema 架构合同，4 文件／27 项通过。依赖分层检查通过（7／7 现存记录），退役一条当前图不再报告的过期条目；架构只读 census 补齐维护 bootstrap owner 和六个现有写点的实际 authority 分类后通过。原失败日志全部保留。

恢复预约补验（2026-10-16）：12 文件／204 项首轮 201 pass／3 fail。两项为新增用例的返回字段放错位置，一项为恢复集成用例结束后未还原全局数据库 provider；修正本人测试后，三个受影响文件全部 45 项／803 断言通过。其他迁移、V7 防篡改、日志与 SQLite／PG 用例首轮已通过。后端类型、相关 lint、架构只读 census r4 与单二进制构建 r2（46.5 秒）通过。机器证据保留于 `/private/tmp/aw-rfc370-restored-recovery-validation-receipt.json`、`aw-rfc370-restored-recovery-recheck-receipt.json`、`aw-rfc370-build-candidate-r2-receipt.json`；不将修复复验写成一次全量全绿。

## M2 开发记录

当前 M2 是独立未提交在制品，不包含在上述 M1 三个提交中，尚未执行功能验证。已写生产适配与对应测试用例：

- 多仓工作区复用 `materializeGroupSpace`，远端准备计划 v2 固定完整 sources / layout，兼容 M1 plan v1；涵盖嵌套挂载、稀疏成员、只读标记、显式目录和倒序回收。
- 上传经分块命令传输、完整摘要校验和同卷独占发布；保留既有重名、断点内容核对与失败补偿策略，CS 文件读取固定版本。候选提交、冲突现场、自动化 action／baseline 和员工案例均复用原有原生接收器，由任务助手执行。
- 普通文件合并冲突拆为既有准备／观察结果两段，远程 Agent 在两段之间执行；未确认停止的写者阻止后续合入与清理。子模块回调采用分步原生合并与任务卷上的已提交结果记录，避免重复调用已解决子模块的 Agent；已写多子模块成功、未解决和未退出用例。
- 系统 Agent 复用普通业务执行核心与托管 Agent 调用，命名 scratch 在持久任务卷中；稳定业务尝试 ID 关联平台执行与观测，事件附原始去重键，远端结果确认后结算，未知结果保留现场。M2 HTTP 执行组门控暂未解除。
- call／fusion 继承场景按持久工作区引用解析物理卷归属，保持子任务自己的执行 ID。删除计划在删除业务行之前冻结卷归属，子任务清理不关闭父卷，拥有卷的任务必须等平台确认物理释放；没有对现有正式实例执行任何删除操作。

- 自定义观察器在任务容器执行，原应用仍负责输入／输出信封、游标和 subject 校验；同一输入沿稳定执行键恢复，未知或未退出写者保留目录。原生执行也补上未退出时不清理的保护。
- 对象存储扩展流式上传、全量摘要校验与精确 Range 读取；对象到卷的传输按固定大小分块、核对字节数和摘要后原子发布。数字员工程序版本和输入上传记录保存各自的不可变对象引用，服务盘只接收 HTTP 临时上传。
- 开发／员工根新增选定内容根和仓库准备选择，两种数据库及 HTTP 根传递同一选择。开发基线与 case 场景使用同一持久卷；仓库刷新只快进、未知结果沿原命令键接管，基线准备后保存所属卷引用。回收枚举保存隔离目录的物理卷归属，借用父卷的子任务不删除父场景。
- CS RFC-040 已补齐大文件／二进制对象材料、引用固定和恢复，以及命令 Secret 发布授权／版本冻结／私有 Git；用户已授权，生产实现与用例已写齐，尚未完成集中验证。

- 开发证据、任务输入 blob 与尝试上下文保存到 CS 对象；新增 `development_object_artifacts` 元数据索引（SQLite 0260 / PG 0036）。保留已有 SHA blob、ULID bundle、范围下载与材料化合同；对象先固定引用，再在租约围栏内保存索引。加上本轮插件索引（SQLite 0261 / PG 0037）后，M2 当前 schema 206 source / 200 active，逻辑摘要 `sha256:17d0ff321d6c7fe926f009929d37ae64689ecde7e5cb85d30edcd324c53fe1ef`。
- 验证命令在任务卷执行原有脚本接收器，写者回执与最终结果落在任务卷；超时、未退出、响应不确定时保留目录，结算后才导入输出与清理。需求、流水线、审批的 9 类适配器复用原 argv／env 策略；变更操作固定幂等键和暂存目录，重启重试不重新触发外部变更。
- 运行时管理使用 Manifest 明确模型映射与 CS 兼容性证明，版本变化进入探测配置围栏；冒烟走真实远程 Agent 执行族，等待结算后才清理，失败保留现场。系统测试覆盖选中模型与结算失败，未执行功能测试。
- 评审正文以不可变对象回执保存在已有人工门日志，所有路由、评论、决定、前轮继承和运行期开门使用同一内容选择；未提交正文不可见。Git 回滚快照检查交给任务助手。已写双 provider 派发、冷读取、恢复、摘要异常及清理用例。
- 任务归档复用原终态维护协调器：JSONL 分块、任务文件流式对象化，完整目录 catalog 固定后以一个 DB 索引事务发布，再允许删除在线任务行。回放保留原始任务卷，归档恢复不依赖服务本地目录；追加远程执行绑定／事件、端口对象和事件 source key 的归档。已写整树、2001 条事件分块、发布回执丢失后的恢复、围栏失败和写者／符号链接拒绝用例。
- 对象引用版本与 CS 目录 CAS 版本分开：固定 AW 引用版本，上传／引用响应丢失后重试不会因 CS 目录版本增长而改变请求；补充引用释放方法及幂等测试。此修正目前在 M2 工作区，尚未提交发布。
- 插件安装在任务镜像运行原 npm／Git 安装器；固化完整依赖树、文件 mode、树内相对链接与 entry，拒绝循环／悬空／逃逸链接和祖先冲突。请求及结果回执落盘，原生安装完成但助手结果未落盘时从完整清单恢复。文件和清单固定对象引用后发布 `plugin_artifact_generations` 索引，回收按 releasing／released／retired 分段恢复，保留当前插件和在途 journal 引用；未结算写者阻止物理清理。
- 意图／资源包技能产物的 DB 暂存与不可变版本、插件产物 owner 与冷恢复已接到托管生产根；包含技能内容的事务围栏、已删除／被新版本替代时只清暂存、原有资源包 journal 严格解码与回执校验。已写真实 Intent 两资源提交后失权、重建 owner 恢复、发布回执丢失和错误归属拒绝用例。
- 维护 Worker 在实际启动时冻结主实例租约，独立使用小连接池，接入同一归档、资源包恢复、插件回收、Intent 工件与 scratch 内容；旧 Worker 不跟随 DB 中新拥有者。System Agent 保留引用改为可跨进程校验的稳定标识，清理前核对该作用域全部远程执行已结算；Intent retention 的失败／运行中 scratch 保留。相关冷恢复与 Worker 信封用例已写，未执行。

- MCP 诊断接入托管选择，沿用原诊断应用、ACL、会话／轮次与归一化 Agent 执行核心；每个会话独占持久父卷，逐轮稳定执行和观测 ID，远程回执不伪造 PID。恢复只读取原 attempt 的终态，未知提交、变化的 attempt 与恢复 hold 均保留；清理等待写者结算及平台物理释放。会话、事件和原生会话锁的写事务校验当前执行权，待机查询不启动恢复／清理；对应双协议及双 provider 用例已写。AW 已补 startup-inventory 严格解码与当前诊断／任务验证器接线，按档位 startupInventoryVersion=1 选择；未知／错误／缺失事实保持 unavailable 或 malformed，真实收到的清单才参与核对。CS RFC-040 已完成该事件和原生 MCP 材料的生产接线及用例编写，尚待集中验证和部署，diagnostics 门控保持。

剩余：CS RFC-040 集中验证与部署、AW 原生材料编译和能力声明、双协议联合实机验收、其余后台选择、完整能力矩阵与集中功能验收；M3 事件链路已并行进入开发，见下节。RFC-040 插件依赖树／mode／安全链接、对象固定引用和命令 Secret 冻结已进入生产实现；集中验证进行中。运行时／开发适配器、评审／归档／技能和任务镜像轮次的静态结果分别留档；资源完整接线的格式／lint／类型均已通过（`/private/tmp/rfc370-m2-*-scratch-final.log`）；随后又补写进程回执原子占位、祖先／子路径与符号链接检查、验证结果 fsync／冷恢复、插件冻结版本引用。M2 功能测试尚未执行，不能把静态检查或用例已写当作功能完成。最近一次只读复查：正式实例 blue／green Pod 均 Running、Ready，重启次数 0；没有执行部署替换、停止或删除。

## M3 开发记录

当前仍为未提交在制品，功能测试尚未执行。

- 托管根从 `AW_EVENT_SOURCES` 读取显式 producer／代码平台实例／API 根／仓库集合／事件目录 UUID／endpoint binding revision 与 transport mode。新增 `/integrations/crewstation/events`，只接受配置 JWKS 签发、目标 aud 匹配、`cs_kind=platform`、`cs_project=platform`、`sub=service:platform/cs-events` 的服务来源令牌；用户令牌不通用。来源判据与本机 CS 的 `34-cs-events.yaml` 及 `forwardAuthService.ts` 对齐。
- 精确校验 CS UUIDv7、信封与三个投递头；目录按 CS 两个 producer 的 40 个实际类型逐项映射，family 冲突拒收。GitHub／GitLab 的纯归一化已从旧 adapter 提到 integration domain，两种 transport 共用；直连签名检查仍在原入口。路由、API 根与 clone 地址限制在显式批准的来源实例及仓库。
- 接收事务一次保存 inbox、逻辑事件回执及全部目标，commit 后才 204；同 delivery／event 的变内容重投为 409，并累计审计冲突。首次路由绑定冻结，后续增删绑定不会给旧事件增加目标。无匹配仓库、已删除 endpoint、shadow、paused 均有明确结果。
- active worker 在围栏事务中将 MR stream／effect、规范化业务 delivery、永久 transport receipt 与两项观测义务一起提交；之后按原稳定 observation key 逐项补发布，两个 ACK 记录完成后才标 completed。业务 delivery 曾 failed 不会重新受理 MR；待发布目标阻止旧业务 payload 被 GC。Event Center 新观测的围栏检查位于其写事务内。
- 审计详情通过鉴权后的 `/api/integrations/crewstation/events/:deliveryId` 查询；原 webhook 详情明确 `cs-delegated`、`reserialized-json` 和关联 receipt。CS 接管 endpoint 后直连接收返回冲突；shadow 只留对拍事实，不派发。
- SQLite `0262`／PG `0038` 增加四张 integration 表，不改已有业务表行合同；当前 schema 210 source／204 active／6 archive-only，逻辑摘要 `sha256:9a3d2e5d9de9e2724d5bf152a1c4ffb371134be6474c6aea91ef86e4ef28d35f`。M2 的 0261 snapshot 前驱身份保持；PG 历史生成成功。
- 用例覆盖 40 类型及现有忽略、来源 token 不可互换、双引擎事务 ACK／冻结扇出／冲突、第一类成功第二类丢 ACK、业务 failed 后永久去重、真实 Event Center 围栏／补发布、删除／影子／暂停和 HTTP 合同。`/private/tmp/rfc370-m3-*-events-guard.log` 的格式／lint／类型通过；其后 UUIDv7 与 GC 回归补充尚待静态复查。

后续未提交候选（仍未执行功能验证）：

- API 自动化采用 CS 用户会话 cookie 加同一 AW 用户的 PAT。网关验证 CS 会话，AW 保留 PAT 的权限／用途边界；错误、撤销和跨用户 PAT 不降为浏览器权限。已接 HTTP 身份链并补真实 AuthRuntime／MCP 认证用例；CS 外部客户端实机验收尚待执行。用法见 `docs/crewstation-automation.md`。
- 维护 Worker 的全部 PostgreSQL 写入在原同一连接的事务内检查冻结租约；工作区维护接远程准备、scratch 与文件系统选择。事件归档以 prepared 意图 → 对象固定 → 原子发布索引并删除对应源事件推进；读取校验完整对象并保留 session ancestry。SQLite 0263／PG 0039 增加归档索引，HTTP 事件／stdout 与 session view 已接托管读取。
- 人工评审的对象恢复进入既有人工门后台任务，按固定间隔补完 committed 回执；prepared 清理必须有已提交后继版本证据，不能仅按时间删除。
- 数据库备份在同一 PostgreSQL 只读快照中导出逻辑行并解析对象引用，独立固定归档子块、插件依赖文件、员工程序／输入与评审正文。新备份日志先记录对象意图再固定引用，全部完成后才发布清单；旧 epoch 的未完成备份可冷恢复释放。手工与定时备份保留策略接维护 Worker，活动恢复源始终保留。数据库备份选择已接托管生产根。
- 空目标库恢复先下载并完整校验逻辑文件和依赖对象，再由原 PostgreSQL 逻辑目标复制；既有活动库拒绝覆盖。复制已 verified 而进程中断时，重启重新校验目标后激活；恢复的旧执行租约冻结，活动备份槽清空，原备份作为恢复源保留。`AW_RESTORE_OBJECT` 已接发布迁移 Job 和可选 Manifest 配置。平台侧空目标库配置／切换流程、恢复工作卷及管理界面仍待接通，不能据此宣称完整恢复已交付。
- SQLite 0264／PG 0040 增加备份目录与对象意图两表；该阶段 schema **213 source／207 active／6 archive-only**，逻辑摘要 `sha256:ccd48b6520ab147bffa772ce19ee48800b45d5c0d5c2011e054ea39a0433ddc8`。以上旧阶段计数仅表示对应阶段。0040 plan digest 为 `sha256:d7d1a9f47d2fffc8b12d11906382ea2714602e780135791a6d9f983dc5b3e017`。新增真实 PG 备份→拒绝覆盖→空目标→verified 后中断→冷恢复→正常服务启动用例，尚未执行。

- 事件审计详情 UI 已补验证方式、正文表示与原始 transport receipt；CS 信封展示明确为重序列化正文，旧行缺字段显示未知。中英文组件用例已写；该轮格式／lint／类型通过，尚未浏览器验收。
- 所有托管 PostgreSQL 业务写入共用事务内 shared advisory lock；控制面发布迁移窗口时取得 exclusive lock，排空前序写后才报告 ready。窗口存库跨槽生效，普通待机配置写仍可用；schema digest 拒绝旧槽在升级后重开写。冻结后丢 ready 的冷启动先补 ACK，CS 迁移结束且 schema 一致后才重开。原 HTTP 错误层保留 ORM 包装的有类型 503。SQLite 0265／PG 0041 增加迁移写窗口表；跨实例／真实 PG 排空、冷恢复与 HTTP 503 用例已写，未执行。
- 工作卷捕获接任务镜像的同一原生 worktree capture 策略（非终态、排除 .git、64 MiB 上限和逐项跳过）。数据库先持久记录捕获请求、Source Control 保留卷，再派稳定 helper operation；文件与最终回执 fsync 后上传独立固定对象，清单逐项记录捕获／跳过。备份发布后的清理失败保留日志，后继观察原命令后清理，未知 writer 阻止删除。卷关闭和相关 GC 尊重持久保留记录。恢复预检核对工作区 roster 与完整对象哈希；工作卷实际重建尚未接入。
- SQLite 0266／PG 0042 增加工作卷保留与备份捕获意图两表。该阶段 schema **216 source／210 active／6 archive-only**，逻辑摘要 `sha256:283ef4c1c0ad3fbd5f86397a1d6535a5efcc76e4cd5459e5c428e4f7f2c67f2f`，0042 plan digest `sha256:2c69baed7bcd5c15003db5b26d1836e2466ffbf6fd820f085d1ac7b81c434060`。完整历史只增，0264／0265 snapshot 原字节保留。

- 插件上传计划在 put／pin 前持久化，回执先于 release；索引未发布时的丢应答也可冷恢复回收。发布与 GC 锁定同一版本记录，并在回收认领事务内重查当前引用、Intent 与资源包日志；当前租约中的安装不会被 GC 抢走。备份包含已确认的安装对象引用，未确认 pin 明确阻止该次快照导出。SQLite 0267／PG 0043 增加安装日志；对应双引擎竞争／冷恢复用例已写。
- 节点事件对象在任务／节点删除后由维护轮次回收；prepared 上传已成功但源行消失时先补持久回执，再沿 releasing 释放。丢 release 应答可重试，原任务归档／数据库备份保留独立引用；用例已写，未执行。
- 事件通道切换状态与操作历史已持久化。直连最终受理、CS 目标冻结、暂停／恢复共用来源事务锁；暂停记录直连／转发水位和在途投递、目标、终态控制义务。环境配置只初始化来源，不能覆盖旧槽已保存的切换。恢复前要求义务排空，并保存操作者、上游变更与人工对账记录；没有跨通道 exactly-once 声明。现有端点卡片接入中英文管理 Dialog，支持暂停、刷新在途、对账恢复、回退到直连和最近 100 次操作历史；权限、待机、丢应答稳定 requestId 用例已写。来源目录与 Manifest subscriptions 通过渲染器注入的 AW_EVENT_TYPE_IDS 对账，启动时拒绝缺／多项。
- 恢复快照中的未结算执行增加持久 hold，覆盖工作流、System Agent 与诊断。已确认的执行只能读取原结果；没有提交回执的不能重新提交，保存的超时／取消意图也不能自动执行。冷启动对待核对任务及其共享卷／父子调用族保留 owner、effect fence 和运行时会话锁，无关任务继续原启动恢复。旧卷仍可读取；正常 ensure／capture／GC 不得创建、修改或释放恢复保留卷，须后续显式恢复核对。共享卷写者结算按物理 CS 父任务聚合，包含继承卷子任务。双 provider／真实 PG 恢复用例已写，尚未执行。
- 设置页新增托管备份目录与校验 Dialog：只向 backup:run 权限开放，列出最近 100 条和恢复源保留状态，手工备份明确传工作卷选项，待机可读目录／校验但不能创建。校验完整清单和全部对象后才显示恢复引用及平台操作步骤；同备份并发校验合流，跨备份互斥，保留回收竞态重查状态。HTTP、组件与真实 PG 备份接口用例已补，前端静态检查通过；尚未浏览器／功能验收。该界面不提供覆盖当前数据库的操作，平台空目标配置切换与工作卷重建仍未完成。
- 执行恢复 hold 阶段 schema 为 SQLite **0269**／PG **0045**，**220 source／214 active／6 archive-only**；逻辑摘要 `sha256:6f00e6b157e673e2acdc2ddf7e841ce3e35a9cd9b7770fc40563aef623334c87`，0045 plan digest `sha256:a725bc4f20f5b7e5bdf3eb6f05753f905a83d1cbd09f305b70c8095560c605c5`。历史只增，0266／0267／0268 snapshot 原字节保留。插件、事件切换及执行恢复静态格式／lint／类型检查通过；随后工作卷保护与聚合写者检查另记。功能用例与浏览器均未运行。

- 归档对象新增上传／固定／发布／释放日志及发布引用图，索引与引用关系同事务提交。目录 catalog 的传递依赖阻止仍被发布归档引用的块被回收；已失去发布引用的对象在冷维护中幂等释放，丢上传／释放应答及并发相同 put 均沿原日志收敛。数据库备份包含 ready 对象图，未确认上传阻止快照导出。SQLite 0270／PG 0046 新增两表；全部对应测试已写，未运行。
- 启动清单事件只保存经过严格验证的状态／名称，不持久化未经校验的原始字节，不把传输报告记成会话正文。任务与系统 Agent 复用原 startup verification；运行时 inventory HTTP 改走选定内容读取端口，托管实例只读流式保存的事实，原生仍读原运行目录。双数据库／双协议、运行中查询、不可用与异常报告用例已写。
- 执行绑定保存原运行时协议、声明清单、启动观测能力及节点帧／原信封 nonce／Git baseline；重启接管不再用当前资源推断旧执行。恢复预检复核 AW operator ACL、手动执行准入、物理卷归属、generation／attempt、原材料和原生会话；事务内通过同一预检实例持有的本地事实再次校验，不在持锁事务中调用 CS。
- 新增恢复请求持久日志和消费组件：claim → 本库受理 → 原 AW 命令准备 → 平台回执 → AW 投影；回执落库与业务投影分开。物理父卷最多一个未投影恢复，未知原请求处于 held；拒绝原因在远端 ACK 丢失时仍保留。旧 epoch 的 running 操作以原幂等键接管，终态请求只读结果绑定；恢复快照中的未完成请求不得自动重发。启动 reaper 保留未投影恢复的任务族及 effect fence。**五动作的 AW 业务命令实现、后台／启动生命周期装配及 UI 共用入口仍未完成；消费组件与端口用例不构成端到端交付。**
- 原 `resumeTaskProjection` 拆出可持久受理和按原 intent 驱动两步，普通调用仍走同一实现；重复命令不增加 lifecycle revision／operation generation，已终结命令不复活后续任务状态。原 `retryNodeProjection` 保留受理、取消旧子任务、铸行顺序，恢复日志检查点与原 CAS／铸行／resume intent 在同一事务内提交。投影 JSON 的 v2 envelope 保存命令进度，兼容先前 v1 投影，不增加 schema。普通 continuation／节点重试在同一事务复核活动恢复保留，包含尚未提交首个执行绑定的继承子任务；无关任务继续准入。真正平台就绪等待置于后台 drive，避免消费者等自己的回执。双 provider 用例覆盖冷重入、同请求竞争、检查点失败回滚、失权／恢复 hold、撤权、丢 resume 应答和普通行为；未执行功能测试。
- 恢复执行观察者已接到选定执行 owner；标有恢复来源的绑定只能读取原恢复日志产生的新 attempt，不能退回普通 POST。新 attempt 的 `previousId`／attempt／materialDigest 再核对，原信封与工作目录须由后续节点准备接线保持。profile-only 历史绑定接管时不再为内部材料引用上传当前 Agent 定义。**实际节点准备、原隔离目录与运行内容映射、五动作业务装配、后台及 UI 入口仍待完成。**
- 已提交投影但尚未被 driver 认领的 resume intent 纳入恢复消费查询，启动 reaper 同样保留这类任务族；领取前丢唤醒会按原 intent 重新唤醒，重新解析请求者权限，不再重做 CS 操作。pending → claimed 使用原 intent 状态作为持久投递回执。数据库快照恢复同时 hold 已投影记录，避免其旧 pending intent 自动驱动工作卷。消费者、启动恢复与真实 PG 还原的对应用例已补，尚未执行。
- 当前 schema 为 SQLite **0271**／PG **0047**，**223 source／217 active／6 archive-only**；逻辑摘要 `sha256:ea7958c95b857224c762c028d8b30cb48fb07e13120d3d5e75113dea160e2924`，0047 plan digest `sha256:ae3212a4d63ad120c8ac65fef81e0161b3e48a4590a8f163cfda191187dc2159`。旧 SQL／PG 历史未改写；新增 Drizzle snapshot 仍按 journal idx 命名，SQL 文件前缀按实际最大编号递增。恢复日志与消费器的双数据库用例、真实 PG 恢复保护用例已写，仍未执行。静态日志为 `/private/tmp/rfc370-m3-{format,lint,types}-automation-worker.log`，后续候选变化须继续限定自查。

- CS 入站增加现有数字员工 System Mock 全旅程的第二条 transport 分支：真实 HTTP → 持久 inbox → 冷 Worker → Event Center 规则 → Case／Reaction → Git／外部适配器，含同 delivery 重投。保留原直连分支，两个 provider 均声明两条旅程。CS producer 和来源签名在此测试中是夹具，实际平台 producer 仍需实机验收；新用例尚未执行。
- 开发证据对象上传前保存不可变事实日志，pin 回执与原 blob／bundle 索引同事务发布；新执行权持有者按原 request key 恢复已完成的上传／pin，不依赖旧 HTTP 暂存文件。平台确认仍缺 bytes 才标 awaiting-source，网络未知保持 recovering 并持久退避，前台重入与迟到恢复由行锁／revision 隔离。现有维护 Worker 的 Development Automation 保留任务接入恢复；备份拒绝尚未结算的 pin。沿用单机证据保留政策，不凭不完整引用图删除共享 blob。双 provider 用例已补，未执行。
- 最新 schema 为 SQLite **0272**／PG **0048**，**224 source／218 active／6 archive-only**；逻辑摘要 `sha256:d58ed6996a1a88ebaa665a8de988fb98724d989cfeae837b1b7ab7a4572f2a67`，0048 plan digest `sha256:c03492fe8b02bc2ecfa7ec011c6642b3f41b42a8fb2f68c2d4cfa29edd39ad96`。新增 development_object_uploads，既有迁移历史原字节保留。恢复投影提交后至 intent 被领取前继续保留准入互斥，防止丢唤醒窗口被新命令抢先。

- 恢复与终态维护使用同一准入互斥：归档／删除 claim 前复核恢复保留，恢复预检及事务复核读活动维护成员；物理卷上的继承任务、冷孤儿目录、脚本／日志删除、快照与 partial-clone GC 同样保留。Source Control 提供历史卷归属查询，闭卷仅供 restart，closing 不得受理。既有保留表承接恢复 reservation，与日志受理、投影／拒绝 ACK 同事务更新；未知 running 请求也保留已知物理卷，绝不凭此产生业务 admission。
- 父任务 resume／rebuild 恢复组件已写：精确请求／operationId、generation +1、同 volumeUid 及 running／ready 后才调用普通 resume 的持久受理，投影后普通 driver 执行原回滚。普通业务准入已抽出复用，子任务仍强制先检查点回滚；消费者把明确业务 DomainError 变成固定拒绝类别，且旧 epoch accepted 重放也在每次平台 execute 前重新授权，不保存可能携密的异常文本。
- restart 恢复组件已写：不可变 UUIDv7 请求确定新 AW task ID，CS 已创建的新父卷经 Source Control 绑定，原卷归属保留。普通 root launch 新增内部持久命令检查点：任务、普通 launch intent、恢复进度同事务提交，重入复核请求 hash 和授权；直到恢复投影才唤醒原 coordinator。新卷在投影前保留，确定的新任务 ID 同时用于 continuation／终态维护、启动 reaper 与孤儿工作区补偿保护。失败的持久启动保留已准备工作区供原命令重入。没有增加第二套任务写入路径或 schema。
- 已补 `rfc370-m3-recovery-{parent-continuation,root-launch,workspace-retention}.test.ts` 及现有 preflight／consumer／checkpoint／继承卷用例：包括同事务失败回滚、失回执冷重入、generation／卷／请求身份变化、清理互斥、撤权与旧 epoch 重放。当前仅执行格式、lint、类型静态自查，功能用例未运行。父任务／restart 是已写组件；原参数读取、子 Agent 恢复材料与冷接管、五动作业务总装配、生命周期与统一 UI **仍未完成**。最近只读查看 `cs-agent-workflow` 蓝绿 Pod 均 Running／Ready、0 restarts，未停止、删除或替换正式 M0。

剩余：事件切换与真实 CS producer→规则／Reaction 的集中验收；五种恢复动作与 AW 业务命令／ACL 的统一入口；蓝绿／迁移就绪实机验收；工作卷恢复、托管恢复管理入口与平台空目标库操作；其他对象族保留回收及能力完整矩阵。维护能力门控保留，生产已接工作卷捕获但仍未经功能验证。M2/M3 的格式、lint、类型检查与功能／真实平台验收分别记录，不相互替代。

### 2026-10-15 原生材料、私有 Git 与恢复成员补充（开发中）

- CS RFC-040 基线 `92889e87a7be3db1cbc4f2aad8c63a85f1f577c9` 的准确 CI 38838520891 九项成功，七后端与任务底座已实际部署。OpenCode 1.18.29 的对象文件／插件树、内部子 Agent、local／remote MCP、权限与模型选项、Secret 轮换冻结、取消后 fresh retry、冷 session 续接已完成实测。用户最新裁定只验证 OpenCode，未启动新的 Claude Code 实机验证。具体回执保存在 CS RFC-040 `acceptance.md` 与 `opencode-live-20261015.json`。
- CS 后续补充 `de9c69ccb8d28e455de1a0a6766ed7473ad85606` 保留 OpenCode 插件 options、MCP OAuth 与大小写子进程 env，并对新增秘密叶值脱敏。其集中 21 项合同／真实 PG／脱敏用例及 1 项 OpenCode 驱动准备通过；准确 CI 38845648786 的 Session 事件持久化断言失败，按提交与调用链归因为本次未改动的既有路径，整仓 gate 未绿。补充尚未部署；没有把基线实测外推成补充实测。
- AW 已写原生材料编译与全执行族传递：根正文／记忆、依赖 Agent、共享 MCP 归并、完整冻结插件树与选项、实际启动声明。材料上传走 `hosted_material_object_uploads` 持久日志，上传前密封源字节，稳定引用重入，收到对象回执后擦除源；父工作区物理关闭前保留引用，旧 epoch 失回执可由新 epoch 对账回收。SQLite 0273／PG 0049 已生成，未对正式服务运行迁移。
- 私有 Git 接线已写：发布档案 `gitCredentialsDefinitionId` 指向公共绑定配置；每个凭据由独立 CS Secret 引用注入任务容器。HTTP 精确匹配协议／主机／仓库；SSH 精确匹配账号／端口／仓库并要求已固定的 known_hosts，临时私钥在原 SSH 进程退出后回收。固定助手覆盖仓库准备、推送与插件安装，普通脚本与读取命令不获取 Git Secrets；持久命令重入直接观察原命令，映射轮换不改原 Secret 引用。
- 恢复预检已补无 execution binding 的逻辑子任务：按 Source Control 的物理工作区归属检查所有成员 ACL，事务内重查成员集合；call／fusion／借用工作区的准入检查活动恢复保留，防止预检后新子任务加入原卷。
- 上述 AW 实现与回归用例仍处完整开发阶段。已做格式／精确 lint／类型静态自查，未执行新增功能测试、实现门或真实 AW M2/M3 验收。五动作业务总装配、子执行冷接管、原启动参数重建、工作卷／平台空目标恢复和能力完整矩阵仍待完成。M0 正式蓝绿服务保持运行。

### 2026-10-15 恢复总装配、对象日志及工作卷身份证据（候选更新）

本节更新上述阶段记录，不将已写代码视为功能通过；AW M2/M3 仍未执行集中功能验证。

- 五动作消费者已接原业务命令／ACL、恢复准入与持久检查点、CS 回执与投影、原 driver 唤醒和后台生命周期。子执行接管沿原材料与启动清单；根 restart 重建原工作流、原始上传字节及参数。隔离恢复保留原物理任务族；无隔离 passthrough 沿原 cwd，不因途中出现 `.git` 而创建新工作树或回滚目录。双数据库用例已补。
- CS 恢复深链只传原 project/task/subtask 身份，权限和恢复动作由原 CS 恢复页重新读取。缺失或失效 child 不静默退回父任务操作；统一 Dialog 保留列表上下文。CS 的两文件集中回归 **17 pass / 0 fail / 147 assertions**，全仓结构／lint／前后端类型检查通过。该 UI／名称补充仍未提交、未部署，不属于前一版实机证据。
- 完成 [能力矩阵](./capability-matrix.md) 与 [对象保留矩阵](./object-retention-matrix.md)。员工程序／参数／输入新增 `employee_object_uploads` 持久日志，pin 前登记事实，冷重入使用原操作；原维护 Worker 对账失回执，未知状态持久退避，原生共享 blob 保留政策不变。评审文档无 pin receipt 的清理先核对原上传，未知网络状态保留待清理日志；未结算声明阻止备份。
- 工作树捕获清单保存 `ownerTaskId/businessTaskId/volumeUid/generation`，意图在远程效果前持久化，捕获及对象读取后重新核对；身份变化拒绝发布，冷清理也不能落到替换卷。旧清单可以读取，但没有该 tuple 时不能据此证明原卷身份。原卷对账／缺失卷重建仍未交付。
- SQLite **0274**／PG **0050** 仅纠正恢复执行 hold 的逻辑 owner 为 task-execution；既有行合同不变。新增员工日志为 SQLite **0275**／PG **0051**；最新合同 **226 source / 220 active / 6 archive-only**，schema digest `sha256:0d832c7dbda5cefd86d7ffa1d6659cb1917d63f576543261dafbf9f14033181d`，0051 plan digest `sha256:934ed13ce042efe6e5bf5916f587880ea87e6764c7a887ae1ae2c7d6867136d9`。这些迁移没有在正式 AW 执行。
- 最新静态自查 `rfc370-workspace-proof-{types,lint,format}.log` 通过；日志位于 `/private/tmp`。没有执行新增 AW 功能用例、实现门或真实 M2/M3 工作流。能力门暂时保留，不能算已上线。
- 当前有两项明确设计裁定待回复：CS RFC-040 的 OpenCode 依赖子 Agent 平台模型映射补充；CS RFC-042 的独立空目标恢复／停写证明／世代切换与原型。两项均已形成可评审文档，未擅自进入对应新合同实现。当前补充不降低 RFC-370 的完整等价标准。
- 只读复核正式 AW：blue UID `67808ecd-2cb8-418b-98f1-4e7ce338bce3`、green UID `0039a97f-e2ae-4647-9913-a99b4839c1cc` 均 Running／Ready、0 restarts；保持原服务运行。
- CS 补充实机随后完成：包含 de9 补充的 `3fb767e61c1e6878af01ae81efadbb6ab6e1bc6c` 准确 CI 38855659848 九项成功；隔离 OpenCode 档位 r3 的真实子任务 `01a1436b-6137-7000-9938-1d16f43e6e94` 在固定 Runner `0f87aceb…` 上成功。插件 options、OAuth 配置、大小写 MCP env、原生文件摘要与持久事件回放共 **18 项通过**。首次验收脚本错误地要求回显应被脱敏的 nonce，原失败保留，改为核对同一次进程的文件回执，没有重跑模型来掩盖失败。OAuth 外部授权握手未测试；子 Agent 独立模型仍待裁定。详细时序和回执见 CS RFC-040 `opencode-options-live-20261015.json`。

## 附：STATE.md 中被 v3 取代的 RFC-370 段落（逐字）

### 2026-10-16 RFC-370：集中验证完成修复复验，发布与实机验收继续

作者“按推荐实现”已批准 CS 子模型映射和独立数据库恢复方案。AW RFC-370 双 provider 集中运行 229 文件／2236 项，首轮 2204 pass／32 fail；修复后 9 个失败文件全部 74 项复验通过，原失败证据保留，不能写成一次全量全绿。恢复预约补验 204 项首轮 201 pass／3 fail，修复本人用例后受影响三文件 45 项通过；SQLite 0277／PG 0053 保留旧恢复记录并放行精确授权的新独立重启。当前候选类型、架构扫描和单二进制构建 r2 通过。CS `3c1d2eab` 准确 SHA CI 9 个作业通过并部署 8 个平台实例；两个实机缺陷已修复，修复门禁继续。不同模型 OpenCode 委派、五动作与事件、独立恢复、正式新版和浏览器验收继续；隔离恢复迁移正受单节点 CPU 请求额度限制。RFC 保持 In Progress。正式 M0 两槽保持 Ready、0 restarts。此前 AW 共享 main 推送被自动审批拒绝，本次发布清单准备就绪，仍需明确发布授权。详情见 [RFC-370 status](./status.md)。下方历史及全部并发产出保留。

### 2026-10-15 RFC-370 v2 M1：远程执行候选（In Progress）

M1 源码已本地提交 962dd1e5c，SSE 轮换修复为 2b92ec1b1，静态检查与架构写点登记通过。自动审批拒绝共享 main push，已在当前会话请求明确授权，尚未推送／取得本候选精确 SHA CI 或 CS 实机执行证据。M2 多仓、流式对象与上传、候选／普通及子模块冲突、自定义观察器、员工程序／输入、自动化／员工工作区、系统 Agent、继承卷与删除回收适配及用例已写为独立未提交在制品，未执行功能验证，剩余合同与能力见 status。涵盖执行边界、CS 租约／写屏障、持久执行绑定与事件重放、取消／重启接管、单仓 Git 包装器与脚本任务容器、对象产物；SQLite 0259 / PG 0035。正式 M0 服务继续运行。M2 的 CS 配套 RFC-040 已由用户于 2026-10-15 授权接手，CS 实现与测试用例已写齐，正在集中验证；详见 [RFC-370 status](./status.md)。本次继续保留原有未提交 RFC-370 执行端口准备与所有并发产出。

M2/M3 继续开发：API 自动化的 CS 会话＋同用户 AW PAT、人工门对象恢复、维护 Worker 全写围栏与远程工作区维护、对象事件归档、数据库快照／对象依赖备份及空目标恢复候选已写。迁移跨槽写屏障／冷启动补 ready、事件来源审计 UI 与持久工作卷捕获已补入；已续补插件上传日志与发布／回收互锁、事件归档孤儿回收、持久事件切换水位及管理 UI；当前 SQLite 0272／PG 0048，224 source／218 active。恢复旧执行意图与工作卷的保护、待核对任务族保留锁而无关任务继续启动恢复、共享父卷写者结算判定与用例已写。托管备份目录／完整对象校验及管理 Dialog 已接通；MCP 诊断远程选择、持久回执恢复、逐事务围栏与待机只读查询已补，用例已写。AW 启动清单消费、选定 inventory 读取端口与原执行上下文冻结已补；CS 事件生产已在 RFC-040 实现，正在集中验证。归档对象发布／回收日志和依赖图、恢复请求日志／消费组件、事务内预检复核及启动保护已写；共用 resume／retry 的持久检查点、丢唤醒保护和原执行观察器已补；新增开发证据对象上传前日志、冷恢复、维护 Worker 和备份未结算屏障，并扩展现有 System Mock 全旅程覆盖 CS 事件入口；相关用例已写未运行。五动作业务命令实现、生命周期装配和统一 UI 仍待完成。功能测试尚未执行，执行能力门控保留；工作卷重建、统一恢复入口及其余项见 status。正式 M0 未替换／停止／删除，AW 共享 main 发布授权仍待当前会话答复；CS RFC-040 实施授权已明确。

恢复链续补（在制、未功能验收）：终态归档／删除与恢复准入互斥；Source Control 的历史卷归属查询与同事务恢复保留，未知 running 请求只保留、不生成授权；普通 resume 的业务准入复用、业务拒绝稳定分类和每次 CS execute 前重新授权。父任务 resume／rebuild 组件等待精确卷 generation 就绪后才受理普通 resume；restart 组件把 CS 新空卷映射到固定的新 AW task，复用普通 root launch 的任务／意图／恢复检查点同事务提交，投影后再由原 coordinator 认领。新卷和未投影启动也进入终态／孤儿清理保护。双 provider 用例已写；子任务恢复的材料映射／冷接管、重启原参数装配、五动作总装配和统一入口仍待开发。没有把组件或静态检查记成端到端通过。正式 M0 蓝绿 Pod 最近只读核对均 Running／Ready／0 restarts，未操作服务生命周期。
