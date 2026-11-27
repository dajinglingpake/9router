import argparse
import base64
from collections import Counter, defaultdict
from contextlib import closing
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
import json
from pathlib import Path
import re
import sqlite3
import sys


CHINA_TIME = timezone(timedelta(hours=8))
TEST_NAME = "AI 测试费用"
LABELS = {"codex": "OpenAI Codex", "openai": "OpenAI API", "kimi": "Kimi",
          "codebuddy-cn": "CodeBuddy CN", "gemini": "Gemini", "nvidia": "NVIDIA NIM",
          "kilocode": "Kilo Code"}
CODEX_PLANS = {"free", "plus", "pro", "go", "team", "business", "enterprise", "edu"}


def report_dates(args):
    if args.start or args.end:
        if args.month or not (args.start and args.end):
            raise ValueError("请指定月份，或同时指定起止日。")
        start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    else:
        month = args.month or (datetime.now(CHINA_TIME).date().replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
        start = date.fromisoformat(f"{month}-01")
        end = (start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    if start > end:
        raise ValueError("起始日必须早于或等于结束日。")
    return start, end


def utc_boundary(day):
    return datetime.combine(day, time.min, CHINA_TIME).astimezone(timezone.utc).isoformat(
        timespec="milliseconds").replace("+00:00", "Z")


def normalize_plan(value):
    plan = value.strip().lower() if isinstance(value, str) else ""
    return plan if plan in CODEX_PLANS else None


def codex_plan(connection_data):
    # Mirror accountPlan.js for the local account inventory. Export plan names only.
    try:
        data = json.loads(connection_data)
    except (TypeError, ValueError):
        return "unknown"
    if not isinstance(data, dict):
        return "unknown"
    claims = []
    for field in ("idToken", "accessToken"):
        token = data.get(field)
        if not isinstance(token, str) or token.count(".") != 2:
            continue
        payload = token.split(".")[1]
        try:
            details = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
            auth = details.get("https://api.openai.com/auth") or {}
            plan = normalize_plan(auth.get("chatgpt_plan_type")) or normalize_plan(details.get("plan_type"))
            if plan:
                claims.append((float(details.get("iat") or 0), plan))
        except (AttributeError, TypeError, ValueError):
            continue
    if claims:
        return max(claims, key=lambda claim: claim[0])[1]
    saved = data.get("providerSpecificData") or {}
    return (normalize_plan(saved.get("chatgptPlanType")) if isinstance(saved, dict) else None) or "unknown"


def collect(path, start, end):
    bounds = (utc_boundary(start), utc_boundary(end + timedelta(days=1)))
    uri = path.expanduser().resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True, timeout=5)) as db:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        first, last = db.execute(
            "SELECT min(id), max(id) FROM usageHistory WHERE timestamp >= ? AND timestamp < ?", bounds
        ).fetchone()
        totals = defaultdict(lambda: [0, Decimal(0)])
        if first is not None:
            for name, provider, calls, cost in db.execute(
                """
                SELECT COALESCE(NULLIF(TRIM(a.name), ''), ?), COALESCE(NULLIF(u.provider, ''), 'unknown'),
                       COUNT(*), COALESCE(SUM(u.cost), 0)
                FROM usageHistory u NOT INDEXED LEFT JOIN apiKeys a ON a.key = u.apiKey
                WHERE u.id BETWEEN ? AND ? AND u.timestamp >= ? AND u.timestamp < ?
                  AND LOWER(TRIM(COALESCE(u.status, ''))) IN ('', 'ok', 'success', '200')
                GROUP BY 1, 2 ORDER BY 1, 2
                """,
                (TEST_NAME, first, last, *bounds),
            ):
                if re.search(r"(?:sk|rk|sess)-[a-zA-Z0-9_-]{8,}", name, re.IGNORECASE):
                    name = TEST_NAME
                entry = totals[name, provider]
                entry[0] += calls
                entry[1] += Decimal(str(cost))
        accounts = defaultdict(Counter)
        for provider, data in db.execute(
            "SELECT provider, CASE WHEN provider = 'codex' THEN data END FROM providerConnections WHERE isActive = 1"
        ):
            plan = codex_plan(data) if provider == "codex" else "any"
            accounts[provider][plan] += 1
    return {
        "start": start.isoformat(), "end": end.isoformat(),
        "account_snapshot_date": datetime.now(CHINA_TIME).date().isoformat(),
        "active_accounts": accounts,
        "usage": [
            {"name": name, "provider": provider, "calls": calls, "estimated_usd": str(cost)}
            for (name, provider), (calls, cost) in totals.items()
        ],
    }


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def usage_snapshot(data):
    if "period" not in data:
        return data
    if data.get("currency") != "USD":
        raise ValueError("平台预估费用接口应使用美元折算。")
    return {
        "start": data["period"]["startDate"], "end": data["period"]["endDate"],
        "account_snapshot_date": data["accountSnapshot"]["date"],
        "active_accounts": data["accountSnapshot"]["activeByProvider"],
        "usage": [
            {"name": row["name"], "provider": provider["provider"], "calls": provider["calls"],
             "estimated_usd": str(provider["estimatedUsd"])}
            for row in data["byName"] for provider in row["byProvider"]
        ],
    }


