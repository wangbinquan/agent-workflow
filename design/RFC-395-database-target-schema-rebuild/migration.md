# RFC-395 迁移与切换合同

## 1. 一次搬迁的含义

可以多次使用冻结副本演练转换；对一个部署实例只进行一次正式 schema 代切换。正式切换前旧库是唯一业务权威，切换后新库是唯一业务权威。转换期间新库没有业务 writer，不做在线双写，不把转换器嵌入正常读写回退。

本 RFC 批准实现不等于批准操作真实数据。每次正式执行必须生成可审阅的 `MigrationPlan`：源实例 / 合同、目标位置、备份位置、内容策略、预计维护时间、未完任务处置、验证摘要、切换方式和恢复方法。用户批准具体实例的执行后再进入维护窗口。

## 2. 支持矩阵与版本识别

| 路径 | 本 RFC 要求 | 说明 |
| --- | --- | --- |
| 新装 SQLite / PostgreSQL | 必须 | 直接创建目标 baseline，不重放历史迁移链 |
| SQLite 旧 schema → SQLite 目标 | 必须 | 新数据库文件；保留原文件及一致性备份 |
| PostgreSQL 旧 schema → PostgreSQL 目标 | 必须 | 独立目标 database，沿用当前固定应用 schema；目标连接经 profile 配置切换 |
| SQLite 旧 schema → PostgreSQL 目标 | 必须保留已有跨 provider 搬迁能力 | 独立验证，不能用同 provider 演练替代 |
| PostgreSQL → SQLite | 非本次新增承诺 | 不以通用逻辑转换器存在就宣称已支持 |
| 切换前的旧 epoch 备份 → 目标 epoch | 必须（用户 2026-10-21 确认） | 旧备份作为转换器的一种源：读备份内容与引用内容清单，经同一版本化 reader / transformer 恢复到目标 epoch；纳入 AC-7 必测矩阵 |

旧 epoch 备份恢复的实现约束（II-0，2026-10-21）：源种类为 epoch-1 SQLite 备份快照（VACUUM INTO + manifest v2）、epoch-1 逻辑工件（PG 备份与迁移工件）与托管备份，三者共用源读者接口（`preflight / assertUnchanged / readChunk`）。恢复是一次离线 epoch 转换，产生 `role = restored` 的新代，不再走「换文件 + openDb 前滚」或 additive 行桥。单机备份今天不含 `runs/ logs/ evidence/`，恢复时按 §4.4 区分「原本已缺失」与「恢复后新丢失」。

不采用同一 PostgreSQL 库改 `search_path` 切代：当前适配和迁移对固定 schema 有假设，独立 database 能让源和目标的备份、driver、连接池及恢复边界清晰。目标 database 创建权限、容量与连接配置是预检条件；托管环境由现有部署控制面提供目标实例 / 配置能力，不在业务进程内擅自新建基础设施。

源识别读取实际 table / column / type / nullability / key / index / constraint 与迁移 journal，生成 `SourceFingerprint`。journal 条目数只作诊断，不能当版本。支持源合同必须明确列在转换器 manifest；旧版本可以先在离线副本上运行已冻结的原迁移再转换，绝不在真实源上“试着补迁移”。

首次必须覆盖：当前源码合同、RFC-374 之前无 seq / allocator 的合同、实际本机审计样本的物理差异、现有 PostgreSQL 支持的已发布迁移版本。未知指纹需先增加明确版本 reader / mapper 及 fixture，不能按“列差不多”写入目标。

### 2.1 额外表、缺失表与空表

- 在 manifest 中逐项列出预期不存在的 provider 专用表、应为空的退役表、内容归档表和未知表。
- 源表不存在时，只有已支持版本明确规定“该功能尚未引入”才能形成空目标 / 默认配置；不能把所有 missing 都当空表。
- 已知退役空表可以只记录 schema 与零行 receipt；有数据则导出并校验后归档。
- 未知非空表阻塞切换。未知空表也必须有显式 disposition 决议后才能省略，防止漏掉真实配置能力。
- 所有源行至少关联一个 `converted / preserved / archived / blocked` 处置，不允许 unclassified。

## 3. 转换运行模型

迁移器输出版本化 `MigrationPlan`、`MigrationRun`、`MigrationTableReceipt`、`MigrationRowDisposition`、`MigrationArtifactReceipt`。这些是 system-operations 拥有的专用迁移元数据，不计入当前 217 张业务源表；可以存于目标数据库的迁移 schema / 专用表及独立回执文件。

