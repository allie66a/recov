import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  DEFAULTS, normalizeInputs, waveReduce, tReduce, totalReduce,
  newCostPrice, needUpPct, totalUpPct, totalSaveAmount,
  addFundAmount, maxHoldShares, maxOccupyAmount,
  scenarioRows, collectWarnings, fmtMoney, fmtPct, fmtNum,
} from './utils/calculations.js'

// URL 分享用的参数 key
const URL_KEYS = [
  'cost', 'current', 'shares', 'buyPrice', 'waveRatio', 'sellPrice', 'sellType',
  'tRatio', 'tReturn', 'tTimes', 'tBasis', 'feeEnabled',
  'buyFee', 'sellFee', 'stampDuty', 'minFee', 'slippage',
]

export default function App() {
  // ===== 状态: 所有输入字段 =====
  const [input, setInput] = useState(() => loadFromUrl() || { ...DEFAULTS })
  const [stockCode, setStockCode] = useState('')
  const [fetchStatus, setFetchStatus] = useState('')
  const [fetching, setFetching] = useState(false)
  const [quote, setQuote] = useState(null)   // 行情数据
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'auto')
  const [toast, setToast] = useState('')

  // 主题应用
  useEffect(() => {
    const root = document.documentElement
    const isDark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)
    root.setAttribute('data-theme', isDark ? 'dark' : 'light')
  }, [theme])

  // URL 同步(无刷新)
  useEffect(() => {
    syncUrl(input)
  }, [input])

  // 输入变更
  const update = useCallback((key, value) => {
    setInput(prev => ({ ...prev, [key]: value }))
  }, [])

  // 切换目标价类型时, 联动填充目标卖出价
  //   auto → 压力位 / ma60 → MA60 / ma20 → MA20 / custom → 保持不动
  const handleSellTypeChange = useCallback((newType) => {
    const sp = sellPriceByType(newType, quote)
    if (sp != null) {
      // 有行情数据: 按类型自动填
      setInput(prev => ({ ...prev, sellType: newType, sellPrice: sp }))
    } else {
      // 无行情 或 custom: 只改类型, 不动卖出价
      setInput(prev => ({ ...prev, sellType: newType }))
    }
  }, [quote])

  // ===== 计算结果(派生) =====
  const p = useMemo(() => normalizeInputs({
    ...input,
    actualRows: input.tBasis === 'actual' ? buildActualRows(input) : [],
  }), [input])

  const result = useMemo(() => {
    const r = {
      waveReduce: waveReduce(p),
      tReduce: tReduce(p),
      totalReduce: totalReduce(p),
      newCost: newCostPrice(p),
      needUp: needUpPct(p),
      totalUp: totalUpPct(p),
      totalSave: totalSaveAmount(p),
      addFund: addFundAmount(p),
      maxHold: maxHoldShares(p),
      maxOccupy: maxOccupyAmount(p),
    }
    return r
  }, [p])

  const scenarios = useMemo(() => scenarioRows(p), [p])
  const warnings = useMemo(() => collectWarnings(p), [p])

  // ===== 行情拉取 =====
  const fetchQuote = useCallback(async () => {
    if (!stockCode.trim()) { setFetchStatus('请输入股票代码'); return }
    setFetching(true)
    setFetchStatus('拉取中…')
    try {
      const res = await fetch(`/api/quote?code=${encodeURIComponent(stockCode.trim())}`)
      const json = await res.json()
      if (!json.ok) throw new Error(json.error || '拉取失败')
      setQuote(json.data)
      applyQuoteToInput(json.data, input, update)
      setFetchStatus('')
    } catch (e) {
      setFetchStatus('拉取失败: ' + e.message + '(可手填价格)')
      setQuote(null)
    } finally {
      setFetching(false)
    }
  }, [stockCode, input, update])

  // ===== 操作 =====
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2400) }

  const resetDefaults = () => {
    setInput({ ...DEFAULTS })
    setQuote(null)
    setStockCode('')
    setFetchStatus('')
    showToast('已恢复默认值')
  }

  const copyResult = () => {
    const lines = [
      `股票回本计划`,
      `原成本: ${fmtNum(p.C)} 元  当前价: ${fmtNum(p.cur)} 元`,
      `波段: 加仓${fmtNum(p.B)}元(${(p.P * 100).toFixed(0)}%) → 卖${fmtNum(p.S)}元`,
      `做T: ${p.N}次 × ${(p.R * 100).toFixed(1)}% (${(p.tRatio * 100).toFixed(0)}%仓位)`,
      `──────────`,
      `波段降本: ${fmtNum(result.waveReduce)} 元/股`,
      `做T降本: ${fmtNum(result.tReduce)} 元/股`,
      `累计降本: ${fmtNum(result.totalReduce)} 元/股`,
      `新回本价: ${fmtNum(result.newCost)} 元`,
      `目标价后需涨幅: ${fmtPct(result.needUp)}`,
      `当前价→回本价: ${fmtPct(result.totalUp)}`,
    ]
    if (isFinite(result.totalSave)) lines.push(`总减亏: ${fmtMoney(result.totalSave)}`)
    const text = lines.join('\n')
    navigator.clipboard.writeText(text)
      .then(() => showToast('已复制到剪贴板'))
      .catch(() => {
        const ta = document.createElement('textarea'); ta.value = text
        document.body.appendChild(ta); ta.select()
        document.execCommand('copy'); ta.remove()
        showToast('已复制')
      })
  }

  const shareLink = () => {
    syncUrl(input)
    const url = location.origin + location.pathname + location.search
    navigator.clipboard.writeText(url)
      .then(() => showToast('分享链接已复制'))
      .catch(() => showToast('链接: ' + url))
  }

  // ===== 渲染 =====
  const heroClass = isFinite(result.newCost) && isFinite(p.cur)
    ? (result.newCost <= p.cur ? 'up' : 'down') : ''

  return (
    <div className="container">
      {/* 顶栏 */}
      <header className="topbar">
        <div className="title-wrap">
          <h1>股票回本计划计算器</h1>
          <p className="subtitle">通过低位波段加仓与滚动做T, 估算调整后的持仓成本和回本距离</p>
        </div>
        <button className="btn btn-ghost" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} title="切换深/浅色">
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </header>

      {/* 股票查询条 */}
      <section className="quote-bar card">
        <label className="field-inline">
          <span className="label">股票代码</span>
          <input type="text" value={stockCode} placeholder="如 301205 或 联特"
            onChange={e => setStockCode(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') fetchQuote() }} />
        </label>
        <button className="btn btn-primary" onClick={fetchQuote} disabled={fetching}>
          {fetching ? '拉取中…' : '拉取行情'}
        </button>
        <span className="fetch-status" role="status" aria-live="polite">{fetchStatus}</span>
      </section>

      {/* 均线/压力位卡片 */}
      {quote && <MaCard quote={quote} />}

      {/* 输入区 */}
      <div className="cards-row">
        {/* 卡片一: 原始持仓 */}
        <section className="card">
          <h2>① 原始持仓</h2>
          <NumberField label="原始持仓成本" unit="元/股" value={input.cost} onChange={v => update('cost', v)} />
          <NumberField label="当前股价" unit="元/股" value={input.current} onChange={v => update('current', v)} />
          <NumberField label="原持仓股数" unit="股(选填)" value={input.shares} onChange={v => update('shares', v)} placeholder="如 1000" />
        </section>

        {/* 卡片二: 波段计划 */}
        <section className="card">
          <h2>② 波段加仓计划</h2>
          <NumberField label="加仓价格" unit="元/股" value={input.buyPrice} onChange={v => update('buyPrice', v)} />
          <NumberField label="加仓比例" unit="占原持仓 %" value={input.waveRatio} onChange={v => update('waveRatio', v)} />
          <NumberField label="目标卖出价" unit="元/股" value={input.sellPrice} onChange={v => update('sellPrice', v)} />
          <label className="field">
            <span className="label">目标价类型</span>
            <select value={input.sellType} onChange={e => handleSellTypeChange(e.target.value)}>
              <option value="auto">均线压力位(自动)</option>
              <option value="ma60">60日线</option>
              <option value="ma20">20日线</option>
              <option value="custom">自定义</option>
            </select>
          </label>
        </section>

        {/* 卡片三: 做T计划 */}
        <section className="card">
          <h2>③ 做T计划</h2>
          <NumberField label="做T仓位比例" unit="占原持仓 %" value={input.tRatio} onChange={v => update('tRatio', v)} />
          <NumberField label="单次T目标收益率" unit="%" value={input.tReturn} onChange={v => update('tReturn', v)} />
          <NumberField label="做T次数" unit="次" value={input.tTimes} onChange={v => update('tTimes', v)} />
          <div className="field">
            <span className="label">T收益基准</span>
            <div className="radio-group">
              <label><input type="radio" name="tBasis" value="estimate" checked={input.tBasis !== 'actual'} onChange={() => update('tBasis', 'estimate')} /> 按收益率估算</label>
              <label><input type="radio" name="tBasis" value="actual" checked={input.tBasis === 'actual'} onChange={() => update('tBasis', 'actual')} /> 输入每次实际价差</label>
            </div>
          </div>
          {input.tBasis === 'actual' && (
            <ActualRows input={input} update={update} />
          )}
        </section>
      </div>

      {/* 费用设置 */}
      <details className="card details-card">
        <summary>④ 交易费用设置(可选)</summary>
        <label className="check-line">
          <input type="checkbox" checked={!!input.feeEnabled} onChange={e => update('feeEnabled', e.target.checked)} />
          计入交易费用(佣金/印花税/滑点)
        </label>
        {input.feeEnabled && (
          <div className="fee-fields">
            <NumberField label="买入佣金率" unit="%" value={input.buyFee} onChange={v => update('buyFee', v)} />
            <NumberField label="卖出佣金率" unit="%" value={input.sellFee} onChange={v => update('sellFee', v)} />
            <NumberField label="印花税率" unit="%(卖出单边)" value={input.stampDuty} onChange={v => update('stampDuty', v)} />
            <NumberField label="单笔最低佣金" unit="元" value={input.minFee} onChange={v => update('minFee', v)} />
            <NumberField label="预计滑点" unit="%(单边)" value={input.slippage} onChange={v => update('slippage', v)} />
          </div>
        )}
      </details>

      {/* 结果区 */}
      <section className="card result-card">
        <h2>预计回本计划</h2>
        <div className="hero">
          <div className="hero-label">调整后预计新回本价</div>
          <div className={`hero-value ${heroClass}`}>
            {isFinite(result.newCost) ? fmtNum(result.newCost) + ' 元' : '—'}
          </div>
          <div className="hero-sub">
            {isFinite(result.newCost) && isFinite(p.C)
              ? `较原成本 ${fmtNum(p.C)} 元 降低 ${fmtNum(p.C - result.newCost)} 元/股` : ''}
          </div>
        </div>
        <div className="result-grid">
          <ResultItem label="累计降低成本" value={fmtMoney(result.totalReduce, '')} />
          <ResultItem label="↳ 波段贡献" value={fmtMoney(result.waveReduce, '')} />
          <ResultItem label="↳ 做T贡献" value={fmtMoney(result.tReduce, '')} />
          <ResultItem label="目标价后仍需上涨" value={fmtPct(result.needUp)} className={isFinite(result.needUp) && result.needUp < 0 ? 'pos' : (isFinite(result.needUp) ? 'neg' : '')} />
          <ResultItem label="当前价→回本价 总涨幅" value={fmtPct(result.totalUp)} className={isFinite(result.totalUp) && result.totalUp > 0 ? 'neg' : (isFinite(result.totalUp) ? 'pos' : '')} />
          <ResultItem label="总减亏金额" value={fmtMoney(result.totalSave)} />
          <ResultItem label="加仓所需资金" value={fmtMoney(result.addFund)} />
          <ResultItem label="最大持仓/资金占用" value={(isFinite(result.maxHold) ? Math.round(result.maxHold) + ' 股' : '—') + (isFinite(result.maxOccupy) ? ` / ${fmtMoney(result.maxOccupy)}` : '')} />
        </div>
        {warnings.length > 0 && (
          <div className="warn-box">
            {warnings.map((w, i) => <p key={i}>⚠ {w}</p>)}
          </div>
        )}
      </section>

      {/* 情景对比表 */}
      <section className="card">
        <h2>情景对比</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>操作方案</th>
                <th className="num">累计降本</th>
                <th className="num">新回本价</th>
                <th className="num">目标价后需涨幅</th>
              </tr>
            </thead>
            <tbody>
              {scenarios.map((s, i) => (
                <tr key={i} className={s.hl ? 'highlight' : ''}>
                  <td>{s.label}</td>
                  <td className="num">{fmtMoney(s.reduce, '')}</td>
                  <td className="num">{fmtNum(s.newCost)}</td>
                  <td className="num">{fmtPct(s.needUp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 操作按钮 */}
      <div className="actions">
        <button className="btn btn-ghost" onClick={resetDefaults}>恢复默认值</button>
        <button className="btn btn-ghost" onClick={copyResult}>复制计算结果</button>
        <button className="btn btn-primary" onClick={shareLink}>生成分享链接</button>
      </div>

      {/* 风险提示 */}
      <footer className="risk">
        <strong>风险提示</strong>
        <p>本工具仅用于持仓成本和交易情景测算, <u>不构成证券投资建议</u>。计算结果基于用户输入的假设成交价格, 可能未完全考虑佣金、印花税、滑点、成交失败以及价格继续下跌等风险。补仓会增加持仓规模和风险敞口, 做T也可能产生卖飞、追高买回或进一步亏损的风险。请独立判断, 自负盈亏。</p>
      </footer>

      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </div>
  )
}

// ===== 子组件 =====

function NumberField({ label, unit, value, onChange, placeholder }) {
  return (
    <label className="field">
      <span className="label">{label} <em>{unit}</em></span>
      <input type="number" step="0.01" min="0" inputMode="decimal"
        value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)} />
    </label>
  )
}

function ResultItem({ label, value, className }) {
  return (
    <div className="result-item">
      <span className="result-label">{label}</span>
      <span className={`result-value ${className || ''}`}>{value}</span>
    </div>
  )
}

function MaCard({ quote }) {
  const d = quote
  const mas = [['MA5', d.ma5], ['MA8', d.ma8], ['MA13', d.ma13], ['MA20', d.ma20], ['MA60', d.ma60]]
  const lvMap = { '紧': 'lv-tight', '偏紧': 'lv-midtight', '偏松': 'lv-midloose', '发散': 'lv-loose' }
  const hintMap = {
    '紧': '均线高度粘合, 抛压最重, 建议高比例清仓',
    '偏紧': '均线偏紧, 抛压较重',
    '偏松': '均线偏松, 适度清仓',
    '发散': '均线分散, 做T风险高, 优先减波段仓',
  }
  let hint = ''
  if (d.first_resistance != null) {
    hint = `第一压力位 = ${d.resistance_ma} ${fmtNum(d.first_resistance)} 元`
    hint += `(${hintMap[d.cohesion_level] || ''})`
    if (d.suggested_clear_ratio != null) hint += `, 参考清仓比例 ${Math.round(d.suggested_clear_ratio * 100)}%`
    hint += '。已自动填入目标卖出价。'
  } else {
    hint = '所有均线均在当前价下方, 暂无明确均线压力位。目标卖出价请手填。'
  }
  return (
    <section className="ma-card card">
      <div className="ma-card-head">
        <h2>{d.name} ({d.code}) 收盘 {fmtNum(d.current_price)} {d.last_date}</h2>
        {d.cohesion_level && (
          <span className={`badge ${lvMap[d.cohesion_level] || ''}`}>
            均线{d.cohesion_level} 粘合{d.cohesion_pct}%
          </span>
        )}
      </div>
      <div className="ma-grid">
        {mas.map(([name, val]) => (
          <div key={name} className={`ma-cell ${name === d.resistance_ma ? 'is-resistance' : ''}`}>
            <div className="ma-name">{name}{name === d.resistance_ma ? ' ◀ 压力位' : ''}</div>
            <div className="ma-val">{val != null ? fmtNum(val) : '—'}</div>
          </div>
        ))}
      </div>
      <div className="ma-hint">{hint}</div>
    </section>
  )
}

function ActualRows({ input, update }) {
  const N = Math.round(+input.tTimes || 2)
  const rows = buildActualRows(input)
  const setRow = (i, key, val) => {
    const next = rows.map((r, idx) => idx === i ? { ...r, [key]: val } : r)
    // 存到 input.actualRows_ 前缀, 通过自定义字段传递
    update('actualRows_', next)
  }
  return (
    <div className="actual-wrap">
      <p className="mini-hint">填每次T的买价/卖价(元/股), 按T仓位比例折算降本</p>
      {Array.from({ length: N }).map((_, i) => (
        <div className="actual-row" key={i}>
          <span className="ar-tag">第{i + 1}次</span>
          <input type="number" className="ar-buy" placeholder="买价" step="0.01" inputMode="decimal"
            value={rows[i]?.buy || ''} onChange={e => setRow(i, 'buy', e.target.value)} />
          <input type="number" className="ar-sell" placeholder="卖价" step="0.01" inputMode="decimal"
            value={rows[i]?.sell || ''} onChange={e => setRow(i, 'sell', e.target.value)} />
        </div>
      ))}
    </div>
  )
}

// ===== 辅助函数 =====

function buildActualRows(input) {
  if (input.tBasis !== 'actual') return []
  const N = Math.round(+input.tTimes || 2)
  const stored = input.actualRows_ || []
  return Array.from({ length: N }).map((_, i) => stored[i] || { buy: '', sell: '' })
}

// 根据目标价类型, 从行情数据取对应的卖出价
//   auto   → 压力位 (后端算的 MA20/MA60 较低者)
//   ma60   → MA60
//   ma20   → MA20
//   custom → null (用户手填, 不覆盖)
function sellPriceByType(type, d) {
  if (!d) return null
  if (type === 'auto') return d.first_resistance
  if (type === 'ma60') return d.ma60
  if (type === 'ma20') return d.ma20
  return null  // custom
}

function applyQuoteToInput(d, input, update) {
  update('current', d.current_price)
  // 按当前目标价类型填卖出价(custom 不覆盖)
  const sp = sellPriceByType(input.sellType, d)
  if (sp != null && (input.sellType !== 'custom' || input.sellPrice === '' || input.sellPrice == null)) {
    update('sellPrice', sp)
  }
  // 建议清仓比例仅在 waveRatio 为空时填(不覆盖用户已设值)
  if (d.suggested_clear_ratio != null && (input.waveRatio === '' || input.waveRatio == null)) {
    update('waveRatio', Math.round(d.suggested_clear_ratio * 100))
  }
}

function loadFromUrl() {
  const params = new URLSearchParams(location.search)
  let any = false
  const obj = {}
  URL_KEYS.forEach(k => {
    if (params.has(k)) {
      any = true
      const v = params.get(k)
      if (k === 'feeEnabled') obj[k] = v === '1' || v === 'true'
      else if (k === 'tBasis') obj[k] = v
      else obj[k] = v
    }
  })
  return any ? { ...DEFAULTS, ...obj } : null
}

function syncUrl(input) {
  const params = new URLSearchParams()
  URL_KEYS.forEach(k => {
    const v = input[k]
    if (v !== '' && v != null) {
      if (k === 'feeEnabled') params.set(k, v ? '1' : '0')
      else params.set(k, v)
    }
  })
  const qs = params.toString()
  const newUrl = location.pathname + (qs ? '?' + qs : '')
  history.replaceState(null, '', newUrl)
}
