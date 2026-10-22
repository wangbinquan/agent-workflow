# RFC-396 真实模型与托管验收

状态：进行中。本文记录实际失败、修正和验收结果，不将确定性夹具、接口接线或部署就绪当作真实模型交付通过。

用户在本会话明确回复“1.这个不阻塞你 2.允许”：共享 schema 断言不阻止本任务继续，允许将虚构验收需求、夹具代码、生成的设计和执行上下文发送到已配置的 `opencode-go/deepseek-v4.1-flash`。此前暂停调用的许可条件已解除。

## 候选与环境

- 实现候选：`fe835ab435b86e814ce48aafe9197dd2e08a4181`；单机使用 [CI 39729036993](https://github.com/wangbinquan/agent-workflow/actions/runs/39729036993) 的 `agent-workflow-e2e-macos-latest` 编译产物，真实运行时为本机 OpenCode 与上述模型。
- 隔离单机地址和端口会随重启变化，持久目录为 `/tmp/rfc396-live-McVHGG`；原始验收材料放在 `/tmp/rfc396-live-evidence/`。临时控制文件含会话凭据，不纳入仓库或报告。
- 独立托管项目：`rfc396-graph-acceptance`，project `01a16258-52b4-7000-8510-afa1ee567504`，service `01a16258-52b4-7001-a23f-ab6109ec10ce`。使用本机 CrewStation 的正式项目、配置、构建和发布接口；不更新已有正式 AW 服务。
- 托管源码快照：内部项目 `main@448b9cabf68635995c9cb502ecdd99627c3f2fd7` 对应上述 AW 候选。任务镜像为本次单独登记的 `01a1625d-689a-7000-a82a-372cacccc834`，构建 `01a1625d-a8ed-7000-ad84-412c942d0d51`；构建、镜像验证、服务就绪、业务执行分别记录。
- 本轮浏览器控制没有可用 surface，因此当前真实模型旅程由产品 API 操作。此前三平台十个浏览器分片和三个确定性完整旅程的结果继续有效，但不混记为本轮代理实际点击了界面。

## 三个案例

| 案例 | Case | 初始需求与主要变化 | 当前结果 |
| --- | --- | --- | --- |
| 预约 | `01M5H550KMNV5RQX7S9RP7S5GX` | 单资源时段预约、幂等、冲突、取消；后续讨论优先级与并发 | v9 已验证并交付候选提交；24 项实际测试通过 |
| 异步通知 | `01M5H59S2462BFFJBJWGMF4SY9` | 按 entity 去重、版本乱序、失败重试与版本内终态 | v9 已验证并交付候选提交；44 项实际测试通过 |
| 已有模块 | `01M5H59TF3767SKWW9T280J4K3` | 修正 `normalizeResponse` 对非法 data 的处理；保留签名、返回结构和 consumer | v8 已验证并交付候选提交；13 项实际测试通过 |

实际测试 profile：`01M5H59QNZ4T44H5388ZGMVRS8@1`，内容 digest `346d744b8456279d6faa14dd7e41327ef7e4669dc49aabd13b9e6479b5700513`。它要求执行候选仓库中的 `verify.sh`，收集实际 stdout、退出码和原始回执；脚本需执行 `bun test`。模型声称测试通过不能代替该证据。

人的回答均由代理针对虚构案例作出，不代表真实业务负责人批准。判断保留 `provisional`，责任人与复查时间未定；不为了让材料完整而编造负责人、日期或生产承诺。

## 已观察到的失败与恢复

1. 发布前建立的 `/tmp/rfc396-live-sK18Ey` 保存了尚未改成 Node ESM 的试制审核工作流，新产物启动时报 `builtin-workflow-content-conflict:00000000000000GRAPHWFRV1`。逐字比对证明首次公开实现 `5f11d1857` 到当前候选的资源定义相同，冲突仅涉及发布前试制数据。原库保留为失败记录；当前三个案例在干净隔离库中运行，没有改动产品校验或覆盖旧工作流。
2. 新库首次预约调用因验收 daemon 继承沙箱限制，OpenCode 无法打开自己的日志文件而失败。按用户已给出的模型调用许可重启同一隔离库，并通过 Case 的原生 resume 入口恢复；没有重写 Task 状态或手工伪造输出。
3. 三个首轮设计均被领域校验拒绝：模型在没有匹配人工来源时填入 decision 的成熟度，并让决策表 `rows.ruleId` 引用未在 `elements` 声明的规则。错误作为 `import-error` 留在工作区，当前版本未被错误输出覆盖。后续通过原生澄清回答同时提供业务判断和具体错误反馈，要求模型修复；不能将这些首轮结果记为可读有效设计或首次通过。
4. 已有模块首个 designer 调用在本次验收配置的 `480000ms` 上限超时；其 NodeRun `01M5H59VS9KBCAG5M6HMBQHSQ1` 保留 `node-timeout: exceeded 480000ms`。平台一次自动重试 `01M5H5RHQKRRGS6V7JF4DNV2M0` 产出设计，之后进入原生澄清。这个 8 分钟值是验收配置，不能写成产品固定超时。
5. API 验收脚本第一次同时提交单选 option 与 customText，收到 `clarify-confirmation-required`。依据既有单选合同改为一个完整自定义回答，再按实际题集计算 `questionSetKey` 与逐项 `confirmedBasis`，提交成功。此项是验收脚本错误，不是产品缺陷；没有放宽原确认合同。

## 证据边界

三个单机真实模型闭环及固定图组合对照已收齐，详细版本与失败历史见后文；托管业务执行、最后 exact-SHA CI 和收尾仍在进行。模型调用累计 token 字段包含其会话记账，不能直接推算费用或独立输入规模。

文档提交 `b45f3712740e6f70c45d88fe4912434dbb738749` 的 [CI 39732007816](https://github.com/wangbinquan/agent-workflow/actions/runs/39732007816) 终态为 47 success / 2 failure；失败根因仍是 [backend 12/24](https://github.com/wangbinquan/agent-workflow/actions/runs/39732007816/job/119668947797) 的 `Expected length: 217 / Received length: 222`，另一个失败是汇总门。用户已明确这不阻止继续验收；该事实不等同于整仓 CI 通过。


## 2026-10-22 07:18 UTC 后续实测与修正

- 通知 Task `01M5H59T311QNRBW618FECR3SM` 于 07:02:58 UTC done，最终澄清输出已修复首稿的两类语义错误；直接领域校验结果为空。但宿主错误地取了 designer 的首个 `agent-result`，原 Case 仍在 running，daemon 每个 cycle 重复相同语义失败。该问题通过真实模型揭示，不能把模型 done 记为旅程通过。
- 修复复用任务已有统一结果投影，并把导入的领域校验错误转换为 semantic 失败回执。新回归覆盖多节点同名端口、旧 output 代次、seq 优先于 ID、inactive/skipped/缺失最终输出；两 provider 各 20 项相关测试通过，实际升级恢复待新编译候选。
- 已有模块与预约澄清后的调用分别于 07:09:13、07:12:28 UTC 耗尽 480000ms 自动重试，Task failed。失败与原始作答保留；全局默认已通过配置入口恢复为产品的 30 分钟，但已冻结的旧 Task 仍使用原 8 分钟预算，不能靠修改配置冒称旧调用成功。
- 托管任务镜像首构建 failed，完整日志在系统包安装输出后中断；没有足够证据断言 OOM 或具体终止原因。bootstrap 旧镜像验证 `01a1626a-0db3-7000-aeea-7e6049bda6f6` passed，只用于取得服务构建环境，不作为 RFC-396 任务执行证据。
- 第一次正式服务 release 返回 412，明确为对象存储后端预算已全部分配。读取配置确认已声明配额 66571993088 bytes，物理空余约 6.48 GB；为本次隔离项目新增 256 MiB 档位 `01a16276-6c78-7000-b3a3-1841d66325f4`，后端预算仅增加 268435456 bytes，未改其他空间或档位。后续重用 v0.1.0 返回标签已存在，保留历史并使用新版本继续。

## 2026-10-22 后续恢复与提案审阅

- 单机已升级至 `285d72ff50da0350ee0ec7d6848602bf857e0d05` 的 CI 编译产物。通知 Case 在原数据库中恢复为 waiting、设计 revision 2，最终澄清结果与三个原始人工来源均已导入；预约恢复 Task `01M5H78JK1B41KMW3FC8EXQMH8` 也完成并导入 revision 2。
- 该提交的 CI 发现两项本次变更影响的旧测试：RFC-310 结构断言仍锁旧结果选择表达式，RFC-374 的计划选择夹具没有最终 output 节点。`66c084c3eba5719dcc1bc561e4268b58796fc20b` 保留原断言意图与反序 ID 用例并修正夹具，三个相关文件 SQLite / 真实 PostgreSQL 各 46 pass / 0 fail、267 assertions。共享 schema 断言已随 RFC-395 I-a 提交 `4b91ada04` 发布；这不预判后继 CI 终态。
- 已有模块在原 Case 中通过明确失败回执阻塞，未再每个 cycle 重复异常。原生追加澄清请求 `live-existing-recover-native-v1` 启动 Task `01M5H93075R45MC02VV15MGWF3`，设计随后导入 revision 3。候选包含 out-of-scope 关注点，选择器拒绝两项候选，因此没有选中图；这是当前真实模型质量缺口，不能视为成功选图。
- 恢复还暴露了人工来源遗漏：旧 Task 已回答，但设计导入失败；新 Task 没有新问题，其设计没有携带旧回答。修正从同一设计的历史成功/失败导入回执发现 Task，先经执行 owner 校验 Case 归属，再从协作 owner 读取原始作答；同时保留冻结设计中被模型省略的人工来源。回归覆盖拒绝设计后恢复、已接受设计后恢复、不可读取其他 Case 回答及重复消费不增版本。
- 通知首次重规划超时，第二次生成可审阅的“三次 accepted attempts”提案。代理接受为草案后要求进一步消除“第三次 failed 本身仍被接受、第四次才因耗尽被忽略”的歧义，并补足被遗漏的原有视图覆盖。未据此批准实现或签署测试通过。
- 预约重规划在运行时返回后报 `JSON Parse error: Unexpected identifier "I"`。解析原先把全部 assistant 事件文本当作一个 JSON；修正允许唯一完整 JSON 对象前后的说明文字，同时保留字符串内容，拒绝多个对象、未完成对象和被事件上限截断的输出。业务 schema 与领域校验仍由原 owner 执行。
- 重规划现在取得与程序选择一致的 `planningBudget` 和 authoring rules；规则明确排除 out-of-scope concern 的覆盖声明，避免整项候选被拒绝。没有改变选择器或为失败输出填造有效图。
- 上述恢复/解析相关四份测试在 SQLite / 真实 PostgreSQL 各 23 pass / 0 fail、98 assertions；修正测试夹具只读赋值后，受影响文件两库各 10 pass / 0 fail、31 assertions。预算材料与工作区两份测试两库各 6 pass / 0 fail、46 assertions，范围有重叠，不累计成全量结论。目标 lint 通过；本地完整 backend typecheck 仍报并发在制的 `rfc165-scratch-space.test.ts:140` 缺时间戳、`rfc300-workspace-prune.test.ts` 未定义 `id`，没有修改这些其他会话文件。

## 托管候选的实际发布

- 隔离服务 v0.1.1 的源码为 `285d72ff5`，服务镜像 digest `sha256:80b412affb7696266b1a913e71a4a557d3a3186c5076ac37b95b36cdbb25e996`，已 Ready。
- 第二次任务镜像构建因 BuildKit 拉取服务镜像的 registry 地址超时失败。随后从本项目已 Ready 的精确服务镜像导出 AW 二进制，SHA-256 `6da298099639e2774eedb5afdb8be95d764fe07874356dc56dd997668fe6d543`；以平台当前任务底座构建镜像并加入 Bun。先核对本地底座 config digest 与平台 immutable manifest 一致。
- 使用平台正式签发的临时 registry 凭据和公开本机网关完成上传，未更改全局 Docker 配置、registry 授权或其他项目。镜像为 `runtime/rfc396/graph-acceptance@sha256:619d990b9b04b18d47378f8ef048f5663cbd7ca17fe52c7b5b38563eef737d91`；本机上传途中发生的证书、代理和工具配置错误留在临时验收日志。
- 登记已有镜像 revision `01a16297-d3b4-7000-81f0-569047a05d90`，检查成功；生成版本 `01a16297-d960-7000-8a61-ae04bd5a10a4`。实际任务验证 `01a16298-f4d8-7000-aff9-4e527600d4b0` passed。
- 绑定该任务镜像的服务 v0.1.2：release `01a1629d-ce69-7000-bea3-495f2b4a1da2`、journey `01a1629d-cfba-7000-86f8-3897db7833c4`、发布仓库 commit `f637479915f578bd6a36aaf9f31c5a70c0d4598f`，已 Ready。镜像验证和服务就绪仍不代表 AC14 的完整业务执行或 AC17 真实模型闭环完成。

### 2026-10-22 08:25 UTC：冻结依据的大提示传输与托管激活

- `cfe25471eff2475c5c1546e1892ece92981e0002` 已推送并在同一单机验收数据目录运行（CI `39746345356` 的 macOS artifact `12412061085`）。预约走原 action retry，已有模块走新的原生 clarification request，保留先前超时、无效候选与答案历史。
- 通知 v3 重规划再次达到 10 分钟限制。代理逐项审核 v2 的状态机和规则表后，经正常 changes API 修正第三次仍 applied / 第四次才 attempts-exhausted 的两处歧义及旧版门控说明；未冒充模型自动修正，未删除量化 coverage 元数据漏项的限制。冻结 revision 4、52 个 included 元素、12 个义务、3 条原始 provisional 答案，basis digest `94ed81132c1e0c5bf4aeff76ba11e9426d5eb7ff889e11516c49cce4cb5f299d`。
- 原生审核任务 `01M5HBB9G719ENFD92D0CFC5F6` 和恢复任务 `01M5HBBCJ7G2VDT5H3SYH44Q7W` 启动失败：`prompt-too-large`，实际提示分别 322366 / 322689 bytes，argv guard 为 122880 bytes。尚未批准此依据、未执行代码生成。
- 修复选择完整 stdin 传输大提示，保留小提示既有 argv 协议和 argv-only guard，两个统一装配入口均传递 stdin；不裁掉设计、原回答或审批材料。OpenCode v1.19.0 的 `packages/opencode/src/cli/cmd/run.ts:400` 明确在分派前读取 piped input；后续本机源码 `cb562b2c6289` 对应逻辑位于 `packages/opencode/src/cli/cmd/run.ts:416-418`。增加真实子进程大段 CJK/多行/尾部哨兵和业务、系统装配回归；真实模型上的修复效果待新候选继续验收。
- 独立托管 v0.1.2 已从 Ready 切到 prod，release journey `01a1629d-cfba-7000-86f8-3897db7833c4` 为 succeeded，激活 `01a162ab-407b-7000-afef-248060b34ce0`。仅该项目的部署就绪，不代表托管业务链路完成。
- CI `66c084c3` 的两个剩余根失败是 provider 函数语料 47/门槛48，以及新增 `rfc395-head-history-injection.test.ts` 假 PG runtime 未登记；RFC-395 自行提交 `228f726c0` 修复，已为 `cfe25471e` 祖先。旧 CI 仍按自己的失败记录保存，后继 exact-SHA CI 另记。

### 2026-10-22 真实恢复后的组合计分修正

- 已有模块恢复 Task `01M5HC4NWJ495P7X2EZVTWEER8` 已完成，revision 4 恢复三条原始人工来源，无新增问题。候选选择同时留下决策表、流程图和包含二者的复合图，暴露同一 concern 的部分覆盖被错误相加；不同渲染器不证明新增覆盖。
- 选择策略升级到 version 2：同一 concern 只取最大声明贡献，保留真实缺口，冗余清除和固定视图规则继续生效；旧计划仍可读取。增加部分覆盖不可叠加、复合图替代重叠组件、固定图保留和顺序稳定回归。仍需真实候选回放与限定验证，不据此宣称算法全局最优。
- 通知通过正常人工编辑入口修正 `repo:` 测试引用前缀，冻结 revision 5、basis digest `8a3738fe1c1fbf654422cb4de0f5bc78cd473686c99f9043e59e3a06201434bd`，三条原回答保持。已有模块另出现 `planned:path::name` 引用；提示规则明确实际仓库相对测试路径及可选 `#test-name`，执行验证仍按真实文件与追溯核对，不放宽合同。
- 单机已运行 `12081efd2d5ace933fe64f0b3fdc48d5cc5bd1f3`；通知原生评审正文与冻结 `implementation.md` 89021 bytes 逐字一致，review NodeRun `01M5HDENSGG57RMK5QFV2HNH79` 已批准，真实 receipt `01M5HDH4NXPET600MVF1T72S15`。实现请求 `live-notifications-implement-v5` 已受理，代码和执行证据另验。
- 真实已有模块候选以策略 v2 回放，从三个重叠视图变为 `cand-dt-flow-recommended`，仍包含决策表与调用流两个语义模型，六项部分覆盖/责任缺口仍在。该候选比另一复合表达在 c-empty 和 c-compat 各高 0.05；不能把它说成“更贵的等价表达”。人工采纳并修正测试引用，保持三条原始来源。验收脚本初次漏建新的选中视图，revision 5 评审取消；通过正常编辑生成 revision 6 和新 basis `92510c77e328b7d23f4d322724137dffd6c5ee472b4311c94d69200d3c48bd02`，不把脚本错误算作模型失败。
- 限定三文件 SQLite 30 pass / 0 fail、113 assertions；规划/工作区真实 PostgreSQL 6 pass / 0 fail、50 assertions。完善等覆盖成本检查后，受影响纯领域文件 24 pass / 0 fail、63 assertions，属于前述范围复验。目标 lint 和完整 backend typecheck 通过；首次缺 PostgreSQL 环境变量的运行保留为验收配置错误，未跳过其红灯。
- `12081efd2` 的 [exact-SHA CI 39748578316](https://github.com/wangbinquan/agent-workflow/actions/runs/39748578316) 已终态成功，49 个 job success。它不包含本节尚待发布的策略 v2 修正，也不替代真实业务验收。
- 托管 v0.1.3 首次源码发布收到 `source-publication-http-400`，原因未证实；正常重试成功，155 个文件动作、GitLab commit `0acbb6d4e087549c302832e1b42825580d8d5ffe`、release `01a162da-f222-7000-847f-30e3153f6967`。截至本记录处于 migrating，未将它记作激活或业务链路通过。RFC 保持 In Progress。

### 真实生成后的执行引用与反馈闭环

- 策略 v2 已发布为 `8325059a5bf94493bc3d1078439c68e593f90381`。预约短重规划 v3 超时后，沿原 Case 发起原生澄清请求 `live-booking-native-batch-v4`；没有把超时当成功。已有模块 revision 6 原生评审正文 37933 bytes 与冻结依据逐字一致，已批准并启动实现。
- 通知实现 Task `01M5HDK3A0704N5R5RTVYQT7BS` 完成，实际候选 tree `fa61d403ca92c198c8e105244b2bdeb85ae02387`，新增一个领域文件、四个测试文件及 verify.sh。模型报告 31 项本地测试通过，但平台原始 execution.json 明确 `receipt:null / testReferencesChecked:false`，不能认作独立 profile 通过。
- 原因是义务绑定 `test/notification.test.ts`，有效追溯引用 `test/notification.test.ts#具体测试名`，平台仅做完整字符串相等比较。修复允许已核对的命名测试同时证明其所在文件；反向不成立，缺失测试名、只有文件的命名义务、仅声明未核对追溯仍不得运行。增加真实命令执行及三个拒绝回归，两文件 SQLite / PostgreSQL 各 18 pass / 0 fail、94 assertions。类型检查发现测试只读数组类型不兼容，随后仅修正参数类型并复验类型。
- 实现报告中六条 limitations 已生成正常 code-feedback 提案，继续阻止自动交付。内置提示明确：limitations 用于未满足批准范围的实现缺口；已批准边界写 summary，人工与 profile 待办保留原验收，不能伪称通过。未放宽非空 limitations 的交付门。
- 通知经人工采纳反馈和正常编辑，明确单进程内存范围、任意整数起始与版本空洞，以及 failed 无 error 时“同版本保留最近已知错误、更高版本清除旧错误”的虚构验收策略，并要求新增真实测试。冻结 revision 7、basis digest `86e0a0a4bbc9cb8485a62acbf5cc4fb581e055e3ff685dd820f6104eaf3b1420`，进入原生评审；原三条 provisional 来源及未知责任人/日期不变。
- 托管 v0.1.3 已 Ready 并申请激活，traffic switch `01a162e6-4cd2-7000-958e-3fe0b026b383`。freeze 与 handoff-prepare 成功，route 阶段等待“目标生产路由实际生效”，业务入口 503；尚未完成激活和 AC14。两槽 Pod Ready 且 Service 端点存在，继续核查正常平台路由，不改其他项目。

### 存量实例升级回归与保留历史

- `3a36ce4c7a51c5d697102b23a306863684b8acc2` 在原验收目录升级时拒绝启动，错误 `graph-builtin-agent-content-conflict:00000000000000GRAPHBUILD1`。原因是本次修改了已发布 v1 的内置 Agent 正文，触发原有不可变内容校验；新建实例的 CI 不能替代升级验收。先恢复到兼容的 `8325059a5`，原数据库、回答和评审均保留。
- 前向修复使用新的 `00000000000000GRAPHBUILD2` / `graph-development-implementer-v2`，保留两种曾发布的 v1 安装快照及冻结任务引用，绝不改写旧记录或放宽冲突校验。额外指导进入可演进的冻结 `materials.authoringRules`；明确实际缺口必须报告、平台待办不能伪称通过，责任假设不能伪造 `.agent-workflow` 代码追溯。
- 升级夹具保存真实原实例 v1 正文（2588 bytes，SHA-256 `e5de5ebf79fcc528237b34f04c286eab57681c2cf3f83843e78303fa41c0f1a3`）。回归同时安装原始 v1 与 `3a36ce4c7` 的 v1 变体，检查新会话加载、再次加载以及旧资源完全不变；实际升级结果另记。
- 最终升级回归两文件 SQLite / 真实 PostgreSQL 各 8 pass / 0 fail、77 assertions，完整 backend typecheck 与目标 lint 通过。首次未限定 provider 的本地命令因没有 PostgreSQL 环境变量出现两项配置失败，分别使用明确的 SQLite 和隔离 PostgreSQL 配置完成复验；不计作产品缺陷。`8325059a5` 的 [CI 39753694035](https://github.com/wangbinquan/agent-workflow/actions/runs/39753694035) 已终态 49/49 success；其后候选的 CI 和实际升级另验。
- 预约的原生追加需求已生成状态、决策表与序列组合，批量请求按输入顺序逐项处理、前项成功对后项可见、失败不回滚且不终止后项。保留六条真实回答来源及各自成熟度，revision 5 的 basis `320c5f1c9e50c64e28cac3b896a16a7d2c5ee3a566c24177d86b427c2571a951` 已经原生审核 `01M5HFN2SRBVT5CG9R2APB98EH` 批准。
- 已有模块首个真实候选 tree `8a7fdaa72f762e2544868e15eff3ce96c219b282` 保持 consumer.ts 未改，模型报告 12 项通过；平台尚未独立执行，且责任假设错误追溯到平台材料被正确拒绝。反馈经正常提案采纳与编辑，revision 8 basis `a4524d9492df4e92e6ea03407b000dd71a800bb9b411a7f33d26d34ddbded697` 已经原生审核 `01M5HFNX4MNW1XTNRZ1FJ6378K` 批准。通知 revision 7 也已批准，三者均待修复版继续实际代码与验证。
- 托管 v0.1.3 激活最终完成，journey `01a162da-f73e-7000-9a4e-c285844c8023` succeeded；私有仓库导入 batch `01M5HFM4KBKS8H2JCDQF1E4RA6` completed，repo `01M5HFXD9V3BA8QTAKAGX94G56`。受控夹具 Case `01M5HG061H9GVQDME92SJA2AJK` 已创建，实际 TaskRunner 准备工作区；此夹具只证明托管运输和执行链路，不算真实模型质量或 AC14 完成。
- `3f487dddafc5022c4b02e73d0b43cf370d20863b` 已发布；真实升级继续暴露 `builtin-employee-job-content-conflict:platform:graph-development:job:v1`。固定默认岗位也包含不可变工具引用，之前的资源加载回归没有预装旧岗位，未覆盖整条升级链。再次恢复兼容二进制后，修复为新岗位 `platform:graph-development:job:v2`、新工具 `platform:graph-development:implement-change:v2`，并保留旧员工冻结的 v1 工具注册以及 `3f487ddd` 的中间注册别名；仅新定义选择新版本。
- 补充回归预装三种已发布安装状态的 v1 默认岗位，检查实际初始化及再次重启、旧岗位内容完全不变、旧精确引用仍解析到原 Agent、新岗位使用 v2。浏览器旅程夹具改选 v2 岗位；不删除旧岗位、更新旧员工或重写原审批。原会话三项已批准依据仍原样保留。
- 完整升级链与 Case 受理限定复验两文件 SQLite / 真实 PostgreSQL 各 9 pass / 0 fail、83 assertions，backend typecheck、目标 backend/E2E lint 通过；中间的 Agent 引用回归各 6 pass 属于重叠范围，不累计。实际存量升级继续使用精确 CI 二进制另验。
- `3a36ce4c7` 的 [失败 job 119748379649](https://github.com/wangbinquan/agent-workflow/actions/runs/39756102381/job/119748379649) 明确为 `test-suite-policy` 的 RFC-396 Unix fixture skipIf 登记数 5/实际7 不一致；是本次两项新增测试漏更新清单，已由 `6b97e9978cd103945d271b19b6e12db94270c95a` 修复。该清单限定复验 12 pass / 0 fail、15 assertions，没有放宽断言或移除测试。
- 同一设计材料的自适应/固定组合投影对照见 [比较记录](./adaptive-comparison.md)。它保留固定三类对预约批内顺序表达的遗漏，也明确其他两例的有效模型内容相同；不把模型覆盖分数、渲染字节数或代理审阅推断为真人理解效果。浏览器控制当前不可用，本轮 API 证据不冒称新的真实浏览器走查。

### 真实岗位名称与托管材料传输

- `4df20d2a53b23227d56bd870555dbfcf642184ac` 的实际升级发现 `ConflictError: job template name already exists`：岗位名称还有独立唯一约束，旧测试用了不同的历史名字而遗漏该情形。新岗位明确命名为“图驱动研发 v2”，测试预装真实旧名“图驱动研发”；旧名称和旧 ID 均不改。原隔离实例再恢复兼容二进制，原业务数据不变。升级不能只以新建库或局部目录加载通过作结论。
- 托管设计 Task `01M5HGXDX009KPKE77VKFV2Z46` 已实际完成并导入 revision 2，唯一需求 clamp 的单 flow 表达、执行 profile 和测试引用可读取。冻结请求 `hosted-clamp-basis-v2` 返回 500；重启前日志明确 `CrewStation object storage responded 429`。其后实例因 `platform-unreachable` 失去执行租约而按既有流程退出，不能仅凭时间相邻认定两者同一根因。
- `createGraphDesignArtifacts.files()` 原来并发读取全部文件，且每个文件再次读取同一清单，超过本项目两路对象传输额度。改为顺序读取已验证清单指向的实际 blob，保留整包/每文件摘要与缺失检查；单文件读取也复用已验证清单。真实文件回归用两路额度模拟拒绝，八份中文材料完整返回，清单只读取一次；缺失内容、被改字节和错误清单仍拒绝。
- 本隔离服务原采用小型接入验收的 50m CPU 套餐，有持续 event-loop stall。下一版配置选择平台已存在的 250m/512Mi `agent-workflow-control` 套餐，仅作用于 `rfc396-graph-acceptance`；不修改共享套餐。该资源调整与 429 修复分别记录，不能把延迟或租约退出全部归因于 CPU。
- 材料读取与设计/工作区限定验证：SQLite 三文件 12 pass / 0 fail、83 assertions，真实 PostgreSQL 两文件 10 pass / 0 fail、73 assertions；岗位真名回归两库各 7 pass / 0 fail、71 assertions。backend typecheck 和目标 lint 通过。范围包含重叠检查，未累计为全仓结论，实际托管重试另验。

### 2026-10-22 10:54 UTC：存量升级成功与真实候选执行

- `c38be1ef0a2b1e1bba6d06ea92e1d686a4313b13` 的 CI `39763563985`、macOS artifact `12419412282` 已在原持久目录成功升级；原岗位、三个 Case、原答案和批准记录未重建。首次下载因 `unexpected EOF` 失败，重试相同产物成功。预约 v5、通知 v7、已有模块 v8 的实现分别启动 Task `01M5HKDYCYTVC978B81TRQZG88`、`01M5HKDYG6T4CSQ0DHKH7264QJ`、`01M5HKE0NZHBTDAJSMCNJK01A9`。
- 已有模块首个输出被 `envelope-port-malformed` 拒绝，平台一次正常重试成功。候选 tree `6cb114c7678258359c3559e42b9f977c3c3d327c` 的原始 profile 回执为 exit 0、13 pass / 0 fail、16 assertions；`src/consumer.ts` blob 仍为 `b5c8e6a8d477f051d9056931f9d62bad5110eae0`。已实际读取代码与两个测试文件，五类非法 data、空串/空白和旧行为均保留；尚待精确候选的人工义务和最后交付。
- 通知 tree `08243c7639f7c4eedae89d11d88500c184eb79a9` 也取得独立 profile 原始回执，35 pass / 0 fail、105 assertions，包括同版本无 error 保留、更高版本无 error 清除的新增分支。但模型仍把已批准范围、平台后续工作和人工待办写入实现 `limitations`，平台按原合同继续阻止交付。预约也存在相同报告分类问题，不能删除这些回执后冒称首次通过。
- 独立托管 v0.1.4 源码提交 `e802441cabdafcd81e8f92377b5fbdd6d92aa846` 对应 `c38be1ef0`，release `01a16330-cc08-7000-bcca-54dd6b4db7e2`。构建阶段失败，平台消息 `Job has reached the specified backoff limit`；尚未进入迁移、部署或激活，具体根因继续读取日志，不能据此断言业务代码错误或资源不足。
- 执行材料暴露环境记录错误：编译验证进程报告内嵌 Bun 1.4.3 / Node 兼容版本，而真实 `verify.sh` 日志使用 PATH 中 Bun 1.3.13。修复将 `verifierRuntime` 与实际 PATH 的 `bun/node --version` 观测分列，探测失败/缺失/超时明确保留，不回填内嵌版本；环境 digest 会随观测变化。该观测范围只涵盖 PATH Bun/Node，任意 profile 脚本仍可能选择其他工具，不宣称完整工具链证明。
- 环境回归通过实际子进程验证版本变化、缺失、失败、超时和同环境摘要稳定；连同真实候选验证和测试清单三文件 SQLite 27 pass / 0 fail、95 assertions，backend typecheck、目标 lint 通过。真实实例的新环境记录与 PostgreSQL 相关复验另记。

### 2026-10-22 11:41 UTC：三条真实模型旅程完成，Windows 失败归因

- 单机运行 `ccde54fafcee93c21ca0d66ca79d574f14ef34fc`（CI `39767238898`，artifact `12420274604`）。三条 Case 都经完整冻结正文核对、原生审核批准、模型代码生成、独立 profile、代理人工义务核对，最终状态为 terminal / delivered。以下是虚构业务候选提交，未配置业务远端发布；不等于 RFC 仓库 CI 或托管服务已通过。
- 已有模块 v8：basis `a4524d9492df4e92e6ea03407b000dd71a800bb9b411a7f33d26d34ddbded697`，tree `6cb114c7678258359c3559e42b9f977c3c3d327c`，交付 commit `6dcda12b3f1897a5867800c4092d6eb4b31cbdea`。新环境下 execution `execution:01M5HNDKFG4GRSE587J88CC8J2:4b5b2bd050323ec3` 为 13 pass / 0 fail、16 assertions；三个原始 provisional 回答与 consumer blob 均未变。
- 预约 v5 原 profile 虽为 21 pass / 0 fail，但代理业务复核发现键碰撞：`("a", "b\\u0000c")` 与 `("a\\u0000b", "c")` 的分隔符编码相同，不相交时段仍返回 `accepted / idempotency-conflict`。通过正常设计变更补充无损二元键要求与回归义务，刷新受影响视图并重新批准 v9；不是直接代改模型候选或放宽验证。
- 预约 v9：basis `c085816d91c0b8f65e6115cbfe2cca3da87a0d434b9c0c74f1257e512c32cfe0`，Task `01M5HNN67G2NZ69J0Q76BTR2P3`，tree `746925f72ffc19d0c784087126bfc1ecad412722`，交付 commit `7485e154f176b40a7a69ba60c3a0f653cef04643`。模型改为嵌套 Map 并加入 NUL 键回归及单进程交错调用测试；profile 实际 24 pass / 0 fail、90 assertions，原反例独立重放也得到两个 accepted。六条原始回答和 confirmedBasis 保留，全部仍 provisional，负责人和复查日期未知。最终证据 round `01M5HPHABK3X5WY01FZJH715J5`。
- 通知 v9：basis `65572e58d141e320e47d1823ef980c3946207fbf0b7d4ae8a134f6c4644c6d0b`，Task `01M5HNG126KBR5SBANSF447NR4`，tree `b7d5c10b97511b5b823066196bca7b26ee2c4330`，交付 commit `dc2f0e1a2c39b3ab081d78cf87423a302a2c45b4`。核心代码与 v7 相同，新增实际决策规则测试；profile 为 44 pass / 0 fail、129 assertions。已读独立规则函数、状态/返回类型及尝试预算常量，判断内部可扩展且不用增加现有 ingest 输入字段；未来终态/新策略仍需后续实现，不宣称已支持。三个回答及暂定策略、未知责任信息保留。最终证据 round `01M5HPHAB1S1ACNSWCB7HQBWJC`。
- 预约与通知原报告把已批准范围、后续 profile 和人工待办误列为“未实现”。其原始失败报告保留，普通 feedback 提案进入模型后形成新约束，明确 `limitations` 只报告未履行的批准范围；人工义务和真实执行仍由平台单独检查。新候选在人工核对前继续 blocked，直到收到精确 tree 的 acceptance 后才交付；没有过滤或清空旧失败回执来变绿。
- 新真实环境回执区分 PATH Bun `1.3.13` / Node `v26.0.0` 与内嵌验证器 Bun `1.4.3` / Node 兼容值 `26.3.0`；环境 digest `f58cfe32cbba9f6365c5cd48330eeb86523b260e4bed3a380052d9d8781ce692`。环境修正后的真实 PostgreSQL 候选验证 13 pass / 0 fail、65 assertions，与 SQLite 相关范围分别记账。
- `c38be1ef0` 的 CI `39763563985` 和 `ccde54faf` 的 CI `39767238898` 均为 47 success / 2 failure。后者唯一功能失败是 Windows e2e shard 3/4 的三条图研发旅程（同分片其余 135 项通过），另一失败为汇总门。下载前者 trace，Case round `01M5HMPZ2VQG7ZTGW13QH1BKWB` 明确记录 `spawn opencode failed: ENAMETOOLONG: name too long, uv_spawn`，不是审核业务超时。原实现仅按 Linux 单参数 120 KiB 判断；Windows 的整个命令行更小，且 JSON 引号会增加传输长度。修正改为对 Windows 计算全 argv 的保守 UTF-16/转义预算，超限完整走 stdin；保留小提示、POSIX 和 argv-only 旧合同。[Microsoft CreateProcessW 文档](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw) 给出的命令行上限为 32767 字符，包含末尾空字符。
- 托管 v0.1.4 构建完整日志最后为 BuildKit `error: failed to receive status: rpc error: code = Unavailable desc = error reading from server: EOF`；未见足以判定 OOM 或业务编译错误的证据。GitLab 全树 GET 两次 HTTP 500 后读取成功，只对只读请求加入有限重试；v0.1.5 已发布源码 `22fdad79c0e043fd88ac643977d7f914e56c0e82`（对应 `ccde54faf`），构建成功并进入部署。新任务 helper 镜像、实际托管业务和最终 CI 继续另验。
- Windows 传输修正的集中复验：runtime golden 与统一装配两文件 24 pass / 0 fail、79 assertions，目标 lint 与格式检查通过。覆盖低于 Linux 阈值的中等提示、引号/反斜线、运行时路径和 session 参数、UTF-16 代理对，以及真实子进程完整 stdin；本机跨平台参数用例不冒充 Windows OS 实测，最终仍消费新的 hosted Windows E2E。
