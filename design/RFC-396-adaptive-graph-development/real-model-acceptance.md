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
| 预约 | `01M5H550KMNV5RQX7S9RP7S5GX` | 单资源时段预约、幂等、冲突、取消；后续讨论优先级与并发 | 进行中 |
| 异步通知 | `01M5H59S2462BFFJBJWGMF4SY9` | 按 entity 去重、版本乱序、失败重试与版本内终态 | 进行中 |
| 已有模块 | `01M5H59TF3767SKWW9T280J4K3` | 修正 `normalizeResponse` 对非法 data 的处理；保留签名、返回结构和 consumer | 进行中 |

实际测试 profile：`01M5H59QNZ4T44H5388ZGMVRS8@1`，内容 digest `346d744b8456279d6faa14dd7e41327ef7e4669dc49aabd13b9e6479b5700513`。它要求执行候选仓库中的 `verify.sh`，收集实际 stdout、退出码和原始回执；脚本需执行 `bun test`。模型声称测试通过不能代替该证据。

人的回答均由代理针对虚构案例作出，不代表真实业务负责人批准。判断保留 `provisional`，责任人与复查时间未定；不为了让材料完整而编造负责人、日期或生产承诺。

## 已观察到的失败与恢复

1. 发布前建立的 `/tmp/rfc396-live-sK18Ey` 保存了尚未改成 Node ESM 的试制审核工作流，新产物启动时报 `builtin-workflow-content-conflict:00000000000000GRAPHWFRV1`。逐字比对证明首次公开实现 `5f11d1857` 到当前候选的资源定义相同，冲突仅涉及发布前试制数据。原库保留为失败记录；当前三个案例在干净隔离库中运行，没有改动产品校验或覆盖旧工作流。
2. 新库首次预约调用因验收 daemon 继承沙箱限制，OpenCode 无法打开自己的日志文件而失败。按用户已给出的模型调用许可重启同一隔离库，并通过 Case 的原生 resume 入口恢复；没有重写 Task 状态或手工伪造输出。
3. 三个首轮设计均被领域校验拒绝：模型在没有匹配人工来源时填入 decision 的成熟度，并让决策表 `rows.ruleId` 引用未在 `elements` 声明的规则。错误作为 `import-error` 留在工作区，当前版本未被错误输出覆盖。后续通过原生澄清回答同时提供业务判断和具体错误反馈，要求模型修复；不能将这些首轮结果记为可读有效设计或首次通过。
4. 已有模块首个 designer 调用在本次验收配置的 `480000ms` 上限超时；其 NodeRun `01M5H59VS9KBCAG5M6HMBQHSQ1` 保留 `node-timeout: exceeded 480000ms`。平台一次自动重试 `01M5H5RHQKRRGS6V7JF4DNV2M0` 产出设计，之后进入原生澄清。这个 8 分钟值是验收配置，不能写成产品固定超时。
5. API 验收脚本第一次同时提交单选 option 与 customText，收到 `clarify-confirmation-required`。依据既有单选合同改为一个完整自定义回答，再按实际题集计算 `questionSetKey` 与逐项 `confirmedBasis`，提交成功。此项是验收脚本错误，不是产品缺陷；没有放宽原确认合同。

## 证据边界

当前仍需收齐三个完整闭环、变化前后的图组合对照、代码和真实验证回执，以及托管业务执行结果。模型调用累计 token 字段包含其会话记账，不能直接推算费用或独立输入规模。

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
