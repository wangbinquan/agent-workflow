# RFC-370 实施计划

状态：In Progress · 2026-09-28。用户已批准实现、部署及提交上库到远端。用户已确认完整接入，以及“先补齐 adapter 切面，再编写 CS 独立 adapter”的顺序。CS adapter 采用必要能力先行、先部署再逐项收编策略。当前执行阶段 A，进度和门状态见末尾实施日志；尚未部署 aw。

## 1. 两阶段顺序与验收门

H1～H8 是职责边界，A-T／B-T 是实施任务。阶段 A 的独立退出门 A-G 通过后才能开始阶段 B 的生产实现；不能在抽取本地端口时并行夹带 CS adapter。B1～B4 保留原验证阻塞编号，不与 B-T 任务混用。

### 阶段 A：平台中立切面与本地 adapter

| 任务 | 内容／交付物                                                                                                        | 依赖             | 完成证据                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------- |
| A-T0 | 完成 RFC 功能设计门及实施批准记录；D1／D7／D8 已确认，其余设计决策与能力影响按实际批准记录处理                      | 本稿             | 不复用 CS RFC-033 的实施批准                                              |
| A-T1 | H1～H8 全调用者清单：复用／扩展／新抽取分类、owner、port、adapter、composition、迁移范围；固定原行为 oracle         | A-T0             | 逐入口源码和合同，含业务／系统 Agent、Git／脚本、MCP 测试台及所有后台效果 |
| A-T2 | H1／H6：抽配置、安装元数据、内容和启动生命周期切面；接现 provider／filesystem 实现                                  | A-T1             | 原路径、密钥、generation、导入导出与持久性语义不变；无 CS 运行依赖        |
| A-T3 | H2／H8：收口身份与 revalidation 接线、transport-neutral webhook 受理及事务参与者；保留原登录和直连 provider adapter | A-T1             | 原 HTTP／WS、ACL、PAT、webhook 去重／重放及 MR 行为回归                   |
| A-T4 | H3：复用 Task／SC 合同，抽物理 workspace／Git 效果，接 local adapter                                                | A-T1             | 两条 launch lane、多仓、隔离／共享 worktree、merge／上传／读取行为回归    |
| A-T5 | H4／H5：分离中立执行、runtime 配置／协议职责和本地启动材料；local adapter 包住 PID／spawn／流／取消，切全调用者     | A-T2、A-T4       | 双 Agent、系统执行、脚本及工作组等原行为回归；业务接口无 CS DTO           |
| A-T6 | H7：抽执行权／恢复生命周期端口，接现 local 单实例／owner 语义；后台效果统一接线                                     | A-T2、A-T3、A-T5 | 现重启、重试、取消、人工等待和后台派发语义不变                            |
| A-T7 | 收口 composition／public／依赖守卫与 owner 账本，消除本次入口的直连 FS／spawn 等效果，完成共同合同测试              | A-T2～A-T6       | 清单全覆盖；非假 adapter facade；无新增平台业务耦合                       |
| A-G  | 阶段 A 功能实现门、双 OS／双数据库精确 SHA CI，形成独立可发布版本                                                   | A-T7             | AC00 全部通过、候选内容／提交 SHA／证据记录；RFC 仍未 Done                |

A-T2／A-T3／A-T4 可在合同冻结后并行开发，遵守共享 main 的文件归属和发布串行规则。A 阶段只重构本 RFC 必经切面，已有合格端口无需再包装。不要求为推进阶段 A 启动 CS 资源或先完成远程容量验证。

### 阶段 B：必要适配先行，先部署，再逐项收编

部署不再是阶段 B 最后的单独任务。M0 必须先在实际 CS 可用；其后每个增量都在已有安装上发布和验收。B1～B4 按当期能力拆项，不形成“全部闭合才允许首次部署”的总门。

| 任务 | 里程碑及内容／交付物                                                                                                        | 依赖                                             | 完成证据                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| B-T0 | M0 合同冻结：只确定服务 Manifest、PG／配置／Secret、浏览器身份、内容存储及未就绪能力提示；建立后续能力清单                  | A-G                                              | M0 所需 schema、B3 当期持久性方案、B4 新身份／首个管理员方案；不等待插件／MCP／旧 PAT 迁移       |
| B-T1 | M0 必须 adapter：H1 托管入口与现 PG、H6 当期资源内容、H2 HTTP／WS 身份；最小中立客户端、镜像／Manifest／迁移／探针／UI 提示 | B-T0                                             | 能构建和发布；已开放编辑路径全部耐久；执行和外部效果未就绪时不派发                               |
| B-T2 | **M0 首次实际部署**：本机 CS 新安装，登录、编辑／保存、服务重建、数据回读；留下可用访问入口                                 | B-T1、实际资源授权                               | release／镜像 digest／配置、浏览器和持久性证据；AC00B 的首次部署要求通过                         |
| B-T3 | M1 工作区／runtime／执行最小完整纵向路径，加该路径必须的 authority、失租约处理、持久 intent／receipt、取消释放及重启对账    | B-T2；仅所选流程涉及的 B1／B2／B3 检查通过       | 在 M0 安装增量发布；一条代表性工作流实际完成、取消和重启对账通过；其余能力明确未就绪             |
| B-T4 | M2 按能力逐项扩展 H3／H4／H5：双 runtime、完整 Git／多仓／脚本、插件、MCP、系统 Agent、复杂工作流与工作组                   | B-T3；各条目自己的依赖验证                       | 每项独立 adapter 变更、相关回归、发布和现场流程；逐步关闭 AC03～06 中的条目                      |
| B-T5 | M3 事件增量：integration CS EventDelivery 入站 adapter、持久 receipt、provider 归一化、事件 UI 与 Task／Reaction 触发       | B-T3、目标规则依赖的 B-T4 条目就绪               | 增量发布并跑通两个 producer 的实际投递、去重、MR／规则、业务执行链路；AC08                       |
| B-T6 | M3 运维增量：system-operations 的剩余恢复动作、完整 handoff／migration、后台功能及对应 UI                                   | B-T3、每种动作依赖的执行能力                     | 逐项声明并开放动作；实际恢复／升级交接／额度测试；AC07／09／10。可与 B-T4／B-T5 的无依赖条目穿插 |
| B-T7 | M4 旧实例迁移／回退演练，补齐原身份／PAT、全量内容、完整能力与浏览器对拍                                                    | B-T4～B-T6 全部完成、B1～B4 全闭合、实际迁移授权 | AC01～11 完整证据；旧实例停写、导入、对账及正式切换方案                                          |
| B-G  | 完整托管功能实现门、双方合同／精确 SHA CI、架构账本与 RFC 收口                                                              | B-T7                                             | AC00、AC00B、AC01～12 全部有证据；只有此时 RFC 记 Done                                           |

每个 B-T 实现增量都携带功能测试、必要 UI、发布／回退说明，并按实际授权及时发布到试点安装；不能把现场验证和前端入口全部留到 B-T7。未支持的配置在启动前提示，不能接受后无限等待或由服务槽 local spawn 兜底。M1 前置的最小执行权、幂等、取消和恢复对账不能推迟到 M3。完整蓝绿交接就绪前，采用停派发、排空在途任务的单槽维护升级。

B1～B4 的能力调查和必要 CS 配套 RFC 跟随具体消费者推进；平台合同已满足的部分不被无关差异阻塞。阶段 B 暴露中立合同缺口时，先独立补合同与 local 回归、验证受影响的 A 门，再继续依赖的 adapter。当前用户确认的是增量交付策略，不代表 M0／M1 可以替代最终完整验收。

## 2. 建议提交批次与独立交付

1. A：调用者／合同与原行为 oracle（A-T1）。
2. A：启动／内容、身份／事件、工作区切面，按 owner 小批提交（A-T2～A-T4）。
3. A：执行／材料、本地执行权与全部调用者接线（A-T5／A-T6）。
4. A：架构守卫、功能实现门和 CI 收口（A-T7／A-G），记录独立可发布版本；此时无 CS 生产 adapter。
5. B／M0：必要合同与 adapter（B-T0／B-T1）→ 首次实际部署并留下可用入口（B-T2）。
6. B／M1：首个远程任务完整闭环，随同必须的执行权／恢复对账发布（B-T3）。
7. B／M2～M3：按能力逐项提交、增量部署和验收执行、事件与运维 adapter（B-T4～B-T6）；每项同时交付 UI。
8. B／M4：旧实例迁移、全能力对拍及完整 RFC 收口（B-T7／B-G）。

不把 A／B 混入同一实现提交；保持同一 RFC 下两个清晰交付阶段。独立 adapter 指 owner 模块内目录与依赖边界，不强制独立 npm 包。所有代码保持共享 main 和精确路径提交；不创建 branch／worktree／clone，不与其他会话并发操作共享 index。实施、部署和既有实例迁移分别记录实际授权。

## 3. 证据清单

- [ ] A 阶段逐切面记录原调用者、既有／新增端口、local adapter、composition 与清理完成情况。
- [ ] AC00 独立通过：无 CS 运行依赖、原行为等价、真实 local adapter 回归、架构守卫、功能实现门及精确 SHA CI。
- [ ] B 阶段 adapter 按 owner 独立落位；wire DTO 不泄漏到业务层；共用客户端不拥有业务状态。
- [ ] M0 已实际部署且能登录、编辑、耐久保存／重建回读，首次部署没有被全能力适配阻塞。
- [ ] M1～M3 每个增量都有能力清单、用户可见状态、release 与现场证据；必要的执行唯一性、取消与对账随首个任务闭环交付。

- [ ] 完整入口普查：Task、node、wrapper、workgroup、系统Agent、独立MCP测试台、Git／脚本和后台worker。
- [ ] Runtime能力矩阵：原支持内容全部具备等价证据；能力收缩逐项获批且正反例覆盖。
- [ ] 持久性：PG 元数据／效果日志、对象 ready／pin／域引用、配置/密钥、任务工作卷、跨副本／重建、历史 cursor／归档都对账。
- [ ] 身份：用户／服务token严格区分，ACL、首次admin、WS和现有权限／撤权验证。
- [ ] 稳定requestKey与副作用日志覆盖所有远程POST；每个崩溃窗口至多一个实际执行。
- [ ] 事件：producer类型穷尽矩阵、provider normalize、ACK后崩溃、MR乱序、transport迁移和两个重放语义。
- [ ] 权限和生命周期：preview、旧epoch、migration、rollback、恢复五动作及资源释放。
- [ ] 实际集群和浏览器证据与单元/mock证据分列；实际公网回调不以手工签名请求冒充。
- [ ] 记录aw提交SHA、CS合同SHA、两方CI、镜像digest、release/config/profile revision、数据备份及资源清理／保留回执。
- [ ] 全部AC通过后更新RFC索引、STATE与必要基线；未闭合项明确标阻塞，不给RFC-294未完成波次倒签。

## 4. 设计阶段记录（历史）

已核对aw当前main与CS已提交v3/恢复/事件合同，提出8个适配面及4个验证阻塞。按用户后续要求将三件套改为 A 切面重构 → A-G 独立验收 → B CS 独立 adapter／部署，补齐目录边界、AC00 和分阶段任务。按进一步确认，将 B 改为 M0 必须能力先部署 → M1 任务闭环 → M2／M3 逐项接入 → M4 完整收口，并增加 AC00B；RFC状态保持Draft。未运行测试、未修改生产代码、未触碰CS在制内容或本机已部署资源。

设计门状态：尚未执行独立设计门。本会话检索不到仓库要求的openai-codex评审工具；本轮文档对拍不冒称该门通过。按CLAUDE.md要求，后续设计门仅审功能正确性、完整性和用户可见行为，不开展安全相关检视。

## 5. 实施日志（当前状态）

- 2026-09-28：用户明确批准本 RFC 实现、部署和远端发布，目标保持完整接入，阶段顺序不变。独立设计门工具仍不可用，未记 PASS；继续已授权的入口普查和本地切面重构，不提前通过 A-G。
- A-T1 进行中：生成 [候选效果调用者清单](./seam-inventory.md)，覆盖进程、文件／路径、身份、后台效果和 webhook 的源码候选点。静态匹配不等同于语义闭环验收，各调用者仍须逐项确认 port／adapter 和回归。
- A-T2 第一批：新增 system-operations-owned `DatabaseConfigurationPort` 和 `infrastructure/local/fileDatabaseConfiguration`；启动 composition 可注入配置端口，现 CLI／daemon 继续用原文件实现；将原 config 文件机制原样迁至 platform/configuration，旧 config/index 仅 re-export，保留单一缓存与 API；恢复协调器等待异步配置读取，配置激活仍复用现迁移协议；真实PG迁移恢复用例改经bootstrap注入异步配置端口。补本地 adapter 的默认创建、配置切换、其他设置保留、读副本及错误传播行为测试。其余配置／generation／密钥／内容切面仍待完成，不将此批记为 H1／H6 完成。
- 首批检查：仅运行目标文件 Prettier／ESLint 与架构账本生成；正式测试待该批提交的 GitHub CI。尚无 CS adapter 生产实现，M0 尚未开始。

- 首批提交 `b172b1d47ae03cf1f081d09e5851ded1f39816f1` 已推送，CI `36366595075` 的 Markdown 检查发现16个 CS 相邻仓库文件链接在单仓 checkout 中不存在；后续修复改用固定 CS SHA＋源码路径／行号。同步移除首批四项已使用的账本增长声明，不扩大豁免。生产代码测试仍等待包含该提交的后继 CI 终态，不把原 run 记为成功。

- A-T1 新增[切面核对表](./seam-assessment.md)：区分已有 SkillRepository／PluginInstallerPort／仓库准备／runtime 管理合同与实际缺口；密钥字节入口直接复用，不重复设计。尚未完成全入口关闭。
- A-T2 第二批候选：generation 的 schema／digest／manifest／升级／恢复判定移入无文件 IO 的共同核心，现文件 API／原子替换保持；补两种 artifact source 的行为对拍。读取快照的中立视图已分离，异步宿主快照加载及 metadata 写入仍待接线，未据此宣告 H1 完成。
- 当前独立设计／实现门所需工具不可用，已向用户询问是否允许由独立子代理做只读功能评审；回答前不启动子代理，正常实施继续。

- 第二批候选检查：目标 TypeScript／测试文件 Prettier 和 ESLint 通过；确认 generation 原子写入段与已发布版本逐字一致。架构重采记录 owner 分母 +10 与只读工厂被既有 create 前缀规则计入入口 +1，新增两项一次性增长说明；正式测试仍交远端精确 SHA CI，未本地运行测试。

- 第二批已提交并推送 `6d865eb4ccc2918a389c7ca8595c9e82853cff9b`；正式 CI 为 `36367641292`，尚未取得终态。
- A-T2 第三批候选：provider runtime 提供已加载 artifact source 入口，PostgreSQL 不再要求虚假的本机安装路径；原文件入口委托同一严格校验和运行时创建逻辑。保留 standalone 升级／恢复 owner；新入口只解析已安装 generation，不运行迁移。复用原运行时生命周期用例对拍两种来源，补配置冲突、旧 schema／manifest 错误在创建连接池前失败及 SQLite 路径要求。异步 metadata 载入、迁移 Job 与全新 PG 安装语义仍待实现。

