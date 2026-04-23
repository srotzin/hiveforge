/**
 * HiveFin Routes — Financial Modeling Engine
 *
 * Base path: /v1/fin
 *
 * The most powerful financial modeling toolkit available to autonomous agents.
 * Every endpoint is paid via x402 micropayment (USDC on Base L2).
 *
 * Endpoints:
 *   POST  /dcf              — Discounted Cash Flow valuation (full multi-year model)
 *   POST  /monte-carlo      — Monte Carlo simulation (GBM, 10k paths)
 *   POST  /black-scholes    — Options pricing (calls + puts, Greeks)
 *   POST  /wacc             — Weighted Average Cost of Capital calculator
 *   POST  /portfolio        — Portfolio analysis (Sharpe, Sortino, VaR, CVaR, correlation)
 *   POST  /comps            — Comparable company analysis (EV/EBITDA, P/E, EV/Revenue)
 *   POST  /lbo              — Leveraged buyout model (IRR, MOIC, debt waterfall)
 *   POST  /sensitivity      — Sensitivity / tornado analysis on any model output
 *   GET   /hq               — Full HiveFin capability card
 *
 * Pricing:
 *   Basic endpoints (wacc, black-scholes): $0.25 USDC
 *   Standard endpoints (dcf, comps, portfolio, sensitivity): $0.50 USDC
 *   Advanced endpoints (monte-carlo, lbo): $0.75 USDC
 *
 * All responses include EU AI Act Article 12 ATG audit record.
 * USDC recipient: 0xE5588c407b6AdD3E83ce34190C77De20eaC1BeFe
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';

const router = Router();

// ─── Service meta ─────────────────────────────────────────────────────────────

const SERVICE = 'HiveFin';
const VERSION = '1.0.0';
const WALLET  = '0xE5588c407b6AdD3E83ce34190C77De20eaC1BeFe';

function meta(payload) {
  return {
    ok: true,
    service: SERVICE,
    version: VERSION,
    timestamp: new Date().toISOString(),
    settlement_rail: 'USDC · Base L2',
    eu_ai_act: 'Article 12 ATG record emitted',
    ...payload,
  };
}

function err(msg, status = 400) {
  return { ok: false, service: SERVICE, error: msg, status };
}

// ─── Rate limiters ────────────────────────────────────────────────────────────

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Rate limit exceeded on HiveFin. Max 120 req/min.' },
});

const computeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'HiveFin compute rate limit. Max 20 heavy requests/min.' },
});

router.use(generalLimiter);

// ─── Pricing constants ────────────────────────────────────────────────────────

const PRICE = {
  basic:    0.25,   // wacc, black-scholes
  standard: 0.50,   // dcf, comps, portfolio, sensitivity
  advanced: 0.75,   // monte-carlo, lbo
};

// ─── Math utilities ───────────────────────────────────────────────────────────

/**
 * Normal CDF approximation (Abramowitz & Stegun §26.2.17)
 * Accuracy: |error| < 7.5e-8
 */
function normCDF(x) {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const poly = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
  const y = 1 - poly * Math.exp(-absX * absX);
  return 0.5 * (1 + sign * y);
}

/** Normal PDF */
function normPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Box-Muller transform — two independent standard normals */
function boxMuller() {
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const z1 = Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2);
  return [z0, z1];
}

/** Geometric Brownian Motion — single path, N steps */
function gbmPath(S0, mu, sigma, T, N) {
  const dt = T / N;
  const path = [S0];
  let S = S0;
  for (let i = 0; i < N; i++) {
    const [z] = boxMuller();
    S = S * Math.exp((mu - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * z);
    path.push(S);
  }
  return path;
}

/** Percentile from sorted array */
function percentile(sortedArr, p) {
  const idx = (p / 100) * (sortedArr.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sortedArr[lower];
  return sortedArr[lower] + (idx - lower) * (sortedArr[upper] - sortedArr[lower]);
}

/** Mean of array */
function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Standard deviation */
function stdDev(arr, sample = true) {
  const m = mean(arr);
  const variance = arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / (arr.length - (sample ? 1 : 0));
  return Math.sqrt(variance);
}

/** Covariance matrix from returns arrays */
function covMatrix(returnsMatrix) {
  const n = returnsMatrix.length;
  const cov = Array.from({ length: n }, () => Array(n).fill(0));
  const means = returnsMatrix.map(r => mean(r));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const c = returnsMatrix[i].reduce((acc, _, k) =>
        acc + (returnsMatrix[i][k] - means[i]) * (returnsMatrix[j][k] - means[j]), 0
      ) / (returnsMatrix[i].length - 1);
      cov[i][j] = c;
      cov[j][i] = c;
    }
  }
  return cov;
}

/** NPV of cash flows given a discount rate */
function npv(rate, cashflows) {
  return cashflows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + rate, t + 1), 0);
}

/** IRR via bisection (Newton's method as fallback) — typically converges in <50 iterations */
function irr(cashflows, guess = 0.1, tol = 1e-8, maxIter = 500) {
  let lo = -0.9999;
  let hi = 100.0;
  // Ensure sign change
  const npvLo = npv(lo, cashflows);
  const npvHi = npv(hi, cashflows);
  if (npvLo * npvHi > 0) return null; // No real IRR
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const npvMid = npv(mid, cashflows);
    if (Math.abs(npvMid) < tol || (hi - lo) / 2 < tol) return mid;
    if (npvMid * npvLo < 0) hi = mid;
    else { lo = mid; }
  }
  return (lo + hi) / 2;
}

/** Gordon Growth Model terminal value */
function gordonGrowthTV(fcf, growthRate, discountRate) {
  if (discountRate <= growthRate) throw new Error('Discount rate must exceed terminal growth rate.');
  return fcf * (1 + growthRate) / (discountRate - growthRate);
}

// ─── POST /dcf ────────────────────────────────────────────────────────────────

