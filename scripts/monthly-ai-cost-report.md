# 团队 AI 费用月报

在 9router 项目里说「出 2026-12 的团队 AI 费用月报」，附上当期独立账号的使用人、平台、实际人民币费用，以及新增、停用、赠送额度或特殊账单等变动。默认使用北京时间上一个完整自然月。独立账号按本期确认的名单录入。

## 采集

优先用已登录的 9router 管理面板会话读取 `GET /api/usage/platform-estimate?month=2026-12`，将响应 JSON 保存为本期用量文件。接口返回按名称的 `byName` 和平台明细、总调用和启用账号计数。`byName` 中的 `callShare` 和 `estimatedCostShare` 分别为调用占比和预估费用占比，以 0 至 1 表示。可重复传 `excludeProvider` 排除指定平台。使用 `startDate` 和 `endDate` 指定含首尾的北京时间日期，也可省略查询参数取上一个完整自然月。

部署版本暂无该接口时，可用下面的数据库采集方式。出报告时的 `--usage` 接受上述接口响应或数据库导出的 JSON。

在数据所在主机用 Python 3.8 或更高版本，只读查询正在使用的 9router SQLite。根据部署配置确认真实挂载路径。导出的 JSON 只包含按 Key 显示名和平台聚合的成功调用次数、API 美元折算、启用账号的套餐计数及统计日期。

```bash
python3 "scripts/monthly-ai-cost-report.py" collect \
  --db "/path/to/9router/db/data.sqlite" --month "2026-12"
```

已有 SSH 权限时，可把脚本传给数据所在主机执行。先创建项目下的 `.run/monthly-ai-cost-report/` 目录。

```bash
ssh "<host>" 'python3 - collect --db "/path/to/9router/db/data.sqlite" --month "2026-12"' \
  < "scripts/monthly-ai-cost-report.py" > ".run/monthly-ai-cost-report/2026-12-usage.json"
```

复核非自然月报告时，用 `--start "2026-10-28" --end "2026-11-26"` 指定两个包含端点的日期。在结果中核对统计区间和账号快照日期。

## 费用输入

共享定价沿用 `.run/monthly-ai-cost-report/platform.json`。其中 `shared` 按平台配置 `plan` 和 `unit_cny`，`any` 表示按该平台全部启用账号计数。`zero_cost` 记录赠送额度、免费次数和暂不计费的口径，`exclude` 列出本期排除的平台。新工作区按现有实际口径初始化这份本地配置。

Codex 共享账号按启用的 Plus 计数，Kimi 按启用账号计数。套餐来自 9router 保存的账号信息。核对历史账期、账号转给个人、停用后仍发生本期扣款，或套餐识别不全时，从配额页或已确认账单确定本期实际共享账号数，填入当期的 `platform_counts`。独立账号与共享账号各记一次。

每月另存一份补充信息，例如 `.run/monthly-ai-cost-report/2026-12-extras.json`。示例中的账号名和金额为占位。

```json
{
  "independent_accounts": [
    { "name": "成员姓名", "provider": "codex", "amount_cny": "100.00" }
  ],
  "platform_counts": {},
  "platform_bills_cny": {}
}
```

`name` 使用网关显示名。`platform_counts` 用于覆盖特定平台的共享账号数，`platform_bills_cny` 用于加入按量平台的已确认人民币账单。填写按量账单时，在本地配置检查该平台属于报告范围。

本地平台配置示例。

```json
{
  "shared": { "codex": { "plan": "plus", "unit_cny": "120.00", "label": "Codex Plus" } },
  "zero_cost": { "openai": "赠送额度" },
  "exclude": []
}
```

## 出具 Word

使用工作区内已有 `python-docx` 的 Python。报告含平台费用汇总、按名称列示的「共享平台预估费用」和末页「人员实际费用汇总」。

```bash
"<python-with-python-docx>" "scripts/monthly-ai-cost-report.py" report \
  --usage ".run/monthly-ai-cost-report/2026-12-usage.json" \
  --extras ".run/monthly-ai-cost-report/2026-12-extras.json" \
  --output ".run/monthly-ai-cost-report/2026-12-团队AI费用月报.docx"
```

- 共享费用按各名称在对应平台的 API 折算费用占比分摊，各平台分别对账。独立账号金额直接归到使用人。共用分摊正金额在额度内至少记 0.01 元。
- 按 Key 显示名列项，无可匹配名称的调用汇总为「AI 测试费用」。有成功调用的名称均列出，包括金额为零的记录。
- 「共享平台预估费用」列出各名称的总调用、调用占比、美元预估费用和预估费用占比。预估费用按各模型的 API 价格和实际用量计算。总调用汇总报告范围内全部 API，包括免费调用。末页总费用占比的分母为全部已确认人民币费用。表头的列名与单位放在同一行。
- 没有调用的已付独立账号或缺少折算权重的共享费用计入首页「未分摊费用」。无计费依据的平台标为「待核」。

交付前核对账号数量、统计期、人民币总额、人员分摊和占比。采集文件、当期补充信息和报告均放在 `.run/`。
