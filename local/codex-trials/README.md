# Codex 账号测试

入口：`/dashboard/diagnostics?tab=trials`，与请求分析共用“请求诊断”模块。原 `tab=pelicans` 链接仍可打开。

- 默认 `gpt-6.1-sol` / `xhigh`，默认提示词保留鹈鹕骑自行车动画文案，可自由修改提示词、模型与推理强度。后台默认同时执行 2 个任务，其余自动排队，界面无需选择账号数量。
- 一键测试所有 Codex 账号，包括禁用账号；不修改启用状态。每张卡也可单独重测。
- 在现有 9router 容器内临时启动真实 `codex exec`，写出 `index.html` 后退出。无额外容器、常驻 CLI 服务或依赖包。
- CLI 通过 `http://127.0.0.1:$PORT/v1/responses` 访问 9router，使用任务专属临时凭证固定账号和模型。真实账号凭据不交给 CLI。保留原有代理、刷新令牌、请求间隔、并发、错误冷却和诊断日志；试用不做账号切换或额度降级。
- Codex 使用独立 HOME / CODEX_HOME，不加载宿主配置、认证或项目指令。默认开启 CLI 沙箱，模型执行的工具只可写本次工作目录、读取最小系统运行文件及 CLI 运行时，禁止工具联网。CLI 本身仍可连接 9router。
- 任务在服务端执行，关闭网页不影响运行。停止、失败、完成、15 分钟超时后退出 CLI，清理本次工作目录。
- 运行中在账号卡片直接显示 CLI 文字、命令、文件变更和错误，每秒刷新；显示最近输出时间与当前活动。可打开“执行输出”查看完整记录和原始 JSONL。文本及原始日志各保留最近 64 KiB 字符，每秒最多持久化一次，结束后随结果保存。
- 结果保存至 `DATA_DIR/codex-trials/<connection-id>.json`，原子替换，刷新和重启后保留。重测立即清掉该账号旧作品，失败只展示错误。服务重启时未完成任务标记中断，不自动重跑。
- HTML 预览使用无同源权限的 sandbox iframe，并通过 HTTP CSP 禁止网络、嵌套页面、表单和跳转。可下载原始 HTML。
- 展示原始 HTML 行数。预览以 1280×800 的初始视口渲染，通过隔离 iframe 的尺寸消息自动适配内容，再等比缩小到卡片内，隐藏预览滚动条。尺寸报告脚本和样式只注入预览响应，不修改持久文件或下载内容。
- 速率为 CLI `turn.completed.usage.output_tokens / 总耗时`，不估算缺失 token；总耗时包括思考、排队与文件生成。中转错误按失败 HTTP 请求 / Responses 流计数（同一请求最多一次）；CLI 错误另列。诊断中的请求统计与整次 CLI 任务统计口径不同。
- 点击“中转错误”数字，直接打开现有请求明细，按账号、模型和本次测试时段筛选失败尝试，可展开查看错误原因、HTTP 状态、请求 ID 和重试信息。

## 文件与上游合并

主要实现均为新增独立文件：

- `src/lib/codexTrials/`：进程生命周期、批量队列、持久结果。
- `src/sse/local/codexTrialSession.js`：短期路由会话及指定账号凭据。
- `src/app/api/codex-trials/`：受现有 Dashboard 鉴权保护的接口。
- `src/app/(dashboard)/dashboard/diagnostics/CodexTrialsPanel.js`：独立界面。
- `src/shared/utils/codexTrial.js`：默认参数及预览策略。

仅三个现有文件有小接入点：诊断 `page.js` 加页签，`src/sse/local/chat.js` 接受临时会话，`src/sse/local/modelRouting.js` 固定账号。没有修改 `open-sse`、账号管理界面、数据库结构或依赖清单。

## 本地容器部署

先按项目原方式构建包含上述源文件的 9router 镜像，命名为 `9router:codex-trial-base`。然后使用本目录 Dockerfile 为该镜像加入已安装的 Codex Linux 运行时。当前验证版本是 `codex-cli 0.163.0`，需要支持命名权限配置和 `--ignore-user-config`。

```sh
docker build -f "local/codex-trials/Dockerfile" \
  --build-context "codex-runtime=/absolute/path/to/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl" \
  -t "9router:codex-trial-20261019" "."
```

容器沿用原数据卷与端口。默认沙箱模式要求宿主机内核启用用户命名空间（`/proc/self/ns/user` 存在）；不支持时界面会显示原因并禁用测试，避免发起模型请求后才失败。Linux 上 CLI 的 bubblewrap 沙箱需要创建用户命名空间；本机 Docker 默认 seccomp / AppArmor 阻止该操作，需要在此容器 compose override 设置：

```yaml
services:
  9router:
    image: 9router:codex-trial-20261019
    init: true
    security_opt:
      - seccomp=unconfined
      - apparmor=unconfined
```

这会放宽这个容器的 Docker seccomp / AppArmor 层，以运行 CLI 自身的文件系统与网络沙箱；不修改宿主机全局策略，不使用 privileged。`init` 用于回收退出的工具子进程。

对于未启用用户命名空间的群晖内核，可在管理员明确接受容器内文件和网络访问权限后，使用以下独立 override：

```yaml
services:
  9router:
    image: 9router:codex-trial-20261019
    init: true
    environment:
      CODEX_TRIAL_UNSANDBOXED: "true"
```

此开关仅为账号测试进程添加 `--dangerously-bypass-approvals-and-sandbox`，无需放宽 Docker seccomp / AppArmor。模型请求仍固定连接本容器的 9router；独立工作目录、实时输出、超时和退出清理照常工作。生成的命令可访问容器内的数据，HTML 浏览器预览仍保留 iframe 沙箱与 CSP。未设置该变量时继续使用 CLI 沙箱。

运行时可用 `CODEX_TRIAL_CLI` 和 `CODEX_TRIAL_RUNTIME` 指定 CLI 可执行文件和只读运行时目录。CLI 访问端口读取现有 `PORT`，默认 20128。测试页不会自动发起模型请求，需要用户点击开始。