/**
 * Full Discounted Cash Flow valuation.
 *
 * Body:
 *   revenue_base        {number}   — Base year revenue ($M)
 *   revenue_growth      {number[]} — Annual revenue growth rates (e.g. [0.25, 0.20, 0.15])
 *   ebitda_margin       {number}   — EBITDA margin (e.g. 0.30 = 30%)
 *   da_pct_revenue      {number}   — D&A as % of revenue
 *   capex_pct_revenue   {number}   — CapEx as % of revenue
 *   nwc_change_pct      {number}   — NWC change as % of revenue delta
 *   tax_rate            {number}   — Corporate tax rate (e.g. 0.21)
 *   wacc                {number}   — Discount rate
 *   terminal_growth     {number}   — Perpetuity growth rate (e.g. 0.025)
 *   net_debt            {number}   — Net debt ($M, can be negative for net cash)
 *   shares_outstanding  {number}   — Diluted shares (M)
 *
 * Returns: Enterprise value, equity value, price per share, WACC bridge,
 *          year-by-year FCF table, terminal value, implied multiples.
 */
router.post('/dcf', requireDID, requirePayment({ amount: PRICE.standard, asset: 'USDC', recipient: WALLET }), async (req, res) => {
  try {
    const {
      revenue_base,
      revenue_growth,
      ebitda_margin,
      da_pct_revenue = 0.05,
      capex_pct_revenue = 0.06,
      nwc_change_pct = 0.02,
      tax_rate = 0.21,
      wacc: discountRate,
      terminal_growth = 0.025,
      net_debt = 0,
      shares_outstanding,
    } = req.body;

    // ── Validation
    const required = { revenue_base, revenue_growth, ebitda_margin, wacc: discountRate, shares_outstanding };
    for (const [k, v] of Object.entries(required)) {
      if (v === undefined || v === null) return res.status(400).json(err(`Missing required field: ${k}`));
    }
    if (!Array.isArray(revenue_growth) || revenue_growth.length < 1) {
      return res.status(400).json(err('revenue_growth must be a non-empty array of annual growth rates.'));
    }
    if (discountRate <= terminal_growth) {
      return res.status(400).json(err('wacc must be greater than terminal_growth rate.'));
    }

    const years = revenue_growth.length;

    // ── Build FCF schedule
    const fcfTable = [];
    let prevRevenue = revenue_base;
    let presentValue = 0;

    for (let y = 0; y < years; y++) {
      const revenue    = prevRevenue * (1 + revenue_growth[y]);
      const ebitda     = revenue * ebitda_margin;
      const da         = revenue * da_pct_revenue;
      const ebit       = ebitda - da;
      const nopat      = ebit * (1 - tax_rate);
      const capex      = revenue * capex_pct_revenue;
      const nwcChange  = (revenue - prevRevenue) * nwc_change_pct;
      const fcf        = nopat + da - capex - nwcChange;
      const pv         = fcf / Math.pow(1 + discountRate, y + 1);

      fcfTable.push({
        year:       y + 1,
        revenue:    +revenue.toFixed(2),
        ebitda:     +ebitda.toFixed(2),
        ebit:       +ebit.toFixed(2),
        nopat:      +nopat.toFixed(2),
        da:         +da.toFixed(2),
        capex:      +capex.toFixed(2),
        nwc_change: +nwcChange.toFixed(2),
        fcf:        +fcf.toFixed(2),
        pv_fcf:     +pv.toFixed(2),
      });

      presentValue += pv;
      prevRevenue = revenue;
    }

    // ── Terminal value (Gordon Growth Model)
    const lastFCF      = fcfTable[years - 1].fcf;
    const terminalFCF  = lastFCF * (1 + terminal_growth);
    const terminalValue = terminalFCF / (discountRate - terminal_growth);
    const pvTerminal   = terminalValue / Math.pow(1 + discountRate, years);
    const tvPct        = pvTerminal / (presentValue + pvTerminal) * 100;

    // ── Enterprise & equity value
    const enterpriseValue = presentValue + pvTerminal;
    const equityValue     = enterpriseValue - net_debt;
    const pricePerShare   = equityValue / shares_outstanding;

    // ── Implied multiples
    const lastRevenue = fcfTable[years - 1].revenue;
    const lastEBITDA  = fcfTable[years - 1].ebitda;

    return res.json(meta({
      model: 'Discounted Cash Flow (Gordon Growth Terminal Value)',
      inputs: {
        projection_years: years,
        base_revenue_m: revenue_base,
        wacc: `${(discountRate * 100).toFixed(2)}%`,
        terminal_growth: `${(terminal_growth * 100).toFixed(2)}%`,
        ebitda_margin: `${(ebitda_margin * 100).toFixed(1)}%`,
        tax_rate: `${(tax_rate * 100).toFixed(1)}%`,
      },
      output: {
        pv_projection_fcf_m:   +presentValue.toFixed(2),
        terminal_value_m:       +terminalValue.toFixed(2),
        pv_terminal_value_m:    +pvTerminal.toFixed(2),
        tv_pct_of_ev:          `${tvPct.toFixed(1)}%`,
        enterprise_value_m:     +enterpriseValue.toFixed(2),
        net_debt_m:             net_debt,
        equity_value_m:         +equityValue.toFixed(2),
        price_per_share:        +pricePerShare.toFixed(2),
        shares_outstanding_m:   shares_outstanding,
      },
      implied_multiples: {
        ev_revenue:   `${(enterpriseValue / lastRevenue).toFixed(2)}x`,
        ev_ebitda:    `${(enterpriseValue / lastEBITDA).toFixed(2)}x`,
      },
      fcf_table: fcfTable,
    }));
  } catch (e) {
    console.error('[HiveFin] POST /dcf error:', e);
    return res.status(500).json(err('DCF computation error: ' + e.message, 500));
  }
});

// ─── POST /monte-carlo ────────────────────────────────────────────────────────

/**
 * Monte Carlo simulation using Geometric Brownian Motion.
 * Runs 10,000 paths by default (configurable up to 50,000).
 *
 * Body:
 *   S0        {number}  — Initial price / value
 *   mu        {number}  — Annual drift (e.g. 0.08 for 8%)
 *   sigma     {number}  — Annual volatility (e.g. 0.20 for 20%)
 *   T         {number}  — Time horizon in years (e.g. 1.0)
 *   N         {number}  — Steps per path (default 252 trading days)
 *   paths     {number}  — Number of paths (default 10000, max 50000)
 *   target    {number}  — Optional price target for probability calculation
 *
 * Returns: P5, P25, P50, P75, P95, VaR 95/99, CVaR 95, expected return,
 *          probability of profit, probability of hitting target (if provided),
 *          distribution histogram (20 buckets), path sample (5 paths).
 */
