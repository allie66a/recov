/**
 * 股票回本计划 — 计算公式集（纯函数, 无副作用）
 *
 * 变量约定:
 *   C  = 原始持仓成本(元/股)
 *   cur= 当前股价(元/股)
 *   Q  = 原持仓股数(股)
 *   B  = 加仓价格(元/股)
 *   P  = 波段加仓比例(小数, 如 0.30)
 *   S  = 目标卖出价(元/股)
 *   tRatio = 做T仓位比例(小数)
 *   R  = 单次T目标收益率(小数, 如 0.05)
 *   N  = 做T次数
 *
 * 验证基准(联特案例, 必须对得上):
 *   波段降本 17.4 / 做T降本 8.79 / 累计 26.19 / 新回本价 306.81 / 需涨幅 4.71%
 */

// ===== 默认参数 =====
// 注意: 持仓相关价格(成本/当前价/加仓价/目标价/股数)不设默认值,
//       这些是用户自己的数据或拉取行情后自动填, 预填某只股票的数字会误导。
//       这里只保留"策略参数"的默认值(做T比例/收益率/次数、费用率等)。
export const DEFAULTS = {
  cost: '',             // 原始持仓成本: 用户自填
  current: '',          // 当前股价: 拉取行情后自动填
  shares: '',           // 原持仓股数: 用户自填
  buyPrice: '',         // 加仓价格: 拉取后自动填今天收盘价
  waveRatio: 30,        // 百分比输入(界面), 内部转小数
  sellPrice: '',        // 目标卖出价: 拉取后自动填压力位
  sellType: 'auto',     // auto / ma60 / ma20 / custom
  tRatio: 30,           // 百分比
  tReturn: 5,           // 百分比
  tTimes: 2,
  tBasis: 'estimate',   // estimate / actual
  feeEnabled: false,
  buyFee: 0.025,        // 万2.5
  sellFee: 0.025,
  stampDuty: 0.05,      // 0.05%(卖出单边)
  minFee: 5,            // 单笔最低5元
  slippage: 0.05,       // 单边0.05%
};

// ===== 工具 =====
const pct = (v) => v / 100;   // 界面百分比 → 小数

/**
 * 单笔佣金: max(成交额×佣金率, 最低佣金)
 */
export function commission(amount, rate, minFee) {
  return Math.max(amount * rate, minFee || 0);
}

/**
 * 空字符串/空值 → NaN(让下游 isFinite 检查显示"—", 而非误算成 0)
 */
const numOrNaN = (v) => {
  if (v === '' || v == null) return NaN
  const n = +v
  return isFinite(n) ? n : NaN
}

/**
 * 把界面输入(含百分比字段)归一化为计算用参数对象
 */
export function normalizeInputs(input) {
  return {
    C: numOrNaN(input.cost),
    cur: numOrNaN(input.current),
    Q: numOrNaN(input.shares),
    B: numOrNaN(input.buyPrice),
    P: pct(numOrNaN(input.waveRatio)),
    S: numOrNaN(input.sellPrice),
    tRatio: pct(numOrNaN(input.tRatio)),
    R: pct(numOrNaN(input.tReturn)),
    N: Math.round(numOrNaN(input.tTimes) || 0),
    tBasis: input.tBasis || 'estimate',
    actualRows: input.actualRows || [],
    fee: {
      enabled: !!input.feeEnabled,
      buyFee: pct(numOrNaN(input.buyFee)),
      sellFee: pct(numOrNaN(input.sellFee)),
      stampDuty: pct(numOrNaN(input.stampDuty)),
      minFee: numOrNaN(input.minFee),
      slippage: pct(numOrNaN(input.slippage)),
    },
  };
}

// ===== 核心公式 =====

/** 波段降本(元/股) = (目标卖出价 − 加仓价) × 加仓比例 */
export function waveReduce(p) {
  if (!isFinite(p.S) || !isFinite(p.B) || !isFinite(p.P)) return NaN;
  return (p.S - p.B) * p.P;
}