- 第三批候选检查：仅对变更源码／测试运行 Prettier 和 ESLint；以原 RFC-349 连接池生命周期探针对拍 file／artifact 两臂，未新增假 PG runtime 账本条目。架构重采仅 owner 分母 +3，上一批入口增长声明已退役；正式功能结果等待精确 SHA GitHub CI。

- 第三批 `68ecb2664a644982bf62a8b5bdce0828b3c5caf2` 已上库；正式 CI `36368150663` 尚待终态，之前被后继取消的运行不记成功。
- A-T2 第四批候选：安装准备的原有升级／恢复判定收归 system-operations application，新增 `DatabaseInstallationPort`；本地 generation／manifest／锁／复制恢复／provider 准备由 `infrastructure/local/fileDatabaseInstallation` 实现。旧 `prepareDatabaseSchemaUpgrade` 保留兼容接线；SQLite 和 PG 的准备回调等待异步锁与 metadata 提交。新增应用层时序回归，原 RFC-359 真实文件／双数据库恢复用例继续走同一编排。当前仍未实现 hosted metadata 存储、新安装及前台生命周期，不据此关闭 H1。

- 第四批补 composition 显式装配，`DatabaseInstallationPort` 的 consumer／provider／composition 均有生产接线；新增真实历史 SQLite 用例验证异步 metadata 提交前不返回 runtime、不释放升级锁。目标文件格式／lint 通过，未运行本地测试。账本中 module→platform 被既有规则记为 legacy-outbound，本次中立类型引用 +6、composition 历史加载 +1，按 exact 条目如实登记，不修改判据或给 W9 完成信用。
- CI `36368150663` 的 macOS backend shard 3 发现 RFC-349 functional evidence 仍绑定原 `test(...)` 声明，参数化改写导致静态证据失配。修复保留原测试名称，在该测试内部遍历 files／artifacts 两臂，保留功能覆盖及原证据绑定；不将失败 run 记成功。

- 第四批 `37a0e4978ff2c06211b4853c063ac9de6e86331f` 已发布，正式 CI `36368991331` 尚未终态。
- A-T2 第五批候选：设置 GET／PUT 收敛为 system-operations 公开应用合同，原配置语义校验／probe 失效／持久化／通知／日志／MCP 对账／并发池热更新顺序移入同一 application；新增异步配置持久端口和独立文件 adapter。SQLite／PG bootstrap 均用同一 composition；HTTP 不再接收 configPath 或读取文件。其余后台／启动配置调用者和耐久内容仍待迁移，不宣告 H1/H6 完成。
- 第五批验证：新增异步内存存储的保存顺序、写入中不可热更新、写入失败无通知、retention／默认 runtime 拒绝用例；保留原真实文件及双 provider HTTP 热更新测试，将原源码接线断言跟随应用层迁移。目标格式／lint 通过，未跑本地测试。W29 仅 PG 装配与 SQLite API 装配的 Settings 单格变化，语句数 165／65 不变，源码生成摘要重采；SQLite 总装配摘要保持原值。正式行为验收仍由精确 SHA CI 给出。

- 第四批 CI `36368991331` 的 Ubuntu backend shard 2 检出安装应用／port 仍直引 PG 迁移历史。第五批同时修复：history 由 composition 传给 local adapter，新增中立 `resolveRecoverySource` 端口返回逻辑 schema，原 bridge 校验留在 adapter；不扩大 provider-specific debt 允许表，既有真实 SQLite／PG 恢复用例继续覆盖。
- 第五批切面检查：配置持久 port 的 consumer／provider／composition 均 active；运行时校验和 MCP 对账通过应用自有依赖形状注入原命令，无新增 off-dag offered 边。架构账本按真实新增入口、public 合同、owner 和接线登记一次性增长；目标 lint／格式与 diff 检查通过，正式结果待 GitHub CI。

- 第五批 `6df459b60e7c52c6c7efbba982ba800a207b17eb` 已上库，精确 SHA CI `36370237803` 进行中。
- A-T2 第六批候选：把存储值默认回填、patch 校验与嵌套／数据库判别联合合并抽为 `platform/configuration/configurationValues`；文件 adapter 与异步存储回归 fixture 复用同一规则。非法 patch 仍先拒绝再加载配置；原文件缓存、原子写入和 RFC-276 迁移段保持。新增内存值／真实文件对拍，覆盖默认值、null 继承、嵌套值、provider 切换及 schema 默认、错误和无意外创建文件。此批不是托管存储实现，其余配置调用者／内容／启动生命周期仍待收口。
- 第六批候选检查：原 merge helper 段（仅两个导出标记）、原子写入段及 RFC-276 文件迁移段与第五批逐字核对一致；目标格式／lint 通过，未本地跑测试。架构仅 owner 分母 +4，其余本批无增长，移除第五批已消费增长声明。

- 第六批 `d725f7bda26627e944ea7de82308d968f6d5cbab` 已发布，精确 SHA CI `36370688213` 已排队。前一批 CI `36370237803` 的 typecheck 检出 shared 未导出 `RuntimeKind`；修复为消费现有 `RuntimeStatusEntry['protocol']`，不新增协议枚举或跨域依赖。此修复仅类型引用，退役第六批已消费的 owner 增长声明；等待后继精确 SHA CI，不将原失败记成功。

- 类型修复 `93a84cd1d277fa4a4cecd5d2e1458c8506039fcb` 已发布，精确 SHA CI `36370857680` 进行中。
- A-T2 第七批候选：新增配置查询 public 合同，维护状态、PlantUML、仓库缓存／组、任务详情和归档六组 HTTP 路由移除配置文件读取，支持异步按需查询。SQLite／PG bootstrap 分别装配一个原文件 reader，保持热读取及原回退；任务深度配置的读取失败仍回到默认 timeout，维护状态存在时仍不读 fallback。原双 provider HTTP 回归保留，补异步路由读、连续请求读新值、归档预览等待配置及维护状态优先回归。其余 public origin／登录入口、启动、后台任务和执行配置调用者仍待迁移，H1/H6 不关闭。
- 第七批候选仅运行格式／lint 和源码摘要／架构账本生成，未跑本地测试。W29 两个根各新增一个配置 reader 装配（PG165→166，SQLite API65→66），SQLite 总装配摘要不变；原 source guard 随深度配置函数的参数切面更新。架构计入8条接线、1个public合同及2个owner符号，不扩大 provider-specific 例外。

- 第七批 `943a08ad377216696da5a6e05590735da65ca85f` 已发布，精确 SHA CI `36371425603` 进行中；前序 `93a84cd1d` 的类型检查 job 已通过，整体 CI 当时尚未终态。共享 STATE 因并行 RFC-371 尚未发布链接而保留在工作树，不剥离其他输出。
- A-T2 第八批候选：文档／发现、OIDC public origin、PAT 创建和 MCP transport 的配置读取统一接按需查询；MCP 开关规则改读已加载配置值，原默认值和判断顺序不变。完成态 `ComposedAppDeps` 及 provider HTTP 装配边界只持配置 query，不再把 configPath 交给 transport；SQLite 将原 reader 上移到外层，与 API／公开路由／MCP 共用，PG 复用既有 reader。配置地址读取失败仍走原请求头回退，OIDC 登录、PAT 与 MCP 业务规则未改；后台／执行／启动与 intent 的文件读取仍待关闭。
- 第八批补异步发现文档新值与 MCP 开关、public origin 读取失败回退用例；保留原双 provider OIDC／MCP／文档 HTTP 回归。仅格式／lint、源码摘要和架构生成，不本地运行测试。W29 记录 SQLite reader 上移（外层46→47、API66→65）、PG166不变及完成态装配改传 query；mountApiRoutes／createApp 摘要不变。架构仅六条 legacy→public 类型接线增长，无新增公共合同、owner 或运行效果。

- 第七批 CI `36371425603` 的类型检查发现异步路由测试夹具的 Hono actor 上下文未声明、taskArchive 缺少必填 maxTreesPerSweep。第八批修复为独立 MiddlewareHandler 注入和完整归档配置；不改变生产行为，原失败 run 不记成功，等待后继精确 SHA CI。

- 第八批 `7859e770a328f949981256255cb16c169590c2d7` 已发布，推送后 main／origin/main 精确同步；CI `36372241796` 已排队，未取得终态。共享 STATE／索引与并行 RFC-371 工作完整保留。下一步继续启动、内容存储和剩余配置消费者切面，尚无 CS adapter 生产实现或 M0 部署证据。

- A-T2 第九批候选：Settings／CLI 数据库迁移 composition 改为注入既有 DatabaseConfigurationPort，默认复用原文件 adapter；迁移及回退的配置写入 Promise 返回原 coordinator，由原 admission 顺序等待完成。启动准备与手工迁移不再各自直写配置。安装 metadata／内容／前台启动等切面仍待收口。
- 第九批验证补齐原真实 PG coordinator 用例的异步目标／源配置写入屏障，验证写入前不开放下一个 provider。核对发现该旧用例未被普通 CI 的专用变量选中，现复用 resolveTestProviders／resolvePostgresqlTestUrlEnv，Ubuntu 双库通道实际执行；仅显式 SQLite 通道 skip，选中 PG 缺 URL 则失败。以既有真库用例相同方式清理 disposable 目标 schema，迁移进度断言跟随当前 schema contract，保留幂等重放和首次写入前回退检查。正式结果待本批精确 SHA CI。
- 第九批目标格式／lint 通过，仅运行源码账本生成；无本地功能测试。架构跨边与例外各减少一条，移除第八批已消费增长声明，没有新增长豁免。第八批 CI `36372241796` 当前已完成9项，尚无失败，仍未终态。

- 第九批 `bf71912e8d57db8f191e03985f6d592205331b6b` 已推送且 main／origin/main 同步，精确 SHA CI `36372660023` 已排队，等待终态。下一处已确认缺口：runtime-management 配置 port 的 current() 仍仅支持同步结果，默认效果工厂内直接 loadConfig；registry 启动的 legacy 默认值检查也仍接受 configPath。后续按 owner 分离并保持原探针／热读取和启动迁移语义。

- A-T2／H5 第十批候选：RuntimeManagementConfigPort 支持同步／异步读取，11处使用点等待当前配置；配置投影和既有探针队列收归 runtime-management/infrastructure/local/fileRuntimeManagementConfiguration，composition 可注入独立配置 adapter，默认仍走原文件。registry 启动旧默认值检查改接 RuntimeLegacyConfigurationPort，原始文本在应用中解析／判定，文件读取另有 local adapter；SQLite／PG 启动均显式装配，无业务层 configPath。
- 第十批回归：原双 provider 管理应用测试改用异步配置，新增无路径 composition、读取未完成前无探针、读取失败不删 profile；旧默认值测试保留真实文件路径覆盖，补异步文本拒绝／已迁移放行／不可读回退，boot 顺序和错误传播继续覆盖。仅目标格式／lint 与架构生成，本地未跑功能测试，等待精确 SHA CI。
- 第十批架构按既有规则登记2个 adapter 文件／工厂和1个port的owner增长、3个被计数的读端口／工厂入口及1条净新增bootstrap接线；无新增业务效果或平台DTO。启动全生命周期、内容和远程runtime执行材料仍待完成，不据此关闭 H1／H5／H6。

- 第十批 `e62fe79be9fd0539549088d6351b4ae5cf25fb98` 已发布且远端同步，精确 SHA CI `36373218652` 已排队。同 SHA 自动 maintenance-soak `36373218651` 为单独工作流，不替代功能 CI。
- 第九批 CI `36372660023` 类型检查发现测试的闭包写入不被 TypeScript 控制流识别，初值 sqlite 被错误用于后续 PostgreSQL 断言类型。修复为带 DatabaseConfig 类型的可变状态容器，保留真实双向持久化和切换时序断言；不改生产行为，原失败 run 不记成功。

- 第九批测试类型修复 `784c083acba8c919cf27a1a3da932276e37e1415` 已发布，main／origin/main 同步；精确 SHA CI `36373395839` 已排队。该提交包含第十批 runtime 切面，正式功能结果仍待终态；未部署 CS、未通过 A-G。

- A-T3／H8 第一批候选：直连 webhook 完成 provider 验签／归一化后，调用 integration-owned VerifiedWebhookIngressCommands；事务受理、终态唤醒、Event Center observation 发布、路由审计与重复投递修复从 HTTP 路由移入同一 application。SQLite／PG bootstrap 显式装配，缺失 dispatcher／secret／Event Center 时仍不挂载原入口；HTTP 层保留 body／provider／endpoint 解析及原状态码。没有 CS DTO 或生产 CS adapter。
- H8 回归保留 GitLab／GitHub 双 provider HTTP 到业务链路，并增加无 HTTP 的应用测试：持久受理前不能发布、重复重发稳定 observation、插入后发布失败释放原 UUID、重复失败不覆盖历史、无规则与终态效果审计分支。W29 只重采两处入口 composition 摘要，原路由顺序和运行句柄保持；既有 observer nudge 的 void-promise 条目随源码迁移，未改变计数／判据。业务人工 replay 仍有单独语义，CS receipt／ACK和transport迁移留阶段 B，不将此批当 H8 完成。

- 基线 `784c083ac` 的 CI `36373395839` macOS shard 3 检出 RuntimeProfileConfigurationCommands 没有生产 consumer：Settings 应用抽取后实际方法仍被调用，但 composition 只标了应用自有依赖形状。修复由 system-operations composition 显式绑定 runtime-management public 命令合同到 required port；保留依赖反转和原行为，不新增未消费合同豁免或业务层跨域绑定。原失败 run 不记成功。
- H8 首批目标 TypeScript 格式／lint 通过，架构按实际 application/public/root 接线计数，未改扫描器和未消费合同规则；无本地功能测试，最终以本批 GitHub CI 为准。

- H8 第一批 `065add7015056323f4f14dcfd49b1f16aa410e5a` 已发布并验证 main／origin/main 同步；精确 SHA CI `36374140357` 已排队，正式测试尚未终态。前序 `784c083ac` 的 public consumer 失败由该批修复，不将失败 run 记成功。仍无 CS adapter 生产实现或 M0 部署证据。

- A-T2/H1 配置消费者续批：MCP diagnostics adapter 不再持有 configPath／直接 loadConfig，改接只读、可异步的 runtime 配置投影。SQLite／PG 应用与 daemon 根明确装配既有 file query，测试台选型／默认 binary／profile 覆盖及快照逻辑不变。已有服务与真实 runtime 用例继续使用真实 file adapter，新增无路径异步 reader 的等待、热读、默认值／覆盖优先级和失败传播用例；工作区／本地进程效果仍待 H3～H5 收口，不宣称 MCP 已可在 CS 执行。
- 本批目标 TypeScript Prettier／ESLint 通过，W29 两个 composition 内容摘要随唯一配置绑定变化更新；未改其扫描／断言规则。架构 ledger 分母无增长：一个配置 legacy 直连移为 bootstrap file query 装配边；删除 H8 前批已消费的五项 allowGrowth。正式功能测试以发布后的精确 SHA CI 为准，不运行本地测试。