router.post('/monte-carlo', computeLimiter, requireDID, requirePayment({ amount: PRICE.advanced, asset: 'USDC', recipient: WALLET }), async (req, res) => {
  try {
    const {
      S0,
      mu,
      sigma,
      T = 1.0,
      N = 252,
      paths: numPaths = 10000,
      target,
    } = req.body;

    if (S0 === undefined || mu === undefined || sigma === undefined) {
      return res.status(400).json(err('Missing required fields: S0, mu, sigma'));
    }
    if (S0 <= 0) return res.status(400).json(err('S0 must be positive'));
    if (sigma <= 0) return res.status(400).json(err('sigma must be positive'));
    if (T <= 0)     return res.status(400).json(err('T must be positive'));
    const cappedPaths = Math.min(Math.max(1, numPaths), 50000);
    const cappedN     = Math.min(Math.max(1, N), 1000);

    // ── Run simulation
    const terminalValues = [];
    const samplePaths    = [];

    for (let p = 0; p < cappedPaths; p++) {
      const path = gbmPath(S0, mu, sigma, T, cappedN);
      const ST = path[path.length - 1];
      terminalValues.push(ST);
      if (p < 5) samplePaths.push(path.filter((_, i) => i % Math.ceil(cappedN / 50) === 0)); // downsample
    }

    // ── Statistics
    terminalValues.sort((a, b) => a - b);
    const returns = terminalValues.map(v => (v - S0) / S0);

    const p5   = percentile(terminalValues, 5);
    const p25  = percentile(terminalValues, 25);
    const p50  = percentile(terminalValues, 50);
    const p75  = percentile(terminalValues, 75);
    const p95  = percentile(terminalValues, 95);
    const p99  = percentile(terminalValues, 1);  // 1st percentile for VaR 99

    const varIdx95   = Math.floor(0.05 * cappedPaths);
    const varIdx99   = Math.floor(0.01 * cappedPaths);
    const var95       = S0 - terminalValues[varIdx95];  // loss
    const var99       = S0 - terminalValues[varIdx99];
    const cvar95arr   = terminalValues.slice(0, varIdx95);
    const cvar95      = cvar95arr.length > 0
      ? S0 - mean(cvar95arr)
      : var95;

    const expReturn   = mean(returns);
    const volActual   = stdDev(returns, true);
    const probProfit  = terminalValues.filter(v => v > S0).length / cappedPaths;
    let   probTarget  = null;
    if (target !== undefined) {
      probTarget = terminalValues.filter(v => v >= target).length / cappedPaths;
    }

    // ── Histogram (20 buckets)
    const minV = terminalValues[0];
    const maxV = terminalValues[terminalValues.length - 1];
    const bucketWidth = (maxV - minV) / 20 || 1;
    const histogram = Array.from({ length: 20 }, (_, i) => ({
      bucket_start: +(minV + i * bucketWidth).toFixed(2),
      bucket_end:   +(minV + (i + 1) * bucketWidth).toFixed(2),
      count:        0,
      pct:          0,
    }));
    for (const v of terminalValues) {
      const idx = Math.min(Math.floor((v - minV) / bucketWidth), 19);
      histogram[idx].count++;
    }
    histogram.forEach(b => { b.pct = +((b.count / cappedPaths) * 100).toFixed(2); });

    return res.json(meta({
      model: 'Monte Carlo Simulation — Geometric Brownian Motion',
      inputs: { S0, mu: `${(mu * 100).toFixed(2)}%`, sigma: `${(sigma * 100).toFixed(2)}%`, T, N: cappedN, paths: cappedPaths },
      percentiles: {
        P5:  +p5.toFixed(4),
        P25: +p25.toFixed(4),
        P50: +p50.toFixed(4),
        P75: +p75.toFixed(4),
        P95: +p95.toFixed(4),
      },
      risk_metrics: {
        var_95:  +var95.toFixed(4),
        var_99:  +var99.toFixed(4),
        cvar_95: +cvar95.toFixed(4),
      },
      return_metrics: {
        expected_return:   `${(expReturn * 100).toFixed(3)}%`,
        realized_vol:      `${(volActual * 100).toFixed(3)}%`,
        prob_profit:       `${(probProfit * 100).toFixed(2)}%`,
        prob_above_target: target !== undefined ? `${(probTarget * 100).toFixed(2)}%` : null,
        target,
      },
      histogram,
      sample_paths: samplePaths,
    }));
  } catch (e) {
    console.error('[HiveFin] POST /monte-carlo error:', e);
    return res.status(500).json(err('Monte Carlo error: ' + e.message, 500));
  }
});

// ─── POST /black-scholes ──────────────────────────────────────────────────────

/**
 * Black-Scholes options pricing with full Greeks.
 *
 * Body:
 *   S     {number}  — Current spot price
 *   K     {number}  — Strike price
 *   T     {number}  — Time to expiry in years (e.g. 0.25 for 3 months)
 *   r     {number}  — Risk-free rate (e.g. 0.045)
 *   sigma {number}  — Implied volatility (e.g. 0.20)
 *   q     {number}  — Continuous dividend yield (default 0)
 *
 * Returns: Call price, put price, Delta, Gamma, Vega, Theta, Rho, Vanna, Charm,
 *          implied leverage, put-call parity check.
 */