/** 做T降本(元/股)
 *  - estimate: S × R × tRatio × N
 *  - actual:   Σ(卖出价−买入价) × tRatio
 */
export function tReduce(p, nOverride) {
  const N = nOverride !== undefined ? nOverride : p.N;
  if (p.tBasis === 'actual') {
    if (!Array.isArray(p.actualRows)) return 0;
    return p.actualRows.reduce((sum, r) => {
      const buy = parseFloat(r.buy);
      const sell = parseFloat(r.sell);
      if (isFinite(buy) && isFinite(sell) && sell > buy) {
        return sum + (sell - buy) * p.tRatio;
      }
      return sum;
    }, 0);
  }
  if (!isFinite(p.S) || !isFinite(p.R) || !isFinite(p.tRatio) || !isFinite(N)) return NaN;
  return p.S * p.R * p.tRatio * N;
}

/** 累计降本 = 波段降本 + 做T降本 */
export function totalReduce(p, nOverride) {
  const w = waveReduce(p);
  const t = tReduce(p, nOverride);
  if (!isFinite(w) || !isFinite(t)) return NaN;
  return w + t;
}

/**
 * 调整后新回本价 = C − 累计降本 + 总费用/Q
 * 费用仅在 fee.enabled 时计入。
 */
export function newCostPrice(p, nOverride) {
  if (!isFinite(p.C)) return NaN;
  const reduce = totalReduce(p, nOverride);
  if (!isFinite(reduce)) return NaN;
  let feePerShare = 0;
  if (p.fee.enabled && isFinite(p.Q) && p.Q > 0) {
    feePerShare = totalFees(p, nOverride) / p.Q;
  }
  return p.C - reduce + feePerShare;
}

/** 目标价后仍需上涨比例(%) = (新回本价 − S) / S × 100 */
export function needUpPct(p, nOverride) {
  const nc = newCostPrice(p, nOverride);
  if (!isFinite(nc) || !isFinite(p.S) || p.S <= 0) return NaN;
  return (nc - p.S) / p.S * 100;
}

/** 当前价 → 回本价 总涨幅(%) = (新回本价 − 当前价) / 当前价 × 100 */
export function totalUpPct(p, nOverride) {
  const nc = newCostPrice(p, nOverride);
  if (!isFinite(nc) || !isFinite(p.cur) || p.cur <= 0) return NaN;
  return (nc - p.cur) / p.cur * 100;
}

/** 总减亏金额(元) = 累计降本 × 原持仓股数 */
export function totalSaveAmount(p, nOverride) {
  const reduce = totalReduce(p, nOverride);
  if (!isFinite(reduce) || !isFinite(p.Q)) return NaN;
  return reduce * p.Q;
}

/** 加仓资金占用(元) = 加仓价 × Q × 加仓比例 */
export function addFundAmount(p) {
  if (!isFinite(p.B) || !isFinite(p.Q) || !isFinite(p.P)) return NaN;
  return p.B * p.Q * p.P;
}

/** 最大持仓(股) = Q × (1 + P) */
export function maxHoldShares(p) {
  if (!isFinite(p.Q) || !isFinite(p.P)) return NaN;
  return p.Q * (1 + p.P);
}

/** 最大资金占用(元) = 当前价×Q + 加仓价×Q×P */
export function maxOccupyAmount(p) {
  if (!isFinite(p.cur) || !isFinite(p.Q) || !isFinite(p.B) || !isFinite(p.P)) return NaN;
  return p.cur * p.Q + p.B * p.Q * p.P;
}

/**
 * 交易总费用(元): 波段 + 做T
 *  波段: 加仓股数(Q×P) 的买入佣金(B) + 卖出佣金(S) + 印花税(S) + 双边滑点
 *  做T : 每次买卖(T仓位) 的佣金 + 印花税 + 滑点, ×N
 */
