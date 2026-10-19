# RFC-378 集中验收记录

本次先完成生产实现、接线和全部用例，再集中进行独立功能门、远端 CI 与真实操作验收。用户已明确授权实现、自主验收和提交远端。这里分别记录代码、模型输出、浏览器行为和部署，未完成项不以其他层的通过代替。

## 1. 候选与自动化

| 提交 | 内容 | GitHub Actions |
| --- | --- | --- |
| `3fd0c4f28ecd868df432bb1e87cd0b525da05b16` | 完整生产实现、用例、设计和原型 | [CI 39194638524](https://github.com/wangbinquan/agent-workflow/actions/runs/39194638524) failure：新增弹窗漏登记、三平台两个 E2E 仍查折叠的旧错误提示。Windows 平台和视觉回归分别为 `39194638518` / `39194638499` success。 |
| `bac110674e995bc5c3e9772ea2b80dd492981aaf` | 友好错误 alert、弹窗清单、E2E 适配；根据真实提问补齐类别、兼容选项、独立标签与证据约束 | [CI 39196728147](https://github.com/wangbinquan/agent-workflow/actions/runs/39196728147) failure：三个前端用例的单 alert 查询歧义，另三平台 E2E 刷新后标签查询失败。分别在 `644e9a538` / `05fe01fb8` 修复。 |
| `644e9a538959238e3b9dd3533513457cd3e9f3e2` | 上述前端查询修复；最终输出显式保留未标注成熟度，区分模型推导与用户接受的代价 | [CI 39197229351](https://github.com/wangbinquan/agent-workflow/actions/runs/39197229351) failure：前端已通过，剩余三平台 E2E 刷新后标签查询问题（已在 `05fe01fb8` 修复）。视觉 `39197229362` success；实机使用该运行产出的生产二进制。 |
| `96bef8c1829f337006c27fa2fca434df7b7ea5b2` | 脑图前言/示例/结构规则与独立取舍、成熟度指导一致；普通模式保持 | [CI 39198744675](https://github.com/wangbinquan/agent-workflow/actions/runs/39198744675) failure：同一刷新后标签查询问题仍影响三平台 E2E；实际提问复验使用其生产二进制。 |
| `05fe01fb878eb843bd6e9ad4a8bc8bb4835f5f75` | 仅 E2E 在刷新后按 textbox 可访问名称查找已恢复内容，原严格值/状态断言保留 | [CI 39198998975](https://github.com/wangbinquan/agent-workflow/actions/runs/39198998975) 完整终态 success，包含三平台 E2E 与 `CI required`；生产源码与 `96bef8c18` 完全一致。 |
| `a550f5a3ec8db734ca4af4ec69d560b2f00e76af` | 消除脑图前言要求未知全部定案的冲突；单选仅改变一个变量；最终文档不新增成熟度必填门 | [CI 39200587900](https://github.com/wangbinquan/agent-workflow/actions/runs/39200587900) 完整终态 success，49/49 jobs 成功。四文件独立功能复核通过，第四轮真实任务完成，内容质量缺口见下。 |
| `19347b3be8365e1531024aa2752a4aff6abc4e0f` | 四轮单机验收的原始内容、界面证据与未通过项；生产源码未改变 | [CI 39202756779](https://github.com/wangbinquan/agent-workflow/actions/runs/39202756779) 完整终态 success，49/49 jobs 成功。 |
| `54d485de419c6203be93287d4c3522ba067aab25` | 存储解阻和计算容量失败回执；生产源码未改变 | [CI 39208822738](https://github.com/wangbinquan/agent-workflow/actions/runs/39208822738) failure：47/49 jobs 成功；Ubuntu E2E shard 3/3 的工作组用例期望 5 次 leader run，实际 9 次，汇总门随之失败。`a550f5a3e..54d485de4` 无生产、测试或依赖差异，额外 4 次运行报 clarify-forbidden；根因归属未确认，保留失败，未代改或重跑追绿。 |

所有失败均按实际 job 日志和本次差异归因；没有代改或回退其他 session 的代码。没有执行本地 Bun 功能测试、E2E 或开发服务。限定路径的 TypeScript、ESLint、Prettier 和 diff 静态检查通过。真实验收运行的是下载的 CI 生产二进制。

## 2. 第一轮真实单机旅程

- 隔离实例：`http://127.0.0.1:7459`，数据目录 `/private/tmp/rfc378-acceptance/standalone`，正式实例保持运行。
- 构建：`3fd0c4f`，GitHub artifact `12161686520`。
- 模型：`opencode-go/deepseek-v4.1-flash`，实际 OpenCode 进程和运行观测均有记录。
- Agent：`01M593HKSBG4XX3XAKM3X9WK1F`；workflow：`01M593G2AFPH8QC3PYVHJE5TE1`。
- task：`01M593MGE19EQN2J13X6MT64EP`；初始成功 agent run：`01M593Q5AVPTANKX1B3BQWM69D`。
- clarify node run：`01M593RM926RN9KFCTBS5GNWBQ`；最终 agent run：`01M594RBEDGSFQQAJFSK286H7C`；output run：`01M594S9V03X8QTTGRF60BYZFB`。
- task 于 `2026-10-19T03:55:17.730Z` 进入 `done`，实际输出端口为 `result`。

操作从新工作流的「从模板开始 → 脑图澄清 → 选择已有代理 → 校验并应用」进入，得到 4 节点 / 4 连线；经实际启动向导运行虚构的 20 人、3 间会议室、两周交付、无历史基线场景。初始 5 题由模型生成，引用追问追加 4 题，九个答案均通过实际 UI 输入和确认。

引用原文「我们还不知道空占是否是主要矛盾。」后，输入区分真实需求不足与空占的具体追问。第一次在途取消，原引用和指引仍保留；再次请求返回 `missing mindmap category: q1`，原答案仍保留。刷新后恢复同一引用和指引，重试成功，四个子题保留在 Q4 分支。运行观测记录：取消 `01M593Y2WYHPX3H7ATY6CZQTFQ`；生成后协议校验失败的模型调用 `01M5941DQZQ4FM40X6KM373TFB`；成功重试 `01M5945NPVKP2YPDJSPKYH3BQD`。模型调用本身的 `done` 不等于追加题校验成功。

问题确实带出一个值得进一步检视的点：提醒会改变行为，启用后的记录不能直接当成自然空占率。将该未知写入决定补充后，本题立即回到「待确认」；重新确认、刷新、打开复核，原话、暂定、依据、代价、未知、验证角色和复核条件完整保留。在途追问时复核可读而最终提交不可用；复核的「定位查看 / 修改」回到原题。只提交一次后任务继续并实际完成。

第一轮发现了三类内容问题并加入相应约束：兼容的记录/提醒被放在单选、推荐排序后“上一档”指向不清、无证据的主要痛点判断。随后还发现最终文档把未标注答案列为「已决定」，把推导的 FCFS 风险称为「本版接受」。因此第一轮证明了真实运行与数据贯通，但最终语义未通过；[原输出](evidence/standalone-first-output.md) 和 [封存轮次](evidence/standalone-first-round.json) 如实保留。

最初的隔离服务由工具沙箱启动，OpenCode 无法写入自身日志，任务出现 8 次失败尝试；改以批准的执行权限重启同一隔离服务，再恢复同一任务，成功进入真实模型。该环境错误和后续真实调用分开记账。

## 3. 后续候选复验

使用 artifact `12162193858`，SHA-256 `4cd416998f04b83c0b6ee2296cdd572f04c53e307a04e6a89f3cefa6798ef157`；artifact 的 `workflow_run.head_sha` 为 `644e9a538959238e3b9dd3533513457cd3e9f3e2`，二进制 `version` 为 `agent-workflow 644e9a5`。保留隔离数据目录，仅替换本会话验收服务进程。

通过实际「再次启动」向导创建 task `01M595BGCZ4WS394Q2QBFT6RWY`，复用同一场景输入。首次初始生成因缺 `mindmap.categoryPath` 被拒；既有协议重试成功，成功初始 run `01M595D3ZAAZYTXXQVP2B6W4X6`、clarify run `01M595DN9BYKMEG0J952FSJWPS`。明确将共享文档标为已决定，将记录/提醒且不自动释放标为暂定，其余保留未标注。追问又追加四题；在生成期间成功继续回答其他题。复核后只提交一次，最终 run `01M5960CTKTKE54H4RV3SRVGJD`、output run `01M59617BVVVBA816FSZ7ZYGX1`，task 在 `2026-10-19T04:17:05.917Z` 为 `done`。

[实际最终输出](evidence/standalone-second-output.md) 正确分为「已定事项」「暂定事项」「当前选择（成熟度未标记）」。全部用户决定补充原话保留，明确负责人待定、未指派人选、复核未排定；模型推导的影响另列为「非用户接受，仅作提示」。用户主动指出的“冲突次数单独不能反证空占”“抽样未见人不等于整个时段未使用”“复核触发不等于证据充足”也完整进入输出。原始 [封存答案](evidence/standalone-second-round.json) 与截图保留，本轮 AC10 实际输出语义通过。

本轮初始提问仍把记录/取消/强制释放混成单选，验收指标与推广范围也混成一个选择轴，因此 AC09 尚未据此签过。模型追加题虽使用兼容多选，推荐说明仍有逻辑跳跃（把冲突次数当成直接反证、把任一触发当作样本量下限）；本轮用自定义回答明确纠正，证明用户可以质疑并保留修正，不把该现象说成模型质量已保证。

据此回读完整提示，发现通用 mandatory 前言要求合并相关点、通用结构规则把所有回答当作已解决决定、通用示例漏分类，分别与脑图尾部约束冲突。`96bef8c1829f337006c27fa2fca434df7b7ea5b2` 仅在脑图模式统一这三处，新增八种提示组合与普通模式兼容回归；独立窄范围复核无 P1/P2。第三轮复验使用同一生产源码的 `96bef8c18` 二进制（artifact `12163550177`，archive SHA-256 `2d5271cff93ed48478c508ead45b56854774462a4d54b2fb061114a48bda2258`），task `01M596GKWDDAK42HW2D9AA04RQ`。初始 run `01M596GM6MDZ4E3NG5324T2NAH` 一次通过分类校验，clarify run `01M596JKJ8MJE2SD7SFY4DENMX` 得到五题；证据记录题为 multi，但时间粒度含管理员例外、爽约处理混入记录方式，AC09 仍未完全通过，不能通过不断挑选成功样本宣布模型内容保证。

使用者明确指出记录方式与释放权限混杂，并请求两个独立问题后，实际分支调用 `01M596Q6MJGNACPWXTP7VHGAH7` 成功，新增一个“是否允许人工释放”的 single 和一个“可并行收集哪些证据”的 multi。用户自定义纠正“禁止管理员代释放不等于禁止预约人主动取消”，同时保留缺少抽样/复核负责人。复核面板实际显示「验证负责人或复核时机尚未完整指定」，仍允许用户提交，没有逼填人名或自动分派。

最终首尝试 `01M596TB6BA9KSAXA3T3JNRG7H` 报 `envelope-missing`（`no <workflow-output> envelope found in stdout`）；平台既有协议重试后 run `01M596V6PPX17JXKSXG4N8AT08` 成功，output run `01M596VKMYHM4EBN3BBF6QBR8K`，task 于 `2026-10-19T04:31:30.465Z` done。[原输出](evidence/standalone-third-output.md) 与 [封存问题/答案](evidence/standalone-third-round.json) 保留。三种成熟度、原话、用户接受的代价、缺失责任人与未排期状态仍正确呈现；模型另有要求实施前标记成熟度的建议，这不是产品的提交阻断规则，也不能替用户作决定。第三轮证明最新生产候选的完整执行和主动纠正链路，初始问题质量不足仍是公开的未通过项。

第三轮之后继续修复已确认的提示冲突：通用前言的“所有未说明细节都是阻塞”“每项决定必须定案”“不能写 TBD”尚与允许暂定推进冲突；`a550f5a3e` 只在脑图模式明确用户可以保留未知、选择停止，结果不新增标记成熟度门。同时将单选约束具体化为“标题只命名一个变量、选项和说明仅给该变量的值”，使用不同领域的记录保留期示例说明套餐互斥不等于原子取舍。该修复不新增答案必填、语义猜测校验器或模型调用，不更换场景/模型来规避原失败。

### 第四轮：最新生产候选

使用 `a550f5a3e` 的 CI 生产二进制，artifact `12164105847`，archive SHA-256 `cfbcefc930426c2a620e397fc13449eeae28ba4e48a994b15ffefc11d3da7145`。保持同一需求全文、Agent、工作流、模型与隔离数据目录。task `01M597Q2K6DD0N55FY06VN15AY`；初始 run `01M597Q2WSHY67S41AN5TYJAA9`；clarify run `01M597SD6T49DH2G5J2899CX0F`；实际分支调用 `01M597X94H3H82F6EQ4Z8TEQ3Y`；最终 agent run `01M5982M6EZYF1EWJRXZ5YDBK3`；output run `01M5983J76H6AGTK1C7VS1Y6MQ`。任务于 `2026-10-19T04:53:19.721Z` done，三次业务模型调用均成功，未发生协议失败重试。

初始五题中，“是否自动释放”已单独成题，但“不自动释放”选项仍附带记录与提示；“回看已有记录”和“试点采集新记录”仍被放进 single；共享日历是否存在被当作默认前提。使用者通过自定义答案明确反对这些假设。点击「检查依据」只预填指引，再由用户点击「继续追问」，生成四个同分支子题；期间继续完成另外两题。子题带出了空占定义、观察偏差、记录负责人和复核信号，但复核触发信号仍被做成互斥 single，不能把这些内容记为 AC09 通过。

最终九个答案为 1 decided、1 provisional、7 unmarked；封存答案中的 15 段非空原选择/决定补充均逐字出现在 [原始输出](evidence/standalone-fourth-output.md)。[封存轮次](evidence/standalone-fourth-round.json)、[复核面板](evidence/fourth-review.png)、[实际 done](evidence/fourth-completed-task.png)、[输出预览](evidence/fourth-output-preview.png) 均保留。结果正确区分原话与模型推断，保留 TBD、未定日期和不自动派发，没有再要求把所有成熟度补齐后才能推进。

但输出第 6 节仍将“签到尚未决定”写成“不设签到”的推断前提；第 8 节把“是否提醒另行决定”写成“不启用日历自动化或提醒”，标题为“严格限于已决定项”却同时列入暂定和未标注内容。结尾仍有“启用前仍需用户判断”的要求，不能将消除成熟度必填扩大为已消除所有额外前置要求。虽然原话和逐项状态完整保留，这仍可能误导阅读者，故最新候选的 AC10 **内容一致性未完全通过**。四轮真实证据表明当前提示约束不能稳定保证原子问题或消除模型额外假设；不继续挑选成功样本，也不通过自动改写用户原话、强制成熟度必填或替用户作决定来制造通过。后续内容质量方案需针对这些保留样本验证，当前 RFC 保持 In Progress。

独立审查代理再次核对本轮封存 JSON、原输出和验收口径，确认 9 个答案、三种成熟度及 15 段原文的统计，未发现字段复制/存储层改写；同意 AC09/AC10 不签过。验收口径复核通过不代表功能整体验收完成。

## 4. 浏览器与键盘

桌面、390×844、320×700 的浅/深色复核均经过截图查看。两种窄屏的 `documentElement.scrollWidth` 与 viewport 分别同为 390 / 320，弹窗左右边距 12px，长原话和决定字段可在内容区滚动，底部提交/返回按钮保持可达。Tab 从最后提交按钮回到关闭，Shift+Tab 从关闭回到提交；Escape 关闭后焦点回到「复核决定并提交」。临时 viewport 覆盖已恢复。

这部分实机 UI 来自 `3fd0c4f`；之后的生产修改限于失败提示语义和模型提示/摘要，已有交互实现未改变。大图、self/cross、继续/停止、部分封存、协作、保存失败等组合以对应自动化结果记账，不冒充全部人工走查。

## 5. 独立托管验收

已创建独立项目 `rfc378-mindmap`（project `01a15233-d0b4-7000-ba3b-4a72cf7da7e4`，service `01a15233-d0b4-7001-bfa0-21f28bb515a4`，namespace `cs-rfc378-mindmap`），使用本项目配置与授权的既有运行档位/镜像。未修改正式 AW 的工作流、配置或切流状态。

自动创建的模板发布 `v0.1.0` 源码是 `c2005eca5ef13a0dfb1f9112ae9b5ea1a78ad0f2`，不是 AW 候选。其构建曾因 `Insufficient cpu` 等待调度，后来于 `03:54:26 UTC` 完成，模板预览槽 ready。该事实不能当成新候选已部署。

早期候选源码 `644e9a538` 已通过原发布脚本进入该项目 GitLab，提交 `821b6a8f502c957bf2c231c170dac7b57a786499`。请求 `v0.1.1` 时平台返回 HTTP 412 `config-incomplete`：`后端可分配空间预算不足。在项目设置里补齐生产组配置后重试`。对象存储后端的 60 GiB 可分配预算已全部分配，独立项目尚无对象空间。没有通过修改共享预算、挪用其他空间或删除其他资源绕过前置检查；候选尚未创建 release，托管追问与最终输出仍未验收。

已为自己的隔离项目创建专用 2 GiB 档位 `01a15265-9b8f-7000-a4d8-a050cdf8d145`，授权只加在本项目。最新 `05fe01fb8` 源码与该档位的 manifest 经 `--no-release` 发布为 GitLab `df9390f2196997822ae3d8880ebf00711eef63a3`。共享后端预算仍为 60 GiB；2026-10-19T04:22:11Z 实测物理空闲约 13.7 GiB。已在当前会话请求用户决定是否增加 2 GiB 共享可分配预算；未答复前不执行依赖的配置变更。

后续 `a550f5a3e` 源码沿同一路径发布为 GitLab `afd093389442f396c304996f434caf8ca28384fa`，仍未发起候选 release。原正式实例的审计任务再次只读检查，仍为 running，诊断 S5：`task running with active node_run(s) but events stopped landing`，活跃 run `01M58YVDP0JM0RXJCYFB7TV543` 的 `pid` / `lastEventTs` 均为 null。已保存 [实际诊断截图](evidence/original-hosted-s5.png)，没有执行修复、取消或重启。这个旧链路问题与本候选尚未部署分别记录，根因仍未归属。

### 用户授权预算增加后的发布

用户在本会话明确批准推荐的 60 → 62 GiB 调整。`2026-10-19T06:00:12.208Z`，通过平台管理 API 对 Local Garage（`01a0e955-7699-7000-ae9f-6b118e4e99ad`）执行 revision 1 的条件更新，读回 revision 2 / `66571993088` bytes。独立项目对象空间 `01a152bf-6c72-7000-8c98-09d7a549ed0a` 随后成功分配，额度 `2147483648` bytes、health `ready`，原 HTTP 412 容量阻塞已解除。

已将 `19347b3be8365e1531024aa2752a4aff6abc4e0f` 的已提交源码通过原脚本发布为 GitLab `bdec7705b49f554d1405e743a4271e7bc3a04627`，创建 `v0.1.1` release `01a152bf-6ffe-7000-a80d-bea6275b65ad`。该 release 在 `06:00:42.985Z` 于 queued 阶段失败：`该镜像尚未通过所选用途与档位的验证`，构建、迁移和新候选部署均未开始。实际界面见 [发布失败截图](evidence/hosted-release-image-blocker.png)。此前镜像的 passed 记录属于其他项目；当前平台将 projectId 纳入验证契约摘要，所以新项目不能借用该记录。

本次按平台正常流程启动本项目的 task 用途验证 `01a152c3-29d8-7000-8325-e5d15b8d00a3`，固定镜像版本 `01a14fc6-95a1-7000-b860-518323f4a121`，镜像摘要 `sha256:722194e94a5b65fb7fcbb94cdb4362be25dfa07ed79e39f282af1aae3ebe8133`。验证 Pod `crewstation-system/task-01a152c329d870008325e5d15b8d00a3` 的 requests 为 1 CPU / 2 GiB memory，调度器记录 `Insufficient cpu, 1 Insufficient memory`。当时节点 requests 为 9905m / 31312Mi，allocatable 为 10 CPU / 32810996Ki memory；这是调度预留量，不是实时使用率。以 Kubernetes 条件监听等待后，平台于 `06:09:51.951Z` 将验证置为 failed：`验证环境未能完成初始化`，checks 为空。`06:11:42.861Z` 已确认验证 Pod 自动消失，没有手动删除。

[预算、对象空间、发布、镜像验证与调度原始回执](evidence/hosted-storage-and-capacity.json) 保留了两个时点：验证等待期间 9905m / 31312Mi；失败回收后的节点 9855m / 30800Mi。后者仍不足以安排 1 CPU / 2 GiB 的验证。当前选定的父任务档位和 Agent 档位分别需要 100m / 2 GiB，后续真实旅程需要两者并行，因此至少需要为验证留出 1 CPU，并为任务阶段留出 4 GiB 内存，另计构建/迁移和服务资源。主机为 10 CPU，Docker 配置也已分配 10 CPU，不能仅增加内存就解除 CPU 调度阻塞。

未调整其他项目的资源请求、配额或副本，没有停止正式 AW、其他任务或旧验收实例。原模板 `v0.1.0` 预览仍为 Running / Ready，它不是本候选。需要用户指定可暂停的其他测试资源，或另行提供有容量的运行环境后，才能重新验证镜像并发布新的候选版本；没有绕过镜像准入，也没有反复重试同一容量条件。托管 AC05/AC12 仍未完成。

只读查看资源中心时，切换「资源清单」意外触发“运行镜像授权有未保存的输入”提示。自动审批拒绝了放弃输入，随后已选择「继续编辑」并保留页面，没有丢弃或提交这些状态；这不影响上述 API 与 Kubernetes 回执，也没有据此代改 CrewStation。

### 2026-10-19：按授权清理超过 14 天的任务资源

用户明确授权“你可以自由清理14天以前的任务”。以开始盘点时的 UTC 时刻固定截止线 `2026-10-05T13:10:57.000Z`，通过平台任务 API 盘点 31 个项目、373 条任务记录；212 条早于截止线，其中 198 条已释放、14 条失败，没有仍在运行的旧任务。任务创建时间与实际 Kubernetes UID 对照，未用容器最近重建时间替代任务年龄。

先通过资源中心 `delete-volume` 动作回收 19 个已标记 PendingReclaim 的旧任务工作卷，其中 3 个为平台已登记的孤立任务卷。剩余业务任务 `01a0e30e-e096-7000-be22-db3c8ecd4171` 创建于 `2026-09-27T13:29:58.166Z`；在确认全部子执行均终结后，经其所属服务 `rfc028-images-20260927` 的 `/actions` 正常 close，操作 `01a1544d-94f7-7000-a7e5-ab5e2f5d0f52`。任务读回 closed / resourceState released / quotaHeld false，原失败 Pod 消失，最后一个卷转为可回收后再执行 delete-volume。

截至 `2026-10-19T13:17:15.281Z`，20 个目标 PVC 与对应 PV 均已物理消失，失败 Pod UID `f748cdc5-645f-4982-96bf-835e648f38e1` 已不存在；20 条卷台账全部 stopped。被回收卷的申请容量合计 **101 GiB**，该数不是实际磁盘已释放字节数。任务历史记录保留。正式 AW 服务 Pod 仍 Running / Ready，未停止较新的任务、其他服务或项目。完整 [清理与容量回执](evidence/old-task-cleanup.json) 记录对象、时间、平台动作、物理消失和容量结果。

清理前旧任务均未占用运行中的计算资源，故 CPU/内存调度容量未因本次清理增加。盘点后的节点 requests 为 `9605m / 30288Mi`，尚余 `395m / 1753.98828125Mi`。仍不足以调度 1 CPU / 2 GiB 的镜像验证，也不足以运行父任务与 Agent 的 4 GiB 并行需求。未重新发起必然被同一容量条件阻断的验证或发布；托管 AC05/AC12 继续保持待验。

后继共享基线 `a6c05417bd437fc0b00655b862ed524380ad5f37` 的 [CI 39242700213](https://github.com/wangbinquan/agent-workflow/actions/runs/39242700213) 终态 failure：后台 shard 15/24 的 development-automation 装配架构断言、shard 20/24 的 RFC-370 PostgreSQL 程序工具 HTTP 201/500 断言失败，汇总门失败。该基线不是本轮清理提交；并发工作区正在修改相关生产文件和测试，本会话未提交或修改这些文件。另 [全量 E2E 39250118444](https://github.com/wangbinquan/agent-workflow/actions/runs/39250118444) 失败，不能据此前生产候选 49/49 成功宣称当前共享 CI 全绿。

## 6. 完成边界

原型、独立代码功能门、实际单机运行、模型内容、自动化、托管部署分别成立才记录相应完成状态。一次代理走查证明操作链路与可见内容，不证明真实使用者已经形成更深入的思考或责任习惯；后续试用应观察主动质疑、明确代价、保留未知和提出可执行复核安排，而不是统计填写字段或分支数量。

## 7. 验收逐项对账

| 标准 | 当前证据与结论 |
| --- | --- |
| AC01 起步 | 实际模板选择已有 Agent、校验应用、4 节点/4 边、真实启动通过；无合适 Agent 的分支由自动化覆盖。 |
| AC02 全景 | 实际原答案摘要/成熟度、业务标题、分支定位与目录操作通过；大图与分类路径由 E2E 覆盖。 |
| AC03 成熟度 | 实际设置 decided/provisional/未标注、编辑使确认失效、刷新后仍保留通过；原确认 hash 兼容由 shared 覆盖。 |
| AC04 主动追问 | 原引用与具体指引、快捷提示只填不发、在途继续作答、取消、协议失败、刷新恢复、重试及真实分支追加通过。 |
| AC05 两形态执行 | 单机实际 OpenCode 通过；托管已选 binding 接线及冻结/取消由回归覆盖，共享存储预算已获批解除，候选因项目镜像验证未通过受阻，验证又因 CPU/内存不足失败，真实托管待验。 |
| AC06 数据贯通 | 原始字段在实际编辑、刷新、封存及输出引用中逐字贯通；协作/归属/双数据库/部分锁定由自动化覆盖。生成内容的解释一致性见 AC10。 |
| AC07 提交复核 | 实际复核原答案、全部五类决定补充、成熟度与定位修改通过；第三、四轮缺少负责人实际显示警告并允许推进，失败提示另由自动化覆盖。 |
| AC08 提交语义 | 实际 self + stop 单次提交与任务续跑通过；continue/cross、保存错误、部分锁定和在途阻断由自动化覆盖。 |
| AC09 问题内容 | 四轮真实内容发现并修复提示冲突；最新仍有兼容来源和复核信号被设为 single、选项夹带决定，未通过。用户可以自定义纠正，不代替初始质量通过。 |
| AC10 最终文档 | 原话、三种成熟度、代价、未知、未定负责人/复核均贯通；第二轮该样本通过。最新第四轮仍有推断前提与成熟度章节不一致，内容一致性未完全通过。 |
| AC11 可用界面 | 桌面、390/320px、浅/深色、键盘与文本选择实际检查通过；5000 节点/深度 100/300 同级规模由 E2E 覆盖。 |
| AC12 完整旅程 | 单机从起步到真实追问、编辑/刷新/复核/最终输出和 task done 通过；托管旅程待候选部署。 |

自动化覆盖的“通过”以相应候选确切 SHA 的终态为准。生产候选 `a550f5a3e` 和首批验收记录 `19347b3be` 已完整成功；后续 `54d485de4` 与共享基线 `a6c05417b` 的失败分别保留，不能作为当前全仓通过。RFC 保持 In Progress，直到 AC09/AC10 剩余内容质量与托管 AC05/AC12 分别闭合。

## 8. 实际界面证据

- [第三轮提交复核：缺失责任人明确提示](evidence/third-review-missing-owner.png)。
- [第四轮最新候选：复核](evidence/fourth-review.png)、[任务完成](evidence/fourth-completed-task.png)、[实际文档](evidence/fourth-output-preview.png)。
- [第三轮实际最终文档](evidence/third-output-preview.png)。
- [第二轮最终文档：三种成熟度分开](evidence/second-output-preview.png)、[任务实际完成](evidence/second-completed-task.png)。
- [桌面原话复核](evidence/second-review-desktop.png)、[390px 浅色](evidence/review-390-light.png)、[320px 深色](evidence/review-320-dark.png)。