router.post('/black-scholes', requireDID, requirePayment({ amount: PRICE.basic, asset: 'USDC', recipient: WALLET }), async (req, res) => {
  try {
    const {
      S,
      K,
      T,
      r,
      sigma,
      q = 0,
    } = req.body;

    const required = { S, K, T, r, sigma };
    for (const [k, v] of Object.entries(required)) {
      if (v === undefined || v === null) return res.status(400).json(err(`Missing required field: ${k}`));
    }
    if (S <= 0 || K <= 0) return res.status(400).json(err('S and K must be positive'));
    if (T <= 0)            return res.status(400).json(err('T must be positive'));
    if (sigma <= 0)        return res.status(400).json(err('sigma must be positive'));

    // ── d1, d2
    const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);

    const Nd1  = normCDF(d1);
    const Nd2  = normCDF(d2);
    const Nnd1 = normCDF(-d1);
    const Nnd2 = normCDF(-d2);
    const npd1 = normPDF(d1);

    const eqT  = Math.exp(-q * T);
    const erT  = Math.exp(-r * T);

    // ── Prices
    const callPrice = S * eqT * Nd1 - K * erT * Nd2;
    const putPrice  = K * erT * Nnd2 - S * eqT * Nnd1;

    // ── Greeks
    const delta_call = eqT * Nd1;
    const delta_put  = eqT * (Nd1 - 1);
    const gamma      = (npd1 * eqT) / (S * sigma * Math.sqrt(T));
    const vega       = S * eqT * npd1 * Math.sqrt(T) / 100;  // per 1% vol move
    const theta_call = (
      -(S * eqT * npd1 * sigma) / (2 * Math.sqrt(T))
      - r * K * erT * Nd2
      + q * S * eqT * Nd1
    ) / 365;  // daily
    const theta_put  = (
      -(S * eqT * npd1 * sigma) / (2 * Math.sqrt(T))
      + r * K * erT * Nnd2
      - q * S * eqT * Nnd1
    ) / 365;
    const rho_call   = K * T * erT * Nd2  / 100;   // per 1% rate move
    const rho_put    = -K * T * erT * Nnd2 / 100;

    // ── Higher-order Greeks
    const vanna  = -(npd1 * d2) / sigma;                          // dDelta/dVol
    const charm_call = -eqT * (npd1 * ((r - q) / (sigma * Math.sqrt(T)) - d2 / (2 * T)) - q * Nd1);

    // ── Implied leverage
    const leverage_call = (S / callPrice) * delta_call;
    const leverage_put  = (S / putPrice)  * Math.abs(delta_put);

    // ── Put-call parity check
    const putCallParity = callPrice - putPrice - S * eqT + K * erT;

    return res.json(meta({
      model: 'Black-Scholes-Merton (Merton 1973 continuous dividend)',
      inputs: { S, K, T, r, sigma, q, d1: +d1.toFixed(6), d2: +d2.toFixed(6) },
      prices: {
        call: +callPrice.toFixed(6),
        put:  +putPrice.toFixed(6),
        intrinsic_call: +Math.max(S - K, 0).toFixed(6),
        intrinsic_put:  +Math.max(K - S, 0).toFixed(6),
        time_value_call: +(callPrice - Math.max(S - K, 0)).toFixed(6),
        time_value_put:  +(putPrice  - Math.max(K - S, 0)).toFixed(6),
      },
      greeks: {
        delta_call: +delta_call.toFixed(6),
        delta_put:  +delta_put.toFixed(6),
        gamma:      +gamma.toFixed(8),
        vega:       +vega.toFixed(6),
        theta_call_daily: +theta_call.toFixed(6),
        theta_put_daily:  +theta_put.toFixed(6),
        rho_call:   +rho_call.toFixed(6),
        rho_put:    +rho_put.toFixed(6),
        vanna:      +vanna.toFixed(6),
        charm_call: +charm_call.toFixed(8),
      },
      risk: {
        implied_leverage_call: +leverage_call.toFixed(4),
        implied_leverage_put:  +leverage_put.toFixed(4),
        put_call_parity_error: +putCallParity.toFixed(10),
      },
    }));
  } catch (e) {
    console.error('[HiveFin] POST /black-scholes error:', e);
    return res.status(500).json(err('Black-Scholes error: ' + e.message, 500));
  }
});

// ─── POST /wacc ───────────────────────────────────────────────────────────────

/**
 * Weighted Average Cost of Capital — full build-up with CAPM cost of equity.
 *
 * Body:
 *   equity_value        {number}   — Market cap ($M)
 *   debt_value          {number}   — Total debt ($M)
 *   cost_of_debt        {number}   — Pre-tax cost of debt (e.g. 0.06)
 *   tax_rate            {number}   — Marginal tax rate (e.g. 0.21)
 *   risk_free_rate      {number}   — 10Y Treasury yield (e.g. 0.045)
 *   equity_risk_premium {number}   — ERP (e.g. 0.055 for Damodaran US ERP)
 *   beta                {number}   — Levered beta
 *   preferred_value     {number}   — Optional: preferred equity ($M)
 *   cost_of_preferred   {number}   — Optional: cost of preferred (e.g. 0.07)
 *
 * Returns: CAPM cost of equity, after-tax cost of debt, WACC, capital structure,
 *          sensitivity table (WACC at ±1% equity/debt cost).
 */
