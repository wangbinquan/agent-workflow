# RFC-371 真实 System 调用的运行时和启动身份

状态：修复候选，未完成全类型验收。真实任务、原生记录、完整报告、页面和 hosted CI 分别验收；历史失败记录保留。

## 实际缺口与修复

独立 Intent 原调用有五条 stream 用量，共 91,246 Token，但 SQL 运行时投影遗漏已选择注册的身份，未建立原生采集和冻结人民币费率。投影追加原 `runtimes.id` 和 `probeFence`，按原运行时 registry 的语义生成 `observationIdentity`。`probeFence` 就是已有 configurationRevision，不增加列或新版本来源。原禁用运行时的已选执行和未注册名称的内置回退保持；回退没有注册身份，不编造身份或价格。

探针、MCP 首次和续接的真实进程已有 PID、退出及排空事实，但原 managed process 的 launchNonce 为 null。它只在 requireSpawnReceipt 时由原进程机制生成；这些入口只传了原生进程 observer。物理执行 binding 在选择任一原生 observer 时启用已有 required receipt，复用原 managed process、nonce、PID、落库和终态回调。无 observer 的旧调用行为保持。完整性 verifier 的原条件不变，不补写历史记录、不将缺失 nonce 判为完整。

原双 provider Intent SQL 回归追加实际运行时查询的身份及回退断言。原 System native 回归追加不显式提供 requireSpawnReceipt 的真实子进程，读取全部 422 条原生记录、两个实际根和四类 Token；三个旧 case 和各 120 秒预算保持。其一处 `new Database` 只构造外部 OpenCode 的固定 SQLite 文件，AW 来源、账本、续接和 CNY 使用两个真实 provider。W5 原调用点清单追加这一条，复用原 real-file-database 分类，不增加例外或修改分类判据。

## 已完成的真实对账

以下三类记忆均从正式产品入口触发，报告全部 14 区段以每页一条读取到真正 EOF，与原生唯一 part ID、四类 Token 和冻结人民币费率逐条核对。缓存写 0 是本次模型实际观测值。验收费率不代表供应商账单。

| 来源           | 原任务/Job ID              |  输入 | 缓存读 | 缓存写 |  输出 |   合计 | 验收人民币估值 |
| -------------- | -------------------------- | ----: | -----: | -----: | ----: | -----: | -------------: |
| Agent 执行记忆 | 01M4D0EQFYB4XCTT49THJSG4H4 | 5,388 |  6,144 |      0 |   204 | 11,736 |      ¥0.015480 |
| 任务执行记忆   | 01M4D0ESNF0T4S2RJRZES6FD24 | 4,817 |  6,144 |      0 |   531 | 11,492 |      ¥0.016954 |
| 用户反馈记忆   | 01M4D4TFBNGAETKP9KJACY321W | 4,787 |  6,144 |      0 | 3,582 | 14,513 |      ¥0.041302 |

前三份报告分别为 `66290085-fbd3-49d5-b2fa-fa1b501db7e4`、`324a16a1-b87d-450b-82f0-176d8d58fb65`、`b73ebe0e-dadb-4fe0-bf5a-708388a1b1aa`，均 ready。反馈提取完成后唯一临时 memoryDistillRuntime 选择已恢复为原 null 并正式读回验证；候选记忆未审批发布。

反馈前的成功 Loop 父报告 `f163e562-e989-4088-819f-09d79bb7cb55` 已把主调用和前两类关联记忆各计一次：三个唯一 step，输入 15,093、缓存读 16,384、缓存写 0、输出 835，共 32,312 Token，¥0.045058。该保留快照不包括随后新建的反馈调用，新反馈后的父汇总另验。

## 继续验收

修复后须重新实际执行 Intent、探针、MCP 首次/续接，证明原始启动身份与 native capture 完整、CNY 逐条一致；旧不完整报告继续显示已知量与缺口。还要验证工作组及其系统 orchestrator、技能融合、评审/澄清失败与重试的已知量和父汇总，以及 Git、提交、冲突和各数字员工入口。Git/数字员工的本机 demo 产品分支/提交/推送操作仍按已准备的具体审批方案等待明确答复，不用开发用工作树绕过共享 main 规则。

独立实现门、原 canonical 投影与匹配、精确提交、GitHub 全部相关功能作业、正式页面和 CS 部署另验。原 239 source / 233 active / 6 archive-only 的 schema contract 由原生成器更新；全部旧 223 个表对象保持，仅追加 16 张 System 表。RFC 未完成。