| 记录 | 必需内容 |
| --- | --- |
| Plan | `sourceFingerprint, targetContractDigest, converterVersion, candidateBuild, sourceBackupId, contentManifestDigest`；完整表映射与阻塞清单 |
| Run | `runId, phase, sourceGeneration, targetGeneration, sourceWriteWatermark, startedAt, completedAt`；阶段完成点 |
| Table receipt | source table/version、读行数、目标集合、转换 / 历史化 / 阻塞计数、键和内容摘要 |
| Row disposition | 同键可推导的转换以 chunk 回执证明（源表 / 版本、键范围、行数、源摘要、各目标表计数与摘要、规则版本）；派生 ID、合并、删除占位、history-only、归档、阻塞、冲突决议逐行记录（源表 + 结构化迁移键 → 目标表 / ID 集合或 archive ref、规则版本、决议） |
| Artifact receipt | 原引用 → 目标内容 ID / backend；原始 bytes hash / size、发布状态、外部文件缺失说明 |

迁移元数据存放在目标库（SQLite 目标文件内 `aw_meta_*` 表，PG `agent_workflow_meta` schema），chunk 行与其回执同事务提交；`validated` 时导出一份只写一次的回执文件到操作根。推导质量写在目标行或 `execution_legacy_evidence`，不在处置表重复。`db migration trace` 按源键给出处置。「同键可推导」指目标主键等于源主键或其纯函数，且目标列值是源行（加已声明、带版本的查找集合）的纯函数；这类 chunk 内每行处置为 `converted`。迁移元数据随目标库保留至批准的保留期结束，之后可压缩为表级回执与已导出文件。

迁移键使用现有 primary / migration key，复合键用版本化结构编码，不用易冲突的分隔符拼接。目标 ID 尽量保持源 ID；新增 child ID 用确定性映射且将结果写回 receipt。重启复用同一 plan / source watermark / target generation，逐 chunk 幂等；任一变化必须开新 run，不能沿用旧完成标记。

分块事务可以用于大表转换，但只在所有约束 / 语义验证通过后才能激活整体目标。按依赖拓扑插入，必要时先身份再从属关系；允许目标构建阶段延后建立约束，切换前必须全量验证并启用同等约束。不能将关闭 FK 的目标当作验收通过。

旧迁移 SQL / journal 不改写、不重编号；独立迁移包保留其 reader。目标 baseline 有新的 schema epoch、合同 digest 和最小可读 binary 版本，旧二进制遇到目标库明确拒绝打开；目标二进制遇到旧库进入迁移说明 / 维护入口，不自动运行半套业务。epoch 2 的后续演进按 design §13 的合同历史边增量应用；在本 RFC 激活提交之前，新增 epoch-1 迁移必须同时登记为转换器支持的源版本（并同时更新目标 contribution），转换器支持的源版本 = 候选构建时 epoch-1 的全部已发布版本。

generation pointer 升至 v2（显式 epoch、角色、数据库位置、合同与 plan digest、前一代引用）；运行时只接受 v2，v1 只在迁移模块读取（源识别、首写前撤回）。载荷为 `{version: 2, schemaEpoch, generationId, provider, role: 'installed' | 'converted' | 'restored', database: {kind: 'sqlite-file', relativePath} | {kind: 'postgresql-target', profileRef}, contractDigest, planDigest, operationId | null, manifestDigest | null, activatedAt, previous: {generationId, pointerDigest} | null}`，外层仍为 `{payload, digest}`。SQLite 业务库位于代次目录 `~/.agent-workflow/databases/<generationId>/db.sqlite`（WAL / SHM 同目录），新装同样落在代次目录并总是写 pointer v2（文件布局变化经用户 2026-10-21 确认）。目标 SQLite 库内置 epoch-1 二进制必拒的哨兵迁移收据；SQLite 目标具备与 PG 同义的首写标记。

源 / 目标角色属于迁移 run 与代次（`installed / converted / restored`），不属于 provider；`providerTraits.migrationRole` 删除。迁移 run 记录 `(sourceProvider, targetProvider, sourceEpoch, targetEpoch)`，由 §2 支持矩阵校验；`role ∈ {converted, restored}` 的代必须带 `operationId`。

## 4. 关键转换规则

### 4.1 Task 主体与来源