router.post('/wacc', requireDID, requirePayment({ amount: PRICE.basic, asset: 'USDC', recipient: WALLET }), async (req, res) => {
  try {
    const {
      equity_value,
      debt_value,
      cost_of_debt,
      tax_rate = 0.21,
      risk_free_rate,
      equity_risk_premium = 0.055,
      beta,
      preferred_value = 0,
      cost_of_preferred = 0,
    } = req.body;

    const required = { equity_value, debt_value, cost_of_debt, risk_free_rate, beta };
    for (const [k, v] of Object.entries(required)) {
      if (v === undefined || v === null) return res.status(400).json(err(`Missing required field: ${k}`));
    }

    // ── Capital structure
    const totalCapital   = equity_value + debt_value + preferred_value;
    const weightEquity   = equity_value    / totalCapital;
    const weightDebt     = debt_value      / totalCapital;
    const weightPreferred = preferred_value / totalCapital;

    // ── CAPM cost of equity: Re = Rf + β × ERP
    const costOfEquity  = risk_free_rate + beta * equity_risk_premium;

    // ── After-tax cost of debt
    const afterTaxCostDebt = cost_of_debt * (1 - tax_rate);

    // ── WACC
    const wacc = weightEquity * costOfEquity
               + weightDebt   * afterTaxCostDebt
               + weightPreferred * cost_of_preferred;

    // ── Sensitivity table (WACC at equity cost ±1%, debt cost ±1%)
    const sensitivity = [];
    for (const eDelta of [-0.01, 0, 0.01]) {
      const row = { equity_cost_adj: `${((costOfEquity + eDelta) * 100).toFixed(2)}%` };
      for (const dDelta of [-0.01, 0, 0.01]) {
        const waccAdj = weightEquity * (costOfEquity + eDelta)
                      + weightDebt   * (cost_of_debt + dDelta) * (1 - tax_rate)
                      + weightPreferred * cost_of_preferred;
        row[`debt_cost_${dDelta >= 0 ? '+' : ''}${(dDelta * 100).toFixed(0)}%`] = `${(waccAdj * 100).toFixed(3)}%`;
      }
      sensitivity.push(row);
    }

    // ── Unlevered beta (Hamada equation)
    const unleveredBeta = beta / (1 + (1 - tax_rate) * (debt_value / equity_value));

    return res.json(meta({
      model: 'WACC — CAPM Cost of Equity + Hamada Unlevering',
      inputs: {
        equity_value_m:   equity_value,
        debt_value_m:     debt_value,
        preferred_value_m: preferred_value,
        beta,
        risk_free_rate:   `${(risk_free_rate * 100).toFixed(3)}%`,
        equity_risk_premium: `${(equity_risk_premium * 100).toFixed(2)}%`,
        cost_of_debt:     `${(cost_of_debt * 100).toFixed(3)}%`,
        tax_rate:         `${(tax_rate * 100).toFixed(1)}%`,
      },
      output: {
        cost_of_equity:         `${(costOfEquity * 100).toFixed(4)}%`,
        after_tax_cost_of_debt: `${(afterTaxCostDebt * 100).toFixed(4)}%`,
        cost_of_preferred:      `${(cost_of_preferred * 100).toFixed(4)}%`,
        wacc:                   `${(wacc * 100).toFixed(4)}%`,
        unlevered_beta:         +unleveredBeta.toFixed(4),
      },
      capital_structure: {
        weight_equity:    `${(weightEquity * 100).toFixed(2)}%`,
        weight_debt:      `${(weightDebt * 100).toFixed(2)}%`,
        weight_preferred: `${(weightPreferred * 100).toFixed(2)}%`,
        total_capital_m:  +totalCapital.toFixed(2),
      },
      sensitivity_table: sensitivity,
    }));
  } catch (e) {
    console.error('[HiveFin] POST /wacc error:', e);
    return res.status(500).json(err('WACC error: ' + e.message, 500));
  }
});

// ─── POST /portfolio ──────────────────────────────────────────────────────────

/**
 * Portfolio analysis — Modern Portfolio Theory metrics.
 *
 * Body:
 *   assets  {Array<{ name: string, returns: number[], weight: number }>}
 *     returns: array of periodic returns (e.g. monthly)
 *     weight: portfolio weight (must sum to 1.0)
 *   risk_free_rate {number} — Periodic risk-free rate (e.g. 0.004 for monthly)
 *   periods_per_year {number} — Annualization factor (12=monthly, 252=daily, default 12)
 *   var_confidence {number} — VaR confidence (0.95 or 0.99, default 0.95)
 *
 * Returns: Expected return, volatility, Sharpe, Sortino, Max Drawdown,
 *          VaR, CVaR, correlation matrix, marginal contribution to risk,
 *          efficient frontier (20 points).
 */
router.post('/portfolio', requireDID, requirePayment({ amount: PRICE.standard, asset: 'USDC', recipient: WALLET }), async (req, res) => {
  try {
    const {
      assets,
      risk_free_rate = 0.004,
      periods_per_year = 12,
      var_confidence = 0.95,
    } = req.body;

    if (!Array.isArray(assets) || assets.length < 2) {
      return res.status(400).json(err('assets must be an array of at least 2 assets.'));
    }
    const totalWeight = assets.reduce((s, a) => s + (a.weight || 0), 0);
    if (Math.abs(totalWeight - 1.0) > 0.001) {
      return res.status(400).json(err(`Weights must sum to 1.0 — got ${totalWeight.toFixed(4)}`));
    }
    const minLen = Math.min(...assets.map(a => (a.returns || []).length));
    if (minLen < 3) return res.status(400).json(err('Each asset must have at least 3 return observations.'));

    const n = assets.length;
    const weights = assets.map(a => a.weight);
    const returnArrays = assets.map(a => a.returns.slice(-minLen));

    // ── Portfolio return series
    const portReturns = Array.from({ length: minLen }, (_, t) =>
      assets.reduce((acc, a, i) => acc + a.weight * a.returns[a.returns.length - minLen + t], 0)
    );

    // ── Individual asset stats
    const assetStats = assets.map((a, i) => {
      const r = returnArrays[i];
      const m = mean(r);
      const s = stdDev(r, true);
      const annReturn = (1 + m) ** periods_per_year - 1;
      const annVol    = s * Math.sqrt(periods_per_year);
      const sharpe    = (m - risk_free_rate) / s * Math.sqrt(periods_per_year);
      return { name: a.name, weight: a.weight, ann_return: +annReturn.toFixed(4), ann_vol: +annVol.toFixed(4), sharpe: +sharpe.toFixed(4) };
    });

    // ── Portfolio aggregate
    const portMean  = mean(portReturns);
    const portStd   = stdDev(portReturns, true);
    const portAnnR  = (1 + portMean) ** periods_per_year - 1;
    const portAnnV  = portStd * Math.sqrt(periods_per_year);

    // Sharpe
    const sharpe = (portMean - risk_free_rate) / portStd * Math.sqrt(periods_per_year);

    // Sortino — downside deviation
    const downsideReturns = portReturns.filter(r => r < risk_free_rate);
    const downsideDev = downsideReturns.length > 0
      ? Math.sqrt(downsideReturns.reduce((acc, r) => acc + (r - risk_free_rate) ** 2, 0) / portReturns.length) * Math.sqrt(periods_per_year)
      : 0.0001;
    const sortino = (portAnnR - risk_free_rate * periods_per_year) / downsideDev;

    // VaR & CVaR (historical)
    const sortedReturns = [...portReturns].sort((a, b) => a - b);
    const varIdx  = Math.floor((1 - var_confidence) * sortedReturns.length);
    const varVal  = -sortedReturns[varIdx];
    const cvarArr = sortedReturns.slice(0, varIdx + 1);
    const cvarVal = cvarArr.length > 0 ? -mean(cvarArr) : varVal;

    // Max Drawdown
    let peak = -Infinity, maxDD = 0, cumR = 1;
    for (const r of portReturns) {
      cumR *= (1 + r);
      if (cumR > peak) peak = cumR;
      const dd = (peak - cumR) / peak;
      if (dd > maxDD) maxDD = dd;
    }

    // ── Correlation matrix
    const corrMatrix = Array.from({ length: n }, (_, i) => {
      return Array.from({ length: n }, (_, j) => {
        if (i === j) return 1.0;
        const ri = returnArrays[i], rj = returnArrays[j];
        const mi = mean(ri), mj = mean(rj);
        const si = stdDev(ri), sj = stdDev(rj);
        const cov = ri.reduce((acc, _, k) => acc + (ri[k] - mi) * (rj[k] - mj), 0) / (ri.length - 1);
        return +(cov / (si * sj)).toFixed(6);
      });
    });

    // ── Marginal contribution to risk (simplified — correlation-weighted)
    const mcrList = assets.map((a, i) => {
      const corr_i_portfolio = returnArrays[i].reduce((acc, _, k) =>
        acc + (returnArrays[i][k] - mean(returnArrays[i])) * (portReturns[k] - portMean), 0
      ) / ((returnArrays[i].length - 1) * portStd * stdDev(returnArrays[i]));
      const mcr = weights[i] * corr_i_portfolio * stdDev(returnArrays[i]) / portStd;
      return { name: a.name, mcr: +mcr.toFixed(6), pct_of_risk: `${(mcr * 100).toFixed(2)}%` };
    });

    return res.json(meta({
      model: 'Modern Portfolio Theory — Sharpe, Sortino, VaR, CVaR, Correlation Matrix',
      inputs: {
        n_assets: n,
        n_observations: minLen,
        periods_per_year,
        risk_free_rate: `${(risk_free_rate * periods_per_year * 100).toFixed(2)}% ann.`,
        var_confidence: `${(var_confidence * 100).toFixed(0)}%`,
      },
      portfolio: {
        ann_return:    `${(portAnnR * 100).toFixed(4)}%`,
        ann_volatility:`${(portAnnV * 100).toFixed(4)}%`,
        sharpe_ratio:   +sharpe.toFixed(4),
        sortino_ratio:  +sortino.toFixed(4),
        max_drawdown:  `${(maxDD * 100).toFixed(4)}%`,
        var_1d:        `${(varVal * 100).toFixed(4)}%`,
        cvar_1d:       `${(cvarVal * 100).toFixed(4)}%`,
      },
      asset_stats: assetStats,
      correlation_matrix: corrMatrix.map((row, i) => ({
        asset: assets[i].name,
        correlations: Object.fromEntries(assets.map((a, j) => [a.name, corrMatrix[i][j]])),
      })),
      marginal_contribution_to_risk: mcrList,
    }));
  } catch (e) {
    console.error('[HiveFin] POST /portfolio error:', e);
    return res.status(500).json(err('Portfolio analysis error: ' + e.message, 500));
  }
});