- MCP 配置续批 `b1258161ef173cb219578a653f58cdcd75a52d3b` 已发布，推送后 main／origin/main 精确同步；CI `36374739146` 已排队。前批 `065add701` 的 check 已通过，完整 CI 尚未取得终态，不能替代本批验收。未通过 A-G，尚无 CS adapter 或 M0 部署。

- A-T3/H2 HTTP 首批：新增 identity-access public `HttpAuthenticationParticipant`，共享 HTTP transport 只接 request facts／已准入 identity；SQLite／PG 组合根显式选择 local adapter，完成态装配允许替换认证机制。原 session／PAT／daemon 解析、WS credential 解析与重验函数迁至 `identity-access/infrastructure/local/localCredentialAdmission`，`auth/session` 保留兼容委托；13 个迁移函数体经只读 AST 比较与迁移前相同。HTTP 原公开路径、Bearer 语法、bootstrap 阻止及重叠请求合流归 local adapter。
- 新增真实双 provider fixture 覆盖无本地 Bearer 的异步替换 adapter 接线、原 local overlap 合流／完成后重新读取及公开登录路径；原 auth-session、PAT、bootstrap、WS dedup／revalidation 用例继续通过兼容入口执行。原路径文本断言随公开路径规则迁到 local adapter，未变更判据。WS query 凭据提取／完整生命周期切面仍待后续，H2 不记完成；无 hosted identity 或 CS adapter。

- 前批 `b1258161e` CI `36374739146` 的 Ubuntu shard 4／macOS shard 2 暴露 H8 迁移后的旧 source／manifest 断言，以及 Settings 的 runtime public 绑定被放在 system-operations composition 而不在 bootstrap。修复将显式 `RuntimeProfileConfigurationCommands` 绑定放回两个 provider root，system-operations 仅消费 required shape，删除该 DAG 外边，不加例外；RFC-310 精确 manifest 随真实 H8 路径更新，publisher-only 断言覆盖 route→application→composition 整链，禁止 endpoint-wide dispatcher 的原规则保持。原失败 run 不记成功。

- H2 首批与上述 CI 修复的目标 TypeScript Prettier／ESLint 通过，W29 五处摘要按实际装配更新。架构重采记录迁移后的实际 owner／legacy facade 边及1个已被消费的 HTTP participant；不修改扫描器、DAG 和未消费合同豁免。新 HTTP 测试包含实际 `createHttpRequestApp` 的异步 adapter 入口，正式功能结果等待本批发布后的 GitHub CI。

- 发布阻塞：本批精确暂存调用被自动审批服务拒绝执行，原因是 Codex 使用额度耗尽、审核无法完成（工具明确不是安全性否决）。尚未执行 git add／commit／push；复核共享 index 为空，HEAD 仍为 `b1258161ef173cb219578a653f58cdcd75a52d3b`。实现与修复全部保留在主工作区，已准备精确30路径 allowlist／commit message；等待额度恢复后重新 fetch、核对候选内容与共享 index，再按原授权发布，不绕过审批。

- 审批恢复核对：账户工具报告 ordinaryUsageAllowed，原审批流程下 git fetch 已成功；候选30路径摘要与封存一致，共享 index 仍为空。继续原授权的精确暂存／提交／发布，不改变审批方式。

- 前批 CI `36374739146` 已终态 failure：除上述架构定位外，已启用的真实 PG 迁移用例暴露完成后重复 start 仍先要求 SQLite 的原缺陷。本批在已校验 generation 绑定的成功迁移上返回原 operation；不同 target 仍拒绝，未完成／失败操作保留原显式恢复路径。回归继续保留真实迁移、异步持久配置和回滚，并补相同 canonical 请求的新调用 key、不同 target 拒绝及无重复 admission 效果断言。不删除用例或将失败当成功。

- H2 HTTP 首批及上述 CI 修复 `465987a332e74f8db29ede7405f2b6b5275fbc15` 已发布，main／origin/main 精确同步；新 CI `36376587910` 已启动，前批失败保持原记录。仍无 CS adapter 或 M0 部署。

- A-T3/H2 WS 续批：身份合同转归 identity-access public participant，本地 adapter 封装 query 提取、session／PAT／daemon、bootstrap 拒绝、重验 key 与到期读取；runtime-management 仅接收 bootstrap 所选身份 participant、继续拥有通道查询。WS 传输持有不透明内存凭据，由同一 adapter 负责 upgrade／open／主动重验及同步帧到期判断；原 epoch、重验合流、presence、通道 gate 与释放顺序保持。两 provider 根明确装配 local，兼容类型别名不再暴露本地 token union。
- WS 回归继续保留原多 token、provider transition、单次 lookup、presence 和重验行为套件；新增真实双 provider 的替换 adapter 用例，使用非 token query、不同凭据形状，覆盖异步 upgrade、open 重验、同凭据双连接合流和广播过期关闭。旧入口源码锁与实际 owner 迁移同步，不改变 REST 不接受 query 的判据。仅目标静态检查，正式结果以本批 GitHub CI 为准；不据此声称 CS 登录已接入。

- WS 续批静态复核补齐 RFC-305 精确 public／consumer 清单：前批新增 HttpAuthenticationParticipant 与 authentication composition 的条目、本批 WS 两个合同及 credential owner 迁移均逐条对应源码；扫描器和判据保持。架构净 public +2、exception -1、owner -2、import／mutation 数不变，删除前批已消费 allowGrowth，仅保留本批两个已消费 WS 合同的精确增长。W29 只更新 PG composition 内 token 从 WS transport 移到本地身份装配的摘要。

- 前批 `465987a33` CI `36376587910` 已完成 check；运行中的后端作业显示迁移已通过重复 start 和真实回滚，剩余旧断言把 active 表数固定为182（当前合同186）。改为核对回滚前后操作 tableCounts 保持一致，不再把 schema 演进误报为迁移失败。同时更新 runtime registry 接线文本锁以容纳并要求显式 public satisfies 绑定；补记 auth/session 兼容门面的4条精确 R1 边及具名退役阶段。移入 owner 的 Actor 投影直接返回同一对象，删除原兼容层多余类型断言，没有增补检查逻辑或改变认证行为。此批继续由新 SHA CI 验收，不将前批失败作业记成功。

- WS 续批 `51fed92c17735d570df994ae1a3320d9b8339011` 已发布，推送后 main／origin/main 同步。精确 SHA CI `36377661392` 已启动，maintenance-soak `36377661346` 单独记录；未取得完整终态，不记 A-G 通过。

- A-T2/H6 评审文稿切面：保留 collaboration 的 HumanGateArtifactStore／operation journal，允许 stage／finalize／cleanup 返回异步持久 receipt；准备、提交后发布及恢复全部等待效果完成再更新原状态。新增 owner-owned ReviewArtifactContentPort，DB reader 保留原 committed／completed 及 staged fallback 规则，字节读取归 file adapter；composition 可在无 appHome 时注入成对的存储／读取实现。standalone 文件路径、内容摘要、旧无journal文稿和恢复行为不变。
- 新增双 provider 真库回归：异步 stage 完成前仍 preparing／declared、finalize 完成前仍 committed／consumed 且 staged 可读、cleanup 完成前不清声明；无本机 home 的内容 reader 覆盖异步等待、staged→final、摘要失配、缺失、旧文稿与读取失败。原 finalize 失败重试用例增加异步拒绝。生产和测试的既有本地读取入口显式选择 file adapter，没有新 PG 内容表或 CS adapter；Skills／plugins／其他产物与全量存储机制仍待后续，不记 H6 完成。

- WS 续批 CI `36377661392` 检出 fixture 的 `Object.freeze` 对象未推导两个 credential 参数类型，以及 RFC-305 精确 import 清单漏记 server 中第二条 IA participant 类型导入。本批显式标注 `RealtimeCredential`，补齐实际导入条目；不修改扫描判据。原失败作业不记成功，正式验证交给本批精确 SHA CI。

- H6 评审文稿切面及 WS CI 修复 `f518f037323b3c18e3ef2acc058720bd4d5ff2c5` 已发布，推送后 main／origin/main 精确同步。CI `36378565660` 已启动，未取得整体终态；不记 A-G 或部署通过。
- H1 Intent 请求配置续批：九处轮次入口等待注入配置 query，保持各入口原读取位置；创建／预留前读取，取消入口仍先执行原取消再读取后继配置；dispatcher 的配置快照直接使用 Config 值。两 provider 根复用现有 live file reader，W29 仅重采这两处绑定摘要，装配语句数量及其余摘要不变。新增双 provider 真库用例验证异步读取失败不创建会话／轮次、非法 payload 优先拒绝，以及每次消息读取新预算且预算不足不预留轮次。其他后台、执行和 Intent 启动恢复读取仍未完成。

- Intent 请求配置续批 `345275ada20d9da042206da47494ac8480d8dda9` 已发布且远端同步；CI `36379106536` 的 check 作业已通过，整体仍在运行。前批 `f518f0373` CI `36378565660` 被后继发布取消，不作为完整通过证据；由包含它的后继 SHA 验证。
- H1/H8 Webhook 配置续批：integration-owned WebhookConfigurationQuery 支持异步值，端点 URL 展示及触发器保存验证移除 configPath／文件读取。两 provider 根复用原 live file query；端点写入仍先持久化再补响应 URL，列表逐项读取且保持顺序，读取失败仍返回原 null／默认 runtime 回退。新增双 provider 真库用例覆盖等待、公开地址热更新、各写响应与轮换以及读取失败；CS EventDelivery／receipt／ACK 仍留 B/M3。

- Webhook 配置续批 `3db623de22bd94c9fab82b5106d1e07a132191f1` 已发布并同步远端。CI `36379849533` 被后继 `640e4f4fb` 取消，不能记完整通过；包含提交的 CI `36379958665` 当前 Markdown 失败位于并行 RFC-371 demo 的本机地址链接，其余作业尚待终态，未改动该任务文件。
- A-T2/H6 技能读取续批：抽出 resource-catalog-owned `SkillContentReader` 和独立 file adapter，技能正文／文件树／单文件读取支持异步替换；catalog 显式装配，原直接调用保留 file 默认实现。版本选择、availability、正文解析和 metadata／token 仍由 AW 控制；原快照优先、旧 live fallback、文件错误和树元数据保持。补双 provider 的真实目录／catalog 替换、异步期间 metadata 更新、无 home 读取、失败与消失行回归。写入、版本发布／恢复和导入导出仍待抽取，不关闭 H6，也不开放 CS 编辑。
- H1 设计勘误：当前 `start` 已以前台运行，托管缺口是配置／安装元数据／控制文件和生命周期装配；复用现 `serveDaemon`，不另造 HTTP listener 或以消除 fork 作为本次成果。

- 本批只做目标文件 Prettier／ESLint、diff 检查与源码派生 census，未运行本地测试；文件树遍历函数与迁移前逐字一致。实际账本新增一个只读工厂入口、九个 owner 项和三条净 util 引用／exception，均逐项记录一次性增长；不改扫描范围或判断规则。正式功能验证交给本批 GitHub CI。

- 技能读取切面 `583820430aa05d1563a310d981c6fe411838679c` 已上库且远端同步；CI `36380693407` 被后继文档修复 `83ac30718` 取消，不能记成功。并行作者已修复 RFC-371 的本机 demo 链接，包含提交的 CI `36380839265` 尚待终态。
- A-T2/H6 版本内容续批：新增 `SkillVersionContentStore`，版本存储按 plan／stage／capture／publish／abort／discard 接线，现存 DB 四阶段状态机继续拥有版本号、操作日志、空写决定和提交。正文／文件增删、版本恢复、初始归档及 ZIP 覆盖改用平台中立的声明式变更；file adapter 保留原复制／指纹／快照／发布效果，旧 callback 仅由本地兼容 API 消费。catalog 与 ZIP composition 共用所选 store，没有 CS DTO。
- 本批测试补双 provider 真库的阶段等待、持久快照失败后补偿等待与补偿失败留待恢复、提交后发布失败再放行且不重复版本、空写等待和真实文件 adapter 异步增删／恢复／二进制替换。旧技能与导入／版本／崩溃回归继续走 local adapter；本地仅跑目标格式／lint 和源码 census，不跑功能测试。
- 边界仍明确：`StagedSkillVersion` 的旧持久 journal 词汇保持兼容，物理引用在版本漏斗内交 adapter 解释；启动 recovery handler、初始树准备／删除、history／ZIP create／统一资源导入及 legacy backfill 仍有本地依赖，后续必须按同一持久存储接线。不能仅注入本批 store 就开启 hosted 编辑或宣告 H6 完成。

- 候选源码复核确认 `commitSkillVersionInTx` 与前批逐字一致，未改 DB 提交或既有业务判定；目标格式／lint 通过，census 记录实际入口 +2、owner +11、净 util 引用／exception +1 并替换前批已消费的增长说明。后继 CI `36380839265` 的 Ubuntu shard 2 为文档提交后一次性 allowGrowth 过期（本批以实际新增长重新登记）；macOS shard 4 的唯一失败为既有全仓源码扫描超出 5s，本批不改扫描判据或预算，等待新候选正式验证。

- 版本内容切面 `9dec01277ac429240b91796e5cc16e83eebc45ec` 已上库并与远端同步，CI `36381850501` 已创建。发布后补查旧源码锁发现 `skill-version-atomic-publish` 仍把 swap 固定在 legacy 文件；续修同时锁定 AW→所选 store 的等待接线和 local adapter 的原子 swap，并在两处禁止非原子发布，不放宽原判据。此续修仅测试／记录和已消费增长声明退役，无生产变更。

- A-T2/H6 首次创建续批：新增 `SkillCreationContentStore` 与独立 local 实现，普通新建／ZIP create 改传中立内容，catalog 同时为 repository 与 ZIP 选择 creation／version store。统一 file 写树函数复用原二进制及主文档行为，删除重复 ZIP 函数。预留前纯 plan，initialize／discard 等待异步完成；AW 原 reserve→ready 与初始归档顺序不变，提交前清理失败仍释放 DB 预留，提交后错误仍保留待恢复操作。
- 新增双 provider 回归覆盖初始化／发布期间不可见、初始化失败等待清理及清理失败、计划失败零预留、post-commit 故障保留、bundle 阶段补偿，以及实际 catalog 普通新建／ZIP 与 live／snapshot 二进制字节。非文件 fixture 仅验证端口，不能替代 CS 持久化或真实部署验收。删除、history、backfill、boot recovery 和所有 bundle 调用者尚未收口，H6／A-G 仍未完成。
- `954f91f2ee9c5ce7a1b03ad516c389a5c8391e46` 的 CI `36382025085` 已检出三类需修复测试：SkillContentReader 用 plain Actor 传入 DirectAuthenticatedAuthority（本批改为真库用户的正式 admission）；RFC-347 exact 源码锁仍指向旧 auth/session（本批改锁唯一 localCredentialAdmission 与 compatibility composition 的实际入口）；Intent invalid payload 原契约为 422 而新夹具误写 400（本批纠正并增加 intent-invalid code 断言，继续锁零 config IO）。不为这些失败更改生产身份或 HTTP 合同，旧失败 run 不记通过。
- 本批目标 Prettier／ESLint 和源码 census 检查，未运行本地功能测试；实际 mutation 入口净增 1、owner 项净增 11，逐项声明一次性增长，其余账本按源码重采。正式功能结果仍以新候选精确 SHA 的 GitHub CI 为准。

