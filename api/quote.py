"""
Vercel Serverless Function: 股票行情 + 均线压力位 + 粘合度

接口: GET /api/quote?code=301003
返回: 当前价 / MA5/8/13/20/60 / 第一压力位 / 粘合度 / 建议清仓比例

复权纪律: MA 与压力位一律用前复权(qfq)价(遵守 AGENTS.md 数据复权纪律)。
Token 安全: 只从环境变量读, 绝不硬编码, 绝不写进仓库。
"""
import os
import json
from http.server import BaseHTTPRequestHandler

# ---------- tushare 查询 ----------

def _normalize_code(code: str) -> str:
    """把用户输入归一化为 tushare 的 6位数字.后缀 格式。

    支持输入: '301003' / '301003.SZ' / 'sh600519' / '600519.SH'
    """
    code = (code or '').strip().upper()
    if not code:
        return ''
    # 去掉字母前缀(sh/sz/bj)
    if code.startswith(('SH', 'SZ', 'BJ')) and '.' not in code:
        code = code[2:]
    # 去掉后缀
    if '.' in code:
        code = code.split('.')[0]
    # 只保留数字
    digits = ''.join(ch for ch in code if ch.isdigit())
    if len(digits) != 6:
        return ''
    # 按号码段判交易所后缀
    if digits.startswith(('60', '68', '11', '13')):
        return f'{digits}.SH'
    elif digits.startswith(('00', '30', '12')):
        return f'{digits}.SZ'
    elif digits.startswith(('8', '43', '92', '87')):
        return f'{digits}.BJ'
    # 兜底按深市
    return f'{digits}.SZ'


def _query_tushare(code: str):
    """拉前复权日线 + 名称, 返回 (df, name)。失败抛异常。

    用 tushare 的 pro_bar 拿 qfq 收盘价(满足 AGENTS.md 前复权强制)。
    用 stock_basic 查名称。
    """
    import tushare as ts
    token = os.environ.get('TUSHARE_TOKEN', '')
    if not token:
        raise RuntimeError('未配置 TUSHARE_TOKEN 环境变量')

    # 支持主备双 token (逗号分隔): 主线失败自动降级副线(沿用项目双线降级思路)
    tokens = [t.strip() for t in token.split(',') if t.strip()]
    last_err = None
    df = None
    for tk in tokens:
        try:
            pro = ts.pro_api(tk)
            # 名称
            name = ''
            try:
                info = pro.stock_basic(ts_code=code, fields='ts_code,name')
                if info is not None and len(info) > 0:
                    name = str(info.iloc[0].get('name', '') or '')
            except Exception:
                pass
            # 前复权日线(最近 120 日, 够算 MA60 且有余量)
            df = ts.pro_bar(ts_code=code, adj='qfq', asset='E',
                            end_date='', start_date='', limit=120)
            if df is None or len(df) == 0:
                raise RuntimeError('tushare 返回空数据')
            df = df.sort_values('trade_date').reset_index(drop=True)
            return df, (name or code)
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(f'tushare 查询失败: {last_err}')


def _analyze(df, name: str) -> dict:
    """算 MA / 当前价 / 第一压力位 / 粘合度 / 建议清仓比例。"""
    import pandas as pd

    close = df['close'].astype(float)
    # 均线(rolling, 末值即最新)
    ma = {}
    for w in (5, 8, 13, 20, 60):
        s = close.rolling(w).mean()
        ma[w] = round(float(s.iloc[-1]), 3) if pd.notna(s.iloc[-1]) else None

    current = round(float(close.iloc[-1]), 3)
    last_date = str(df['trade_date'].iloc[-1])

    # 第一压力位: 在已算出的均线里, 找 > 当前价 且 数值最小的那条(股价上方第一条均线)
    above = {w: v for w, v in ma.items() if (v is not None) and (v > current)}
    if above:
        res_ma = min(above, key=lambda w: above[w])
        first_resistance = above[res_ma]
    else:
        res_ma = None
        first_resistance = None  # 所有均线都在下方, 无明确均线压力

    # 粘合度: (max-min)/当前价, 只用已算出的均线
    valid = [v for v in ma.values() if v is not None]
    if len(valid) >= 2:
        cohesion_pct = round((max(valid) - min(valid)) / current * 100, 2)
    else:
        cohesion_pct = None

    # 分档: 松<3% / 中3-6% / 紧>6%
    if cohesion_pct is None:
        level, suggested = None, None
    elif cohesion_pct < 3:
        level, suggested = '松', 0.30   # 粘合松, 抛压轻, 30% 足够
    elif cohesion_pct <= 6:
        level, suggested = '中', 0.50   # 中度粘合, 50%
    else:
        level, suggested = '紧', 0.80   # 高度粘合, 抛压重, 80%

    return {
        'code': str(df['ts_code'].iloc[-1]) if 'ts_code' in df else '',
        'name': name,
        'last_date': last_date,
        'current_price': current,
        'ma5': ma[5], 'ma8': ma[8], 'ma13': ma[13],
        'ma20': ma[20], 'ma60': ma[60],
        'first_resistance': first_resistance,
        'resistance_ma': f'MA{res_ma}' if res_ma else None,
        'cohesion_pct': cohesion_pct,
        'cohesion_level': level,
        'suggested_clear_ratio': suggested,
    }


# ---------- Vercel 入口 ----------

class handler(BaseHTTPRequestHandler):
    """Vercel Python runtime 的标准入口(BaseHTTPRequestHandler)。"""

    def _send(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # 解析 query
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        code_raw = (q.get('code', [''])[0]).strip()
        if not code_raw:
            return self._send(400, {'ok': False, 'error': '缺少参数 code (股票代码)'})

        code = _normalize_code(code_raw)
        if not code:
            return self._send(400, {'ok': False,
                                    'error': f'无法识别股票代码: {code_raw}'})

        try:
            df, name = _query_tushare(code)
            if len(df) < 60:
                return self._send(200, {'ok': False,
                                        'error': f'上市/数据不足60日, 当前仅{len(df)}日, 无法算MA60'})
            result = _analyze(df, name)
            return self._send(200, {'ok': True, 'data': result})
        except Exception as e:
            return self._send(500, {'ok': False, 'error': str(e)})

    def log_message(self, *args):
        pass  # 静默日志, 避免 Vercel 日志刷屏