1. 根据已持久化的判别字段（第 5 条的固定顺序）与冻结 snapshot 识别真实主体；host workflow ID 只是来源线索，不再作为新 catalog 引用。
2. 保留各类主体（Workflow / Agent / Workgroup / 数字员工 / code-round）的原冻结执行定义、inputs、资源闭包、引擎版本与运行配置；删除 fake host 只删除迁移已证明为系统占位且无独立用户资源语义的记录（第 6 条）。
3. API 历史展示仍可解析原 ID 与旧 snapshot。不能用当前同名资源或最新版本替换已删除来源。
4. 可执行任务需要完整主体与恢复配置；若不足，报告具体 task / run / 缺失字段并阻塞。终态历史允许显式 unknown，原记录进入证据包。
5. 主体按固定判别顺序转换：`code_round_id` → code-round；`workgroup_id` → workgroup；非空 `source_agent_name` → agent；`workflow_id = 00000000000000DIGEMPHOST0` → digital-employee；其余 → workflow。`workflow_id` 为宿主常量但判别字段不一致的行（例如宿主为 Agent 而 `source_agent_name` 为空）记逐行证据；可执行任务阻塞。
6. `workflows` 中 id 属四个常量、`builtin = 1` 且定义为空骨架的行判为系统占位并删除，删除前的原行进入证据包；同 id 而定义非空骨架的行阻塞。对应 `resource_grants`、依赖索引若存在，随同处置并记证据。
7. `memories` 中 `scope_type = 'workflow'` 且 `scope_id` 为常量的行原样保留（键语义改由领域常量提供，见 design §3.1；Agent / 工作组 / 数字员工任务继续共享该作用域，用户 2026-10-21 确认）。
8. `tasks.workgroup_config_json` 的当前值整体写入 `workgroup_task_state.runtime_config_json`（初始 revision 1）；其中运行中不可改的字段（mode、workgroup id / name、goal、leader）写入 `task_definitions`。被房间改过的成员等字段的原始启动值无从证明，不补造。

### 4.2 主仓镜像与工作区

转换器必须同时读取 `tasks` 与 `task_repos`，不能规定“无条件 child 优先”或“无条件根行优先”。

| 场景 | 规则 |
| --- | --- |
| 双方值相同 | 生成一个挂载值，记录等价 |
| 旧版本尚无 task_repos | 从旧 root 字段建立 ordinal 0，标来源版本 |
| 内部工作区 branch 不同 | 依据冻结工作区种类将“任务期望发布分支”和“实际 repo 分支 / 无分支”分别映射；不覆盖任一事实 |
| 新版本有 child 但 root 与 child 有未解释冲突 | 输出逐字段差异；可执行任务阻塞；历史保存两值与 unknown，不随意挑值 |
| 单仓 / 多仓 checkpoint | 将每个 repo 的快照写入同一子表；映射关联 repo_key；不把缺少 map 解成所有 repo 的 root 值 |
| 老任务无 task_space_nodes | 按该版本已存在的 mount ancestor closure 规则离线补齐目录行，保留显式空目录事实，不在目标正常读取时 fallback |
| 延后准备占位 / 物化失败（零 `task_repos`） | 镜像列的请求值写入 `requested_source`；`worktree_path = ''` → `workspace_root_ref = NULL`；验证投影函数还原旧镜像值 |
| `tasks.branch` 与挂载分支 | 写 `task_branch`；验证 `旧 branch = (挂载 0 分支名非空 ? 该值 : task_branch)`；不成立按「未解释冲突」处理 |
| 单个非根成员仓库组（`repo_count = 1`、`mount_path ≠ ''`） | 单值 checkpoint 列映射到唯一挂载；已知缺陷导致的 `iso_node_tree` NULL：在途（isolating / pending-merge）阻塞并列出 run，终态任务记证据 `node-tree-lost-by-known-defect`，`merged` 行只影响 fanout 撤销、记证据；不伪造节点树。该缺陷按缺陷修复 + 回归用例单独修复，不属于本 RFC（用户 2026-10-21 确认） |

本机样本中 227 个 branch 差异都属于 internal 空 repo branch 与非空 task branch；这是旧模型同字段不同含义的证据，不直接宣判当下实现有数据损坏。转换规则必须有该样本形状的 fixture。

### 4.3 NodeRun 顺序、角色与消费

