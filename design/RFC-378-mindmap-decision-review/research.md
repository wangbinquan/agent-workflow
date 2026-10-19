# 2026-10-18 真实体验与设计依据

## 1. 现场

- 实例：http://agent-workflow.cs.localhost
- task：`01M58Y88V382560PC14KHCS8BQ`
- workflow：`01M58XVV5MWW5EG4Y25M75ETBJ`
- agent：`01M58XYKR7VGDH31THKB7H5RFH`
- clarify node run：`01M58YGYX5Z0HBCM5VZ7A4Z1N3`
- final continuation：`01M58YVDP0JM0RXJCYFB7TV543`
- 源码核对基线：`293c1951fc1c56afcef9bb8ddb42d0d300b1308d`；部署镜像与源码基线分别记账。
- 场景为虚构 UX 讨论，不实施会议室系统。四个问题由真实模型生成，四个自定义答案经实际 UI 确认提交。

## 2. 观察

良好行为：切换全景/聚焦保留答案；修改回答撤销确认；刷新恢复草稿与确认；失败追问保留回答；最终运行 prompt 保留四段用户原话。

缺口：四题对应根+两层分类+问题共 13 个节点；根显示内部 node ID；全景不显示已选回答；未知回答与有依据的答案均显示绿色确认；推荐在无数据时断言主要损失，预约选项捆绑四项独立规则，验收单选排斥本可同时成立的指标；停止反问弹窗没有决策摘要。

两次追问失败日志：

```text
2026-10-19T02:08:41.612Z clarify-followup-spawn-failed: binary failed to start: Executable not found in $PATH: "opencode"
2026-10-19T02:09:44.732Z clarify-followup-spawn-failed: binary failed to start: Executable not found in $PATH: "opencode"
```

调用路径是 `postgresqlDaemonApplication.ts` → `composeClarifyFollowupGenerator` → 固定 `composeLocalSystemAgentRunFamily`。同入口已有 `input.systemAgentRunFamily`，其他 System caller 已接；现有托管 factory 可复用。

截至上一轮 2026-10-19 02:23:45 UTC，最终续跑自 02:12:14 开始仍无事件/输出；本轮开始后浏览器再次显示运行中/输出 0。尚未查明续跑缺口，不能把澄清提交成功记作完整完成。

## 3. TreeLearn 参照范围

用户提到项目名但未提供链接，当前参考候选为 [EfficiencAI/TreeLearnClient-v2](https://github.com/EfficiencAI/TreeLearnClient-v2)。核对了官方 README、ChatArea.tsx、NodeContextMenu.tsx，未安装或运行客户端，不宣称其真实用户效果。

- [项目说明](https://github.com/EfficiencAI/TreeLearnClient-v2)：树状对话、任意节点分支、节点导航。
- [节点菜单](https://github.com/EfficiencAI/TreeLearnClient-v2/blob/development/src/renderer/src/components/Chat/NodeContextMenu.tsx)：提问、追问、重问。
- [ChatArea](https://github.com/EfficiencAI/TreeLearnClient-v2/blob/development/src/renderer/src/components/Chat/ChatArea.tsx)：节点预览同时包含用户问题与 AI 回答；选中文字可成为追问上下文；未选则沿整个回答。重问会删除子分支，这个行为不复制到 AW 的已保存决定记录。

借鉴点是用户主动选疑点、沿分支探索和在图上看到内容。AW 的任务是澄清并推进工作，需要额外保存暂定、依据、代价和复核安排；分支更多不等同于思考更深。

## 4. 仓内复用点

- `packages/frontend/src/lib/workflow-starters.ts` 和 `components/workflow-editor/WorkflowStarterDialog.tsx`：原模板、预检、候选验证与应用流程。
- `components/clarify/QuestionForm.tsx`、`mindmap/MindmapWorkspace.tsx`、`MindmapQuestionPane.tsx`：现有统一答案正文与导航。
- `Dialog`、`Form`、`Segmented`、`Select`、`StatusChip`、`ErrorBanner`：正式实现的公共原语。
- `packages/shared/src/clarifyMindmap.ts`：确认依据、同轮上下文、分类投影合同。
- `schemas/clarify.ts`、`schemas/resourceAcl.ts`、`clarify.detail.tsx`、`clarifyRounds.ts`、`clarify/service.ts`：所有字段复制与归属比较必须成套更新。
- `createCrewStationSystemAgentRunFamily` 与入口已选 `systemAgentRunFamily`：执行设施复用，生成器不选择部署形态。

## 5. 设计验证边界

原型使用上述场景演示，模拟追加问题与结果并明确标识。其可操作性只证明交互方案，实际模型的反问质量、托管调用与最终文档必须由正式候选的真实任务再次证明。
