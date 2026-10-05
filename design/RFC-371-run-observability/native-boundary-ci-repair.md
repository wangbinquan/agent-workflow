# 原 Task finalizer 的公开边界补正

`ad4467631` 的 exact CI 在原 RFC-317 R1 入站守卫失败：本会话给旧 `services/runner.ts` 新增了 Task application 层的直接 import。后继将同一个 finalizer 经 Task 的 exact `public/participants` 入口提供，Runner 只改 import 地址；实际函数身份、参数、逐页到 EOF、历史修订、已提交 partial 数字投影及业务结算全部保持。新增回归核对公开出口与原函数身份相同、Runner 只引用正式公开入口且没有原 private import。

不增加 R1 债，不修改原 R1/R2 分类器、旧数组、规则、assertions 或预算。该入口无数据库／文件／进程环境参数，继续消费现有原 capture 与 observation participant。原 SOURCE13 的 before snapshot 与收据补正内容不变；本片四路径单独有限检视后与对应匹配清单一起提交。两 RFC 的默认 producer、恢复／多 root、CS 平台 v2 与实际规模／页面验收仍开放。
