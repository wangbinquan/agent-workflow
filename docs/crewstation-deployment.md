# CrewStation 托管部署运行手册

RFC-370 的托管形态：agent-workflow（AW）作为 CrewStation（CS）上的 DigitalWorker 运行。本文是运维入口，设计与进度见 `design/RFC-370-crewstation-hosted-deployment/`（[status.md](../design/RFC-370-crewstation-hosted-deployment/status.md)）。API／MCP 自动化见 [crewstation-automation.md](./crewstation-automation.md)，环境变量见 [env-flags.md](./env-flags.md)。

## 形态

- **控制面服务**：`deploy/crewstation/Dockerfile` 构建的单二进制（`agent-workflow start`），跑在 CS 服务槽（蓝绿两槽）。状态全部在平台供给的 PostgreSQL，服务不跑 git、不起 Agent 进程。
- **任务容器**：每个 AW 任务对应一个 CS 父任务和一块持久工作卷（`/work`），镜像是 AW 任务镜像（`deploy/crewstation/task.Dockerfile`：平台任务底座 + 同一份源码构建的 `agent-workflow` 二进制 + git / ssh / python venv / node）。Git、脚本与工作区写入都以命令子任务在卷内执行，调用与单机相同的本地实现。
- **Agent 执行**：每个 Agent 节点是一个 CS Agent 子任务，按 `AW_AGENT_PROFILES` 把（协议，模型）映射到 Manifest 声明的 Agent 档案（CS 算力档位）。
- **执行权**：同一时刻只有持有 CS 执行权的服务实例调度任务；待命实例只读，`GET /api/execution/status` 给出 `mode/state/reason`。

## 平台前置条件

1. **CS 版本**：包含 RFC-040 / RFC-042 的实现，并且不早于 `621e6183`：`8d127df9` 修复任务镜像验证心跳（更早的平台上验证一律以「验证已取消或租约丢失」结束），`191f9ad1` 修复固定项目任务镜像的业务任务创建（更早的平台上 `POST /v3/business-tasks` 一律 500「Cannot expand an active shared admission」），`621e6183` 修复项目并发额度满时已受理的 Agent 子任务被永久搁置（更早的平台上节点一直 pending 到超时）。
2. **运行镜像底座**：平台用 `CS_BASE_IMAGE_TAG` 指向的 `crewstation/task-runtime` 作为任务镜像底座，并校验任务镜像的分层确实以它为前缀。这个底座里的 Runner 必须不早于 CS `92889e87`：AW 的 Git 凭据以项目 Secret 引用注入命令环境，需要 Runner 声明 `commandSecretEnvVersion`；更旧的底座上任务镜像能通过验证，但带凭据的命令会被平台以「当前 Runner 不支持固定版本命令 Secret」拒绝。
3. **套餐与档位**：服务套餐（本机验收用 250m / 512Mi）、任务档位（本机验收用 100m / 2Gi）、授权给项目的对象存储套餐，以及 Agent 使用的算力档位（模型与凭据由档位管理）。
4. **项目并发额度**：每个运行中的 AW 父任务、每个 Agent 子任务各占一个名额（卷内命令不占），AW 的共享系统工作区（记忆蒸馏、意图、运行时冒烟、MCP 探测）与每个 MCP 测试会话也各有父任务。额度至少取「最大 fan-out 宽度 + 3」。名额满时 AW 以同一请求退避重提：Agent 子任务一直等到节点超时；父任务只在供给等待预算内等待，超出以 `hosted-task-quota-exhausted` 失败，恢复任务即重提（本机验收额度 3，fan-out 2 的任务与一次记忆蒸馏重叠时即排队）。

## 一次性配置

在 CS 项目里创建配置项（Manifest 按配置定义 UUID 引用）：

| 环境变量                     | 类型   | 内容                                                                                                                                         |
| ---------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `AW_SECRET_KEY`              | Secret | 主密钥（base64）                                                                                                                             |
| `AW_ADMIN_SUBJECTS`          | 配置   | 首次访问即为管理员的 CS 用户 subject                                                                                                         |
| `AW_AGENT_PROFILES`          | 配置   | `[{protocol, model, agentProfileId}]`，`model: null` 是该协议的缺省映射                                                                      |
| `AW_GIT_CREDENTIAL_BINDINGS` | 配置   | 可选。私有仓库凭据绑定：HTTP `{kind:"http",url,username,passwordSecretId}`，SSH `{kind:"ssh",url,privateKeySecretId,knownHosts}`，最多 32 个 |
| `AW_EVENT_SOURCES`           | 配置   | 可选。托管事件来源，与发布档案的 `eventTypeIds` 同时出现                                                                                     |
| `AW_DATABASE_POOL_MAX`       | 配置   | 可选。每实例 PostgreSQL 连接数（1–256，缺省 8）；发布档案的 `databasePoolMaxDefinitionId` 声明后才注入服务槽                                 |

