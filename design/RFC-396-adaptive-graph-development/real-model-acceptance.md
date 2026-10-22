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