def cents(value):
    amount = Decimal(str(value)) * 100
    if not amount.is_finite() or amount < 0 or amount != amount.to_integral_value():
        raise ValueError(f"人民币金额需为非负且精确到分：{value}")
    return int(amount)


def allocate(amount, weights):
    denominator = sum(weights.values())
    if not amount or not denominator:
        return {}
    parts = {name: divmod(amount * weight, denominator) for name, weight in weights.items()}
    shares = {name: int(whole) for name, (whole, _) in parts.items()}
    order = sorted(parts, key=lambda name: (-parts[name][1], name))
    for name in order[:amount - sum(shares.values())]:
        shares[name] += 1
    for name, weight in weights.items():
        if weight <= 0 or shares[name]:
            continue
        donors = [other for other in shares if shares[other] > 1]
        if not donors:
            break  # The pool has fewer cents than positive weights.
        donor = max(donors, key=lambda other: (shares[other] * denominator - weights[other] * amount, other))
        shares[donor] -= 1
        shares[name] = 1
    return shares


def platform_costs(snapshot, profile, extras):
    pools = {}
    overrides = extras.get("platform_counts", {})
    if unknown := overrides.keys() - profile.get("shared", {}).keys():
        raise ValueError(f"共享平台计数缺少单价配置：{', '.join(sorted(unknown))}")
    for provider, rule in profile.get("shared", {}).items():
        plans = snapshot["active_accounts"].get(provider, {})
        plan = rule.get("plan", "any")
        if provider in overrides:
            count = overrides[provider]
        elif plan == "any":
            count = sum(plans.values())
        else:
            if plans.get("unknown", 0):
                raise ValueError(f"{provider} 有套餐未识别的启用账号，请先核对配额页并填写 platform_counts。")
            count = plans.get(plan, 0)
        if type(count) is not int or count < 0:
            raise ValueError(f"{provider} 的账号数必须是非负整数。")
        unit = cents(rule["unit_cny"])
        pools[provider] = (count, count * unit, rule.get("label", LABELS.get(provider, provider)),
                           f"{count} 个 × {money(unit)} 元")
    for provider, value in extras.get("platform_bills_cny", {}).items():
        if provider in pools:
            raise ValueError(f"{provider} 已按账号计费，请保留一种付款口径。")
        pools[provider] = (None, cents(value), LABELS.get(provider, provider), "平台账单")
    return pools


def calculate(snapshot, profile, extras):
    excluded = set(profile.get("exclude", []))
    totals = defaultdict(lambda: [0, Decimal(0)])
    weights = defaultdict(lambda: defaultdict(Decimal))
    calls_by_name = Counter()
    estimated_by_name = defaultdict(Decimal)
    for row in snapshot["usage"]:
        name, provider = row["name"], row["provider"]
        if provider in excluded or not row["calls"]:
            continue
        cost = Decimal(row["estimated_usd"])
        if not cost.is_finite() or cost < 0:
            raise ValueError(f"{provider} 有无效的 API 折算金额。")
        calls_by_name[name] += row["calls"]
        estimated_by_name[name] += cost
        totals[provider][0] += row["calls"]
        totals[provider][1] += cost
        weights[provider][name] += cost

    pools = platform_costs(snapshot, profile, extras)
    if excluded & pools.keys():
        raise ValueError("排除的平台不能同时计费。")
    own, own_by_provider = Counter(), Counter()
    for account in extras.get("independent_accounts", []):
        name, provider = account["name"].strip(), account["provider"].strip()
        if not name or not provider or provider in excluded:
            raise ValueError("独立账号需要有效名称及平台，并且平台须纳入报告。")
        amount = cents(account["amount_cny"])
        own[name] += amount
        own_by_provider[provider] += amount

    shares = {provider: allocate(pool[1], weights[provider]) for provider, pool in pools.items()}
    shared_by_name = {name: sum(values.get(name, 0) for values in shares.values()) for name in calls_by_name}
    shared_paid = sum(pool[1] for pool in pools.values())
    independent_paid = sum(own.values())
    paid = shared_paid + independent_paid
    displayed_shared = sum(shared_by_name.values())
    displayed_own = sum(own[name] for name in calls_by_name)
    return {
        "totals": totals, "calls_by_name": calls_by_name, "estimated_by_name": estimated_by_name, "pools": pools,
        "own": own, "own_by_provider": own_by_provider, "shared_by_name": shared_by_name,
        "paid": paid, "shared_paid": shared_paid, "independent_paid": independent_paid,
        "unallocated": paid - displayed_shared - displayed_own,
    }


