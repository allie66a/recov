"""
本地行情预览脚本 — 调 tushare HTTP API 拉均线/压力位数据, 不依赖 Vercel。

用途: 不部署 serverless 时, 本地跑一下看看某只股票的均线压力位数据,
然后把价格手动填进网页(浏览器打开 index.html 或 npm run dev)。

用法:
    cd recovery_calculator
    export TUSHARE_TOKEN=你的token
    python3 local_fetch.py 301003
    python3 local_fetch.py 联特        # 中文名走 stock_basic 模糊匹配

复权: 一律前复权(qfq), 遵守 AGENTS.md 数据复权纪律。
Token: 从环境变量 TUSHARE_TOKEN 读, 也可复用上层项目的 data/raw/.env。
"""
import os
import sys
import json

# 尝试复用上层项目 data/raw/.env
_HERE = os.path.dirname(os.path.abspath(__file__))
_QUANT_LAB = os.path.dirname(_HERE)
_RAW_ENV = os.path.join(_QUANT_LAB, "data", "raw", ".env")
if os.path.exists(_RAW_ENV) and not os.environ.get("TUSHARE_TOKEN"):
    with open(_RAW_ENV) as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                if k.strip() in ("TUSHARE_TOKEN", "TUSHARE_TOKEN1", "TUSHARE_TOKEN2"):
                    os.environ.setdefault("TUSHARE_TOKEN", v.strip())

sys.path.insert(0, _HERE)
from api.quote import _normalize_code, _query, _analyze, _ts_post, _ts_to_records


def main():
    if len(sys.argv) < 2:
        print("用法: python3 local_fetch.py <股票代码或名称>")
        print("示例: python3 local_fetch.py 301003")
        print("      python3 local_fetch.py 联特")
        sys.exit(1)

    arg = sys.argv[1]
    token = os.environ.get("TUSHARE_TOKEN", "")
    if not token:
        print("✗ 未配置 TUSHARE_TOKEN 环境变量, 也未找到 data/raw/.env")
        sys.exit(1)
    # 取第一个 token (主备双 token 时)
    tk = token.split(",")[0].strip()

    if not any(ch.isdigit() for ch in arg):
        # 中文名 → 代码 (用 tushare stock_basic 模糊匹配)
        try:
            data = _ts_post("stock_basic", tk, params={}, fields="ts_code,name")
            basics = _ts_to_records(data)
        except Exception as e:
            print(f"✗ 查询股票列表失败: {e}")
            sys.exit(1)
        hit = [b for b in basics if arg in str(b.get("name", ""))]
        if not hit:
            print(f"✗ 未找到名称含 '{arg}' 的股票")
            sys.exit(1)
        if len(hit) > 1:
            print(f"找到 {len(hit)} 只, 请用更精确的名称或代码:")
            for b in hit[:10]:
                print(f"  {b['ts_code']}  {b['name']}")
            sys.exit(0)
        code = hit[0]["ts_code"]
    else:
        code = _normalize_code(arg)
        if not code:
            print(f"✗ 无法识别代码: {arg}")
            sys.exit(1)

    print(f"查询: {code} ...")
    try:
        rows, name = _query(code, tk)
    except Exception as e:
        print(f"✗ 拉取失败: {e}")
        sys.exit(1)

    if len(rows) < 60:
        print(f"✗ 数据不足60日 (仅 {len(rows)} 日), 无法算 MA60")
        sys.exit(1)

    result = _analyze(rows, name)
    print("\n" + "=" * 50)
    print(f"{result['name']} ({result['code']})")
    print(f"数据截止: {result['last_date']}")
    print("=" * 50)
    print(f"当前价:    {result['current_price']}")
    print(f"MA5:       {result['ma5']}")
    print(f"MA8:       {result['ma8']}")
    print(f"MA13:      {result['ma13']}")
    print(f"MA20:      {result['ma20']}")
    print(f"MA60:      {result['ma60']}")
    print("-" * 50)
    if result["first_resistance"] is not None:
        print(f"★第一压力位: {result['resistance_ma']} = {result['first_resistance']}")
    else:
        print("★第一压力位: 无 (均线全在下方)")
    print(f"均线粘合度: {result['cohesion_pct']}% ({result['cohesion_level']})")
    if result["suggested_clear_ratio"] is not None:
        print(f"建议清仓比: {result['suggested_clear_ratio']*100:.0f}%")
    print("=" * 50)
    print("\n把以上价格填进网页即可。")
    print("JSON 输出(api 同款):")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
