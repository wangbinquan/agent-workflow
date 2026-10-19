# RFC-378 集中验收记录

本次先完成生产实现、接线和全部用例，再集中进行独立功能门、远端 CI 与真实操作验收。用户已明确授权实现、自主验收和提交远端。这里分别记录代码、模型输出、浏览器行为和部署，未完成项不以其他层的通过代替。

## 1. 候选与自动化

| 提交                                       | 内容                                                                                   | GitHub Actions                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `3fd0c4f28ecd868df432bb1e87cd0b525da05b16` | 完整生产实现、用例、设计和原型                                                         | [CI 39194638524](https://github.com/wangbinquan/agent-workflow/actions/runs/39194638524) failure：新增弹窗漏登记、三平台两个 E2E 仍查折叠的旧错误提示。Windows 平台和视觉回归分别为 `39194638518` / `39194638499` success。                                                                                                         |
| `bac110674e995bc5c3e9772ea2b80dd492981aaf` | 友好错误 alert、弹窗清单、E2E 适配；根据真实提问补齐类别、兼容选项、独立标签与证据约束 | [CI 39196728147](https://github.com/wangbinquan/agent-workflow/actions/runs/39196728147) failure：三个前端用例的单 alert 查询歧义，另三平台 E2E 刷新后标签查询失败。分别在 `644e9a538` / `05fe01fb8` 修复。                                                                                                                         |
| `644e9a538959238e3b9dd3533513457cd3e9f3e2` | 上述前端查询修复；最终输出显式保留未标注成熟度，区分模型推导与用户接受的代价           | [CI 39197229351](https://github.com/wangbinquan/agent-workflow/actions/runs/39197229351) failure：前端已通过，剩余三平台 E2E 刷新后标签查询问题（已在 `05fe01fb8` 修复）。视觉 `39197229362` success；实机使用该运行产出的生产二进制。                                                                                              |
| `96bef8c1829f337006c27fa2fca434df7b7ea5b2` | 脑图前言/示例/结构规则与独立取舍、成熟度指导一致；普通模式保持                         | [CI 39198744675](https://github.com/wangbinquan/agent-workflow/actions/runs/39198744675) failure：同一刷新后标签查询问题仍影响三平台 E2E；实际提问复验使用其生产二进制。                                                                                                                                                            |
| `05fe01fb878eb843bd6e9ad4a8bc8bb4835f5f75` | 仅 E2E 在刷新后按 textbox 可访问名称查找已恢复内容，原严格值/状态断言保留              | [CI 39198998975](https://github.com/wangbinquan/agent-workflow/actions/runs/39198998975) 完整终态 success，包含三平台 E2E 与 `CI required`；生产源码与 `96bef8c18` 完全一致。                                                                                                                                                       |
| `a550f5a3ec8db734ca4af4ec69d560b2f00e76af` | 消除脑图前言要求未知全部定案的冲突；单选仅改变一个变量；最终文档不新增成熟度必填门     | [CI 39200587900](https://github.com/wangbinquan/agent-workflow/actions/runs/39200587900) 完整终态 success，49/49 jobs 成功。四文件独立功能复核通过，第四轮真实任务完成，内容质量缺口见下。                                                                                                                                          |
| `19347b3be8365e1531024aa2752a4aff6abc4e0f` | 四轮单机验收的原始内容、界面证据与未通过项；生产源码未改变                             | [CI 39202756779](https://github.com/wangbinquan/agent-workflow/actions/runs/39202756779) 完整终态 success，49/49 jobs 成功。                                                                                                                                                                                                        |
| `54d485de419c6203be93287d4c3522ba067aab25` | 存储解阻和计算容量失败回执；生产源码未改变                                             | [CI 39208822738](https://github.com/wangbinquan/agent-workflow/actions/runs/39208822738) failure：47/49 jobs 成功；Ubuntu E2E shard 3/3 的工作组用例期望 5 次 leader run，实际 9 次，汇总门随之失败。`a550f5a3e..54d485de4` 无生产、测试或依赖差异，额外 4 次运行报 clarify-forbidden；根因归属未确认，保留失败，未代改或重跑追绿。 |

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

### 2026-10-19：按补充授权停止两个较新的子执行

用户明确允许停止 `snake-bot-20261014` 父开发会话 `01a13edf-f800-7000-a46d-e38c341e2a1f` 下的两个 10 月 15 日子执行，保留父会话、共享工作卷和已发布服务。于 `14:12:49.926Z` 通过 `agent-terminals/:agentId/stop` 停止 CLI `01a13f48-19f6-7000-b2a8-bc2d681a5cc4`，于 `14:12:50.984Z` 通过 `agents/:agentId/cancel` 停止 Agent `01a13f4b-a05b-7000-afa7-b53d48f76ef7`。两个任务读回 released / native finished，两个目标 Pod 已物理消失，释放的 requests 合计 **800m / 4096Mi**。

父会话仍 running，原 Pod UID `0ccaa08e-31f4-4081-8a68-225d41e1b3d8` 仍 Running / Ready；共享 PVC UID `22dead26-6f13-45b8-8909-e91916cf26aa` 不变且 Bound；snake 已发布服务 UID `c46b9412-3f4b-4b7e-bc42-439b03f372a5` 不变且 Ready。正式 AW 两个服务副本均 Ready。本次未释放父会话（其卷为 follow-container），未删除共享卷。

共享集群同期新增正式 AW blue 与 rfc042-aw-restore blue 两个服务副本，合计 requests `300m / 1024Mi`。核对应用容器与初始化容器的有效调度请求后，当前节点 requests 为 `9105m / 27216Mi`，可用 `895m / 4825.98828125Mi`；内存已足够，镜像验证所需 1 CPU 仍差 **105m**。没有以修改 Pod requests 或重复创建必然 Pending 的验证绕过准入。另一个 `rfc011-role-home` 的旧预览可释放 500m / 512Mi，但服务预览不在旧任务清理授权内，已提出具体补充请求，尚未执行。完整 [子执行停止与保留检查回执](evidence/approved-compute-cleanup.json) 保留实际 UID、平台动作和容量差异。

旧任务清理提交 `bf99a2dfd9e989a018e0c74db9be51494b60e5f4` 的 [CI 39259525265](https://github.com/wangbinquan/agent-workflow/actions/runs/39259525265) 为 46 success / 3 failure：后台 shard 15/24 与 shard 20/24 复现父基线的两组断言，另一个失败为汇总门；该提交仅改五个文档/证据路径，未代改其他会话实现。后继共享基线 `0c266dbcce2711ee8f90ba79bb627f59478127ee` 的 [CI 39261747195](https://github.com/wangbinquan/agent-workflow/actions/runs/39261747195) 已终态 **49/49 success**；旧失败记录保留。同步检查 main 与 origin/main 为 0/0，RFC-378 生产候选内容未因这些文档更新而改变。 已通过原发布脚本将该已提交基线同步到独立项目 GitLab `93b4c6c1a4fc3b7b5a6623cebd6f1131cd3bb2f0`（162 个文件动作、2 个提交）；使用 `--no-release`，尚未申请新候选版本。

### 2026-10-19：一周前旧 RFC 预览清理与镜像验证解阻

用户进一步明确要求完整完成 RFC，并授权下线一周前的其他 RFC 资源、不再逐项询问。本轮通过平台 `slots/preview/offline` 下线 rfc011-role-home、rfc006-verify、rfc022-verify、rfc023-verify 和 rfc038-wizard-20261009 的旧预览；执行前核对 release 创建时间和 preview retention.since 均早于固定七天截止线，按 expectedReleaseId 防止错停新版本。五个旧 Pod 已物理消失，释放请求合计 625m / 1664Mi；rfc038 正式 blue、正式 AW 和 snake 父会话及已发布服务保持 Ready。

新的项目专属 task 镜像验证 `01a154a9-2e3f-7000-93d7-e91285e50e5c` 在 `2026-10-19T14:55:45.068Z` passed。实际镜像 digest 为 `sha256:722194e94a5b65fb7fcbb94cdb4362be25dfa07ed79e39f282af1aae3ebe8133`；worker UID、agent-workflow、git、ssh、python-venv、node 六项检查全部通过。未修改共享资源请求或跳过验证。详见 [旧预览回收与项目镜像验证](evidence/week-old-previews-and-validation.json)。

同时完成 AC09/AC10 失败样本对应的三项修复与用例：脑图续跑不再重复未选提案；分支追问复用含 single/multi 的结构化格式示例；共享提问指导与最终文档检查覆盖人为互斥、未知转否定和跨章节成熟度漂移。当前仅记录实现完成，须在新候选 CI 和实际单机/托管文档中集中复验，不把提示断言当作模型质量证明。

### 2026-10-19：第五轮单机与首轮真实托管候选

候选 `c0b2091730a82177cb09efc7bb256c926586b5aa` 的 macOS CI artifact `12197378036`（archive SHA-256 `4a0f15a96336ed913d59f86f97ce77f6bbdd6bdc9165f746f98f53ba03be3a71`）已用于第五轮单机。task `01M5AC9KPTAEJBHGRCPPRMAXAG` 于 `2026-10-19T15:39:38.121Z` done；clarify `01M5ACB0Y105MTPHCBA6VTM4AC`，最终成功 run `01M5ACX753JHX0C5WW0C9MT778`，output run `01M5AD2ZR7YV7P8J34KX1KHPRX`。五题初始提问、四题真实追问、在途继续作答、刷新恢复、复核定位修改、确认失效后重新确认、缺负责人仍可提交，均实际操作。

[第五轮原始结果](evidence/standalone-fifth-output.md) 保留九个回答、原话与三种成熟度；未把“签到/记录/提醒未决定”改成否定，条件推断另列且标注原成熟度，AC10 在本样本通过。首次最终 run `01M5ACQ6JPXXEB5M2XBE73MY85` 达到 32,000 reasoning tokens、output 0，报缺 workflow-output，原协议重试成功；没有修改模型或手工补写结果。AC09 仍失败：自动释放的否定项顺带承诺记录，预约资格混入时段分配政策。详见 [完整问题、答案与运行元数据](evidence/standalone-fifth-journey.json)、[复核](evidence/fifth-review.png)、[结果界面](evidence/fifth-output.png)。

同一候选已在独立 `rfc378-mindmap` 项目发布并启用：GitLab `4a4fef8ec6c2c83f290f6fe68f2bd856e7c9f8f4`、`v0.1.2`、release `01a154b0-850d-7000-a091-164935643aad`、journey `01a154b0-8641-7000-a78e-6b3aa8d3736e` succeeded；镜像 `sha256:7732664be776592a56b417454773d377012f11cb9eaf2e84911bada76a039228`。控制面 Pod Running/Ready 且 `command -v opencode` 无输出。实际 UI 创建 Agent `01M5AC025JBNQ071TVEV0TVDS0` 和工作流 `01M5AC3ZRBZ5RZDNSXCC4GC06A`，启动 task `01M5AC6EGVPWZXER0GY2QT6DDV`；初始远程 run `01M5AC7P8Q5RW6Q9MJG25VSJ7T` 成功，实际模型为 `opencode-go/deepseek-v4.1-flash`。

托管 clarify `01M5ACK73ZP3SF9YSKFJWQT6TJ` 已有五个确认答案。首次追问由用户操作取消，刷新后回答保留；再次请求 `df9bc06d-626f-4316-8769-0f8c574d0369` 在 `15:38:29.776Z` 报 `clarify-followup-timeout: `，五个答案和失败指引保留，[界面截图](evidence/hosted-c0-followup-timeout.png) 可核查。代码中追问单独写死 180 秒，远程子任务已 Ready，并非资源调度不足。观测正确归属父 task，但未透传冻结 runtime registration，误记为 builtin:opencode。这两项纳入当前修复，不能把初始远程生成当作托管追问成功。详见 [托管实际回执、原题、草稿和观测](evidence/hosted-c0-journey.json)。

本次完整修复候选收齐后再集中验证：提问指导采用机制二选一、参数单变量、兼容证据多选及单句代价的具体形式；最终文档指导收敛为一次原话回读，避免重复扩写；追问复用普通 System Agent 十分钟预算并透传冻结观测身份；任务协作页的未提交脑图轮次进入共用脑图/复核页，跳转前持久化同弹窗其他草稿，普通问答与已封存重答保留控制通道。新增提示组合、双库冻结身份/旧记录、导航/持久化失败/重答用例。没有先运行局部功能测试。候选 CI 与两形态实际复验待完成。

### 2026-10-19：托管追问成功与 Windows 长文档回放归因

候选 `52122e76ad588a95901f957178cc2c98730afd71` 已精确路径发布，独立托管 `v0.1.3` 在 `2026-10-19T16:02:59Z` 启用（release `01a154e1-0bdb-7000-af88-ad384939fd69`，镜像 `sha256:b4d51139ce8ff6c772a56077355ee8838d9c4bf10e251d85b5dc389805bfa3f5`）。同一真实托管轮次请求 `7ac15176-d244-4aa9-a5fc-2ca1a5482ea9` 成功追加 3 题；远程子执行 `01a154ea-7b14-7000-89d3-c2ede8e6d893` 在 `16:13:03.408Z` settled，600000ms 预算、cancelReason null。原五个答案保留；控制面无 OpenCode。新增来源与复核条件均为 multi，假设优先级为 single，明确抽查不能证明整段无人、复核不自动启用政策。最终文档继续实际验收中，尚不记托管 AC12 完成。

单机第六轮 task `01M5AEKT7AST7VZRSCX0DGJ5V4` 初始 run `01M5AEKTHAD91RJK8XDWTYGE8J` 成功；任务协作页已实际显示脑图入口。初始五题仍有三处 AC09 缺陷：时间粒度夹带最短时长、兼容功能组合做成单选套餐、多选中加入“暂不额外采集，仅靠团队反馈”。本次改为明确的单变量/兼容功能形式，并修正混合轮次弹窗提示；原失败样本保留，不能以自定义回答纠正来宣称生成质量已通过。

`c0b209173` 的 [CI 39274464447](https://github.com/wangbinquan/agent-workflow/actions/runs/39274464447) 终态 failure，47 success / 2 failure（Windows E2E shard 3 和汇总门）。trace 中实际答案已完整送达且 designer 已 done；reviewer 的 8 次尝试均 `spawn opencode failed: ENAMETOOLONG: name too long, uv_spawn`，原始 prompt 32770 字符。故根因是本 RFC 的指导扩张越过 Windows 命令行容量，而不是摘要解析或回答丢失；未改 scenario parser。现将指导收敛到 2800 字符预算内，补组合提示与预算回归断言，保留真实长文档录制 E2E 不裁剪。`52122e76a` 的 CI 39281632773 尚未取得终态，新修复候选仍须精确 SHA CI 和真实内容复验。

### 2026-10-19：第七轮原题与并发资源排队

`68b44b40f97767d92ffd783f954f64efb3f7fa9c` 的 CI artifact `12202706570`（平台 archive digest `sha256:ade9b82d439d7baeb6f75113dc059b4c770604c68901335bd9026d0cc609ac07`）已在原隔离目录启动，版本核对 `agent-workflow 68b44b4`。实际 UI 启动 task `01M5AG004R8WXJR02YC2PSN7R3`，初始轮次 `01M5AG12MV1D1BJA8WSGZGHGDD`；时间粒度没有捆绑最短时长，功能项改为 multi，分类均为单层，但“试点小组”仍混入证据来源题，未记 AC09 通过。[原始问题](evidence/standalone-seventh-initial.json) 保留。继续补充同一题必须是同一种取舍轴，明确试点规模不属于证据来源，否定自动措施不意味着只剩人工；保持 2800 字符指导预算。`f5c03f480` 仅同步上一候选的旧断言文案，生产内容不变；CI 39285166918 待终态。

托管最终 run `01M5AFFDXP4QBFN4A0BCNEH38J` 在 AW 为 running，但平台子执行 `01a154f8-7187-7000-aa79-20ae3ceaa72c` 实际 pending / not-started；并行记忆蒸馏也 pending。独立项目原 `maxConcurrentTasks=2`，两个父工作区已占 2/2，模型子执行无法受理；已通过平台 quota API 以 expectedMaxConcurrentTasks=2 调整为 3，让两个父工作区与一个模型子执行共存，子模型串行等待。此为验收项目配置修正，不改变运行模型或业务答案。

同时新版本 build Pod 因 Insufficient memory Pending。按用户授权下线旧 RFC 资源，核对五个 RFC-003 验证服务的 release 和 Deployment 均早于 2026-10-05 且没有活跃业务任务后，以 UID / resourceVersion / 原 replicas=1 为前置条件将其 Deployment 缩至 0：rfc003-ux、rfc003-verify-workbench、rfc003-verify-delivery、rfc003-verify-files、rfc003-verify-integration。释放目标为 675m / 2560Mi；源码、镜像、数据库、卷及访问配置保留，恢复命令为各自 `kubectl scale deployment <name> -n <namespace> --replicas=1 --current-replicas=0`。这是旧验证服务的明确运维下线，平台原发布记录保留，不冒称应用仍在线。逐项 UID、创建日期、执行回执和恢复命令见 [下线回执](evidence/older-rfc-services-offline.json)，独立项目额度见 [额度回执](evidence/own-project-execution-quota.json)。物理回收与在途结果另行确认，正式 AW 和 snake 未纳入目标集合。

## 6. 完成边界

原型、独立代码功能门、实际单机运行、模型内容、自动化、托管部署分别成立才记录相应完成状态。一次代理走查证明操作链路与可见内容，不证明真实使用者已经形成更深入的思考或责任习惯；后续试用应观察主动质疑、明确代价、保留未知和提出可执行复核安排，而不是统计填写字段或分支数量。

### 2026-10-19：录制合同和延迟草稿测试回归归因

[521 CI 39281632773](https://github.com/wangbinquan/agent-workflow/actions/runs/39281632773) 已终态 failure，45 success / 4 failure。macOS E2E shard 2、Windows shard 3、Ubuntu shard 2 的同一 hierarchy 用例均在 initial round 等待超时；模型边界 fixture `recordedDirectionsScenario.ts` 仍要求旧 `multi-level categoryPath` / `Empty notes do not disable` 字面量。现同步为当前非空分类路径、配置祖先保留、空关注默认指导的合同，并补逐项缺失仍拒绝的测试；原完整录制 E2E 和最终答案检查保留。

68b CI 39284749385 的 Windows frontend shard 3 报 `Unexpected network request(s) escaped test mocks: PUT http://daemon.test/api/clarify/nr_plain/draft`。`nr_plain` 属本 RFC 新增的两个混合脑图导航测试；生产队列本来就需要在弹窗卸载后继续保存。测试现明确接住并等待该精确草稿 PUT，不修改生产持久化语义或全局网络守卫。两项由本轮修改引入，按责任范围修复；新 SHA 的终态尚待取得。

五个旧 RFC-003 服务的运行 Pod 已全部消失，正式 AW 和 snake 仍 Ready，见 [物理回执](evidence/older-rfc-services-physical-proof.json)。托管最终子执行在 16:41:45Z 实际启动，原 quota 排队已解除。v0.1.4 镜像构建于 16:41:00Z 报 BuildKit `rpc error ... EOF`；同秒共享 buildkitd 容器退出 137 后重新 Ready，未判定为应用编译错误。该失败候选不切流，后续以新完整候选发布并检查实际结果。

### 2026-10-19：托管完整旅程通过与第八轮问题复核

真实托管 task `01M5AC6EGVPWZXER0GY2QT6DDV` 在 `2026-10-19T16:46:16.221Z` done，最终生成 run `01M5AFFDXP4QBFN4A0BCNEH38J`、output run `01M5AGWXKR2QQPXQH0813GDB6J`；浏览器实际显示已完成并打开结果预览。初始问题来自 c0 候选；成功追问、复核提交和最终生成来自 v0.1.3 / 521 候选，不混记为最新初始提问证据。八个回答中 1 已决定、1 暂定、6 未标注，全部原话与补充保留；未知没有转成不采用，也没有补造负责人或日期。[原始最终文档](evidence/hosted-completed-output.md)、[轮次/执行/冻结身份/观测](evidence/hosted-completed-journey.json)、[提交复核](evidence/hosted-completed-review.png)、[完成界面](evidence/hosted-completed-task.png) 和 [结果预览](evidence/hosted-completed-output.png) 对账。AC05、AC10 与托管 AC12 的本样本通过。

0098 候选第八轮 task `01M5AH41S9WTQENRVF83JJNK3N`、clarify `01M5AH5F762QW7ZQ1A466XBSVQ` 的 [原始初始题](evidence/standalone-eighth-initial.json) 仍有 AC09 缺陷：“不启用未到场释放”描述为“只能靠人工协调”；分配顺序和审批混成单选，所有分类补出单链第二层。实际 prompt 无注入记忆，仍有固定两层分类示例，描述/推荐示例也使用笼统“预期结果/用户应选择理由”。本轮修正这三处脑图专用示例，普通问答示例逐字不变；共享指导增加不替代其他机制的否定示例、分配与审批分离和默认单层，长度 2637 小于 2800 字符。组合提示和真实 followup 接线断言一并更新，真实生成质量仍待新候选复验。

3b4147483 已推送且远端 0/0；CI 39288504112 正在运行。为释放已被替代候选的 runner，仅取消本会话 68b / f5 / 0098 三条未完成主 CI，不把它们记录为通过；已出现的失败日志保留，最新完整候选仍须终态。

### 2026-10-19：第九轮托管初始题与进一步收敛

最新 `80390a0a8` 已在独立项目 v0.1.6 启用（release `01a1551d-6698-7000-b5f9-4c7a79eb25af`，镜像 `sha256:d6420951f60dae3cfb4e060710419b3b9a5b476ac28423ceeb4f80a2d61fa092`，journey `01a1551d-67b0-7000-a78f-902b968f2525` succeeded，execution active）。控制面 `command -v opencode` 仍无输出；应用版本打印 `0.0.0-unknown`，源码身份依据正常发布回执的 GitLab `9846ed5e9634f97969901ec2151b5d5eb3714d67` 与 AW 源 SHA 对应，不借版本字符串推断。

第九轮 task `01M5AJ9573BDJZBH95XVBGFNJD`、initial run `01M5AJAP7XFGSWB29H5G3D8T7P`、clarify `01M5AJKAH8YWZQCPS8A5RSEYB4` 使用同一无基线业务输入、同一真实模型。[原始问题](evidence/hosted-ninth-initial.json) 的否定项已保留“其他处理方式未定”，但启用自动释放的说明仍写“需要签到判定”，将判定方式捆入措施本身；分配项混入“优先级或审批”。实际完整 prompt 已包含本次新示例且无注入记忆，不能归咎旧镜像。该样本仍不签 AC09。

后续指导收敛为先提 2–3 个最关键取舍，判定来源与阈值各自另选，并为启用项给出与否定项对称的短例；历史/新观察和定时/事件复核的兼容规则保留，压缩重复句后总长 2632，仍小于 2800。初始组合提示与实际分支 generator 的接线回归收齐。当前是修复完成，内容复验待新候选；不把模型提示或绿色测试当作真实问题通过。

### 2026-10-19：第十轮原始问题与完整格式示例修正

`3b41474836240c57dcf83595cc3bb362c4294461` 的 [CI 39288504112](https://github.com/wangbinquan/agent-workflow/actions/runs/39288504112) 已终态 **49/49 success**，见 [完整 job 回执](evidence/ci-3b4147483.json)。此前排队的 `CI required` 也已成功。被替代的 68b / f5 / 0098 三条主 CI 已终态 cancelled；803 的未完成主 CI 也按确切 SHA 核对后取消，均不记为通过。

`56cc088c8f334c546a0d57389d32ebbf3f334505` 已发布到独立项目 `v0.1.7`：GitLab `52e2d1f537e1084627c51fb809db673ed47600b6`，release `01a15531-49a0-7000-b0a3-4bba3bc5e5de`，journey `01a15531-4ae6-7000-9d75-15ec7d36e2a6` succeeded；实际 Pod 的镜像摘要为 `sha256:9ceb2887327d7de60442cfb415617d27e1866973c7d521ea3bff9cd88b98f5ea`，Ready、restartCount 0。已通过正常预览下线动作停止本项目旧 v0.1.6，数据保留，正式 AW 不变。见 [部署与预览下线回执](evidence/hosted-focused-deployment.json)。

第十轮 task `01M5AKK5ZZ8CYS6BDGKPPXXEJH`、initial run `01M5AKPKC8PQF9538ZBH2WAVP0`、clarify `01M5AKYGYT3VH87B9KDW9CSCDV` 仍使用原场景与 `opencode-go/deepseek-v4.1-flash`。完整 prompt 8825 字符，实际远程请求长度相同，明确包含最新指导；生成无重试成功，但 [原始问题](evidence/hosted-tenth-initial.json) 仍捆绑签到与自动释放、将配额/审批混入分配顺序。AC09 仍未通过，未通过自定义回答或重跑同一候选改写此结论。

本轮修复将脑图格式里的单选/多选占位符改成两个可直接解析的完整示例：单一提醒措施的开/关不决定渠道与时机，已有记录与新增观察可兼容，推荐明确假设与代价。普通问答原格式保持；共享指导删去重复短例，保留独立取舍、条件性证据、成熟度与分类规则，并用“选择此项后其他变量是否仍可独立决定”检查捆绑。新增示例经真实 parser 的用例，已有八种初始组合提示与双库分支 generator 用例同步；示例加指导及双引号转义估算 3240 字符，小于 3350 的组合预算，避免重现 Windows argv 回归。代码和用例收齐后仅进行静态检查；新真实内容与新确切 SHA CI 继续验收。

### 2026-10-19：第十一轮与无基线时的提问顺序

`e8993e6b25138cff2886a3bdb5662dae8df1032e` 已发布并启用独立 v0.1.8，GitLab `986288e6f0cb6598c14bd3c7f199f791635b4b4f`，release `01a1554b-e2d3-7000-8054-dbe6d1e2b145`，journey `01a1554b-e4b3-7000-b8e2-9b13dad675df` succeeded。控制面 Pod 的 `sha256:44d0d74552de1463691d14fe7b4f818ea9e61e8f39c04a95fe868819ec044fc5` 与回执一致，Ready、零重启、无 OpenCode。新版本启用后正常下线本项目旧 v0.1.7 预览。18:08 UTC 原正式 AW 两个服务副本、snake 服务与父会话仍 Running/Ready，正式 AW 同时有一个本会话未操作的新副本尚未 Ready。见 [部署与保留检查](evidence/hosted-concrete-deployment.json)。首次启用脚本在获取平台登录会话时收到 HTTP 504，尚未执行发布动作；平台新 API/session Pod Ready 后同一正常流程成功。

第十一轮 task `01M5ANA25J7VB5A5TK1PASVQ6K`、initial run `01M5ANBQZA038WZT95FH14F1W6`、clarify `01M5ANM0MBKS1NK6JSDVNNP9FR` 的 [原始三题](evidence/hosted-eleventh-initial.json) 已减少题量，但“未签到自动释放”仍把判定方式装进措施定义，分配顺序仍混入审批。该样本保持 AC09 未通过。第十轮的节点 prompt 与实际远程执行 request 已逐字节比对相同，见 [hash 回执](evidence/hosted-tenth-prompt-proof.json)；不是只核对长度或推测旧镜像。

后续修改将无基线时的起点放在问题优先级、可观察的成功信号和可行证据上，具体机制后续再问；用户已明确要求某项取舍时仍优先尊重该请求。完整格式示例补齐“同一参数的不同值”，三类示例均由原 parser 验证；独立参数不再用配额、审批或操作人等不同维度作为替代值。指导压缩为 1981 字符，示例与指导加双引号转义估算 3286，小于原组合预算 3350。初始模式矩阵检查完整共享指导与普通模式兼容，真实 followup 接线继续检查同一指导和实际三类示例；真实语义仍由下一轮原场景验收，不能用这些断言代签。

`56cc088c8` 的 CI `39293600672` 已终态 47 success / 2 failure。失败 job `118203591633` 是 macOS E2E shard 2：1 failed、5 flaky、9 skipped、159 passed，终态失败在 `rfc294-human-gate-restart.spec.ts:553` 的 daemon 就绪 30 秒超时；另一个失败为汇总门。迁移提取到 config loaded 间隔 20499ms，脑图尚未生成。与已绿 3b 基线相比，harness、该测试、daemon 和 DB 路径未变；本 RFC 生产差异只改提示。慢启动的确切因果归属仍未确认，没有加超时、重跑旧 CI 或修改他人代码。见 [失败归因记录](evidence/ci-56-startup-failure.json)。`e8993e6b2` CI `39297811196` 继续等终态。

### 2026-10-19：第十二轮成功信号的兼容选择

`e8993e6b2` 的 [CI 39297811196](https://github.com/wangbinquan/agent-workflow/actions/runs/39297811196) 已终态 **49/49 success**，见 [job 回执](evidence/ci-e8993e6b2.json)。共享 main 随后新增 `c66a6223` 的正常发布脚本 `--source` 能力；本会话保留该无重叠提交，14 个候选文件 hash 未变，再发布 `7814999e16de64e9a153591924c35a8ef6d2f1cc`。独立 v0.1.9 通过 `--source` 固定此 SHA，GitLab `4f8302b2e1b738106f8df4bf4513075c96fdb99d`，release `01a15561-f631-7000-8b27-31bfebf1a813`，journey `01a15561-f784-7000-a043-138a292c5604` succeeded；实际镜像 `sha256:6261d16d18bfb0cc2ee256c111c272fe96923f658854210134ece78ee2849c10` Ready、零重启、无 OpenCode。旧 v0.1.8 预览已正常下线，正式 AW 与 snake 运行状态另核对，见 [部署回执](evidence/hosted-priority-deployment.json)。

第十二轮 task `01M5APJPEBEYM8RSTDH0VGC0V5`、initial run `01M5APM3F2TFS750SYEFECDJG7`、clarify `01M5APVBG2GECFM5MZ4YMV2X47` 的 [原始问题](evidence/hosted-twelfth-initial.json) 已转向问题优先级、成功信号和可行证据。证据题是 multi，既有记录明确“若可用”，抽样不代表整个周期；分类单层、没有无依据的推荐。剩余错误为成功信号题：几个可同时成立的标准仍被做成 single，题目也没有声明仅选择“首要标准”，因此 AC09 仍未通过。

后续只收敛这一约束：选定一个优先目标不会使兼容的成功标准或证据来源互斥；单选必须明确自己在选“首要标准”。完整 multi 示例改为两个可同时成立的成功标准，并保留基线和证据的局限；来源可用性与抽样约束继续在共享指导和真实样本中核对。全部初始模式与双库追加接线回归同步，parser 和原 3350 组合预算保持（当前含引号估算 3293）。不重试旧候选挑选成功样本，新候选继续相同场景验收。

### 2026-10-19：第十三轮初始通过，追加验证办法仍需拆分

`7814999e1` 的 [CI 39301151416](https://github.com/wangbinquan/agent-workflow/actions/runs/39301151416) 与 `cf4f93cc8b0292af3bcda18830ca3c24e3f8014e` 的 [CI 39304555141](https://github.com/wangbinquan/agent-workflow/actions/runs/39304555141) 均终态 **49/49 success**，分别见 [781 回执](evidence/ci-7814999e1.json) / [cf4 回执](evidence/ci-cf4f93cc8.json)。

cf4 首次发布 v0.1.10 在前端 transform 时因 BuildKit transport EOF / graceful_stop 失败，同秒共享 BuildKit 旧进程退出 137 后恢复 Ready；没有源码编译错误，退出的更深原因尚未确认，没有调整共享构建设施。随后同一 GitLab `97131190e52b24a04306fe792aad99d8b30571a9`、0 file actions 正常重建 v0.1.11 成功，release `01a1557f-9193-7000-a0bd-e8030552cdd3`、journey `01a1557f-92a6-7000-8ec3-1ed24fec6790` succeeded，实际镜像 `sha256:1c9e04c3f154de9b5f8966e626d97c019abb7c8837a517e7f2ec5810683a0dbc` Ready、零重启、无 OpenCode；旧 v0.1.9 预览正常下线，受保护 AW/snake Pod 均 Ready。见 [失败回执](evidence/hosted-criteria-build-interruption.json) / [实际部署](evidence/hosted-criteria-deployment.json)。

task `01M5ARC2998JZV9T3NWSC4QNJV`、初始 run `01M5ARDMRQ7JDV6HEHCYZ9HS4X`、clarify `01M5ARN8AGWV1XW4YWVWJY238N` 沿用原输入与 `opencode-go/deepseek-v4.1-flash`。三个初始问题通过：优先目标 single，成功标准与证据来源 multi，可用性与抽样局限明确，没有无依据推荐。通过实际 UI 将优先方向标为暂定、成功标准已决定、证据未标注；复核保留原话、未知与负责人空值，并在追问运行时阻止最终提交，见 [复核截图](evidence/hosted-thirteenth-review.png)。

使用产品自带“检查依据”原指引发起 `d6ba0921-1338-4961-95ca-f6a1466b2304`，期间完成另外两题；真实托管调用成功追加三题，原答案保留。追加题的“每天全时段 / 只记高峰 / 即时上报不逐日登记”把观察范围与登记时机混成 single，复核题又把未改善或数据不足直接推成方向需调整，宽定义标签还依赖前项。因此 AC09 **仍未通过**，没有用自定义答案纠正后宣称模型通过。原始问题、三份已确认回答和冻结执行见 [第十三轮证据](evidence/hosted-thirteenth-questions.json)，任务留待人工处理供审计。

窄范围修复明确证据来源、覆盖时段和登记时间分别决定，周期记录与即时上报可兼容，复核信号不证明因果或自动改变政策。完整参数示例改为观测时段，并在两项说明中都保留“记录时机另定”；去除模板 JSON 的多余缩进以维持原 3350 组合预算（当前含引号 3264），没有修改普通问答示例、schema 或解析规则。八种初始提示及双库 generator 的对应回归已写齐，继续集中静态核对、精确发布和同场景真实验收。

### 2026-10-19：第十四轮内容通过、原工作区恢复与最终闭合

生产候选 `393ecaea3480dcad194b270e249846606416d9a8` 的 [CI 39309459542](https://github.com/wangbinquan/agent-workflow/actions/runs/39309459542) 已终态 **49/49 success**，见 [完整 job 回执](evidence/ci-393ecaea3.json)。独立 v0.1.12 固定此源码，经 GitLab `0527b58c2bda8a22bc355c5a0926fe111a83bdf9`、release `01a15597-d675-7000-8b17-222e1c1650ed`、journey `01a15597-d76a-7000-8a52-1b494cc407e5` 正常构建和启用；实际镜像 `sha256:0a4bae8551376e20f9efc1e9b4a40187484370253747042ad99ddbab07f04965` Ready、零重启、控制面无 OpenCode。本项目旧 v0.1.11 预览正常下线，正式 AW 与 snake 的独立保护检查保留，见 [部署回执](evidence/hosted-validation-axes-deployment.json)。

task `01M5ASX4NM3XQS5KG2JTMQ2FGH`、initial run `01M5ASYFZ53DQ7KBEENBGEAPRX`、clarify `01M5AT6VDP6E11BKGH265JKXF0` 使用原无基线场景和同一真实模型。初始题分别选择问题优先级、可并用的证据来源和复核责任，没有无依据推荐或假造基线。选择产品原有“检查依据”默认指引后，request `93c0dbed-38aa-44b2-b8a6-c4889963743a` 追加关键假设、最有力反例及低成本证据三题；两项 single 明确选择主要假设或最强反例，兼容证据使用 multi，缺失记录和抽样局限明确，没有再混合覆盖范围与登记时间，也没有把复核等同于政策变更。三个旧回答保留、三个新题挂在原分支。本样本 AC09 通过，见 [未改写的题目与逐项评价](evidence/hosted-fourteenth-questions.json)。

分类原数据并非全部单层：两个二段路径由已实现的单链显示压缩合成一张卡片，目录仍保留完整路径，[实际全景](evidence/hosted-fourteenth-initial-map.jpg) 对此分别留证。初始某项将主观反馈写成“不能当作改善效果的证据”，表述偏绝对；主观反馈仍可支持体验判断。这一模型措辞局限保留，不据此承诺所有生成问题都可靠，也不把提示串断言当作语义保证。

实际 UI 完成六题：1 暂定、1 已决定、4 未标注，负责人空值与具体日期 TBD 保留。[提交复核](evidence/hosted-fourteenth-review.jpg) 明示缺少验证负责人，并允许按原停止权提交。19:43:38Z 进入最终生成前，原父工作区报告 `hosted-workspace-unavailable` / `容器不存在`；六个答案已成功封存，模型尚未启动。平台评估确认原卷 `92f5ab20-5f15-498b-9137-f904c61d58f0` 完好，通过正常 `rebuild-workspace` 请求 `01a155b2-588c-7000-986f-ab79cee0fa1c` 恢复同一父任务，generation 2 → 3，19:45:40Z 成功；应用随后自动续跑。首次只读观察发生在平台成功后约 700ms，应用当时尚未消费回执，这个中间态保留；没有重复恢复或重建业务任务。最初容器消失的根因未确定，没有修改他人平台代码。

恢复后首次模型返回缺少 `<workflow-output>` envelope，自动续会话又因“原会话执行资源尚未停止”被平台拒绝；原流程随后按配置进行 process-retry。这两条运行失败及 `envelope-missing` / `runtime-stream-interrupted` 原错误均保留，没有手动反复重跑挑选文档。

同一 task 于 `2026-10-19T20:00:23.595000+00:00` done，output run `01M5AW0DYR7HATDWE2J2WFKA0H`。原问题与六个封存答案在恢复前后完全相同；[实际最终文档](evidence/hosted-fourteenth-output.md) 逐项核对原话、三种成熟度、未知、接受的代价、未定负责人及两周后复核。本会话阅读全文逐项复核通过；不把 task done 单独视为内容正确。见 [执行、封存与恢复证据](evidence/hosted-fourteenth-journey.json)、[任务完成](evidence/hosted-fourteenth-task.jpg)、[结果界面](evidence/hosted-fourteenth-output.jpg)。早先单机与托管 AC05/AC10/AC12 通过证据继续有效，本轮补齐最新候选的内容闭合。

第十三轮含已确认答案，自动审批拒绝取消该任务，理由是可能影响非平凡应用状态；本会话保留原任务供审计，未改用其他渠道取消。所有历史失败、中断和取消的 CI 继续保留。当前 RFC 按 AC01～AC12 实现与验收范围关闭；这不是对真人思考深度或责任落实效果的研究结论。收口提交只更新文档及证据，远端提交的最终 CI 与同步状态在交接时另核对。

## 7. 验收逐项对账

| 标准            | 当前证据与结论                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC01 起步       | 实际模板选择已有 Agent、校验应用、4 节点/4 边、真实启动通过；无合适 Agent 的分支由自动化覆盖。                                                                              |
| AC02 全景       | 实际原答案摘要/成熟度、业务标题、分支定位与目录操作通过；大图与分类路径由 E2E 覆盖。                                                                                        |
| AC03 成熟度     | 实际设置 decided/provisional/未标注、编辑使确认失效、刷新后仍保留通过；原确认 hash 兼容由 shared 覆盖。                                                                     |
| AC04 主动追问   | 原引用与具体指引、快捷提示只填不发、在途继续作答、取消、协议失败、刷新恢复、重试及真实分支追加通过。                                                                        |
| AC05 两形态执行 | 单机真实 OpenCode 通过；托管控制面无 OpenCode，600000ms 的真实远程追问成功，冻结 registration/revision 与观测 runtime/task 归属核对通过，见 hosted-completed-journey.json。 |
| AC06 数据贯通   | 原始字段在实际编辑、刷新、封存及输出引用中逐字贯通；协作/归属/双数据库/部分锁定由自动化覆盖。生成内容的解释一致性见 AC10。                                                  |
| AC07 提交复核   | 实际复核原答案、全部五类决定补充、成熟度与定位修改通过；第三、四轮缺少负责人实际显示警告并允许推进，失败提示另由自动化覆盖。                                                |
| AC08 提交语义   | 实际 self + stop 单次提交与任务续跑通过；continue/cross、保存错误、部分锁定和在途阻断由自动化覆盖。                                                                         |
| AC09 问题内容   | 第十四轮初始与追加实际内容通过；原子取舍、兼容多选、条件描述和分类显示分别对账。保留主观反馈措辞局限，不保证每次生成。                                                                  |
| AC10 最终文档   | 第五轮单机、v0.1.3 托管与第十四轮最新原文均通过：保留原话、三种成熟度、代价、未知、未定负责人/复核；失败样本保留，不概括为每次模型输出必然正确。                                     |
| AC11 可用界面   | 桌面、390/320px、浅/深色、键盘与文本选择实际检查通过；5000 节点/深度 100/300 同级规模由 E2E 覆盖。                                                                          |
| AC12 完整旅程   | 单机和托管均已从起步完成真实追问、编辑/刷新/复核/最终输出及 task done；task/run/output 和真实界面分别留证。                                                                 |

自动化覆盖的“通过”以相应候选确切 SHA 的终态为准。生产候选 `a550f5a3e` 和首批验收记录 `19347b3be` 已完整成功；后续 `54d485de4`、共享基线 `a6c05417b` 与清理提交 `bf99a2dfd` 的失败分别保留；后继 `0c266dbcce` 已为 49/49 success。最新生产候选 393ecaea3 的 CI 已终态 49/49 success，AC09 及最新真实最终文档亦已闭合。RFC-378 Done；历史失败不改写为通过。

## 8. 实际界面证据

- 第十四轮最新候选：[全景](evidence/hosted-fourteenth-initial-map.jpg)、[提交复核](evidence/hosted-fourteenth-review.jpg)、[任务完成](evidence/hosted-fourteenth-task.jpg)、[结果预览](evidence/hosted-fourteenth-output.jpg)。

- [第三轮提交复核：缺失责任人明确提示](evidence/third-review-missing-owner.png)。
- [第四轮最新候选：复核](evidence/fourth-review.png)、[任务完成](evidence/fourth-completed-task.png)、[实际文档](evidence/fourth-output-preview.png)。
- [第三轮实际最终文档](evidence/third-output-preview.png)。
- [第二轮最终文档：三种成熟度分开](evidence/second-output-preview.png)、[任务实际完成](evidence/second-completed-task.png)。
- [桌面原话复核](evidence/second-review-desktop.png)、[390px 浅色](evidence/review-390-light.png)、[320px 深色](evidence/review-320-dark.png)。