def money(value):
    return f"{Decimal(value) / 100:,.2f}"


def usd(value):
    return "0.01" if 0 < value < Decimal("0.01") else f"{value:,.2f}"


def percent(part, total):
    value = 100 * part / total if total else 0
    return "<0.01%" if 0 < value < 0.01 else f"{value:.2f}%"


def render(snapshot, profile, result, output):
    try:
        from docx import Document
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from docx.oxml import OxmlElement
        from docx.oxml.ns import qn
        from docx.shared import Cm, Pt, RGBColor
    except ImportError as exc:
        raise ValueError("请使用已安装 python-docx 的本地 Python 运行 report。") from exc

    doc = Document()
    doc.core_properties.title = "团队 AI 费用月报"
    section = doc.sections[0]
    section.page_width, section.page_height = Cm(21), Cm(29.7)
    section.top_margin = section.bottom_margin = Cm(1.8)
    section.left_margin = section.right_margin = Cm(1.8)
    styles = doc.styles
    for style, size in (("Normal", 10), ("Title", 28), ("Heading 1", 21), ("Heading 2", 14)):
        font = styles[style].font
        font.name, font.size = "Noto Sans CJK SC", Pt(size)
        styles[style]._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), "Noto Sans CJK SC")

    def table(headers, rows, widths, left_columns=(0,)):
        tbl = doc.add_table(rows=1, cols=len(headers))
        tbl.autofit = False
        for column, width in zip(tbl.columns, widths):
            column.width = Cm(width)
        for index, values in enumerate([headers, *rows]):
            row = tbl.rows[0] if index == 0 else tbl.add_row()
            row._tr.get_or_add_trPr().append(OxmlElement("w:cantSplit"))
            if index == 0:
                row._tr.get_or_add_trPr().append(OxmlElement("w:tblHeader"))
            for col, (cell, value, width) in enumerate(zip(row.cells, values, widths)):
                cell.width = Cm(width)
                p = cell.paragraphs[0]
                p.paragraph_format.space_after = Pt(3)
                p.paragraph_format.space_before = Pt(3)
                if col not in left_columns:
                    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
                r = p.add_run(str(value))
                r.font.size = Pt(9.5)
                r.bold = index in (0, len(rows))
                if index == 0:
                    r.font.color.rgb = RGBColor.from_string("FFFFFF")
                if index in (0, len(rows)) or index % 2 == 0:
                    shade = OxmlElement("w:shd")
                    shade.set(qn("w:fill"), "183043" if index == 0 else "EEF5F5")
                    cell._tc.get_or_add_tcPr().append(shade)

    doc.add_paragraph("团队 AI 费用月报", "Title")
    doc.add_paragraph(f"{snapshot['start']} 至 {snapshot['end']}（北京时间）")
    doc.add_paragraph("平台费用汇总", "Heading 2")
    totals, pools, independent = result["totals"], result["pools"], result["own_by_provider"]
    zero = profile.get("zero_cost", {})
    total_usd = sum(row[1] for row in totals.values())
    providers = totals.keys() | pools.keys() | independent.keys()
    rows = []
    for provider in sorted(providers, key=lambda name: (-totals.get(name, [0, 0])[1], name)):
        calls, cost = totals.get(provider, (0, Decimal(0)))
        pool = pools.get(provider)
        known = (pool[1] if pool else 0) + independent[provider]
        basis = [pool[3]] if pool else []
        if independent[provider]:
            basis.append(f"独立账号 {money(independent[provider])} 元")
        if provider in zero and not pool:
            basis.append(zero[provider])
        rows.append((LABELS.get(provider, provider), f"{calls:,}", usd(cost), percent(cost, total_usd),
                     money(known) if basis else "待核", " ＋ ".join(basis) if basis else "账单待核"))
    rows.append(("已确认合计", f"{sum(result['calls_by_name'].values()):,}", usd(total_usd),
                 percent(total_usd, total_usd), money(result["paid"]), ""))
    table(("平台", "调用（次）", "API 折算（美元）", "折算占比（%）", "费用（元）", "费用依据"),
          rows, (2.6, 2.2, 3.2, 2.75, 2.75, 3.9), left_columns=(0, 5))
    doc.add_paragraph("共享平台费用汇总", "Heading 2")
    shared_rows = [(pool[2], str(pool[0]) if pool[0] is not None else "—", money(pool[1]))
                   for _, pool in sorted(pools.items())]
    shared_rows.append(("合计", str(sum(pool[0] or 0 for pool in pools.values())), money(result["shared_paid"])))
    table(("共享平台", "账号数（个）", "费用（元）"), shared_rows, (8.8, 3.5, 5.1))
    if result["unallocated"]:
        doc.add_paragraph(f"未分摊费用 {money(result['unallocated'])} 元")

    names, shared, own = result["calls_by_name"], result["shared_by_name"], result["own"]
    estimates = result["estimated_by_name"]
    heading = doc.add_paragraph("共享平台预估费用", "Heading 1")
    heading.paragraph_format.page_break_before = True
    doc.add_paragraph("预估费用按各模型的 API 价格和实际用量计算。")
    total_calls = sum(names.values())
    estimate_rows = [(name, f"{names[name]:,}", percent(names[name], total_calls),
                      usd(estimates[name]), percent(estimates[name], total_usd))
                     for name in sorted(names, key=lambda n: (-estimates[n], -names[n], n))]
    estimate_rows.append(("合计", f"{total_calls:,}", percent(total_calls, total_calls),
                          usd(total_usd), percent(total_usd, total_usd)))
    table(("名称", "总调用（次）", "调用占比（%）", "预估费用（美元）", "预估费用占比（%）"),
          estimate_rows, (3.3, 2.55, 3.05, 3.8, 4.7))

    heading = doc.add_paragraph("人员实际费用汇总", "Heading 1")
    heading.paragraph_format.page_break_before = True
    person_rows = [(name, money(own[name]), money(shared[name]), money(own[name] + shared[name]),
                    percent(own[name] + shared[name], result["paid"]))
                   for name in sorted(names, key=lambda n: (-(own[n] + shared[n]), n))]
    allocated = result["paid"] - result["unallocated"]
    shares_total = sum(shared.values())
    person_rows.append(("合计", money(allocated - shares_total), money(shares_total),
                        money(allocated), percent(allocated, result["paid"])))
    table(("名称", "独立账号费（元）", "共享费用（元）", "费用合计（元）", "总费用占比（%）"),
          person_rows, (4.0, 3.55, 2.9, 3.3, 3.65))
    output.parent.mkdir(parents=True, exist_ok=True)
    doc.save(output)