Git 凭据只以 Secret UUID 出现在配置里；任务命令拿到的是 CS 解析后的 `AW_GIT_AUTH_<n>` 与服务按命令下发的 `AW_GIT_RUNTIME_BINDINGS`（由 AW 生成，不要配置它），凭据不进入仓库、argv 或共享卷。平台会把项目配置注入任务容器环境，因此部署级的 `AW_GIT_CREDENTIAL_BINDINGS` 也会出现在任务容器里，AW 不再读取它作运行期绑定。

连接池：托管实例缺省每实例 8 个 PostgreSQL 连接（蓝绿两槽同时在线）。平台只把 Manifest 声明的配置注入服务槽，要调整须在生产配置里建 `AW_DATABASE_POOL_MAX` 并把它的定义 id 写进发布档案的 `databasePoolMaxDefinitionId`（未设置或空值保持缺省）。

## 任务镜像

任务镜像由运维在平台外构建，再作为「已有镜像」登记到项目。镜像源偶发断连时，构建可经代理（`--build-arg http_proxy=… --build-arg https_proxy=…`），apt 步骤本身会整步重试。CS 的运行镜像源码构建器资源固定为 500m CPU / 1 Gi 内存 / 3 Gi 构建缓存，而 AW 二进制构建（前端 + `bun build --compile`）实测峰值内存约 2.15 GB，在平台内构建会被驱逐（2026-10-17 本机实测：缓存超过 3 Gi 被驱逐）。

1. 取平台底座的精确摘要（运行镜像页面所示底座，或平台仓库 `crewstation/task-runtime:<CS_BASE_IMAGE_TAG>` 的 manifest 摘要）。
2. 从准确提交构建（只用已提交内容）：

   ```sh
   git archive <commit> | docker build --platform linux/arm64 \
     -f deploy/crewstation/task.Dockerfile \
     --build-arg CS_BASE_IMAGE=<registry>/crewstation/task-runtime@sha256:<digest> \
     -t <registry>/runtime/agent-workflow/task:<commit> -
   ```

3. 推送到平台仓库的 `runtime/` 前缀下（只有平台管理员能登记已有镜像）。
4. 在项目运行镜像里新建修订，来源 `{kind:"existing", reference:"<repository>@sha256:<digest>", architecture, usage:"task"}`，工具检查至少包括 `agent-workflow`、`git`、`ssh`、`python3 -m venv`、`node`/`npm`；工具检查的输出须恰好是期望文本（例如 `{ … ; } >/dev/null 2>&1 && echo ready`）。
5. 启动该修订的构建（已有镜像只做产物与底座分层校验）得到版本，再对版本发起任务用途验证（`target: {usage: "task"}`），通过后把版本 id 填入发布档案的 `taskRuntimeImageVersionId`。验证 Pod 使用平台缺省任务档位；节点 CPU 吃紧时需由平台管理员临时调整缺省档位后再验证。

Docker 磁盘紧张时（2026-10-17 本机两次瞬时写满，正式服务 Pod 以 `ENOSPC` 重启），不要在节点侧导入整镜像：在宿主机磁盘上以 `oven/bun:1.4.3` 执行 Dockerfile 构建阶段同样的命令得到二进制，再经平台仓库的 API 以上一版任务镜像的全部下层（平台底座与 apt 层）加新的二进制层组装新镜像，只上传新层。

**跨版本的任务镜像**：CS 父任务终身保持创建时的任务镜像。AW 的 scratch 父任务（系统 Agent 的 `system:…`、MCP 测试的 `mcp-test:…`）跟随运行中的发布，在空闲时自动换成新版本的父任务；AW 任务卷与开发工作区（`development:shared`）保留原父任务。任务镜像与服务之间的命令协议出现不兼容变更时，须提升任务合同版本（Manifest `acceptedTaskContractVersions`，代码 `HOSTED_TASK_CONTRACT_VERSION`），由平台按合同约束旧任务的交接。

## 发布与切流

发布档案（本地 JSON，不入库）字段见 `scripts/lib/crewstation-manifest.ts` 的 `CrewStationDeploymentProfile`：项目与仓库、服务套餐、各配置定义 UUID、任务档位、任务镜像版本、对象存储套餐、`agentProfiles`（每项一个算力档位）。

```sh
CS_TOKEN=<平台会话> CS_GITLAB_TOKEN=<项目仓库令牌> \
  bun run scripts/crewstation-publish.ts --profile <profile.json> [--version patch|minor|major|vX.Y.Z]
```

脚本只读取已提交内容，把源码快照与渲染好的 `crewstation.yaml` 发布到 CS 项目仓库，再经平台发布接口发布该提交：平台构建服务镜像、运行迁移 Job（`agent-workflow migrate`）、部署待命槽。切流由项目负责人执行（`crewstation traffic switch --to preview` 或平台切流接口）。