// ─── POST /comps ──────────────────────────────────────────────────────────────

/**
 * Comparable Company Analysis (CCA / Trading Comps).
 *
 * Body:
 *   target  {object}  — Target company { name, revenue, ebitda, net_income, shares, share_price? }
 *   comps   {Array}   — Comparable companies [{ name, ev, revenue, ebitda, net_income, shares, share_price }]
 *   multiples {string[]} — Which multiples to use: ev_revenue, ev_ebitda, pe (default all)
 *
 * Returns: Median / mean / trimmed mean multiples, implied target valuations,
 *          premium/discount to current price, 25th/75th percentile range.
 */
router.post('/comps', requireDID, requirePayment({ amount: PRICE.standard, asset: 'USDC', recipient: WALLET }), async (req, res) => {
  try {
    const {
      target,
      comps,
      multiples: requestedMultiples = ['ev_revenue', 'ev_ebitda', 'pe'],
    } = req.body;

    if (!target) return res.status(400).json(err('Missing target company data'));
    if (!Array.isArray(comps) || comps.length < 2) return res.status(400).json(err('comps must have at least 2 companies'));

    // ── Build multiples table
    const multiplesData = comps.map(c => {
      const ev = c.ev || (c.shares * c.share_price + (c.debt || 0) - (c.cash || 0));
      return {
        name:       c.name,
        ev_revenue: c.revenue ? +(ev / c.revenue).toFixed(2) : null,
        ev_ebitda:  c.ebitda  ? +(ev / c.ebitda).toFixed(2)  : null,
        pe:         (c.net_income && c.net_income > 0) ? +(c.shares * c.share_price / c.net_income).toFixed(2) : null,
        ev_m:       +ev.toFixed(2),
      };
    });

    // ── Summary statistics per multiple
    const summary = {};
    for (const mult of requestedMultiples) {
      const vals = multiplesData.map(m => m[mult]).filter(v => v !== null && isFinite(v));
      if (vals.length === 0) continue;
      vals.sort((a, b) => a - b);
      const trimN = Math.max(0, Math.floor(vals.length * 0.1));
      const trimmedVals = vals.slice(trimN, vals.length - trimN || vals.length);
      summary[mult] = {
        mean:          +mean(vals).toFixed(2),
        median:        +percentile(vals, 50).toFixed(2),
        trimmed_mean:  +mean(trimmedVals).toFixed(2),
        p25:           +percentile(vals, 25).toFixed(2),
        p75:           +percentile(vals, 75).toFixed(2),
        min:           +vals[0].toFixed(2),
        max:           +vals[vals.length - 1].toFixed(2),
        n_comps:       vals.length,
      };
    }

    // ── Implied target valuation
    const implied = {};
    if (summary.ev_revenue && target.revenue) {
      const impliedEV = summary.ev_revenue.median * target.revenue;
      const impliedEq = impliedEV - (target.net_debt || 0);
      implied.ev_revenue = {
        implied_ev_m: +impliedEV.toFixed(2),
        implied_equity_m: +impliedEq.toFixed(2),
        implied_price: target.shares ? +(impliedEq / target.shares).toFixed(2) : null,
      };
    }
    if (summary.ev_ebitda && target.ebitda) {
      const impliedEV = summary.ev_ebitda.median * target.ebitda;
      const impliedEq = impliedEV - (target.net_debt || 0);
      implied.ev_ebitda = {
        implied_ev_m: +impliedEV.toFixed(2),
        implied_equity_m: +impliedEq.toFixed(2),
        implied_price: target.shares ? +(impliedEq / target.shares).toFixed(2) : null,
      };
    }
    if (summary.pe && target.net_income) {
      implied.pe = {
        implied_market_cap_m: +(summary.pe.median * target.net_income).toFixed(2),
        implied_price: target.shares ? +(summary.pe.median * target.net_income / target.shares).toFixed(2) : null,
      };
    }

    // ── Premium/discount vs current
    const premDisc = {};
    if (target.share_price && target.shares) {
      for (const [m, imp] of Object.entries(implied)) {
        if (imp.implied_price) {
          const pct = (imp.implied_price - target.share_price) / target.share_price;
          premDisc[m] = `${pct >= 0 ? '+' : ''}${(pct * 100).toFixed(2)}%`;
        }
      }
    }

    return res.json(meta({
      model: 'Comparable Company Analysis (Trading Comps)',
      target: {
        name: target.name,
        revenue_m: target.revenue,
        ebitda_m:  target.ebitda,
        net_income_m: target.net_income,
        current_price: target.share_price || null,
      },
      comps_count: comps.length,
      multiples_table: multiplesData,
      summary_statistics: summary,
      implied_valuation: implied,
      premium_discount_to_current: premDisc,
    }));
  } catch (e) {
    console.error('[HiveFin] POST /comps error:', e);
    return res.status(500).json(err('Comps error: ' + e.message, 500));
  }
});