export function totalFees(p, nOverride) {
  if (!p.fee.enabled) return 0;
  const N = nOverride !== undefined ? nOverride : p.N;
  const { buyFee, sellFee, stampDuty, minFee, slippage } = p.fee;
  const Qwave = p.Q * p.P;
  let f = 0;
  // 波段买入(B) + 卖出(S)
  if (Qwave > 0 && isFinite(p.B) && isFinite(p.S)) {
    f += commission(Qwave * p.B, buyFee, minFee) + Qwave * p.B * slippage;
    f += commission(Qwave * p.S, sellFee, minFee) + Qwave * p.S * stampDuty + Qwave * p.S * slippage;
  }
  // 做T(每次一买一卖, 简化按 S 估算价位)
  const Qt = p.Q * p.tRatio;
  if (Qt > 0 && N > 0 && isFinite(p.S)) {
    for (let i = 0; i < N; i++) {
      const tradeBuy = p.S;
      const tradeSell = p.S * 1.001; // 每次+0.1%作为简化卖出价
      f += commission(Qt * tradeBuy, buyFee, minFee) + Qt * tradeBuy * slippage;
      f += commission(Qt * tradeSell, sellFee, minFee) + Qt * tradeSell * stampDuty + Qt * tradeSell * slippage;
    }
  }
  return f;
}

// ===== 情景对比表 =====
export function scenarioRows(p) {
  // 各方案: { label, N(做T次数), wave(是否含波段), hl(高亮) }
  const presets = [
    { label: '不操作', N: 0, wave: false },
    { label: '只做波段(无T)', N: 0, wave: true },
    { label: '波段 + 1次T', N: 1, wave: true },
    { label: '波段 + 2次T', N: 2, wave: true, hl: true },
    { label: '波段 + 3次T', N: 3, wave: true },
  ];
  // 用户当前 N
  if (p.N > 0 && !presets.some(x => x.N === p.N)) {
    presets.push({ label: `波段 + ${p.N}次T(你的)`, N: p.N, wave: true, hl: true });
  }
  return presets.map(row => {
    // 临时构造"是否含波段": 若不含波段, 把 P 视为 0
    const tmp = row.wave ? p : { ...p, P: 0 };
    let reduce, nc, need;
    if (p.tBasis === 'actual' && row.N > 0) {
      // actual 模式: 按用户实际价差折算到 row.N 次(等比缩放)
      const full = tReduce({ ...p }, p.N); // 用户填的 N 次总和
      reduce = (waveReduce(tmp) || 0) + (row.N > 0 && p.N > 0 ? full * row.N / p.N : 0);
      nc = p.C - reduce;
    } else {
      reduce = totalReduce(tmp, row.N);
      nc = newCostPrice(tmp, row.N);
    }
    need = (nc - p.S) / p.S * 100;
    return { label: row.label, reduce, newCost: nc, needUp: need, hl: row.hl };
  });
}

// ===== 合理性校验 =====
export function collectWarnings(p) {
  const w = [];
  if (isFinite(p.S) && isFinite(p.B) && p.S <= p.B) w.push('目标卖出价 ≤ 加仓价, 波段无利润空间');
  if (isFinite(p.B) && isFinite(p.cur) && p.B > p.cur * 1.05) w.push('加仓价明显高于当前价');
  if (isFinite(p.P) && p.P > 0.5) w.push('波段加仓比例 > 50%, 补仓风险敞口较大');
  if (isFinite(p.tRatio) && isFinite(p.P) && (p.tRatio + p.P) > 1) w.push('波段 + 做T 仓位合计 > 100%');
  if (!isFinite(p.Q) || p.Q <= 0) w.push('未填原持仓股数, 总金额类指标无法计算');
  return w;
}

// ===== 格式化 =====
export function fmtMoney(v, unit = '元') {
  if (!isFinite(v)) return '—';
  const abs = Math.abs(v);
  let s;
  if (abs >= 1e8) s = (v / 1e8).toFixed(2) + ' 亿';
  else if (abs >= 1e4) s = (v / 1e4).toFixed(2) + ' 万';
  else s = v.toFixed(2);
  return s + unit;
}
export function fmtPct(v, digits = 2) {
  if (!isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(digits) + '%';
}
export function fmtNum(v, d = 2) {
  if (!isFinite(v)) return '—';
  return v.toFixed(d);
}