- 有 seq 的原样保留，包括 RFC-374 历史负数；无 seq 时按已批准旧版本排序规则一次回填并标 `legacy-derived`。不宣称恢复了真实的历史并发先后。
- 新分配高水位必须大于迁入分配器高水位及所有已分配正序号；保留“历史最大分配已 prune 但不能重用”的情况。
- role、container、scope、generation、retry、review / workgroup 维度依据持久化定义和关系转换。`parent_node_run_id` 不能自动同时成为 container、历史 parent 和 selected。
- 用旧查询 oracle 对 terminal / active 样本分别计算选择结果并比较目标 selected；active 任何不确定或 mismatch 阻塞。
- 已有 consumed-upstream 数据保存生产者 ID 与实际消费边（源节点及 shard 粒度；目标不设端口列，见 design §5.1），不套当前图补造。活跃恢复需要完整输入依赖；`inputs_recorded = false` 的行按今天「未记录视为新鲜」的语义处理，不视为缺失依赖（见下）。
- 退役正常 ID fallback 后，历史页通过专用 codec 解释 provenance quality；不能在新命令内偷偷调用旧 SQL。
- per-repo JSON map 按 `(task_id, worktree_dir_name) → repo_index → repo_key` 映射；`''` 键映射到 `mount_path = ''` 的挂载；`repo_count = 1` 的单值列映射到唯一挂载。无法映射的键记证据，可执行任务阻塞。断言 `worktree_dir_name == mount_path`；不等时在途 iso 任务阻塞、终态记证据。
- 多仓任务只有单值 `pre_snapshot`（无 map）时记证据，可执行任务阻塞；旧代码「多仓 + 无 map → 在容器根上走单仓回滚」的回落不带入目标。
- `consumed_upstream_runs_json` 转为 `node_run_inputs`（`input_kind = frame-input`，质量 `legacy-derived`）；JSON 为 NULL 的行 `inputs_recorded = false`。聚合运行的输入由 oracle 计算当时参与的 shard 运行写入，质量 `legacy-derived`。
- 历史运行 `generation_seq = 0`。

### 4.4 澄清、依赖与内容

- questions 保留顺序和完整 snapshot；按稳定 question ID 分解最终答案、草稿与 attribution。孤立 answer key / 重复 question ID 必须逐项决议，不能截断或合并覆盖。
- 旧落库形态需要资源名转 ID 时，只接受唯一且可证明的对应；保留数组顺序、必选属性和各引用参数。有意保留的 Workflow name selector 不改为 ID 权威。所有 Workflow dependency index 与定义 revision 对拍。
- 所有原文摘要继续对原 bytes 计算，不因迁到 jsonb 或重新序列化改变历史 digest。需要查询的结构化投影另存。
- base64 / UTF-8 技能内容解码成 bytes；验证 BOM、非法 UTF-8、空内容。外置内容先发布 ready，再提交最终引用；失败可重试，source 内容在目标验收前不释放。
- 缺少历史 artifact 可以保留“原本已缺失”的证据和原有用户可见错误，但不得将迁移新丢失混入其中。活跃任务所需内容缺失一律阻塞。

### 4.5 事件、幂等与历史

事件 ID / aggregate sequence / consumer cursor、来源 revision、dedupe key、lease epoch、effect receipt、launch idempotency key 保持语义连续。不得因更换物理库重新投递已经完成的业务效果。

已完成 delivery 不重放；未完成 delivery / effect 以持久状态和 receipt 交接到新 owner。lease 的历史 owner 可留证据，但不能把旧进程活跃租约当成新进程有效执行权。新会话通过现有 recovery 协议重新 claim；业务 execution generation 与连接 / daemon generation 不混用。

旧 code work 历史、6 张 ARCHIVE 表和 writer drain receipt 保存离线包及原 ID 索引。当前 `committed_event_family_cutovers` 的有效家族路由必须复制成目标配置；不与 legacy-draining 一起删掉。源 `committed_event_family_cutovers.mode` 必须全部为 dispatchable，`employee_os_writer_state` 必须处于 OS active，否则阻塞（目标去掉 `mode` 列；`employee_os_writer_state` 不建表，其状态写入 activation receipt）。

### 4.6 持久化载荷