def main():
    cli = argparse.ArgumentParser(description="采集 9router 月度用量并生成团队 AI 费用月报。")
    sub = cli.add_subparsers(dest="command", required=True)
    read = sub.add_parser("collect", help="在数据所在主机只读导出聚合 JSON")
    read.add_argument("--db", required=True, type=Path)
    read.add_argument("--month")
    read.add_argument("--start")
    read.add_argument("--end")
    write = sub.add_parser("report", help="使用汇总和本期账号费用生成 Word")
    write.add_argument("--usage", required=True, type=Path)
    write.add_argument("--profile", type=Path,
                       default=Path(".run/monthly-ai-cost-report/platform.json"))
    write.add_argument("--extras", required=True, type=Path)
    write.add_argument("--output", required=True, type=Path)
    args = cli.parse_args()
    try:
        if args.command == "collect":
            start, end = report_dates(args)
            print(json.dumps(collect(args.db, start, end), ensure_ascii=False, indent=2))
        else:
            snapshot, profile, extras = map(read_json, (args.usage, args.profile, args.extras))
            snapshot = usage_snapshot(snapshot)
            result = calculate(snapshot, profile, extras)
            render(snapshot, profile, result, args.output)
            print(f"{args.output} · 已确认费用 {money(result['paid'])} 元")
    except (OSError, sqlite3.Error, ValueError, ArithmeticError, KeyError) as exc:
        cli.exit(1, f"{exc}\n")


if __name__ == "__main__":
    main()
