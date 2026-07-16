"""
Vercel Serverless Function: 股票行情 + 均线压力位 + 粘合度

接口: GET /api/quote?code=301205
返回: 当前价 / MA5/8/13/20/60 / 第一压力位 / 粘合度 / 建议清仓比例

实现: 直接用 requests 调 tushare HTTP API (POST api.tushare.pro),
      不依赖 tushare Python 库(避免 lxml 等重依赖在 serverless 装不上)。

复权纪律: MA 与压力位一律用前复权(qfq)价(遵守 AGENTS.md 数据复权纪律)。
         前复权 = 原始价 × adj_factor / 最新adj_factor
Token 安全: 只从环境变量读, 绝不硬编码, 绝不写进仓库。
"""
import os
import json
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler

TUSHARE_API = "https://api.tushare.pro"

# ---------- tushare HTTP 调用 ----------

def _ts_post(api_name, token, params=None, fields=""):
    """调用 tushare HTTP API。返回 dict (含 fields/items) 或抛异常。"""
    payload = {
        "api_name": api_name,
        "token": token,
        "params": params or {},
        "fields": fields,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        TUSHARE_API, data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        raise RuntimeError(f"tushare 网络错误: {e}")
    if not isinstance(result, dict):
        raise RuntimeError("tushare 返回格式异常")
    if result.get("code") != 0:
        msg = result.get("msg", "未知错误")
        raise RuntimeError(f"tushare 接口错误: {msg}")
    return result.get("data", {})


def _ts_to_records(data):
    """把 tushare 返回的 {fields, items} 转成 dict 列表。"""
    fields = data.get("fields", [])
    items = data.get("items", [])
    return [dict(zip(fields, row)) for row in items]


def _normalize_code(code):
    """把用户输入归一化为 tushare 的 6位数字.后缀 格式。

    支持输入: '301205' / '301205.SZ' / 'sh600519' / '600519.SH'
    """
    code = (code or "").strip().upper()
    if not code:
        return ""
    if code.startswith(("SH", "SZ", "BJ")) and "." not in code:
        code = code[2:]
    if "." in code:
        code = code.split(".")[0]
    digits = "".join(ch for ch in code if ch.isdigit())
    if len(digits) != 6:
        return ""
    if digits.startswith(("60", "68", "11", "13")):
        return f"{digits}.SH"
    elif digits.startswith(("00", "30", "12")):
        return f"{digits}.SZ"
    elif digits.startswith(("8", "43", "92", "87")):
        return f"{digits}.BJ"
    return f"{digits}.SZ"


def _query(code, token):
    """拉前复权日线 + 名称。返回 (records, name)。

    前复权: daily(原始价) + adj_factor, 按 qfq 公式调整。
    qfq_close = raw_close * adj / adj_latest
    """
    # 名称
    name = code
    try:
        data = _ts_post("stock_basic", token,
                        params={"ts_code": code}, fields="ts_code,name")
        recs = _ts_to_records(data)
        if recs:
            name = str(recs[0].get("name") or code)
    except Exception:
        pass  # 名称失败不阻断

    # 原始日线(最近 ~90 个交易日, 够算 MA60)
    daily_data = _ts_post("daily", token,
                          params={"ts_code": code},
                          fields="ts_code,trade_date,open,high,low,close,vol,amount")
    daily_recs = _ts_to_records(daily_data)
    if not daily_recs:
        raise RuntimeError("tushare 未返回日线数据(检查代码或积分)")

    # 复权因子(同周期)
    try:
        adj_data = _ts_post("adj_factor", token,
                            params={"ts_code": code},
                            fields="ts_code,trade_date,adj_factor")
        adj_recs = _ts_to_records(adj_data)
        adj_map = {r["trade_date"]: float(r["adj_factor"]) for r in adj_recs if r.get("adj_factor")}
    except Exception:
        adj_map = {}

    # 合并并按日期升序 (close/low/high 都做前复权, 同口径)
    rows = []
    for r in daily_recs:
        td = r.get("trade_date")
        raw_close = float(r["close"])
        raw_low = float(r.get("low") or r["close"])    # low 兜底用 close
        raw_high = float(r.get("high") or r["close"])  # high 兜底用 close
        adj = adj_map.get(td)
        if adj and adj_map:
            # 前复权: 基准 = 最新交易日的因子
            adj_latest = max(adj_map.values())  # 最新因子 = 最大日期对应
            close_qfq = raw_close * adj / adj_latest
            low_qfq = raw_low * adj / adj_latest
            high_qfq = raw_high * adj / adj_latest
        else:
            close_qfq = raw_close
            low_qfq = raw_low
            high_qfq = raw_high
        rows.append({
            "ts_code": r.get("ts_code", code),
            "trade_date": td,
            "close": close_qfq,
            "low": low_qfq,
            "high": high_qfq,
        })
    rows.sort(key=lambda x: x["trade_date"])
    return rows, name


def _stabilization_signals(rows, closes, ma5_today):
    """企稳信号判断 (5 项全过 = 已企稳, 可考虑加仓)。

    返回:
      stabilized: bool, 5项是否全过
      checks: list of {key, label, passed, detail}
    口径:
      1. 止跌企稳: 近5日最低点出现在前3天内 (最近2天没再创新低)
      2. 不创新低: 近3天最低价都 ≥ 近3天之前那天(倒数第4天)的最低价
      3. MA5抬高: 近5日 MA5 逐日严格上升
      4. 站上5日线: 今日收盘 ≥ 今日 MA5
      5. 未冲高回落: 上影线比例 (最高-收盘)/最高 ≤ 30%
    """
    n = len(closes)
    checks = []

    # 数据不足时直接返回未通过
    if n < 9:  # 至少需要: 近5日 + 算5日MA5序列需要再往前5日 ≈ 9日
        labels = ["近5日止跌企稳", "近3天不创新低", "近5日MA5逐日抬高", "今日站上5日线"]
        for lb in labels:
            checks.append({"key": lb, "label": lb, "passed": False, "detail": "数据不足"})
        return {"stabilized": False, "checks": checks}

    lows = [r["low"] for r in rows]

    # --- 条件1: 止跌企稳 (近5日"最低价"的最低点在前3天, 即最近2天没有更低的 low) ---
    # 注意用 low(最低价) 而非 close, 与条件2同口径, 避免盘中破位尾盘拉回时误判
    # last5_low[0]=倒数第5天 ... last5_low[4]=今天(倒数第1天)
    last5_low = lows[-5:]
    # min_idx_in_5: 0..4, 其中 3..4 = 最近2天(今天/昨天), 0..2 = 前3天
    min_idx_in_5 = last5_low.index(min(last5_low))
    # 最近2天没创新低 = 最低点不在最后2个位置(index 3,4)
    c1_passed = min_idx_in_5 <= 2
    # index → 倒数第几天 (index 4 = 倒数第1天=今天, index 0 = 倒数第5天)
    day_desc = {4: "最近1天(今天)", 3: "倒数第2天", 2: "倒数第3天", 1: "倒数第4天", 0: "倒数第5天"}
    c1_detail = f"近5日最低价在{day_desc.get(min_idx_in_5, '?')}({min(last5_low):.2f}), " + \
                ("前3天内, 已止跌" if c1_passed else "近2天内, 仍在探底")
    checks.append({"key": "止跌企稳", "label": "近5日止跌企稳", "passed": c1_passed, "detail": c1_detail})

    # --- 条件2: 不创新低 (近3天最低价都 ≥ 倒数第4天的最低价) ---
    ref_low = lows[-4]  # 近3天之前那天(前低基准)
    last3_lows = lows[-3:]
    c2_passed = all(lo >= ref_low for lo in last3_lows)
    breach = [round(lo, 2) for lo in last3_lows if lo < ref_low]
    c2_detail = f"前低(倒数第4天){ref_low:.2f}, 近3天最低 {min(last3_lows):.2f}, " + \
                ("未破前低" if c2_passed else f"已破前低{breach}")
    checks.append({"key": "不创新低", "label": "近3天不创新低", "passed": c2_passed, "detail": c2_detail})

    # --- 条件3: MA5 逐日抬高 (近5日每天的 MA5 严格上升) ---
    # MA5[i] = mean(closes[i-4..i]), 取最后5个 MA5 值比较
    ma5_series = []
    for i in range(n - 5, n):  # 最后5个交易日的 MA5 (i 从 n-5 到 n-1)
        ma5_series.append(round(sum(closes[i - 4:i + 1]) / 5, 2))
    c3_passed = all(ma5_series[i] > ma5_series[i - 1] for i in range(1, len(ma5_series)))
    c3_detail = f"近5日MA5序列 {ma5_series}, " + ("逐日抬高" if c3_passed else "未逐日抬高(有回落)")
    checks.append({"key": "MA5抬高", "label": "近5日MA5逐日抬高", "passed": c3_passed, "detail": c3_detail})

    # --- 条件4: 今日站上5日线 ---
    today_close = closes[-1]
    c4_passed = today_close >= ma5_today if ma5_today is not None else False
    c4_detail = f"今日收盘 {today_close:.2f} vs MA5 {ma5_today}, " + \
                ("站上5日线" if c4_passed else "在5日线下方")
    checks.append({"key": "站上MA5", "label": "今日站上5日线", "passed": c4_passed, "detail": c4_detail})

    # --- 条件5: 未冲高回落 (负面信号: 上影线>30% = 冲高回落 = 不利) ---
    # 上影线比例 = (最高价 − 收盘价) / 最高价 × 100%
    today_high = rows[-1]["high"]
    upper_shadow_pct = ((today_high - today_close) / today_high * 100) if today_high > 0 else 0
    upper_shadow_pct = round(upper_shadow_pct, 2)
    c5_passed = upper_shadow_pct <= 30  # ≤30% 算"未冲高回落"(通过)
    c5_detail = f"今日最高 {today_high:.2f} 收盘 {today_close:.2f}, 上影线 {upper_shadow_pct}%, " + \
                ("未冲高回落" if c5_passed else "冲高回落(>30%, 抛压重)")
    checks.append({"key": "未冲高回落", "label": "今日未冲高回落", "passed": c5_passed, "detail": c5_detail})

    stabilized = all(c["passed"] for c in checks)
    return {"stabilized": stabilized, "checks": checks}


def _analyze(rows, name):
    """算 MA / 当前价 / 第一压力位 / 粘合度 / 建议清仓比例。"""
    closes = [r["close"] for r in rows]

    def ma(w):
        if len(closes) < w:
            return None
        return round(sum(closes[-w:]) / w, 2)

    ma = {w: ma(w) for w in (5, 8, 13, 20, 60)}
    current = round(closes[-1], 2)
    last_date = str(rows[-1]["trade_date"])
    ts_code = rows[-1].get("ts_code", "")

    # 第一压力位: 只在 MA20 / MA60 里选(短期波动均线不作为主压力判断)
    # 规则: 取当前价上方、两者中较低的那个; 都在下方则无压力位
    res_candidates = {w: ma[w] for w in (20, 60)
                      if ma[w] is not None and ma[w] > current}
    if res_candidates:
        # 取较低者(更近的压力, 先到先卖)
        res_ma = min(res_candidates, key=lambda w: res_candidates[w])
        first_resistance = res_candidates[res_ma]
    else:
        res_ma = None
        first_resistance = None

    # 粘合度
    valid = [v for v in ma.values() if v is not None]
    if len(valid) >= 2:
        cohesion_pct = round((max(valid) - min(valid)) / current * 100, 2)
    else:
        cohesion_pct = None

    # 粘合度分档(2026-07-17 修订)
    #   <5%    紧   → 80% (均线高度粘合, 抛压最重, 建议高比例清仓)
    #   5-8%   偏紧 → 60%
    #   8-12%  偏松 → 50%
    #   >12%   发散 → 30% (均线分散/价格离均线远, 做T风险高, 优先减波段仓)
    if cohesion_pct is None:
        level, suggested = None, None
    elif cohesion_pct < 5:
        level, suggested = "紧", 0.80
    elif cohesion_pct < 8:
        level, suggested = "偏紧", 0.60
    elif cohesion_pct <= 12:
        level, suggested = "偏松", 0.50
    else:
        level, suggested = "发散", 0.30

    # ===== 企稳信号 (4 项全过 = 已企稳) =====
    signals = _stabilization_signals(rows, closes, ma[5])

    return {
        "code": ts_code,
        "name": name,
        "last_date": last_date,
        "current_price": current,
        "ma5": ma[5], "ma8": ma[8], "ma13": ma[13],
        "ma20": ma[20], "ma60": ma[60],
        "first_resistance": first_resistance,
        "resistance_ma": f"MA{res_ma}" if res_ma else None,
        "cohesion_pct": cohesion_pct,
        "cohesion_level": level,
        "suggested_clear_ratio": suggested,
        "stabilization": signals,
    }


# ---------- Vercel 入口 ----------

class handler(BaseHTTPRequestHandler):
    """Vercel Python runtime 的标准入口(BaseHTTPRequestHandler)。"""

    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        code_raw = (q.get("code", [""])[0]).strip()
        if not code_raw:
            return self._send(400, {"ok": False, "error": "缺少参数 code (股票代码)"})

        code = _normalize_code(code_raw)
        if not code:
            return self._send(400, {"ok": False,
                                    "error": f"无法识别股票代码: {code_raw}"})

        token = os.environ.get("TUSHARE_TOKEN", "")
        if not token:
            return self._send(500, {"ok": False,
                                    "error": "服务端未配置 TUSHARE_TOKEN 环境变量"})

        # 支持主备双 token (逗号分隔)
        tokens = [t.strip() for t in token.split(",") if t.strip()]
        last_err = None
        for tk in tokens:
            try:
                rows, name = _query(code, tk)
                if len(rows) < 60:
                    return self._send(200, {"ok": False,
                                            "error": f"数据不足60日(仅{len(rows)}日), 无法算MA60"})
                result = _analyze(rows, name)
                return self._send(200, {"ok": True, "data": result})
            except Exception as e:
                last_err = e
                continue
        return self._send(500, {"ok": False, "error": str(last_err)})

    def log_message(self, *args):
        pass