1. 在途回放载荷（`collaboration_gate_operations` 中 preparing / prepared 的 clarify-open、review-open 清单；未被任务接纳的仓库 / 工作区准备回执；在途托管工作区命令）在冻结前由源上的既有恢复流程推进到终态；预检发现剩余项即阻塞。目标运行时只写、只读 v2 形状；v1 解码器只在迁移 / 历史模块；已提交的 v1 清单原字节保留。
2. 由旧字段派生的身份与幂等键（effect 的 `request_hash / operation_key / operation_family_key / slot_path_json / slot_path_digest`、lineage 记录、`continuation_slot_key`、`lineage_slot_path_json`、commit 行 node id、进程 spawn 回执、`workspace:` fence 键）按值搬运，不重算。新写入沿用同一公式，`worktree_dir_name` 输入以等值的 `mount_path` 代替；转换器断言二者逐行相等。
3. 自含载荷（人工门续跑载荷 v1、评审决定的工作区回滚计划、澄清决定清单、删除清理计划 v1/v2、调用闭包 v1/v2、wrapper 进度、`archive_json`、`commit_push_json`）原字节保留，运行时解码器不变；其中引用的路径与快照值在目标库中逐字节可得。
4. 对外协议载荷（托管执行的 `HostedAgentContext` v1）保持线格式；由目标表重建时须与存储值逐字节相等。
5. 任务归档格式升到 v3；逻辑备份与旧 epoch 备份走 §2 支持矩阵的转换路径。

人工门续跑载荷中的节点投影摘要在决定事务内计算并比较，提交后不再重算，因此切换前等待人工、切换后才决定的任务不会被围栏拒绝；它不属于需要收敛的在途回放载荷。

### 4.7 约束对齐

目标裁决见 design §2.4。转换器规则：

| 项 | 转换规则 |
| --- | --- |
| 任务 lineage（原 `rfc328_tasks_lineage_after_insert` 兜底） | 源行 `execution_lineage_id / lineage_slot_path_json` 为 NULL 时按迁移 0210（`0210_rfc328_task_execution_ownership.sql`）的规则补齐，记 `legacy-derived` |
| 子任务 launch origin（原 `trg_tasks_launch_origin_inherit_child` 兜底） | 校验父子一致；不一致记证据，在途任务阻塞 |
| `development_missions.reopened_from_mission_id` | 悬空引用记证据、阻塞 |
| `memories.supersedes_id / superseded_by_id` | PostgreSQL 源中的悬空指针置空并记证据（目标两侧统一 `ON DELETE SET NULL`，用户 2026-10-21 确认） |
| `node_runs.container_run_id` | 按依赖拓扑插入或校验后启用；悬空 → history-only + 证据，在途阻塞 |
| `repo_group_nodes.child_group_id` | 悬空引用按应用的解除规则（清空挂载字段）处理并记证据 |
| `task_collaborators.added_by`、`tasks.owner_user_id`、`users.created_by` | 悬空引用阻塞 |
| `tasks.name` | NULL / 空串按迁移 0021（`0021_rfc037_task_name.sql`）的回落规则 `'task-' \|\| substr(id, -10)` 补齐，记 `legacy-derived` |
| `code_work_observations` | 表归档，目标无表 |
| 列序 / 唯一的物理表示 | 按列名转换 |

## 5. 正式切换状态机

```text
discovered → planned → backed-up → quiescing → frozen → converting
          → validated → activation-prepared → activated → verified → completed
```

每一步都有 durable receipt；失败停在可恢复相位，不能跳过。具体顺序：