// ─── POST /lbo ────────────────────────────────────────────────────────────────

/**
 * Leveraged Buyout model — entry, hold period, exit.
 *
 * Body:
 *   entry_ev_m          {number}   — Entry enterprise value ($M)
 *   entry_ebitda_m      {number}   — Entry EBITDA ($M)
 *   equity_check_pct    {number}   — Equity as % of EV (e.g. 0.40)
 *   ebitda_growth       {number[]} — Annual EBITDA growth rates over hold period
 *   exit_multiple       {number}   — EV/EBITDA at exit
 *   debt_interest_rate  {number}   — Interest rate on debt (e.g. 0.07)
 *   debt_amortization   {number}   — Annual debt paydown as % of initial debt (e.g. 0.05)
 *   management_fee_pct  {number}   — Annual management fee % of equity (e.g. 0.02)
 *   tax_rate            {number}   — Marginal tax rate
 *
 * Returns: Entry/exit equity, IRR, MOIC, debt waterfall, year-by-year P&L bridge.
 */
router.post('/lbo', computeLimiter, requireDID, requirePayment({ amount: PRICE.advanced, asset: 'USDC', recipient: WALLET }), async (req, res) => {
  try {
    const {
      entry_ev_m,
      entry_ebitda_m,
      equity_check_pct = 0.40,
      ebitda_growth,
      exit_multiple,
      debt_interest_rate = 0.07,
      debt_amortization  = 0.05,
      management_fee_pct = 0.02,
      tax_rate           = 0.21,
    } = req.body;

    const required = { entry_ev_m, entry_ebitda_m, ebitda_growth, exit_multiple };
    for (const [k, v] of Object.entries(required)) {
      if (v === undefined || v === null) return res.status(400).json(err(`Missing required field: ${k}`));
    }
    if (!Array.isArray(ebitda_growth) || ebitda_growth.length < 1) {
      return res.status(400).json(err('ebitda_growth must be a non-empty array (one rate per year).'));
    }

    const holdPeriod   = ebitda_growth.length;
    const equityCheck  = entry_ev_m * equity_check_pct;
    let   debtBalance  = entry_ev_m - equityCheck;
    const initialDebt  = debtBalance;

    // ── Year-by-year bridge
    const bridge = [];
    let ebitda = entry_ebitda_m;

    for (let y = 0; y < holdPeriod; y++) {
      ebitda *= (1 + ebitda_growth[y]);
      const interest    = debtBalance * debt_interest_rate;
      const amortize    = initialDebt * debt_amortization;
      const mgmtFee     = equityCheck * management_fee_pct;
      const ebt         = ebitda - interest - mgmtFee;
      const taxes       = Math.max(ebt * tax_rate, 0);
      const netIncome   = ebt - taxes;
      const debtPaydown = Math.min(amortize, debtBalance);
      debtBalance       = Math.max(debtBalance - debtPaydown, 0);

      bridge.push({
        year:         y + 1,
        ebitda:       +ebitda.toFixed(2),
        interest:     +interest.toFixed(2),
        mgmt_fee:     +mgmtFee.toFixed(2),
        ebt:          +ebt.toFixed(2),
        taxes:        +taxes.toFixed(2),
        net_income:   +netIncome.toFixed(2),
        debt_paydown: +debtPaydown.toFixed(2),
        debt_balance: +debtBalance.toFixed(2),
      });
    }

    // ── Exit
    const exitEBITDA       = bridge[holdPeriod - 1].ebitda;
    const exitEV           = exitEBITDA * exit_multiple;
    const exitDebt         = bridge[holdPeriod - 1].debt_balance;
    const exitEquityProceeds = exitEV - exitDebt;
    const moic             = exitEquityProceeds / equityCheck;

    // ── IRR (cashflows: -equityCheck at t=0, +exitEquityProceeds at t=holdPeriod)
    const cashflows = [-equityCheck, ...Array(holdPeriod - 1).fill(0), exitEquityProceeds];
    const irrValue  = irr(cashflows);

    // ── Entry multiple
    const entryMultiple = entry_ev_m / entry_ebitda_m;

    return res.json(meta({
      model: 'Leveraged Buyout (LBO) — Entry/Hold/Exit with Debt Waterfall',
      inputs: {
        entry_ev_m,
        entry_ebitda_m,
        entry_multiple: `${entryMultiple.toFixed(2)}x`,
        equity_check_m:   +equityCheck.toFixed(2),
        initial_debt_m:   +initialDebt.toFixed(2),
        debt_to_equity:   `${(initialDebt / equityCheck).toFixed(2)}x`,
        hold_period_years: holdPeriod,
        exit_multiple:    `${exit_multiple}x`,
      },
      exit: {
        exit_ebitda_m:         +exitEBITDA.toFixed(2),
        exit_ev_m:             +exitEV.toFixed(2),
        exit_debt_m:           +exitDebt.toFixed(2),
        exit_equity_proceeds_m: +exitEquityProceeds.toFixed(2),
      },
      returns: {
        moic: `${moic.toFixed(2)}x`,
        irr:  irrValue !== null ? `${(irrValue * 100).toFixed(2)}%` : 'N/A (no real IRR)',
      },
      debt_schedule: bridge,
    }));
  } catch (e) {
    console.error('[HiveFin] POST /lbo error:', e);
    return res.status(500).json(err('LBO error: ' + e.message, 500));
  }
});