## 事件入站

代码平台事件只经 CS 进入 AW（托管下没有直连 webhook 入口）：

1. **CS 侧**：在代码平台的项目或群组上建 webhook，URL 是生产方（如 `gitlab-event-producer`）服务域上的 ingress 路径 `http://<生产方服务>.<服务域>/hooks/gitlab`，Secret token 与生产方的 `GITLAB_WEBHOOK_SECRET_TOKEN` 相同。平台把事件投递给订阅了该事件类型的服务。
2. **AW 侧**：在「Webhook 端点」建端点（provider 与生产方一致），在端点下建触发器（仓库范围、事件类型、分支过滤，启动工作流 / Agent / 工作组 / 数字员工）。
3. **配置**：`AW_EVENT_SOURCES` 按生产方列出 `producerId`、`project`（生产方项目 slug）、代码平台的 `instanceUrl` / `apiBaseUrl`（须与事件里的仓库地址一致）、`sshOrigins`、批准的仓库、订阅的事件类型（目录 id 与名称），以及把仓库路由到端点的 `bindings`（`mode: crewstation`）。发布档案同时给出 `eventTypeIds` 与 `eventSourcesDefinitionId` 时 Manifest 才声明订阅，订阅随该版本就绪登记。
4. 事件里的克隆地址在任务容器里不可达时（例如代码平台的 external URL 是 `127.0.0.1`），触发器选「临时空白工作区」（scratch），不注册事件仓库。

投递以平台签发的来源令牌认证：AW 校验签名、平台 `cs-events` 主体与本服务的受众（`CS_SERVICE_DOMAIN` 决定平台调用方形式的受众），不接受用户令牌或上游签名头。

## 交接中的运行任务

切流时旧实例失去执行权即停止写库：平台上仍在运行的 Agent 子任务与卷内命令保持运行（不发取消），实例排空后退出，库里留下的就是单机守护进程在该时刻崩溃的状态。新实例取得执行权后按持久绑定对账：

- 远程执行仍在运行的节点按原 ID 置回待运行，所在任务启动即自动续跑，调度器接管原执行，不重复派发。
- 其余运行中的任务与单机重启一样落为 `interrupted`，在任务页「恢复」续跑。结果未知的平台操作（例如被打断的推送）只在用户恢复时重放，自动修复不会重放。续跑时，已完成但 merge-back 被打断的节点从保留的隔离区完成合并、不重跑；被打断的自动提交推送重跑一次。

## 回退

- 切回另一个槽即回退服务版本；迁移只增，新版服务接受只增的较新 schema。
- M0（v0.5.0 及更早）的服务启动时要求 schema 与自身完全一致：库迁移到 v3 之后，这些旧版本重启即拒绝启动。升级越过 M0 之后，只回退到 v3 及以后的版本。
- 一旦新版本开始写入数据，不支持退回单机；需要退回时先停写，再走经过验收的导出 / 恢复。

## 备份与恢复

- **备份**：AW 设置页的「备份」（托管）或 `POST /api/backup`（`includeWorktrees: false`）。归档是单机 PostgreSQL 逻辑备份格式，存为 CS 对象，可在同页校验。托管备份不包含工作树（能力影响 C10）。
- **恢复**：在 CS 发布页发起数据库恢复（CS RFC-042）：选择备份引用 → 平台建空的新数据库世代 → 恢复 Job 以 `CS_DATABASE_RESTORE_REFERENCE` 运行 `agent-workflow migrate`（下载校验、导入、恢复后归一）→ 独立校验 Job 运行 `agent-workflow verify-database-restore` → 显式进入维护并切换；原库保留。恢复后非终态任务标为 `auto_recovery_suspended`，未结算的执行绑定按 `restored` 取消结算，进行中的平台恢复请求以失败结束。

## 平台恢复动作

CS 可对 AW 父任务发起 `resume-task` 与 `rebuild-workspace`。AW 以发起人关联的 AW 账号调用原「续跑任务」命令：卷不可用时节点以明确原因失败，平台重建工作区后可续跑。

## 已知限制

- 托管备份不含工作树（C10）。
- MCP「探测」在任务镜像里执行（`system:shared` 工作区上的卷内命令）：本地 MCP 从任务容器的 PATH 与环境启动，远程 MCP 经任务容器的网络访问，与 Agent 使用它们的位置一致；服务容器里没有 node / npx，也不启动 MCP。
- 任务镜像不在平台内从源码构建（见「任务镜像」）。
- 早于 `a70504206` 的版本创建的父任务是 CS 的 `legacy` 完成策略：删除任务后平台只释放容器、保留持久工作卷，占用项目 PVC 配额（配额用满后新任务以「容器不存在」失败）。由管理员在 CS 资源中心对「待回收」的工作卷执行「删除工作卷」回收；此后创建的父任务为 `archive-and-delete`，删除任务时经终结自动删卷。