1. **准备**：对当前 source fingerprint 和目标 build 做离线演练，形成内容清单与容量 / 耗时估计。维护窗口预算从实际数据吞吐及备份恢复演练得出，不在 RFC 中凭空承诺分钟数。
2. **备份**：使用引擎一致性备份和内容 manifest，记录备份 watermark；如备份早于最终冻结，冻结后补到同一 watermark 或重新取最终备份。不能只复制正在写入的 SQLite 主文件而遗漏 WAL。
3. **停止新准入并收敛 writer**：API、schedule、Webhook、event consumer、Worker、托管执行器均进入维护行为；已接收的输入必须持久化 receipt 后稍后交接，或者在确认接收前返回明确可重试错误。不得先 ACK 后丢失。
4. **保存执行状态**：等待正在提交的数据库事务完成，按已有 checkpoint / interrupted 恢复协议停止进程。awaitHuman / awaitReview 保留；无法 checkpoint 的活动运行待其收敛或阻塞窗口，不自动取消。继续接收的已存在人工门请求与 webhook 请求按维护契约返回，不丢掉已提交答案。
5. **冻结**：所有 writer 已退出 / 停止写入，记录最后业务水位；获取同一时点源库与引用内容快照。SQLite 处理 WAL 后只读打开副本；PostgreSQL 使用一致性 snapshot / export，并确认旧 writer 不再产生新提交。
6. **转换与验证**：构建独立目标，完成 schema、行处置、语义、内容和恢复预检。任何 blocked / unclassified / active mismatch 使激活不可达。
7. **准备激活**：写一份 source generation → target generation 的 activation receipt；启动目标二进制的只读 / admission-closed 健康检查。检查不执行 effect，不启动会写库的 maintenance，不调用会隐式修改 schema 的普通启动路径。
8. **切换**：关闭所有旧连接。SQLite 目标位于 `~/.agent-workflow/databases/<generationId>/db.sqlite`；切换以原子替换 pointer v2 为唯一提交点（写临时文件、fsync、rename、fsync 目录），之前崩溃源仍权威、之后目标权威，由 activation receipt 判定。首写前撤回按 activation receipt 原样恢复 v1 pointer（源当时无 pointer 则删除 pointer）。源文件在 `completed` 前保持原位，`completed` 时移入操作根 `database-migrations/<op>/source/` 保留（同文件系统，不删除）。该文件布局变化经用户 2026-10-21 确认。PostgreSQL 切换部署配置到目标 database 并重建全部 pool。保留 source 指针和旧 build 供切换前撤回。
9. **启用**：只有目标 schema admission 与 activation generation 一致且旧 writer 已停，才重新准入。托管蓝绿槽、Worker、任务镜像助手使用同一目标 generation；不能让部分 writer 留在旧库。记录首次业务写入 watermark。
10. **验收**：核对未完任务、队列、协作、历史与内容可读；产生切换回执。旧库与备份按批准保留期保留，不能以 `completed` 自动删除。

维护入口可以复用现有 CLI / 部署操作；本 RFC 不要求新增独立页面。若实施要新增产品界面，先给用户可交互原型审阅，再实现该界面。

## 6. 校验与成功条件

| 校验 | 成功判据 |
| --- | --- |
| schema / 约束 | 目标合同 digest 相同；FK、CHECK、唯一键、索引与 provider 语义已对拍；无未执行目标约束 |
| 行处置 | 所有源键有 receipt；未知处置 = 0；阻塞 = 0；拆分 / 合并后的业务对象数量、标识与关联守恒 |
| 业务投影 | Task 详情 / 历史、当前 run 选择、待办、事件游标、资源引用、费用投影与 source oracle 相等或有已批准的逐项差异 |
| 数据类型 | NULL / 空值、Unicode / collation、整数边界、时间、JSON、二进制与 identity 高水位不漂移 |
| 内容 | 应存在的 bytes hash / size 一致；所有目标 live ref 可读；预先已缺失项单独列明 |
| 活动恢复 | 未完 Task / Case / Mission / Apply / effect / delivery 可交接；无 effect 重复、事件丢失、答案丢失或 owner 被复制为活跃 |
| 恢复能力 | 同 provider 与跨 provider 支持路径按矩阵验证；完整备份能恢复到同等投影 |
| 旧路径退出 | design D1～D13 全部有删除或迁移 / 历史边界证据；正常进程不加载源 schema reader |

源与目标同名表的 count 相等只适用于 KEEP；拆分、关系化、归档后的 count 必须按映射衡量。单独 `foreign_key_check`、schema hash、构建通过或一次 UI 成功都不能替代整组判据。

## 7. 失败恢复与回退边界

| 故障点 | 处理 |
| --- | --- |
| 冻结前 | 源继续正常业务；失败的计划 / 演练标记失败，不切配置 |
| 冻结后、激活前 | 源仍是权威；可重启转换或恢复旧 writer；丢弃目标须另有明确操作，源不动 |
| 配置已切、尚无目标业务写入 | 关闭目标全部连接，依据 activation receipt 恢复源指针 / build，再启用旧 writer；验证没有目标业务提交 |
| 目标已产生业务写入 | 不允许直接切回旧快照，否则会丢新事实；优先修复前滚，或从目标一致性备份恢复。回退到旧 schema 需要额外反向转换方案和明确批准，不在本 RFC 假定可用 |
| 外部内容发布一半 | 复用 publication journal 继续发布 / 释放；已引用 bytes 不删除，未引用对象可由既有回收协议收敛 |
| 激活时进程崩溃 | 启动读取 durable activation receipt 决定唯一允许写入的 generation；恢复确认前维持维护状态 |

故障注入至少覆盖每个阶段的前后、chunk 提交后尚未写 receipt、已写 receipt 后响应丢失、对象上传后引用未提交、配置切换后 admission 未开、首次业务写入后崩溃。重启不能产生重复新增 ID、重复外部 effect 或假成功。