- 2026-09-28 用户要求优先修复 CI，新增适配暂停。创建切面 `a9cba5f7c` 的 CI `36383302845` 类型检查失败于 ZIP 夹具缺少 `encoding: base64`；该遗漏已由后继 `78e3e9cca` 补齐，当前主干 `6aeb271f6` 的检查任务 `108865765242` 已通过类型／lint／格式／shared／system-mocks。完整 CI 尚未结束，不能以此宣告全绿。
- 当前 run `36403163358` 新失败为四份架构 provenance 摘要及 RFC-371 定价测试的四个历史幂等键误报。摘要由并行观测会话修复，本会话不重采含未完成历史读取重构的源码，也不接管其修改；仅按确切 commit/path/rule/line 登记已核实测试字面量。保留全仓扫描及既有判据，等待包含两项修复的最终 SHA 验证。

- 修复提交 `15b66b6d5` 的 CI `36404992960`：42 jobs success，但三后台分片 cancelled，聚合门失败，未达到全绿。Ubuntu 11/12 与 macOS 5/6 均停在本 RFC 创建清理夹具：`expect(pending).rejects` 在清理屏障释放前等待，测试无法走到 finally；改为立即挂接普通 Promise 拒绝观察器，先检查预留／锁再释放屏障，最后断言同一错误对象。所有原业务断言保留，既有版本存储测试采用相同非阻塞观察方式。
- 另一个 Ubuntu 5/12 分片持续输出通过用例至作业 15 分钟上限，测试阶段已耗 13m56s，未见失败断言；按仓库现有预算策略把 Ubuntu 后台 12 分片增至 16，保持全部双 provider 测试、单例串行执行和原作业／单测超时。此容量调整不用于掩盖上述屏障卡死。静态扫描、类型检查和原摘要失败分片在 `15b66b6d5` 已通过，新的完整候选仍须重新验收。

### CI 分片精确登记补齐（2026-09-28）

93f360dec / CI 36408910757 的 root-test-entrypoint 检查仍锁 Ubuntu 12 片；同步为已发布的 16 片，保留每片唯一、完整发现集、OS 与覆盖上传断言。RFC349 的分片和 schema 用例名引用由并行 RFC371 会话修正。本批另删除上一提交已消费的 MCP ledger allowGrowth，并用既有 provenance 函数更新摘要；基线仍为 395，不重跑含未提交适配代码的 census。正式验证继续只认最终包含提交的 GitHub CI。

### H6 历史内容读取续批（2026-10-01）

- 上轮 CI 修复已在包含提交 `8a509ffbc1ddd7693e7e788d3dd84653a9d982ec` 的 CI `36411046837` 取得 50/50 success。当前恢复阶段 A；本批不夹带 CS 生产 adapter。
- `SkillVersionContentReader` 承担指定历史版本的正文／文件树与 diff 字节读取，独立 file adapter 保留原快照路径、文件元数据与 NUL 二进制判定；catalog 显式注入。AW 继续选择和验证版本、解析 frontmatter、使用技能当前名称、计算原 git-style diff；不存在的历史内容不回退 live。
- 新双 provider 用例覆盖真实 catalog 的异步正文／顺序双树等待、无本地内容目录、版本缺失先拒绝、存储错误传播、真实文件元数据／二进制及缺失快照；沿用全部版本发布与恢复回归。仅执行目标格式／lint 和源码架构生成；正式行为待发布后精确 SHA CI。
- 初始版本 backfill、删除、boot recovery 与完整 bundle 路径仍依赖本地效果，本批不关闭 H6 或 A-G。独立评审工具在本会话仍不可用，未冒称门已通过。
- 重新阅读 CS RFC-035 `integration-contract.md` 与 `acceptance.md`：平台已记录对象上传／任务输入、暂停留卷、finalize 归档后原卷回收及卷后下载实机证据。AW 接入应使用服务域对象客户端、不可变 objectId／摘要、持久引用及稳定 requestKey；小型元数据归 PG，任务工作区归 `/work` PVC，服务零 PVC。当前只记录平台合同可用，B3 的容量／迁移与 AW 自身持久化方案仍须在对应 B-T0 冻结并验收，不以平台单独通过替代 AW 联合部署证据。

### H6 生命周期内容与操作恢复续批（2026-10-01）

- 历史 reader 批次 `c60e49975dba08818fd7368d654b3cd6e6d0fd04` 的精确 CI `36839289539` 已终态 50/50 success；原 CI 优先修复已完成，不将取消或局部成功当成全绿。
- 新增 `SkillLifecycleContentStore`、`SkillSnapshotInspector`、`SkillDeletionContentStore`、`SkillVersionRecoveryContentStore` 与独立 local adapter。初始归档、legacy 空壳清理、缺失 live 恢复、完整历史字节检查、删除暂存／补偿／回收、版本恢复的文件效果迁入 adapter；AW 保留版本和引用选择、完整历史判断、数据库阶段／authority、可用状态和锁释放。原路径、内容指纹、两次 rename 发布及既有错误判据保持。
- catalog 与 boot composition 显式选择这些实现。身份迁移屏障透传已选恢复端口给原 recovery driver，预留回滚也可等待所选 creation store 的 discard；完整身份迁移／物理归属预检仍是本地实现，尚不能据此声称 boot 可在零 PVC 服务中运行。
- 新增三组双 provider 回归，验证异步效果未完成时版本／可用性不提前发布、删除和恢复锁保留、失败后沿原操作及持久引用重试、元数据矛盾先拒绝、既有 live 手工编辑不覆盖、真实 local 内容恢复。额外通过真正 boot identity barrier 检验已选删除恢复 adapter 的等待和真实残留清理；原创建／发布／迁移回归保留。
- 仅运行精确文件格式／lint及官方源码 census；生成时在内存使用 HEAD 中的并行源码，未修改或纳入 RFC-371 在制文件。新增四个 file 工厂按既有 create 规则计入入口，两个 recovery 名称按既有规则计入后台分母，owner 净增20；实际增长按两笔发布协议声明并退役，不修改扫描判据。正式功能结果等待本批精确 SHA hosted CI，独立评审工具仍不可用，A-G 未通过。
- H6 仍有旧目录身份迁移、完整资源 bundle 及其余内容消费者；H1～H8 全切面收口、阶段 B 的 RFC035 对象方案冻结／独立 CS adapter、M0 与后续能力的联合实机验收继续。未部署本批、不关闭 H6 或整个 RFC。

### 生命周期 CI 配套修复（2026-10-01）

- `00367b19eb3d091bca9e83eac1b0b35bf2ca2835`／CI `36846302858` 已检出本批三类问题：删除夹具 `plans[0]` 在严格 expect 重载中可能 undefined；原 RFC345 的四条源码接线锁仍引用 `input`；canonical 产物混入并行源码。原 run 已终态 45 success／5 failure（含汇总失败），不记为成功，后续适配暂停。
- 删除回归先断言仅有一个已暂存计划，再核对同一个确定首项；boot 源码锁精确更新为 `selected` 并补四个默认 local adapter 的接线，保留唯一中立状态机／禁止 provider 孪生的原断言。没有改生产行为或减弱回归。
- 查明先前 fs 对象替换未影响 Bun 加载的 named import。修复仅在临时内存加载器接入官方 census 的 source read/readdir，按 HEAD 字节读取所有并行在制源码；仓库生成器、规则与他人文件不修改。生成后 `sourceDigest=sha256:e8aec5cb562cbe85c8ff5856fbc0e83ac347fbacc743231637237597bee8b4c2`，与远端失败日志自行计算的确切已提交语料一致；误混入的 opencode 清单标记同步恢复为 HEAD 的真实投影。
- 各 baseline 无增长，无新增 allowGrowth；只用原 provenance 生成协议更新摘要。两份回归的格式/lint通过，未运行本地 AW 测试/类型检查/构建。完整终态仍须修复提交 hosted CI；独立评审工具未恢复，不据此关闭 A-G 或 RFC。

### H6 身份迁移存储切面与 RFC-035 对齐（2026-10-01）

- 生命周期修复 `9887a0cd8af5e9dc7a94e2ea8ca6fe2f692b4c5f` 的精确 CI `36849001678` 已终态 50/50 success。恢复后续适配；原失败 run 仍保留为失败证据。
- 新增 `SkillIdentityContentStore`／`SkillIdentityInspector` 和独立 local adapter。迁移的源指纹／rename／回滚／完成，以及启动时目录归属、空壳清理、reserve／delete 内容检查和末尾目录证明由所选端口承担；AW 保留 metadata 选择、operation 判定、数据库阶段、引用、锁与孤儿行检查。既有本地效果和判据机械迁移，没有新增检查或 provider 孪生状态机。
- boot composition 同时选择两端口；身份迁移与 recovery driver 透传整个选择，等待所有异步效果后才提交下一阶段或释放锁。双 provider 回归覆盖无本地 home 的真实 boot participant、迁移未完成／失败、两种重启方向、DB 删除后空壳清理等待和 reserve v1 证明等待。原真实文件迁移／备份恢复回归保留。
- 静态对比确认 `assertOperationDbAuthority` 与 `writeCanonicalPaths` 迁移前后 token 相同；目标格式／lint通过，未执行本地 AW 测试、类型检查、构建或服务。正式结果交发布后的精确 SHA hosted CI。独立功能评审工具仍不可用，不记 A-G PASS。
- 按 CS 已落地 RFC-035 更新 proposal／design／B3／持久性清单，并补 [存储接入设计](./rfc035-storage.md)：对象字节由 CS 保存，元数据／域引用／效果日志由 AW PG 保存；区分 tree contentHash 与归档 sha256，先 ready／pin 再发布，未知写结果沿稳定键恢复。任务输入与活跃卷动态写入分别验收。M0 先部署、后续逐项收编的顺序保持。
- 完整 bundle／插件／其余内容消费者及 H1～H8 收口继续；本批不宣称 H6、A-G、CS adapter 或部署完成。
- 官方 census 记录本批真实分母：两个 create 工厂使 mutation +2；既有 sweep 名称规则使 background +1，没有新增定时器；两个原 ValidationError 引用使 observed import／exception 各 +2；owner 净 +18。逐项声明一次性增长，并在随后 ledger-only 提交退役；扫描范围和判据保持。

### 身份切面 CI 配套修复（2026-10-01）

- `d97f55dde9393464f4ca8f5cd5afdf1b7ffdee86`／CI `36854974478` 检出两处本批类型遗漏：机械移出的同步 graph helper 残留 `Promise<void>` 声明，reserve 夹具的已发布摘要仍被推为 nullable。改为真实 void 返回，先断言摘要非空再比较完整输入；不改变效果或数据库阶段。
- 同 run 还检出 RFC-371 的前端 exact 选项及 runner 观测夹具。前端由并行作者在 `f512dc321932e6be0b3453dfc6cc1b69c9bb9dd9` 修复，输出完整保留。本批 runner 的“独立投影”夹具显式报告 `reasoning: 0`，对应它原本断言的已知 output=10；保留全部输出、持久受理与不等待投影断言。生产归一化继续将缺失 reasoning 表示为未知，没有放宽判据。
- 格式／lint通过；通过 scoped source transport 仅生成 HEAD＋本次 inspector 修复的候选，未混入下一批 package reader 的未提交代码。全部 baseline 无增长、allowGrowth 为空，原扫描规则保持。后续适配暂停发布，完整终态由包含修复及并行输出的精确 SHA CI 给出。

### 身份切面平台清单修复与资源包候选（2026-10-01）

