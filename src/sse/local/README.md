# 本地请求策略

本地 API 路由从本目录导入聊天和认证入口。`src/sse/handlers/chat.js` 和
`src/sse/services/auth.js` 保留上游实现，便于后续合并。

- `chat.js`：请求解码、API Key 校验和进入账号调度前的短期排队。
- `modelRouting.js`：组合的账号专属模型、会话绑定、并发队列、冷却重试和流结束释放。
- `requestContext.js`：请求标识、调用方归属和并发监控元数据。
- `accountSelection.js`：按容量选择账号、选择预占和会话账号绑定。
- `accountHealth.js`：账号过载冷却、模型锁和成功后的健康状态恢复。
- `auth.js`：组合上述账号策略，复用上游 API Key 提取逻辑。

请求转换、OAuth 刷新和 Codex 请求格式继续由 `open-sse` 上游模块负责。
流量及完成状态监控放在 `open-sse/utils/localStreamMonitor.js`，流处理只保留调用点。
本地模型能力补充放在 `open-sse/providers/localCapabilities.js`，上游同名定义优先。
使用情况与告警共用 `src/lib/providerUsage.js` 的额度查询及凭证刷新逻辑。

合并上游后，检查新增 API 路由是否导入本地入口；将上游新增的请求选项和账号筛选条件
同步到本地调度调用点，不复制 Codex 执行器或翻译器。模型启用列表筛选同时检查
账号专属模型与 `[1m]` 上下文标记。

仓库只维护上游已有测试。本地策略通过隔离实例和临时验证脚本检查，
不在测试目录维护额外用例。验证上游 Codex 请求格式和流式完成行为可运行：

```bash
cd tests
./node_modules/.bin/vitest run unit/codex-gpt6-lite.test.js unit/openai-responses-completion-watchdog.test.js unit/v1-models-combo-context.test.js --maxWorkers=4
```