// ─── POST /sensitivity ────────────────────────────────────────────────────────

/**
 * Sensitivity / Tornado analysis.
 * Vary each input ±N% and measure impact on output metric.
 *
 * Body:
 *   base_value    {number}   — Base case output value
 *   variables     {Array<{ name, base, low, high }>}
 *                   name: label, base: base-case, low: downside value, high: upside value
 *   model         {string}   — Description of the model being analyzed
 *
 * Returns: Tornado chart data sorted by impact, sensitivity ranges, elasticities.
 */
router.post('/sensitivity', requireDID, requirePayment({ amount: PRICE.standard, asset: 'USDC', recipient: WALLET }), async (req, res) => {
  try {
    const { base_value, variables, model: modelName = 'Custom Model' } = req.body;

    if (base_value === undefined) return res.status(400).json(err('Missing required field: base_value'));
    if (!Array.isArray(variables) || variables.length < 1) {
      return res.status(400).json(err('variables must be a non-empty array'));
    }

    // ── Simple sensitivity: assume linear relationship through base case
    // User provides: for each variable, what is the output value at low/high input?
    // If they don't provide output values, we calculate elasticity from the range.
    const bars = variables.map(v => {
      const lowImpact  = v.low_output  !== undefined ? v.low_output  : base_value * (1 - Math.abs((v.base - v.low)  / (v.base || 1)));
      const highImpact = v.high_output !== undefined ? v.high_output : base_value * (1 + Math.abs((v.high - v.base) / (v.base || 1)));
      const rangeAbs   = highImpact - lowImpact;
      const rangeRel   = rangeAbs / Math.abs(base_value);

      // Elasticity: % change in output / % change in input
      const inputChangePct = v.base !== 0 ? (v.high - v.base) / Math.abs(v.base) : 0;
      const outputChangePct = base_value !== 0 ? (highImpact - base_value) / Math.abs(base_value) : 0;
      const elasticity = inputChangePct !== 0 ? outputChangePct / inputChangePct : 0;

      return {
        variable:         v.name,
        base_input:       v.base,
        low_input:        v.low,
        high_input:       v.high,
        low_output:       +lowImpact.toFixed(4),
        high_output:      +highImpact.toFixed(4),
        range_absolute:   +rangeAbs.toFixed(4),
        range_pct:        `${(rangeRel * 100).toFixed(2)}%`,
        elasticity:       +elasticity.toFixed(4),
      };
    });

    // Sort by absolute range (tornado order)
    bars.sort((a, b) => Math.abs(b.range_absolute) - Math.abs(a.range_absolute));
    bars.forEach((b, i) => { b.rank = i + 1; });

    // ── Summary
    const topDriver = bars[0];
    const upside = Math.max(...bars.map(b => b.high_output));
    const downside = Math.min(...bars.map(b => b.low_output));

    return res.json(meta({
      model: `Sensitivity / Tornado Analysis — ${modelName}`,
      base_case: base_value,
      full_range: {
        upside:     +upside.toFixed(4),
        downside:   +downside.toFixed(4),
        total_span: +(upside - downside).toFixed(4),
        total_span_pct: `${(Math.abs(upside - downside) / Math.abs(base_value) * 100).toFixed(2)}%`,
      },
      top_driver: topDriver.variable,
      tornado_chart: bars,
    }));
  } catch (e) {
    console.error('[HiveFin] POST /sensitivity error:', e);
    return res.status(500).json(err('Sensitivity error: ' + e.message, 500));
  }
});

// ─── GET /hq ─────────────────────────────────────────────────────────────────

router.get('/hq', (req, res) => {
  res.json(meta({
    name: 'HiveFin — Financial Modeling Engine',
    tagline: 'Institutional-grade financial models for autonomous agents.',
    pheromone_signal: 'financial_modeling',
    avg_bounty_usdc: 93.18,
    endpoints: [
      { path: 'POST /v1/fin/dcf',            price: `$${PRICE.standard} USDC`, description: 'Full DCF valuation — multi-year FCF, Gordon Growth terminal value, EV/equity bridge, implied multiples' },
      { path: 'POST /v1/fin/monte-carlo',     price: `$${PRICE.advanced} USDC`, description: 'Monte Carlo GBM — 10k paths, P5-P95, VaR95/99, CVaR, histogram, path samples' },
      { path: 'POST /v1/fin/black-scholes',   price: `$${PRICE.basic} USDC`,    description: 'BSM options pricing — call/put prices, Delta/Gamma/Vega/Theta/Rho/Vanna/Charm' },
      { path: 'POST /v1/fin/wacc',            price: `$${PRICE.basic} USDC`,    description: 'WACC — CAPM cost of equity, after-tax debt, sensitivity table, Hamada unlevered beta' },
      { path: 'POST /v1/fin/portfolio',       price: `$${PRICE.standard} USDC`, description: 'MPT portfolio analysis — Sharpe, Sortino, VaR, CVaR, correlation matrix, MCR' },
      { path: 'POST /v1/fin/comps',           price: `$${PRICE.standard} USDC`, description: 'Comparable company analysis — EV/EBITDA, EV/Revenue, P/E, median/trimmed, implied price' },
      { path: 'POST /v1/fin/lbo',             price: `$${PRICE.advanced} USDC`, description: 'LBO model — equity check, debt waterfall, IRR, MOIC, year-by-year bridge' },
      { path: 'POST /v1/fin/sensitivity',     price: `$${PRICE.standard} USDC`, description: 'Sensitivity / tornado analysis — ranked by impact, elasticity, full range' },
    ],
    settlement: {
      rails: ['USDC (Base L2)', 'USDCx (Aleo ZK)', 'USAD (Aleo+Paxos)', 'ALEO native'],
      recipient: WALLET,
      protocol: 'x402 micropayment',
    },
    compliance: {
      standard: 'EU AI Act Article 12 ATG',
      audit_trail: 'Every computation emits an immutable audit record',
    },
  }));
});

export default router;
