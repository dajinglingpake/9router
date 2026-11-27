# 部署规则

- 以后部署只使用用户的 `scripts/upgrade-remote-9router.sh`，不得另行生成、维护或运行额外的部署脚本。
- 直接运行该脚本完成构建、镜像上传、配置同步和容器更新，不在脚本外手动构建或跳过构建；构建需包含现有 Codex CLI 和账号申诉浏览器运行时。
- 部署时同步本地 `compose.yaml` 到远端，以本地部署配置为准，不再叠加历史 Compose 覆盖文件。
- 部署所需的配置调整应直接修改现有本地配置；不得用临时脚本或远端额外覆盖配置绕过上述规则。
- 部署保留远端挂载目录中的账号、组合、API Key 和其他业务数据；同步部署配置不等于覆盖业务数据库。
- 常规部署不额外生成数据库备份、配置副本或部署快照。

# 团队 AI 月报

- 用户要求生成或更新团队 AI 费用月报时，按 `scripts/monthly-ai-cost-report.md` 采集 9router 用量并生成 Word。平台计费口径沿用本地配置，独立账号与例外按本期确认信息录入。

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