- `7e33d3d415dbbe672eb9445be4020bb593cdff17`／CI `36858098007` 已取消；macOS shard 1 的两条原目录 identity 比较允许记录尚指向旧 legacy 文件，原失败仍保留。并行作者在 `eef12e256408a54d5e52c351c23e4ebea9fdeb32` 将两条记录迁到实际 local adapter，匹配数量与原判据不变；同时保留其观测／E2E 修正。该提交 Windows platform `36862619599` 已 success，主 CI [36862619605](https://github.com/wangbinquan/agent-workflow/actions/runs/36862619605) 已 completed/success、50/50；本批不重提或覆盖其输出。
- 资源包候选新增 `SkillPackageContentReader`，原文件字节与目录判据移入 local reader；AW 保留可用性和 DB 版本选择、主文档投影、全路径排序与二进制复制。两种 provider 共用同一选择，未就绪技能在 IO 前拒绝，异步存储错误不回落本机。
- 原资源包工件合同下沉 `application/package/artifactOwners.ts`，旧类型与工厂入口保留兼容。文件效果独立迁入 `infrastructure/local/fileResourcePackageArtifacts.ts`，composition 可选择 skill/plugin artifact owner；所选 plugin owner 不再被迫提供 local installer。恢复 composition 复用已有 recovery port，默认 SQLite 统一格式／legacy 回落与 PostgreSQL 实现保持，不新建状态机。
- 双 provider 新回归经真实 package apply／journal 检验 persist-before-stage、暂存与发布／完成尾部等待、非文件引用写入、提交前补偿等待、提交后错误保留 committed 行及选定恢复重试；两种 maintenance composition 保留 active attempt 并等待补偿后才 settle。原真实文件、七臂及幂等回归继续生效，原源码锁随 local 位置／reader 接线迁移，不降低断言。
- 精确格式／lint通过；机械 AST token 对比确认文件工件 owner 效果主体与提交版本一致，仅位置／合同／兼容名称变动。正式类型与行为仍交本批 hosted CI；不执行本地 AW 测试、类型检查、构建或服务。官方 census 记录实际 mutation +1、observed import／exception 各 +2、owner 净 +8，分别给出一次性增长说明，发布后按既有协议退役。
- 上述完整 CI 修复已收口，本批按精确路径发布，正式结果等待资源包候选确切 SHA CI。独立评审工具不可用，不能记 A-G PASS。其余 H1～H8、CS 独立 adapter、M0 首次部署和后续完整验收继续，RFC 不关闭。

### 资源包 CI 修复与 Intent 在制边界（2026-10-01）

- 资源包源提交 `e945204a80f3130d4ceae532ceafca4bf011d949`、账本 `0fb4894be2533f6c87e587a8b22b2a04898c84df` 已同步远端。其 [CI 36868540371](https://github.com/wangbinquan/agent-workflow/actions/runs/36868540371) 已 completed/failure、43/50；lint/typecheck 与五个后端分片的实际失败归为三个遗漏，原失败回执保留。
- 新测试导入了不存在的 `buildPackagePreview`，改为已有 `buildPackagePreviewFromReadPort(provider.reads, …)` 并提供真实 importId；同时按既有 parse 合同补齐插件 fixture 的 pluginSources 声明。未修改预检或包解析判据。
- RFC-345 原三参 reader 源码锁迁到四参接线，并固定同一输入的所选 reader／file 默认值；其余七臂、生命周期和服务依赖约束保持。W29 完整装配摘要只因已发布的两处 `NonNullable` 方法形参类型变化更新；保留 166 条语句、原顺序、全部相位与实例断言，未放宽摘要算法。独立 AST token 对拍确认完整 PG 装配的 runtime tokens 与 `eef12e256` 完全一致。
- 并行文档提交 `993ab7ce694988536ecf600d9e4a874901e5ea41` 原样保留，来源和远端已核对。本批精确提交三个修复测试及所需文档／官方证据，scoped census 从 HEAD 读取未提交 Intent source；不把其在制效果或新增合同混入修复。正式结果交本批确切 SHA CI，本地不执行 AW 测试、类型检查、构建或服务。
- 后续 Intent 中立工件合同、local 效果迁位、所选异步内容／恢复接线及真实双 provider 回归处于未发布候选；当前先修复资源包 CI。独立评审及 A-G 未通过，阶段 B／M0～M4 尚未交付，按用户要求持续推进完整 RFC。

### H6 Intent 内容、旧日志恢复与 scratch 续批（2026-10-01）

- 资源包 CI 修复已精确发布 `13f5b8e33350ba6159f85edd6eec1810750ef2e4`，对应 [CI 36874167121](https://github.com/wangbinquan/agent-workflow/actions/runs/36874167121) 等待终态；未以失败旧 run 或未终态 run 关闭 CI。修复未提交本节 source 候选。
- RC 原有 Intent 工件／stage／publication／owner 合同下沉 `application/intent/artifactOwners.ts`，三个具有真实跨域消费者的中立类型由 exact `public/types` 提供。事务参数改用现有 `DatabaseTransaction`，文件工件效果迁到 `infrastructure/local/fileIntentApplyArtifactOwners.ts`，旧工厂／类型路径仅兼容出口；没有第二套资源事务或发布状态机。
- Intent-owned `IntentArtifactContentPort` 承担插件内容存在／丢弃、技能内容发布／丢弃与旧格式补偿，local 实现独立落位。AW 保留 DB 元数据／快照检查、版本选择、journal 解码及收敛、错误隔离和已提交回执；由 AW 先判断 current／superseded，再把事实交存储，adapter 不复制版本业务判据。
- apply composition 可独立选择 skill/plugin owner、内容生命周期及 legacy 兼容端口；boot/hourly recovery 复用同一选择入口，保留自定义 pluginsDir。旧格式继续按整批撤销 boot 标记、逐条等待发布、原事务收尾顺序恢复；默认 standalone 仍使用原 file 实现。
- `IntentScratchStore` 只拥有 stale listing／remove，file adapter 机械迁位，旧名称保持兼容。维护 composition 允许选择异步 store，等待列举及删除后才推进原计数和 swept 标记；running 与失败删除仍排除。旧 application/maintenance 的直接测试兼容入口、turn 执行 scratch 物化及其他内容消费者尚待后续收口，本批不关闭 H6。
- 新真实双 provider 回归覆盖创建／更新、persist-before-stage、owner／content／complete 等待、幂等重放、提交前双层补偿、提交后错误与重试、AW 元数据／superseded 判据、selected legacy 整批发布、boot 原生／旧格式与 active fence、scratch 异步等待／运行／失败／recent 保留。原真实文件及 RFC271／355／359 行为锁保持，源码路径锁随 local 迁位。
- 机械对拍确认 RC file owner、Intent 原文件效果、legacy replay、journal convergence、apply engine 与资源事务主体的 runtime tokens 保持；scratch file 工厂效果主体逐字相同。仅精确格式/lint和官方源码 census，本机不执行 AW 测试、类型检查、构建或服务。实际 census：mutation 1781→1782、observed imports 5585→5590、exception 4962→4960、public 1030→1033、owner 25573→25587；真实增长按既有协议逐项解释并在发布后退役。
- 正式行为等待本节发布后的确切 SHA CI。独立评审工具仍不可用，未记设计门／实现门或 A-G PASS；H1～H8 余项、CS 各 owner 独立 adapter、M0 首次部署及 M1～M4 验收持续推进，RFC 保持 In Progress。

### 资源包 CI 第二轮夹具补正（2026-10-01）

- `13f5b8e33350ba6159f85edd6eec1810750ef2e4` 的 [CI 36874167121](https://github.com/wangbinquan/agent-workflow/actions/runs/36874167121) 已有后端失败，整体终态尚待回执；原三类导入／类型／源码锁遗漏已通过。Ubuntu 2/16 的真实包解析指出新夹具 opId 使用 `op-storage`，与既有 `op-<n>` schema 不符；改为 `op-1`，包解析、预检、storage 效果及原状态／等待断言均不变。未发布 Intent 同类夹具同步纠正，但不混入本次修复提交。
- macOS 1/6 的既有 RFC294 E9-C 崩溃重放用例第一次在固定 50ms 后未进入 launch，第二次随后看到了延迟的 `execution-2`。改为等待 core 明确到达 before-task／after-task 对应崩溃位置，再推进租约时钟与重放；after-task 必须先完成真实任务行写入。保留所有 execution-1、单行、admission 与内核零重复调用断言，不增加重试或修改生产派发。
- 两份修复测试精确格式／lint通过。官方 scoped census 从 HEAD 读取 Intent 在制内容，baseline 无增长；仅发布测试、文档与 provenance。正式结果以本次修复 SHA 的完整 hosted CI 为准，不把当前失败或可能被后继自动取消的 run 记成功。RFC 全部实施与部署持续，A-G 未关闭。

### 配套 CI 回执与下一批边界（2026-10-01）

- 第二轮夹具补正已发布 `ce8a6310adb9576559f4d5100d4916635a104720`，[CI 36876744628](https://github.com/wangbinquan/agent-workflow/actions/runs/36876744628) 进行中。前继 `13f5b8e33`／36874167121 因后继 push 自动取消，终态为 cancelled、34 success／4 failure／12 cancelled；三处后端失败均已取实际日志，分别为包 opId 和崩溃位置固定等待，不以部分绿关闭。没有手工取消 CI 或降低门禁。
- Intent 内容／scratch 候选已经完整准备，scoped 官方 census 仅纳入其 21 个源码／回归路径；从 HEAD 读取下一批任务配置在制内容，未纳入其新增文件。正式发布等待上述 CI 修复完整终态通过，避免夹带后续 feature。原 `op-storage` 同类 Intent 夹具已经按实际 shared schema 改为 `op-1`。
- H1 任务操作配置下一批候选：TE-owned `TaskOperationConfigurationQueries` 只提供当前 binary 路径与 commit exclude patterns。原文件读取包在独立 local adapter；AW 仍负责 mint-time 冻结、每次 operation 数组快照与读取失败时的 launch fallback。六个 node／wrapper／commit 冻结调用及 commit policy 调用均等待所选 query。
- 所选配置能力由 driver 在每次 drive 注入，包括子任务；不进入持久 child run-config 包，原继承清单保持。legacy 文件路径入口仍选择原 live file adapter，所选 query 失败不回读本机。下一批新增真实双 provider／双 runtime 冻结回归、异步等待、配置修改后的旧快照／新节点、commit 数组与 fallback、无文件读取及继承边界回归；本地仅精确格式/lint，未发布或运行正式测试。
- 任务启动 policy、上传限制、后台热读、CLI 生命周期及其余 H1～H8 仍继续收口；本节不关闭任何全切面或 A-G，CS adapter 与 M0～M4 顺序保持。

### 独立功能门备选回执与 H8 多 source 补正（2026-10-01）

按仓库明确的独立子代理备选完成两个精确候选实现门：Intent 21 路径、任务操作配置14路径均有限范围 PASS，未运行本机功能门禁，正式结果仍待各批 exact-SHA CI，不关闭全 H1/H6/A-G。设计首轮仅 H8 单 producer→单 endpoint 的一项功能遗漏；已补来源配置/多路由/逻辑事件完整冻结集合/逐目标持久受理，不合并原 endpoint 规则与观测。八个多 source、局部恢复、跨订阅、路由变更及 MR受理→两类观测间崩溃场景纳入 B-T5；修订稿独立设计门已 PASS，完整 A-G 尚未通过。详见[独立功能门记录](./functional-gates.md)。原工具不可用和历史门状态保留。

资源包第二轮修复 `ce8a6310adb9576559f4d5100d4916635a104720` 的[主 CI 36876744628](https://github.com/wangbinquan/agent-workflow/actions/runs/36876744628)已 completed/success，50/50作业全部成功，headSha完全一致。前继13f的 cancelled/failure 历史不改写；本轮已恢复主 CI，再发布有有限独立功能 PASS 的 Intent 内容/scratch 候选及 H8 设计补正。下一批任务操作配置14路径保留且从本批官方census排除，不混入本批提交。

### Intent 配套 CI 六类遗漏修复（2026-10-01）

Intent 源提交 `497149ad2ad04b42fbc4d7902036b019be8ed880`、账本后继 `2d65a16f5152936ec93de1f0fd362a671e89e44d` 已精确同步远端；[CI 36882578362](https://github.com/wangbinquan/agent-workflow/actions/runs/36882578362) 终态 failure、38 success／12 failure，报六类配套遗漏，暂停后续 feature 发布。将两个 owner 移到 participants 出口，artifact 数据留 types；publication 只接现有 neutral transaction callback，移除两处强转，保留同一事务与 effect 主体。更新移动函数路径、下沉合同的类型依赖和两工厂改名后真实语料下限（函数66／adapter62），原扫描、零孪生、生产消费者及 fixtures 不变。十路径独立有限功能实现门 PASS，详见 functional-gates；正式结果继续等修复 SHA CI。

官方 census 只读取已提交源码加十路径修复，排除任务配置／后台配置18路径候选和其他并行内容。owner／public 等基线没有新增长，observed import 5590→5589、exception4960→4959；仅源码生成与精确格式/lint，无本机 AW 功能测试／类型检查／构建／服务。完整 RFC 和部署继续，A-G 未关闭。

### Intent CI 恢复终态与 H1 任务配置续批（2026-10-02）

修复 `a4b706b942adfc9ca16c15e329ba1f7fa97f78f8` 的 [CI 36886742257](https://github.com/wangbinquan/agent-workflow/actions/runs/36886742257) 因并行文档 push 自动取消，终态48 success／1 cancelled／1 failure（汇总），不能写全绿。包含修复的后继 `8d7e078e31527a3b70c5058af9fb25c4b23ff1f4` 的 [CI 36890491336](https://github.com/wangbinquan/agent-workflow/actions/runs/36890491336) 已 completed/success，全部50个作业 success；祖先及两份 RFC371 文档差异已核对，修复源码没有改变。原失败和取消回执保留。

本次 H1 候选覆盖33个精确源码／测试路径：任务操作配置的六处异步 mint 冻结及 commit patterns 热读；任务后台的启动、四类 tick 热读与 startup/drain；任务 launch 的 commit/runtime/child 三次独立读取、subagent 和 upload 限制。三个 owner port 与三个独立 local file adapter 由 composition 选择，AW 保留每段投影、过滤、默认和失败回退；所选 source 不回读文件。同步 standalone helper 和原25处同步启动回调保持。

协调器在 attach 后等待异步 runtime；读取失败报告并释放，等待期间取消则释放而不进入 admission／准备／执行。独立复核发现所选 source 删除 optional 配置时 boot deps 残留；现只使用本次 launch 投影，并保留宿主 binary override／configPath／memory participant。双 provider 回归覆盖带 boot 配置的删值与三段独立失败。原三个策略投影的 AST runtime token 等价；目标格式/lint通过，真实双 provider／双 runtime 新回归正式结果交本批 exact-SHA hosted CI，本机未运行 AW 测试／类型检查／构建／服务。

官方 census 从已提交源码加33路径候选生成，排除并行 RFC371 内容。真实计数：mutation 1782→1787、observed imports 5589→5608、对应 exception 4959→4978、public symbol 1033→1043、owner 25587→25619；各增长按原 ledger 规则记录 RFC370 一次性依据并于后继账本提交退役，不改扫描规则或现有门槛。此批不关闭全 H1、A-T2 或 A-G；H3～H7、完整入口普查和 CS adapter／M0～M4 按已批准顺序继续。

### 任务配置 CI 配套修复（2026-10-02）

本批源 `4f8244883a30bdbb4e17e431161cb2b96848f72f`／账本 `dd94236a4cdbf08ad41881332db55e94316bcfe6` 的 CI36924136910 已终态 failure，41 success／9 failure，保留原完整回执，不写全绿。新 launch 测试在 standalone buildStartTaskDeps 用 drive-only 夹具，遗漏 SchedulerDriverPort 三个必需方法，改用原完整 createNoopSchedulerDriver。共享 public/queries 完整文件还保留了并行 RFC371 的 positions 合同，该配套 Task owner 实现先前漏提；本修复保留其当前完整6行并行输出并补独立双 provider 同时间／逐项游标／空 cohort 回归，不剥离已提交合同。

另三处旧源码 oracle 仍锚移动前 resolver 或旧协调器 getter，现移到实际 TE 策略／单一解析点，保留字段／类型／唯一 spread／禁止 boot 冻结断言并加 selected 与 legacy 两臂。任务 INSERT 四站点及三血缘列均完整，只更新两个漂移行号。五条 local composition 兼容入边按原 R1 exact 规则记录 why/owner/A-T7 退役，255→260；不增加目录豁免或放宽 scanner/fixtures。官方 scoped census 只纳入10个修复源码／测试和精确登记，H3新候选及其他 RFC371 WIP排除，所有 ledger 数值不变。正式效果继续由修复确切 SHA hosted CI 验证，本机没有 AW 测试／类型检查／构建／服务。

最后四个后端分片还报告 RFC287 T14 导出类型旧位置、RFC332 两处单微任务假设，以及 macOS RFC363 完整迁移历史超过默认5秒（5048.83ms）。导出合同断言移动到 TE 类型并加 legacy ReturnType 两字段检查；两个测试改等真实 continuation/effect started 事件，原未结算／顺序／释放断言不变；只给该迁移用例20秒明确上限，完整历史和拒绝判据保持。

H3 工作区维护6路径候选仍在制。独立复核发现异步 exists 旧快照可绕过新 pruning claim 提前 heal；将修正 shared SQL 原子条件并补真实双 provider 交错回归，再单独复核／发布。本次修复不提交该在制候选，完整 RFC、A-G 及 CS M0～M4 继续。

### H3 工作区维护异步切面（2026-10-02）

沿用原 SC WorkspaceMaintenanceFilesystem、Node adapter、SQL store 与终态清理状态机，开放所选 filesystem；exists、三个列举和 materializing 可异步，全部调用点先 await 再使用，所选 adapter 不回退到本机。原回收年龄、活跃任务／物化保护、失败 claim 和完成顺序保持。

独立首门发现旧 recovery exists 快照与前台 resume／取消／finalize 交错：远端物理删除尚未确认时，旧 false 结果可提前 heal。补写 SQL 现在原子核对无 pruning claim、仍终态／未删除、同一 worktreePath 与 lifecycleEventRevision；两个应用调用点传枚举快照，复用已有生命周期 revision，不新增迁移或第二种 authority。六路径修正后由独立 `/root/intent_functional_gate` 有限 PASS，指纹 `51e83940efeca6a06c7ef9b3fe2b939ef3c18b0df45ba449ff3c3a1100e010c6`。

新增真实双 provider 回归含异步 false／异常重试、四种过期快照与两实例清理 ACK 成功／失败交错：确认前及失败后 pruned=null、claim=claimed，真正持久重试确认后才完成。保留原 selected listing／materializing／iso active 判据及真实 local 维护测试。官方 scoped census 只纳入此六路径，所有 ledger 数值不变；本机仅目标格式/lint及静态语料生成。修复 `c028b22c4a9a5281aa9013d4fac058c343f3a4f3` 的 [CI36928636248](https://github.com/wangbinquan/agent-workflow/actions/runs/36928636248) 已 completed/success，50/50 job success；现发布本批，行为继续交本批 exact-SHA hosted CI，不以有限复核替代正式行为。其他 H3／A-G、CS adapter、M0～M4 仍继续。

### H3 恢复预检存在查询切面（2026-10-02）

SC-owned `WorkspacePresenceQueries` 与独立 file adapter 只提供同步或异步物理存在事实。TE preflight 逐项 await；保留准备未完成409、无任务不探测、多仓任一存在即短路和原410。Legacy resumeKick、SQLite 工作组 continuation 与 PG 工作组 continuation 可使用所选查询；包装调用保留 adapter 的 this。普通 `/api/tasks` resume 另经共用 child lifecycle admission，其物理检查仍未切换，下一批沿实际 bootstrap 接线，不能据本批关闭全 resume/H3。

十路径由独立 `/root/task_config_functional_gate` 有限 PASS，指纹 `ada4b1d9492b69d8aae8bd62ba362ca97d64eadd4fa81664e5b2d3f12c049e15`。新真实双 provider 回归检验 pending/false/reject、409 不探测、多仓順序/短路和真正 workgroup composer；local adapter 真实文件存在/缺失/空引用保持。PG 166 statements/order 的全体 AST 除唯一 worktreeExists 绑定外逐字等价，W29 原逆变换摘要精确迁移，SQLite 两摘要不变；INSERT 血缘四站点只跟随实际行号2467，全部列判据保持。

官方 scoped census 仅纳入这十路径，mutation +1、imports +5、exception +4、public +1、owner +4，各按原账本协议登记并后继退役。仅目标格式/lint与静态源码生成，无本机 AW test/typecheck/build/service。维护前批 `65db0c7710ed527663010112385b93c38f3e3323` 的 CI36931610730 尚待终态；本批行为交新的完整 hosted CI，取消/失败记录分别保留。A-G、CS adapter、M0～M4 仍未完成，RFC 持续。

### 普通 resume 候选与存在查询 CI 源码登记修正（2026-10-02）

普通 resume 的 11 路径候选已获独立有限功能 PASS，指纹 `0d867898de6af0ebef9b3b838b0f72d9bc6f1af588fd2582cb9488734cd52217`。真实 SQLite/PG bootstrap、child lifecycle admission 与工作组复用所选 WorkspacePresenceQueries，逐项 await、保留 this、phase 优先拒绝与多仓任一存在短路；host capability 不进入 ChildResumeRuntime。新增真实双 provider 回归只验证 admission/source-closed 边界，不冒称已运行 AgentTaskEngine。尚未发布，不据此关闭完整 H3。

存在查询已发布 tip `e3b656a10e2bae30c2c51994d565bbcc649efed6` 的 [主 CI36932108422](https://github.com/wangbinquan/agent-workflow/actions/runs/36932108422) 已 completed/failure：47 job success，两 backend 分片失败和汇总失败。两个分片均仅是同一 INSERT 来源行号登记 `services/task.ts:2467` 与格式化后真实 `:2466` 不一致。原四个写入站点和三列血缘完整；修正仅更新该行号，保留逐字/列完整性/新增站点等断言。正式恢复仍等修复提交的 hosted CI，失败历史保留。[Windows surface36932108486](https://github.com/wangbinquan/agent-workflow/actions/runs/36932108486) 已 completed/success、headSha一致。维护提交65db的主CI取消，不记该精确SHA成功。

按只读剩余依赖审计收束 [八个阶段 A 实施组](./remaining-a.md)，不新增平台业务耦合、不改 A-G 或 M0～M4 顺序。共享架构清单已与 RFC371 原会话按用户授权协调，双方源代码保持；其 c2c96cef4 发布后，本候选登记已重新生成，imports5615→5620、exception4984→4987、owner25648→25647，仅前两项实际增长按原协议登记/后继退役。其他有限候选源码均排除。

行号修正 b8995791eb0eb177f944b04166c1e4922d7b3690 和三条已消费观测增长许可的退役后继8cb41fdfa9331183e4a27f32cedfd94b967fbb00均已同步远端。退役不改计数、源清单或历史说明；[CI36938903292](https://github.com/wangbinquan/agent-workflow/actions/runs/36938903292) 正式终态仍待验证，不能以静态对拍替代。普通 resume 与其他 feature 候选先等 CI 恢复再发布，持续推进不冲突的 A 实施。

### 阶段 A 八个有限候选的发布准备（2026-10-02）

普通 resume 11、经典目录 availability 10、插件 local 5、selected boot 2、DE 程序读取3、DA evidence读取6、终态复活11、安装示例完成6，共54个不同源码/测试路径；每组独立有限实现门及指纹见 functional-gates。各自保留原业务、standalone local 和真实 provider 回归，不以这些有限门代替完整 A-G。boot roots 的终态 presence 贯穿仍为下一步；其余八实施组按 remaining-a 持续。

官方 scoped census 从共享 main 已发布语料加上述54路径生成，所有其他在制源码排除。真实计数 mutation1788→1792、observed imports5615→5627、required port36→37、exception4984→4991、public1044→1047、owner25648→25670；六项实际增长按原协议记录一次性许可，源发布后后继退役，不改变扫描规则。seed wrapper 的一条 exact default composition 入边登记 why/owner/A-T7，commons inbound260→261；TE default presence 的跨域内部边明确保留实际分类和 A-T7 注入退役依据，不虚报为零耦合。

前继8cb的 CI36938903292、6b42a9de6 的 CI36940613451 已发现 RFC371 测试夹具的类型／前端失败，不记全绿；并行前端修复完整保留。后端三处测试类型遗漏已作单文件功能修正并经有限独立 PASS，精确上库同步 `0120088f8557ef7357b69e0d0294dd5575d3c842`，完整共享 RFC371 文件含其原并行输出。正式恢复等待 [CI36942147693](https://github.com/wangbinquan/agent-workflow/actions/runs/36942147693)，只有恢复后再发布上述功能候选。仅目标格式/lint与官方静态生成，无本机 AW test/typecheck/build/service，RFC/M0～M4 未关闭。

### CI 范围 URL 修复与后续 local 候选（2026-10-02）

0120088f8 的 CI36942147693 已 completed/failure（45 success/5 failure），静态类型修复通过；三平台观测 E2E 与 macOS multipart timeout 仍红。只发布经有限独立复核的观测 search transport 三处修正，main/origin 同步3ac730f84；正式恢复等待 [CI36945626088](https://github.com/wangbinquan/agent-workflow/actions/runs/36945626088)。单文件首次有限FAIL和修正PASS均留 functional-gates；macOS clone未修改预算、未宣称解决。

journaled repository preparation 七路径和员工 local 内容四路径各获有限PASS，仍独立未发布并排除八批54路径canonical。本批冻结源指纹均不变，仅CI基准/证据与文档更新；恢复CI后按原八小批、真实治理增长及后继退役发布，再贯穿终态presence roots并继续八实施组。无本机AW test/typecheck/build/service，A-G、CS adapter和M0～M4持续，不关闭RFC。

### CI 恢复终态与八批发布（2026-10-02）

修复基准 `3ac730f84c9430459efb6d8fe72a6db9f5e8a1ed` 的 [CI36945626088](https://github.com/wangbinquan/agent-workflow/actions/runs/36945626088) 已 completed/success，50/50 作业 success，headSha 严格相同；观测 E2E 三平台及 macOS multipart 分片通过。multipart 单次停滞原因未确证，未修改预算或把重验成功冒称原因修复。原 012 的失败与所有有限门历史保留。

八批54路径源内容不变，现在短发布临界区按八个小 source commit、canonical/docs、六项真实增长许可后继退役发布。官方语料仍只包括这54路径；新 journaled preparation7、员工 local4、物理插件6、generation GC3 的有限 PASS 候选继续独立在制，全部排除。插件首四路径 source oracle FAIL 与纠正后的六路径 PASS 均见 functional-gates；后续必须登记其实际兼容入边。发布后先验证新 exact-SHA CI，同时贯穿终态 presence 的真实启动根和员工附件异步完成事实，再继续 remaining-a 全组，完整 A-G 与 B/M0～M4 不提前关闭。

### 八批发布与配套 CI 修复（2026-10-02）

实际十个小 commit 的 tip `165bb447dc0a8bc4f8e0e8ce9698512791a7477d` 已同步远端，发布回执确认其他所有在制文件字节不变。主 CI36948285794已终态43 success/7 failure；同 SHA maintenance36948285743成功。五个实际后端失败分片与 Typecheck 日志收齐，范围是作者 async closure type narrowing、证据夹具 DirectAuthenticatedAuthority、两个新增零消费者 type 出口、SO 精确 public 目录名和 TE file default 经 SC barrel 的实际 value SCC。没有修改扫描或既有功能判据，也没有取消原运行。

前三路径有限 PASS 后，将后两类遗漏补入六路径修复，完整候选独立有限 PASS。narrow SC composition 精确导出原 file factory，TE 只改变默认 import；所选实例、默认行为和业务状态机不改。官方 scoped 只包含六路径，TE value SCC 为零，public1047→1045、owner25670→25671，其他数值保持；新文件的唯一真实 owner 增长原协议记录一次并后继退役，正式恢复必须新 exact-SHA CI 全部终态。

附件五路径的首次错误夹具已按真实 intake schema 修正并有限 PASS；启动根十路径的 missing 场景按原410语义修正且独立复读有限 PASS。这些候选和 SC7/员工local4/插件6/GC3不纳入 CI 修复 canonical。恢复后发布这些已复核 owner 切面，再继续 remaining-a 全组／A-G，然后 B/M0～M4；无本机 AW test/typecheck/build/service，RFC 保持 In Progress。


### 2026-10-02 七组40路径候选与 CI 接续

- 六路径修复/许可退役已精确发布02940128f；主CI36951130717 completed/failure、47 success/3 failure，同SHA Windows36951130688 completed/success。原五类错误已通过，两个后端同一既有架构守卫仍失败、汇总失败；只记录状态和源码位置，完整恢复继续。原失败历史保留。
- 七组40路径各获独立有限功能PASS，暂不发布：journaled preparation6、员工local4、插件安装6/GC3、附件完成5、终态presence真根10、提交预览index6。原体、selected async/receiver/first-failure/重试与真实回归保持；准备工厂去未消费public转出口后测试import P2已只改到真实应用合同，首门FAIL保留。各完整指纹见functional-gates.md；此记录不关闭A1～A8/A-G。
- 官方scope仅HEAD加此40路径，六项真实插件R1兼容记录有owner/退役条件，public1045与TE零value SCC保持；五项实际增长许可按原协议登记，发布后精确退役。后续归档内容/恢复、A4其他Git/工作区、A5真实材料/执行、A6/A7/A8继续，CS独立adapter和M0～M4未完成。无本机AW test/typecheck/build/service，不纳入其他WIP。


### 2026-10-02 任务归档内容切面有限 PASS

七路径所选内容端口/独立 local/共享协调器/精确兼容出口和真实双 provider 回归完成有限功能 PASS（4d9650ac2082344a27779947ee3830d9cff079601ed8d888be12f6e632bdb344）。原认领、2000行 JSONL、manifest、恢复、删库规则的纯 AST 对拍及目标格式/lint通过；运行结论待发布后的 exact-SHA CI，真 boot roots 另批，不关闭 A2/A-G。此七路径独立排除原40候选 canonical。并行 e4d7dba7d 的 CI36955843850 终态46 success/4 failure，数量判据和复杂 workflow 上下文修复继续；无本机 AW test/typecheck/build/service，原全部历史保持。


### 2026-10-02 归档八路径与 CI 既有数量补正

原归档7路径保持，RFC349源码键定位真实查询后扩为8路径有限 PASS（31c06684b6c2028f4604e6906c9bee7f4bed2663ffd505427412d7f0f2b7e116），原 SQL 排序判据/why/断言不变。共享 main 已承接 bbb545851 的 E2E lineage 诊断；CI 补正只纳入已提交 HEAD 的源码/治理 seed，48源码候选指纹保持并排除，原候选生成证据留待源发布前重生。仅按确切 CI 的既有数量17/基线16同步一项计数和一次性回执，其他正文/数值/规则/断言不动；有限功能门后单独发布并退役，正式 exact-SHA CI 与原 E2E 功能修复持续，无本机 AW test/typecheck/build/service，不关闭完整 A2/A-G/RFC。

## 2026-10-02 RFC-370 八组48路径发布候选

journaled preparation6、员工local4、插件安装6、generation GC3、附件异步完成5、终态 presence 真根10、提交预览 index6、归档内容8，共48个不同源码/回归路径；八组原有限功能 PASS 和完整指纹均保持，首门 findings 与所有历史 CI failure/cancelled 保留。按八个源码小提交、官方 scoped canonical/docs及五项已消费增长回执的后继退役发布，正式行为交本批 exact-SHA hosted CI。

官方规则及语料算法逐字保持，只纳入已提交 HEAD 加48候选：entry1792→1797、background338→339、imports5627→5661、exception4991→5024、owner25671→25691；公共出口1045、TE零 value SCC保持。六项真实插件 R1 兼容记录完整沿用此前证据，owner resource-catalog、A-T7 selected roots/legacy callers退役；现有292项记录完整保持，不扩大目录或规则。五项增长按原协议一次登记，在匹配 canonical commit 后退役。

归档 coordinator/legacy sweep 的原业务及SQL顺序、异步导出/manifest/move ACK、同 claim恢复和重试保持，RFC349仅定位真实查询源码；默认local位于独立包，真实root选择贯穿仍属A8。其他A1～A8、完整A-G、CS独立adapter及M0～M4继续，尚无AW-in-CS部署证据。仅目标格式/lint、源码/AST/JSON证明与官方scoped生成，无本机AW test/typecheck/build/service。下方所有并行输出与历史完整保留。

## RFC-370 已发布插件 facade 的 CI 清单补正（2026-10-02）

已发布 d5b266c893d07694d5f9c19b24e3642ba6473d19 的主 CI36966192393 终态 cancelled：42 success、3 failure、5 cancelled；不是通过。Ubuntu 后端8/16的实际失败是原 thin-facade 精确清单漏了已变为精确转出口的 services/pluginInstaller.ts；Lint/Typecheck/Format 作业在 Format check 因归档回归样式失败，另有汇总失败。Windows36966192408 failure 是该归档事件夹具的 text 被推断为 string。并行会话已发布69afa48c29234399b58dba3c463ad7068e3d7969，保留原事件值及批次/顺序断言，只加 as const 和对应格式；本候选不重复改该文件。maintenance36966192417、git-protocols36966192415均已终态 success，不能替代主 CI。

本批唯一源码变化为 RFC294 的 thin-facade 精确预期在 maintenanceState 与 protocol 之间补 pluginInstaller.ts。canonical facade 记录已为 thin-facade，旧服务源码只有原接口精确转出口；除这一行外，测试全文逐字等于变更前，所有分类、原断言、扫描规则及 canonical 正文保持。目标格式/lint和纯字节证明通过；/root/rfc370_design_gate 对唯一源码给有限功能 PASS，首末指纹 f32079215f31f791e6ab2435180ff68979e01a6434df38c15dc3f46226f7648c 相同，范围仅此预期/真实 facade，不能替代正式 CI。发布后 exact-SHA hosted CI 单独记录。未运行本机 AW test/typecheck/build/service。候选工作区13路径仍是独立在制，未夹带入本次修复；不关闭 A-G、CS adapter、部署或 RFC，所有历史失败与取消记录保持。

## 候选工作区与启动前恢复24路径有限交付（2026-10-02）

已发布修复 b339e7e06e13c7b4456cc1bf928048c7fc0262a3：主 [CI36969850886](https://github.com/wangbinquan/agent-workflow/actions/runs/36969850886) completed/success，50/50；同 SHA [Windows36970559143](https://github.com/wangbinquan/agent-workflow/actions/runs/36970559143) completed/success，1/1。d5b266c8 的 cancelled 42/3/5、Windows failure 和默认 Windows36970426040 的 cancelled 均保留，不冒称这些旧 run 全绿。原 mixed report 丢失原因仍未确证；本次成功不把它改写成已修原因。

A4 候选工作区13路径由 /root/task_config_functional_gate 有限 PASS，有序指纹 d4be4543ef93d4d5e643d4266ce382d5bbcc47f12d89dcd5323672ba9663a33b。所选 factory/session/workspace 接收 opaque references，独立 local 包持有原 clone、FS、模式/digest、Git scope 和 import 机制。AW 原 stage/derive/commit、排序/过滤/首错、消息/receipt 与 idempotence 保留；lineage digest 按原需求顺序异步读取，import ACK 后才收尾，workspace→session 释放完成才返回，DA 真消费者 finally 等 cleanup 后写 verification 事实。原三组9/4/8个回归断言保持，旧cleanup调用等待完成；新10个所选能力用例和双 provider cleanup 两例已写。共享 tree-identity helper原体保持，整个 push 部分与基准逐字一致；不把 push/node/wrapper/其他Git或完整A4记完成。

A1 启动前恢复11路径由 /root/intent_functional_gate 有限 PASS，有序指纹34de018343c3d0814c8aa4e27d2846050d29fe5374ecfb7428ffba4f8462aafc。中立 DatabasePreOpenRecoveryPort<THistory> 与共享准备层等待 history→generation，之后独立 restore phase；原穷举表的SQLite/PG决定保持，读取失败在实际CLI原restore catch之外。默认路径逐次读取，原post-recovery工厂仍在restore时bare-call；原pendingRestore物理body仅 ./restore import改为等价绝对路径，独立local存放，service的10个value/type兼容出口保持。实际CLI/composition其余声明逆变换token一致；三个oracle仅真实facade、已迁出类型债、表位置注释变化。新12功能例覆盖3ACK、receiver/sync、6kind/provider组合、opaque history、no fallback与错误阶段，finally释放收完。完整安装/人工恢复/外层锁/seed/宿主生命周期与全A1仍继续。

官方 census 只纳入已提交HEAD加上述24路径，原工具/扫描/语料规则保持。entry1803（原1797）、background342（339）、imports5686（5661）、required-port liveness38（37）、exception5048（5024）、owner25720（25691）；public1045、implementation SCC空保持。新增 required SPI 有真实共享consumer、file provider及composition三方owner绑定。原298条边界条款的owner/why/退役规定保留；仅按原口径增加pendingRestore→SO local的实际value/type两项R1，inbound267→269、outbound31不变，A-T7退役。六项真实增长按原协议一次登记，匹配canonical发布后后继退役，不扩大目录/规则。

按两个source小提交、scoped canonical/docs及六项消费回执后继退役发布，正式行为仍以本批exact-SHA hosted CI为准。只有目标格式/lint、纯源码/AST/JSON证明及官方生成，没有本机AW test/typecheck/build/service。有限源码门、已有修复CI与新批正式CI各自记账；A1～A8/完整A-G、CS独立adapter、M0～M4继续，尚无AW-in-CS部署，不关闭RFC。


## 24路径批次的六路径 CI 补正（2026-10-02）

发布24路径的末尾SHA为64bf703622b6a7899df8a82a9e4b1dec13185d33：源码13路径28a1d3973ef060507dcce7cc1db5be8bdfa1ef52、源码11路径4bfa7cae183eba91bebbd725d77a2c7399ea7fae、canonical a5a2a8a6456e7bfd4e6b7b2f1da7ecb94231ec75、六项消费回执后继退役。发布时main/origin精确同步、foreignDrift为空；文档唯一末尾空行补正有限delta PASS，原metadata门结论复用。原13/11路径有限PASS保留，原始24路径字节指纹不冒充下面类型补正后的指纹。

该SHA [Windows36976027391](https://github.com/wangbinquan/agent-workflow/actions/runs/36976027391) completed/failure、1失败；[主CI36976027404](https://github.com/wangbinquan/agent-workflow/actions/runs/36976027404) completed/cancelled、50作业中38成功/7失败/5取消。五个后端失败分片分别为Ubuntu5/6/9及macOS2/3；另外是Typecheck与CI required。失败、取消与原历史完整保留，不能以之前b339的成功替代本批验收。并行e8c9d73b13bf467c2e56b9abe2d9baf2f4765797仅含RFC371两个文档，已同步、源码候选不变；其CI36977794334也不记本批通过。

类型补正三路径：DatabaseProvider从真实platform owner/schemaContract纯类型reexport取值；五处expect<实际fixture类>(this)消除polymorphic this的TS2769，同时严格相等receiver、目标、顺序及所有运行主体保持。两处TS2305及五处TS2769日志逐项归因。/root/intent_functional_gate独立字节逆变换有限PASS，有序指纹b5d58435046f765ba6be12fa40bc7413cd87367ec357d44a5cd8735a8f46897f。

功能/fixture补正三路径：旧storage trait及DatabaseStorageShape在14个真实providerTraits消费者中已无实际读取，旧完整性检查只靠已迁出CLI注释命中；删除未使用类型/三个storage声明及其旧type文档，所有真实provider决策保持，原完整性测试仅删除这项已移除字段的两处断言，其他语料/规则/判据保持。macOS的RFC368 P2-2用例在固定50ms后仍见executionRef null，现等待事务持久化执行身份之后的真实launchBehavior进入，保持planned/execution-1/cancel原断言与原预算；finally释放held launch并await dispatch收完，不声称生产取消逻辑损坏。/root/task_config_functional_gate有限PASS，有序指纹3a9b47d632be3ff1fb972a9879fd7b3a6ac2a1cb3d0ae964eac4b0458cb0c631。六路径联合指纹b86da2d6ecaca2366c57e76780c655fc2910d86852708ad3ee47995929ff8596。

另外两项实际清单补正：provider-specific business dependency已因pendingRestore物理迁出而由24降23，仅该baseline及原因同步、并行nativeUsage说明和所有原条款保留；RFC321 exact Git fetch文件清单只增加实际fileRepositoryCandidateEffects路径，逆删这一行即旧ledger逐字相等，其他列表/记录和整个原扫描/断言规则保持。没有恢复旧注释凑consumer，也没有扩大语料或规则。

官方scoped census仅纳入HEAD加上述六路径，四个官方工具字节保持。imports5686→5687、exception5048→5049为正确解析的纯类型owner边，依原协议只登记两项真实增长，在匹配canonical提交后后继退役；owner25720→25719为删除未使用alias，entry1803、background342、liveness38、public1045及implementation SCC空保持。没有新边界豁免；非RFC294仅上述24→23数量变化。按两个source小提交、canonical/docs、两回执后继退役发布，正式行为等待后继exact-SHA hosted CI。

只做目标格式/lint、只读纯源码/字节/JSON证明及官方生成，没有本机AW测试、类型检查、构建或服务。原mixed report丢失原因仍未确证。完整A1～A8/A-G、CS独立adapter及M0～M4继续，无AW-in-CS部署，不关闭RFC。

## 2026-10-02 RFC035 固定来源链接的 CI 修正

修正tip `55b1104a812c247f692f5450b6738e299d437bc1` 已上库并精确同步；Windows36980819374 completed/success、1/1，headSha一致。主CI36980700296已completed/failure、48success／2failure／0cancelled；仅Markdown link check及CI required聚合失败，其余作业全部成功，不能记全绿。失败日志只列 rfc035-storage.md 的三个CS固定版本blob URL，均为503；PUBLIC仓库/精确提交已由GitHub API核对，三个相同SHA/路径的raw内容URL实时HEAD200。

本次只替换这三个来源链接，完整正文经反向替换逐字等价；保留全部合同/事实/固定SHA与路径。没有改checker、接受状态、重试、预算或CI其他步骤；新确切SHA正式CI另验，原失败和取消记录保留。配置叶层14路径有限PASS与selected根/真实双provider新用例独立在制，均不纳入本次文档提交或canonical；所有数值/规则/源码不动。无本机AW test/typecheck/build/service；完整A-G、CS adapter和M0～M4尚未完成，RFC保持进行中。

## 2026-10-02 所选配置与排空实施增量

已形成五组26路径有限独立PASS候选：叶层14、真实根6、周期2、仓库刷新2、备份2。两项首门FAIL/P2、修正和回归详见functional-gates，全部旧政策/counts/断言保持。A1的同一所选query贯穿双provider/daemon/HTTP和本批purpose读；awaitIdle及仓库刷新异步配置支撑后续CLI stop/drain。settings耐久写、剩余热读/后台真接线、宿主生命周期、完整A1/A7/A8/A-G继续，尚无CS生产adapter或AW-in-CS部署。

scoped canonical只纳入26路径、原规则保持；四项实际增长依原协议登记并在matching canonical后继退役。按五个小source提交及配套及时发布，正式功能验证交本批exact-SHA hosted CI和Windows，不运行本机AW test/typecheck/build/service。e4d6f5b2主CI已cancelled 27/2/21，CS三来源已通过，另一RFC来源503及聚合失败保留；并行c843938a三文档完整保留，其CI已completed/failure、48成功/2失败（OpenCode来源503及聚合），原失败保留。完整B/M0～M4顺序和RFC退出条件保持。

17路径metadata首门另有文档事实P2：c843 CI在复核期间刚进入终态，新增节的“待终态”已按精确回执修正；该finding和原候选指纹f162d6ecbbbbdd592d10d583f7083e8b060176f8991e6268a1366a697aeadbdc保留。独立单文档CI引用修正有限PASS，指纹32ba3a45fec8988daf421e3bb9a64bb4d45d00ab91f9d92158bae8c0e6a32fdf；按CLAUDE原规则把同固定提交/路径/行号的OpenCode blob超链接改成文本引用，逆变换旧全文逐字一致，原RFC371输出全部保持，不改任何事实、checker或预算。该文档以另一个小commit同批发布，正式恢复仍待本批exact-SHA CI。

### 所选配置读写真根与后台排空11路径（2026-10-02）

通知ACK2与真实binding9分组有限PASS，原同步隐含返回值FAIL/P2及修复记录见functional-gates。SO composition选择一次存储，StartOptions、PG应用及SQLite应用透传同一binding；selected逻辑通知key不需本机路径，旧query-only覆写兼容。Settings读写共享receiver，业务校验/probe fence及原热应用顺序保持；维护、TE后台、idle、batch、backup/refresh接所选query，最后两者关闭等待在途ACK。SQLite queued Intent及runtime/迁移/宿主继续。

真实双provider HTTP与binding ACK/失败回归已写；W29三body严格逆变换恢复旧全体，PG168/SQLite49仅各多一binding声明，API65/EC4和原生命周期规则保持。官方scoped生成仅HEAD加11路径，三项实际各+3增长原协议登记/后继退役；原规则、其他计数、public1045及SCC空保持。

前批26源码加17配套按七commit发布71703608，OpenCode文本引用由并行81d6三个共享文档承载且完整保留。717的Windows36990563985已success，主CI非终态快照与最终证据分开。新批按两个小source提交及配套发布，正式验证交确切SHA CI；无本机AW test/typecheck/build/service，完整A-G后才进入独立CS adapter与M0～M4，不改变退出门。


- 2026-10-02 A1手动迁移增量：四路径有限独立PASS（02890cdb5dce0365f295189d8df6dd91e25b8054385710f5e498ca40a475b8a3），首三路径FAIL/两个P2及修正完整保留，详情见functional-gates。实际migrate入口复用SO configuration/installation，原输出与finally close尾部逐字保持；八个双provider例覆盖所选读取/准备/释放/close ACK和错误优先级。默认文件选择行为保留。官方原口径三项各+5，实际两条CLI R1替换旧direct入边，其他规则/数量/条款不变；按source、canonical/docs、三回执后继退役的小提交发布。96eb前批Windows exact-SHA已success 1/1，主CI终态尚未取得；717旧主CI cancelled19/1/30单独留档，不替本批验证。只有目标format/lint与纯source/JSON/官方生成，没有本机AW运行；SQLite queued Intent/runtime真实根、其余A1～A8、完整A-G、独立CS adapters和M0～M4继续，无AW-in-CS部署，RFC仍In Progress。

## 2026-10-02 人工迁移、运行时所选配置与 CI 断言接续

前批 96eb71db5dcaadbc2c0c0aa6bfe59cedb5e234ed 的 [主 CI36993377294](https://github.com/wangbinquan/agent-workflow/actions/runs/36993377294) 已 completed/cancelled：42 success、7 failure、1 cancelled；同 SHA [Windows36993443952](https://github.com/wangbinquan/agent-workflow/actions/runs/36993443952) completed/success 1/1。四个后端失败分别指向两处已滞后的源断言：memory-distill 仍查本地 loadConfig，W29 将所选诊断工厂误查成 direct call。现对应真实每 tick 所选 read 和两根的 phase/unstarted 工厂调用，原工厂数、timeout/四旋钮及同 configuration 参数断言保留。Lint 的 submoduleRefresh.ts:244 已由并行 3bf8cc6c6364773f251b4fae9ea0399b2be349c8 显式 void 修复；其三个完整文件已同步承接，不归入本批源码提交。原失败/取消及 717 的主取消 19/1/30 全部作为历史保留；不能将 Windows 或有限源码门记成主 CI 全绿。

人工迁移四路径有限 PASS 02890cdb5dce0365f295189d8df6dd91e25b8054385710f5e498ca40a475b8a3 及首门两个 P2 完整保留。运行时真实根四路径另由 /root/task_config_functional_gate 有限 PASS，指纹 400cb6451c7747f95c587b96adbf12d90cf23385af848dd8249d5d5aafdd35f1：PG/SQLite runtime-management 的 current 每次调用同一所选 configuration.read，probe fence 与 Settings 共用 applicationConfiguration.notificationKey；默认文件 binding 的 key 保持原 configPath，沿现 KeyedSerialQueue。双 provider 真实 HTTP 夹具覆盖 held read ACK、热切默认 runtime、unsaved probe 使用所选路径及读取失败无回退。两生产文件完整逆变换和 W29 原数量 168/49/65/4 保持；W29 此前只两 digest 变化，新 CI 工厂查找修正单独记账，不改原生命周期规则。

旧人工迁移 17 路径 metadata 在 96eb 冻结候选获得有限 PASS 78b9b1cf03e87ae6f3df9dc041d60d8265938ef011141b13e5fea240d5417c98。HEAD 前进未取消该门；后继 canonical 基于 3bf8cc6 的完整已提交源码加本批九个不同源码/回归路径重生，四原生成规则逐字保持。运行时 binding 与两个 oracle 未新增受控数量，仍只有人工迁移三项实际各 +5：imports 5692→5697、原 exception 投影 5054→5059、owner 25726→25731；entry1805、background342、public1045、required-port liveness38 及原 value SCC 集合保持。两项 CLI 实际 R1 替换一旧边、inbound270/outbound31 及 SO/A-T7 退役条件不变。三条既有 growth receipt 不重复登记，须在匹配 canonical 提交后仅退役这三条。后继 17 路径属于有限 delta 门，正式验证交发布后的 exact-SHA CI。

仅运行目标格式/lint、纯源码/AST/JSON证明和官方 scoped census，没有本机 AW test/typecheck/build/service。SQLite queued Intent、runtime legacy boot、配置 CLI/doctor、外层锁/宿主生命周期及其余 A1～A8 继续；完整 A-G 尚未关闭。独立 CS adapters 和 B/M0～M4 保持批准的顺序，尚无 AW-in-CS 部署，不关闭 RFC。所有旧正文、并行输出及 gate/CI 历史完整保留。

## 2026-10-02 Runtime legacy 与配置 CLI 的 A1 增量

两组共七个不同源码/回归路径分别获有限独立功能 PASS。Runtime legacy 三路径指纹 7300f41bb3aa9b1cae5a325beeee5c9f4bc7f646afcf6e05f6e6e8f1c832d5d3：复用既有 RuntimeLegacyConfigurationPort，start 只选择一次并将同一 receiver 传至 PG/SQLite 初次及 target 重装配；默认文件工厂保持 lazy，原 seed/backfill 后的 guard 读取时点和旧字段拒绝/未读到时的既有安装判据保持。双 provider 三例覆盖 held ACK、每次 boot 当前 raw 内容及所选读取失败不借另一文件；两生产文件全文逆变换一致。

配置 CLI 四路径指纹 ebb45d221e89268c2a728b20a30c53e8d233fbad816659b07e5d7882c72e1645：复用 SO ApplicationConfigurationPersistencePort，经独立 cliConfiguration composition 选择本机默认。原单参数调用保持同步结果与同步抛错；selected 读写返回 Promise，等同一 receiver 的 load/applyPatch ACK，不借本机文件。get 的整份 JSON/单键输出、set 的 JSON-first 解析与格式政策完整保留；持久化工厂只有同步返回类型推导/satisfies 改动，runtime 正文逆变换一致。六例覆盖 held 读写、当前值、一次 patch、无关并发设置、错误及同步兼容；main 调用和原 cli.test.ts 全文字节不变。

官方 scoped canonical 仅已提交 ba47e5d24c4f8f95f27defb82545ea1766b0e7a9 加这七路径，四原生成规则逐字保持。实际新增三条 symbol import：raw port type 与 config CLI 的既有 persistence type/used file factory；imports 5697→5700、原 exception 投影 5059→5062。六个 owner 是五个私有已用 CLI helper 与一个 SO composition file，25731→25737。entry1805、background342、public1045、required-port liveness38 与原空 value SCC 保持。只给实际 CLI type/value 两项 R1 记账，inbound270→272、outbound31；原 bootstrap 列表、条款和所有旧记录保持，owner SO、A-T7 退役。三项真实 growth receipt 一次登记，匹配 canonical 提交后另行退役，不把新切面作为规则豁免。

截至本节候选冻结，上一批 ba47 的 [主 CI36997889808](https://github.com/wangbinquan/agent-workflow/actions/runs/36997889808) 尚未取得终态回执；同 SHA [Windows36998073470](https://github.com/wangbinquan/agent-workflow/actions/runs/36998073470) 已 completed/success 1/1，headSha 严格一致。前批 96eb 的主取消42/7/1、Windows成功及更早717取消19/1/30等原历史完整保留；不能把有限源码门或 Windows 记成主 CI 全绿。正式行为以发布后的 exact-SHA hosted CI 为准。

只有目标 format/lint、纯源码/AST/JSON证明与官方 scoped 生成，无本机 AW test/typecheck/build/service。doctor 配置、SQLite queued Intent、外层启动锁与宿主生命周期、安装/恢复剩余入口及其他 A1～A8 持续，完整 A-G 尚未关闭。独立 CS adapters 和 B/M0～M4 仍按批准顺序推进，尚无 AW-in-CS 部署，不关闭 RFC。下方/既有全文、并行输出及全部 gate/CI 历史完整保留。

## 2026-10-02 CI 终态接续与 doctor 配置读取

上一批 ba47e5d24c4f8f95f27defb82545ea1766b0e7a9 的主 CI36997889808 已 completed/failure：46 success、4 failure、0 cancelled；同 SHA Windows36998073470 completed/success 1/1。旧节的未终态快照作为当时冻结事实完整保留，不改写失败历史。两个后端失败作业 mac1/110809149232、Ubuntu5/110809148997 都只有 RFC359-W5 unattended void 数量多出 services/submoduleRefresh.ts:1。原 reconfigure 的返回值为 boolean|Promise<boolean>；此前 lint 修正的裸 void 被原守卫识别。本次只接住调用结果，对 Promise 分支加拒绝处理和原日志风格，同步返回/抛错、initial/revision/排空与其余完整正文保持。单路径有限 PASS d0a74e255a74706796fee2bab1ad3f4c8c9e4f5da21471913495386db36a399f，原 W5 scanner、账本、负夹具和数量全部不变，无类型压制或检查放宽。

doctor 配置三路径修正后有限 PASS ab326f13a63d3d70b4b6085786c09f8a52b3789960d74ce687517ec6f8b1e398。复用既有 ApplicationConfigurationQueries，独立 SO doctorConfiguration composition 提供 lazy 默认，真实 doctor root 将同一 selected receiver 传给三处配置读取。selected 等待读取 ACK，忽略本机配置存在性，不借本机文件；默认缺文件/已加载/schema和原 Error 文案保持。首门 d461b32c7d794aceb2850c101725ed3a4942c2c3e26cb50d507ac9c2851071dc 的 FAIL/P2 保留：非 Error 拒绝曾使 catch 再抛错或返回 undefined，现转成 String 诊断；null/string/undefined/42 四例回归已补。原六例、双用途失败早退及真实 root AST绑定保持；十步纯逆变换恢复原完整文件，其他诊断正文未改，未执行整个 doctor。

七路径 source 和17路径 metadata 的首 PASS 498cd3b9b88e739edc89b6c4f0c4b6e4ae5a4f11851ed7e998c5195e2421a84a 保留，后继先纳入单路径 CI 修正，数量不变，再纳入已通过的 doctor 三路径。最终官方 scoped 输入为已提交 ba47 加11个不同 source/test路径，四原生成规则逐字保持。总 imports5697→5702、原 exception5059→5064、owner25731→25739；doctor 实际增加 purpose factory value/public query type 两边及 composition file/used factory 两 owner。entry1805、background342、public1045、required-port liveness38及原空 implementation SCC保持。实际新 R1 共三个：CLI type/value 两项、doctor factory value 一项，inbound270→273/outbound31，SO owner/A-T7退役明确；原 bootstrap 列表、条款及所有旧记录保持。原三条未消费 growth receipt 的理由完整保留并追加 doctor 的实际增量解释，没有重复新登记；匹配最终 canonical 提交后另行退役。

按 CI修正1、raw legacy3、config CLI4、doctor3 四个 source小提交，再配套 canonical/docs和三项回执后继退役。17路径后继仅做有限 delta复核，不取消或复跑已完成的旧门；正式行为等待新 exact-SHA hosted CI，不把 ba47 或 Windows记成主 CI全绿。只运行目标 format/lint、纯源码/AST/JSON证明及官方 scoped生成，无本机 AW test/typecheck/build/service；原文档格式告警只来自既有历史空行和原 generated renderer，新增节已符合格式，未整篇改写历史。

SQLite queued Intent、外层锁/宿主生命周期、安装恢复剩余入口、doctor其他目的能力及其余 A1～A8 继续，完整 A-G 尚未关闭。CS独立 adapter 与 B/M0～M4保持批准顺序，尚无 AW-in-CS部署，不关闭 RFC。全部原正文、并行输出、首门 findings及 gate/CI历史完整保留。

## 2026-10-02 doctor 回归的 Windows 编译补正

前批28个不同文件已按六个小提交发布，main/origin 精确同步7b3bf7f4574671ac4d71cfa5e3a1c3ff52eb6313；三条已消费 growth receipt在匹配canonical之后退役，所有数量/原理由与并行正文保持。该 SHA的 Windows37004034478已 completed/failure 0/1，实际功能作业110828029081失败于backend typecheck：rfc370-doctor-configuration-bindings.test.ts:196的expected message仍是string|undefined，Bun expect重载要求string。shared/frontend typecheck在同一日志成功。同SHA主CI37003820059已completed/cancelled：26 success、3 failure、21 cancelled；maintenance37003820306已completed/success 1/1。两项回执分别保留，不把maintenance或旧SHA的成功记为主CI全绿。

本次五路径首候选1ab123f968db3dcd69fb1a72c9494476876635719c9234d3d39f115370cee873的有限FAIL/P2保留：四份新增节仍把已完成回执写成等待。这里只校正这四段终态；三行源码补正独立有限PASS 57562e19d4b18ea44a67c89bdc8d59aa0dcb75342d2d2a2097566b161ddc1649保持，不重跑未变源码门。

唯一源码增量是该既有测试的显式控制流判据：原toBeDefined断言后，若没有原load错误消息则立即抛出夹具失败，随后message被收窄成string。原load调用/默认错误文案比较、全部断言与预算保持；删除这三行即恢复发布测试全文字节，不改任何生产实现或用类型断言压制错误。正式修复仍交新exact-SHA hosted CI。

官方production corpus、两份sourceDigest附加输入、四条生成规则及12份canonical JSON均与7b已提交内容逐字一致；此测试/记录补正不改sourceDigest、数量或增长回执，不重复生成canonical。只做目标format/lint、纯源码/字节证明与有限独立功能门，无本机AW test/typecheck/build/service。并行未提交改动完整保留，原Windows失败、doctor首FAIL/P2、所有旧gate/CI历史保留。queued Intent及完整A1～A8/A-G、CS独立adapter、M0～M4继续，尚无AW-in-CS部署，不关闭RFC。

## 2026-10-02 queued Intent admission 与 scratch 工作区效果选择

两组15个不同源码/回归路径已分别获得有限独立功能 PASS：queued Intent 七路径指纹 `113035adc56532b65ed9b7e3fdf7dee952c862ceacd55d772472f65bf091c888`；scratch 八路径指纹 `c3a95e67571a3152d7891cd0c245978ef40ea91528e40bd6ad21d83c9fe4ecab`。未变源码门复用，不随 HEAD 移动取消或重跑。本门仅覆盖 queued admission lifetime 和 scratch 效果选择，不覆盖已派发 turn 的完整执行 lifetime、完整 launch lane 或全部 A3。

Intent application 拥有冻结通知缓冲、按原政策去重、激活后读取当前 selected configuration、stop admission fence 与 drain ACK；同一 purpose composition 贯穿 SQLite/PG 真根，并首先登记为 provider runtime factory。冻结时不读配置、不启动效果；stop 后不再准入，未准入 IDs 可按原回滚重装配重试，已经准入的 Promise 及错误报告 ACK 排空后才可重启。PG 使用准入时获得的配置，不另读一次。原后台 oracle 仅修改真实工厂接线判据；W29 原168 statements、8 phase blocks 保持，原 PG digest `ac88a77b30ad4f6f4259301edb7af568661583514efc37073f2a11a18eb6a112` 按实际接线更新为 `d636c6a8a0459df274ddce6850cc6ac15313e45a2103f0da911e4f61df690d07`，没有放宽原规则或数量。

SC 将既有七类 workspace facts 原样移入 application 并保留旧 type 出口；原 materializer 全部 runtime tokens 不变。独立 file scratch adapter 承接原 prepare/cleanup 物理调用和本机路径恢复判据，owner composition 保留原 pre/post fence 及 version/task/kind envelope 判据。TE 真实 journal 在原位置 await selected restore，prepare/restore/cleanup 使用同一 receiver，opaque workspace 引用可恢复；原 record-before-act、补偿、错误、重试、清理 ACK 与 admission 顺序保持。真实 journal 的双 provider 夹具覆盖 held ACK、重放、失败补偿及 envelope 拒收；既有文件 scratch 回归完整保留，未在本机执行测试。

官方 scoped census 只纳入已提交 `fc52e3beb91ce987bccab19f1333bbc2a3d91e7a` 加上述15路径，四条原生成/扫描规则逐字保持。实际数量：entry1805→1807（两个已用 factory）；imports5702→5706、原 exception5064→5068（四条实际 symbol edge）；owner25739→25752（20个真实新增、7个原样迁移类型的旧 owner 移除）。background342、public1045、required-port liveness38 与原 implementation SCC 集合保持。原 boundary scanner 没有新增 R1/R2；273 inbound/31 outbound、全部原 owner/reason/退役条款和 bootstrap 列表保持。四项真实 growth receipt 按原协议一次登记，匹配 canonical 提交后另行退役，不扩大规则或目录豁免。

前批 doctor 编译补正已按两提交发布至 `fc52e3beb91ce987bccab19f1333bbc2a3d91e7a`。该 SHA [主 CI37007544133](https://github.com/wangbinquan/agent-workflow/actions/runs/37007544133) 已 completed/failure：48 success、2 failure；功能失败是 Windows shard4 的 mixed wrappers + humans E2E，另一个为 required 汇总作业，原失败保持并继续处理。人工 [Windows37007607865](https://github.com/wangbinquan/agent-workflow/actions/runs/37007607865) 被后继请求取消，日志没有新的 TypeScript 错误，不能记为通过；同 SHA 定时后继 [Windows37008086312](https://github.com/wangbinquan/agent-workflow/actions/runs/37008086312) 已 completed/success 1/1，单独记账。所有更早失败/取消及首门 findings 完整保留，不能将 Windows 或有限源码 PASS 写成主 CI 全绿。

按 queued7、scratch8 两个 source 小提交、17路径 canonical/docs 和四项消费回执后继退役发布；正式行为仍交新 exact-SHA hosted CI。只做目标 format/lint、纯源码/AST/JSON证明及官方 scoped 生成，无本机 AW test/typecheck/build/service。A1 启动安装配置桥接、外层锁/宿主生命周期、其他 A2～A8/完整 AC00/A-G 继续；完整 A-G 后再实施独立 CS adapters，B/M0先部署再逐项 M1～M4。尚无 AW-in-CS 部署，不关闭 RFC；全部旧正文和并行输出保持。
