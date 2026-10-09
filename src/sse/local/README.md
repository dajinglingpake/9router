# 本地请求策略

本地 API 路由从本目录导入聊天和认证入口。`src/sse/handlers/chat.js` 和
`src/sse/services/auth.js` 保留上游实现，便于后续合并。

- `chat.js`：请求解码、API Key 校验和进入账号调度前的短期排队。
- `modelRouting.js`：组合的账号专属模型、会话绑定、并发队列、冷却重试和流结束释放。
- `requestContext.js`：请求标识、调用方归属和并发监控元数据。
- `accountSelection.js`：按容量选择账号、选择预占和会话账号绑定。
- `accountHealth.js`：账号过载冷却、模型锁和成功后的健康状态恢复。
- `auth.js`：组合上述账号策略，复用上游 API Key 提取逻辑。
- `routingPolicy.js`：独立的 Codex 路由设置及默认值，不修改上游设置默认值。
- `accountBalancing.js`：新会话按负载选择账号，同负载轮询；旧会话保持绑定。
- `quotaRouting.js`：额度缓存、按额度池锁定、低额度切换模型和额度耗尽后的迁移判断。
- `comboRouting.js`：复用上游组合轮询、能力选择与失败回退。

在「设置 → Codex 账号路由」配置分配策略、额度耗尽迁移、低额度模型及阈值。
未配置时沿用原有账号分配策略，额度耗尽迁移和低额度模型切换默认关闭。
只有手动配置并保存后，新策略才生效；部署不写入或覆盖实例数据库中的配置。
启用低额度模型切换后，普通 Codex 5 小时或每周额度已用达到 90% 时，
后续请求使用同账号的 `gpt-6-luna`。额度恢复后回到客户端请求的模型。
降级模型须存在于模型注册表，并符合账号模型启用列表和上下文标记。
审查和 Spark 按各自额度池判断耗尽，不自动降级到普通 Luna。

仅在额度相关开关启用时查询额度并记录额度池锁，关闭时保留原有错误处理。
额度查询缓存一分钟并合并同时发生的查询，不依赖打开额度页面；
首次查询和过期刷新在账号选择锁外执行，失败时不沿用旧额度。
确认额度耗尽才迁移绑定，普通 429 限流和 503 过载仍保持原账号。
耗尽锁按额度池记录上游实际恢复时间，迁移重试先释放旧并发槽位。

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
