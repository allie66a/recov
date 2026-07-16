# 股票回本计划计算器

通过**波段加仓 + 滚动做T** 估算调整后的持仓成本和回本距离。填股票代码自动拉 tushare 行情算均线压力位，再给出可视化的回本计划与情景对比。

> ⚠️ **仅用于测算，不构成投资建议。** 见页面底部风险提示。

技术栈：**React + Vite + JavaScript**，前端纯本地计算；可选的 Python serverless 函数（`api/quote.py`）提供 tushare 行情自动拉取。

---

## 功能

- **自动行情**（可选）：输入股票代码 → 调 `/api/quote` → 自动拉前复权日线 → 算 MA5/8/13/20/60 → 在 MA20/MA60 中判定第一压力位（取股价上方、两者较低者）+ 均线粘合度 → 自动填入目标卖出价
- **回本计划**：原成本、加仓价/比例、目标卖出价、做T 参数 → 实时算出调整后新回本价、累计降本、还需涨幅
- **情景对比**：不操作 / 只波段 / +1T / +2T / +3T / 自定义，直观看出每多做一次T 的边际效果
- **交易费用**：可选计入佣金/印花税/滑点
- **分享链接**：参数编码进 URL，复制发给别人，打开即恢复
- **深浅色 + 响应式**：手机/电脑都能用

## 计算公式

设：`C`=原成本，`B`=加仓价，`S`=目标卖出价，`P`=波段仓位比例，`tRatio`=做T仓位比例，`R`=单次T收益率，`N`=做T次数，`Q`=原持仓股数

| 指标 | 公式 |
|------|------|
| 波段降本 | `(S − B) × P` |
| 做T降本 | `S × R × tRatio × N`（估算）或 `Σ(卖−买) × tRatio`（实际价差） |
| 累计降本 | `波段降本 + 做T降本` |
| 新回本价 | `C − 累计降本 + 总费用/Q` |
| 目标价后需涨幅 | `(新回本价 − S) / S × 100%` |
| 当前价→回本价 | `(新回本价 − 当前价) / 当前价 × 100%` |
| 总减亏金额 | `累计降本 × Q` |
| 加仓资金 | `B × Q × P` |

所有公式集中在 `src/utils/calculations.js`。

**验证案例**（联特，原成本 333）：波段 17.4 + 做T 8.79 = 累计 26.19 → 新回本价 306.81 → 需涨 4.71% ✅

## 文件结构

```
recovery_calculator/
├── index.html              # Vite 入口(根目录)
├── package.json            # 依赖 + 脚本
├── vite.config.js          # Vite React 配置, base="/"
├── vercel.json             # 路由: /api/* 走 python, 其余回 index.html
├── requirements.txt        # Python 依赖(api/quote.py 用: tushare, pandas)
├── .env.example            # TUSHARE_TOKEN 占位(真实值只放 Vercel)
├── api/
│   └── quote.py            # Vercel serverless: tushare + MA + 压力位 + 粘合度
├── public/
│   └── favicon.svg
├── src/
│   ├── main.jsx            # React 挂载
│   ├── App.jsx             # 完整界面 + 交互
│   ├── styles.css          # 卡片 + 深浅色 + 响应式
│   └── utils/
│       └── calculations.js # 所有计算公式(纯函数)
├── local_fetch.py          # 本地 tushare 预览脚本(不部署, 本地看行情)
└── README.md
```

---

## 本地运行

### 前端开发

```bash
cd recovery_calculator
npm install
npm run dev
# 访问 http://localhost:5173
```

> 不配 token 也能用：价格全部手填，计算功能完全正常。只是"拉取行情"按钮会失败（提示手填）。

### 完整本地运行（含 tushare 拉取）

```bash
npm install -g vercel      # 装 Vercel CLI
export TUSHARE_TOKEN=你的token
vercel dev                 # 同时跑前端 + python serverless
```

### 只想本地看某只股票的均线压力位

```bash
export TUSHARE_TOKEN=你的token
python3 local_fetch.py 301003        # 代码
python3 local_fetch.py 联特           # 中文名
```
把输出的价格手动填进网页。

---

## 生产构建

```bash
npm run build              # 生成 dist/
npm run preview            # 本地预览构建产物
```

`dist/` 目录结构：
```
dist/
├── index.html
└── assets/
```

---

## 部署到 Vercel（推荐）

### 1. 上传 GitHub

```bash
cd recovery_calculator
git init
git add .
git commit -m "Initial release"
git branch -M main
git remote add origin <GitHub仓库地址>
git push -u origin main
```

> ⚠️ 确认 `.env.example` 里没有真实 token。真实 token 绝不能进仓库。
> 建议加 `.gitignore` 忽略 `node_modules/` 和 `dist/`。

### 2. 导入 Vercel

1. 登录 [vercel.com](https://vercel.com) → 用 GitHub 登录
2. **Add New → Project** → 选刚才的仓库 → Import
3. Vercel 自动识别为 **Vite** 项目，配置应为：
   ```
   Framework Preset:  Vite
   Root Directory:    ./
   Install Command:   npm install
   Build Command:     npm run build
   Output Directory:  dist
   ```
4. 点 **Deploy**

### 3. 配置环境变量（让行情拉取生效）

- **Project Settings → Environment Variables**
- 新增 `TUSHARE_TOKEN` = 你的 tushare token
- （可选）主备双 token：`主线token,副线token`（逗号分隔，主线失败自动降级）
- 保存后 **Redeploy** 一次让变量生效

### 4. 完成

得到地址如 `https://recovery-calculator-xxx.vercel.app`。之后每次 `git push` 自动重新部署。

---

## 修改默认参数

编辑 `src/utils/calculations.js` 顶部的 `DEFAULTS` 对象。

## 安全说明

- **tushare token 只配置在 Vercel 环境变量**，绝不进代码或仓库
- 前端不收集、不上传、不保存任何用户输入
- 分享链接的数据只存在于 URL 和浏览器中
- MA/压力位用前复权（qfq）价，遵守数据复权纪律

## 数据复权纪律

后端 `api/quote.py` 使用 `ts.pro_bar(adj='qfq')` 拉前复权数据。MA、压力位一律用复权价计算，禁止喂不复权原始价（除权日虚假跳空会制造伪信号）。

---

## 风险声明

本工具仅用于持仓成本和交易情景测算，**不构成证券投资建议**。计算结果基于用户输入的假设成交价格，可能未完全考虑佣金、印花税、滑点、成交失败以及价格继续下跌等风险。

**补仓会增加持仓规模和风险敞口，做T也可能产生卖飞、追高买回或进一步亏损的风险。** 请独立判断，自负盈亏。
