/**
 * HiveRE Routes — Real Estate Analysis Engine
 *
 * Base path: /v1/re
 *
 * The most powerful real estate modeling toolkit available to autonomous agents.
 * Every endpoint is paid via x402 micropayment (USDC on Base L2).
 *
 * Endpoints:
 *   POST  /valuation     — Property valuation (Sales Comps + Income + Cost approach)
 *   POST  /cashflow      — Full cash flow model (NOI, IRR, NPV, equity multiple)
 *   POST  /comps         — Comparable sales analysis with adjustments
 *   POST  /mortgage      — Mortgage calculator (amortization, payments, affordability)
 *   POST  /portfolio     — Multi-property portfolio analysis (weighted metrics, rebalance)
 *   POST  /flip          — Fix-and-flip analyzer (purchase, rehab, ARV, profit)
 *   POST  /stress        — Stress test (vacancy, rate, rent, cap rate shocks)
 *   GET   /hq            — Full HiveRE capability card
 *
 * Pricing:
 *   Basic (mortgage, flip):    $0.25 USDC
 *   Standard (cashflow, comps, stress): $0.50 USDC
 *   Advanced (valuation, portfolio):    $0.75 USDC
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

const SERVICE = 'HiveRE';
const VERSION  = '1.0.0';
const WALLET   = '0xE5588c407b6AdD3E83ce34190C77De20eaC1BeFe';

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

function err(msg) {
  return { ok: false, service: SERVICE, error: msg };
}

// ─── Rate limiters ────────────────────────────────────────────────────────────

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Rate limit exceeded on HiveRE. Max 120 req/min.' },
});

router.use(generalLimiter);

// ─── Pricing constants ────────────────────────────────────────────────────────

const PRICE = {
  basic:    0.25,
  standard: 0.50,
  advanced: 0.75,
};

// ─── Math utilities ───────────────────────────────────────────────────────────

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function stdDev(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / (arr.length - 1));
}

/** Monthly payment for an amortizing loan */
function monthlyPayment(principal, annualRate, months) {
  if (annualRate === 0) return principal / months;
  const r = annualRate / 12;
  return principal * r * Math.pow(1 + r, months) / (Math.pow(1 + r, months) - 1);
}

/** IRR via bisection */
function irr(cashflows, tol = 1e-8, maxIter = 500) {
  const npv = (r) => cashflows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + r, t), 0);
  let lo = -0.9999, hi = 100.0;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const npvMid = npv(mid);
    if (Math.abs(npvMid) < tol || (hi - lo) / 2 < tol) return mid;
    if (npvMid * npv(lo) < 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** NPV of annual cashflows */
function npv(rate, cashflows) {
  return cashflows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + rate, t), 0);
}

// ─── POST /valuation ─────────────────────────────────────────────────────────

/**
 * Three-approach property valuation — Sales Comps, Income, and Cost approach.
 * Final reconciled value is a weighted blend.
 *
 * Body:
 *   address       {string}   — Property address (descriptive)
 *   property_type {string}   — residential | multifamily | commercial | industrial
 *   sqft          {number}   — GLA / building SF
 *   lot_sqft      {number}   — Lot size SF (optional)
 *   year_built    {number}   — Year built
 *   condition     {string}   — poor | fair | average | good | excellent
 *
 *   — SALES COMPS APPROACH —
 *   comps   {Array<{ address, sale_price, sqft, age, condition, sale_date_months_ago, adjustments? }>}
 *
 *   — INCOME APPROACH —
 *   gross_rent_monthly   {number}   — Monthly gross rent ($)
 *   vacancy_rate         {number}   — Vacancy rate (e.g. 0.05)
 *   operating_expenses   {number}   — Annual OpEx ($)
 *   cap_rate             {number}   — Market cap rate (e.g. 0.065)
 *
 *   — COST APPROACH —
 *   land_value           {number}   — Land value ($)
 *   replacement_cost_psf {number}   — Replacement cost per SF ($)
 *   depreciation_pct     {number}   — Accumulated depreciation (e.g. 0.15)
 *
 *   weights {object}  — { comps: 0.5, income: 0.3, cost: 0.2 } (must sum to 1)
 */
router.post('/valuation', requireDID, requirePayment({ amount: PRICE.advanced, asset: 'USDC', recipient: WALLET }), async (req, res) => {
  try {
    const {
      address      = 'Subject Property',
      property_type = 'residential',
      sqft,
      lot_sqft,
      year_built,
      condition    = 'average',
      comps        = [],
      gross_rent_monthly,
      vacancy_rate = 0.05,
      operating_expenses,
      cap_rate,
      land_value,
      replacement_cost_psf,
      depreciation_pct = 0,
      weights = { comps: 0.50, income: 0.30, cost: 0.20 },
    } = req.body;

    if (!sqft) return res.status(400).json(err('Missing required field: sqft'));

    const results = {};
    const availableApproaches = [];

    // ── Condition adjustment factors
    const conditionAdj = { poor: 0.80, fair: 0.90, average: 1.00, good: 1.05, excellent: 1.12 };
    const subjectCondFactor = conditionAdj[condition] || 1.0;

    // ── 1. Sales Comps Approach
    if (comps.length >= 2) {
      const adjustedPrices = comps.map(c => {
        // Adjusted price per SF
        let ppsf = c.sale_price / c.sqft;

        // Age adjustment (newer = premium, ~0.3% per year)
        const ageDiffYears = year_built && c.year_built ? (year_built - c.year_built) : 0;
        ppsf *= (1 + ageDiffYears * 0.003);

        // Condition adjustment
        const compCondFactor = conditionAdj[c.condition] || 1.0;
        ppsf *= (subjectCondFactor / compCondFactor);

        // Time adjustment (0.5% per month appreciation)
        ppsf *= (1 + (c.sale_date_months_ago || 0) * 0.005);

        // Manual adjustments (if provided)
        if (c.adjustments) {
          for (const adj of Object.values(c.adjustments)) ppsf += adj / c.sqft;
        }

        return {
          address: c.address,
          sale_price: c.sale_price,
          sqft: c.sqft,
          raw_ppsf: +(c.sale_price / c.sqft).toFixed(2),
          adjusted_ppsf: +ppsf.toFixed(2),
          adjusted_price_subject: +(ppsf * sqft).toFixed(0),
        };
      });

      const ppsfVals = adjustedPrices.map(c => c.adjusted_ppsf);
      const medPPSF  = median(ppsfVals);
      const meanPPSF = mean(ppsfVals);
      const compsValue = medPPSF * sqft;

      results.comps = {
        approach: 'Sales Comparison',
        indicated_value: +compsValue.toFixed(0),
        price_per_sqft:  +medPPSF.toFixed(2),
        comps_detail:    adjustedPrices,
        statistics: {
          median_ppsf: +medPPSF.toFixed(2),
          mean_ppsf:   +meanPPSF.toFixed(2),
          std_ppsf:    ppsfVals.length > 1 ? +stdDev(ppsfVals).toFixed(2) : null,
          n_comps:     comps.length,
        },
      };
      availableApproaches.push('comps');
    }

    // ── 2. Income Approach (Direct Capitalization)
    if (gross_rent_monthly && cap_rate) {
      const egi  = gross_rent_monthly * 12 * (1 - vacancy_rate);
      const opex = operating_expenses || egi * 0.40;  // default 40% expense ratio
      const noi  = egi - opex;
      const incomeValue = noi / cap_rate;
      const grm  = (gross_rent_monthly * 12) > 0 ? incomeValue / (gross_rent_monthly * 12) : null;

      results.income = {
        approach: 'Income (Direct Capitalization)',
        indicated_value:       +incomeValue.toFixed(0),
        gross_potential_rent:  +(gross_rent_monthly * 12).toFixed(0),
        vacancy_loss:          +(gross_rent_monthly * 12 * vacancy_rate).toFixed(0),
        effective_gross_income: +egi.toFixed(0),
        operating_expenses:    +opex.toFixed(0),
        noi:                   +noi.toFixed(0),
        cap_rate:              `${(cap_rate * 100).toFixed(2)}%`,
        expense_ratio:         `${((opex / egi) * 100).toFixed(1)}%`,
        gross_rent_multiplier: grm ? +grm.toFixed(2) : null,
      };
      availableApproaches.push('income');
    }

    // ── 3. Cost Approach
    if (land_value && replacement_cost_psf) {
      const replacementCost    = replacement_cost_psf * sqft;
      const depreciatedCost    = replacementCost * (1 - depreciation_pct);
      const costValue          = land_value + depreciatedCost;
      const landValuePct       = land_value / costValue;

      results.cost = {
        approach: 'Cost (Depreciated Replacement Cost)',
        indicated_value:         +costValue.toFixed(0),
        land_value:              +land_value.toFixed(0),
        replacement_cost_psf:    +replacement_cost_psf.toFixed(2),
        replacement_cost_total:  +replacementCost.toFixed(0),
        depreciation_pct:        `${(depreciation_pct * 100).toFixed(1)}%`,
        depreciated_improvement: +depreciatedCost.toFixed(0),
        land_value_pct:          `${(landValuePct * 100).toFixed(1)}%`,
      };
      availableApproaches.push('cost');
    }

    if (availableApproaches.length === 0) {
      return res.status(400).json(err('Provide at least one approach: comps (2+ sales), income (gross_rent_monthly + cap_rate), or cost (land_value + replacement_cost_psf).'));
    }

    // ── Reconciliation
    const totalWeight = availableApproaches.reduce((s, a) => s + (weights[a] || 0), 0);
    let reconciled = 0;
    const reconciliationDetail = {};
    for (const approach of availableApproaches) {
      const w = (weights[approach] || 0) / totalWeight;  // normalize
      reconciled += results[approach].indicated_value * w;
      reconciliationDetail[approach] = {
        indicated_value: results[approach].indicated_value,
        weight:          `${(w * 100).toFixed(1)}%`,
        weighted_value:  +(results[approach].indicated_value * w).toFixed(0),
      };
    }

    // ── Value range
    const values = availableApproaches.map(a => results[a].indicated_value);
    const low    = Math.min(...values);
    const high   = Math.max(...values);
    const range  = `$${low.toLocaleString()} – $${high.toLocaleString()}`;

    return res.json(meta({
      model: 'Three-Approach Property Valuation (USPAP-aligned)',
      subject: { address, property_type, sqft, lot_sqft, year_built, condition },
      reconciled_value: +reconciled.toFixed(0),
      value_range:       range,
      price_per_sqft:    +(reconciled / sqft).toFixed(2),
      approaches: results,
      reconciliation:    reconciliationDetail,
      approaches_used:   availableApproaches,
      note: 'Values are model estimates. Always confirm with a licensed appraiser for transactions.',
    }));
  } catch (e) {
    console.error('[HiveRE] POST /valuation error:', e);
    return res.status(500).json(err('Valuation error: ' + e.message));
  }
});

// ─── POST /cashflow ───────────────────────────────────────────────────────────

/**
 * Full hold-period cash flow model with IRR, NPV, equity multiple, cap rate.
 *
 * Body:
 *   purchase_price      {number}   — Purchase price ($)
 *   down_payment_pct    {number}   — Down payment % (e.g. 0.25)
 *   loan_rate           {number}   — Annual mortgage rate (e.g. 0.065)
 *   loan_term_years     {number}   — Loan amortization (e.g. 30)
 *   gross_rent_monthly  {number}   — Starting monthly rent ($)
 *   rent_growth_rate    {number}   — Annual rent growth (e.g. 0.03)
 *   vacancy_rate        {number}   — Vacancy (e.g. 0.05)
 *   operating_expense_pct {number} — OpEx as % of EGI (e.g. 0.40)
 *   capex_reserve_pct   {number}   — CapEx reserve % of EGI (e.g. 0.05)
 *   hold_years          {number}   — Hold period (default 10)
 *   exit_cap_rate       {number}   — Exit cap rate (e.g. 0.07)
 *   closing_costs_pct   {number}   — Acquisition closing costs % (e.g. 0.03)
 *   selling_costs_pct   {number}   — Disposition costs % (e.g. 0.06)
 *   discount_rate       {number}   — NPV discount rate (e.g. 0.08)
 */
router.post('/cashflow', requireDID, requirePayment({ amount: PRICE.standard, asset: 'USDC', recipient: WALLET }), async (req, res) => {
  try {
    const {
      purchase_price,
      down_payment_pct       = 0.25,
      loan_rate              = 0.065,
      loan_term_years        = 30,
      gross_rent_monthly,
      rent_growth_rate       = 0.03,
      vacancy_rate           = 0.05,
      operating_expense_pct  = 0.40,
      capex_reserve_pct      = 0.05,
      hold_years             = 10,
      exit_cap_rate,
      closing_costs_pct      = 0.03,
      selling_costs_pct      = 0.06,
      discount_rate          = 0.08,
    } = req.body;

    const required = { purchase_price, gross_rent_monthly };
    for (const [k, v] of Object.entries(required)) {
      if (v === undefined || v === null) return res.status(400).json(err(`Missing required field: ${k}`));
    }

    const loanAmount  = purchase_price * (1 - down_payment_pct);
    const equity      = purchase_price * down_payment_pct + purchase_price * closing_costs_pct;
    const dsMonthly   = monthlyPayment(loanAmount, loan_rate, loan_term_years * 12);
    const dsAnnual    = dsMonthly * 12;

    // ── Amortization — track loan balance
    let loanBalance = loanAmount;
    const balances  = [];
    for (let m = 0; m < hold_years * 12; m++) {
      const interest = loanBalance * (loan_rate / 12);
      const principal = dsMonthly - interest;
      loanBalance = Math.max(loanBalance - principal, 0);
      if ((m + 1) % 12 === 0) balances.push(+loanBalance.toFixed(2));
    }

    // ── Year-by-year schedule
    const schedule = [];
    const equityCashflows = [-equity];  // initial equity outflow
    let cumCashflow = 0;
    let grossRent = gross_rent_monthly * 12;

    for (let y = 0; y < hold_years; y++) {
      const annGrossRent = grossRent;
      const vacancy      = annGrossRent * vacancy_rate;
      const egi          = annGrossRent - vacancy;
      const opex         = egi * operating_expense_pct;
      const capex        = egi * capex_reserve_pct;
      const noi          = egi - opex;
      const capexNOI     = noi - capex;
      const cashBeforeDS = capexNOI;
      const cfads        = cashBeforeDS - dsAnnual;
      const cashOnCash   = cfads / equity;
      const loanBal      = balances[y] || 0;
      const equity_y     = purchase_price * (1 + 0.03 * (y + 1)) - loanBal;  // rough equity gain

      schedule.push({
        year:            y + 1,
        gross_rent:      +annGrossRent.toFixed(0),
        vacancy_loss:    +vacancy.toFixed(0),
        egi:             +egi.toFixed(0),
        operating_expense: +opex.toFixed(0),
        noi:             +noi.toFixed(0),
        capex_reserve:   +capex.toFixed(0),
        debt_service:    +dsAnnual.toFixed(0),
        cash_flow:       +cfads.toFixed(0),
        cash_on_cash:    `${(cashOnCash * 100).toFixed(2)}%`,
        loan_balance:    loanBal,
        dscr:            +(noi / dsAnnual).toFixed(3),
      });

      equityCashflows.push(cfads);
      cumCashflow += cfads;

      // Grow rent for next year
      grossRent *= (1 + rent_growth_rate);
    }

    // ── Exit
    const exitNOI        = schedule[hold_years - 1].noi;
    const exitCapR       = exit_cap_rate || (0.065 + 0.005);
    const exitGrossValue = exitNOI / exitCapR;
    const exitLoanBal    = balances[hold_years - 1] || 0;
    const sellingCosts   = exitGrossValue * selling_costs_pct;
    const exitNetProceeds = exitGrossValue - exitLoanBal - sellingCosts;
    equityCashflows[equityCashflows.length - 1] += exitNetProceeds;

    // ── Returns
    const irrAnnual   = irr(equityCashflows);
    const npvCalc     = npv(discount_rate, equityCashflows);
    const equityMultiple = (cumCashflow + exitNetProceeds + equity) / equity;

    // ── Entry metrics
    const entryNOI    = schedule[0].noi;
    const entryCap    = entryNOI / purchase_price;
    const dscr_y1     = schedule[0].dscr;

    return res.json(meta({
      model: 'Real Estate Cash Flow Model — NOI/DSCR/IRR/NPV Hold-Period Analysis',
      inputs: {
        purchase_price,
        down_payment_pct: `${(down_payment_pct * 100).toFixed(1)}%`,
        equity_invested:   +equity.toFixed(0),
        loan_amount:       +loanAmount.toFixed(0),
        loan_rate:         `${(loan_rate * 100).toFixed(3)}%`,
        hold_years,
        exit_cap_rate:     `${(exitCapR * 100).toFixed(2)}%`,
      },
      entry_metrics: {
        year_1_noi:    +entryNOI.toFixed(0),
        entry_cap_rate: `${(entryCap * 100).toFixed(2)}%`,
        year_1_dscr:    +dscr_y1.toFixed(3),
        monthly_payment: +dsMonthly.toFixed(2),
      },
      exit_metrics: {
        exit_gross_value:    +exitGrossValue.toFixed(0),
        exit_loan_balance:   +exitLoanBal.toFixed(0),
        selling_costs:       +sellingCosts.toFixed(0),
        net_sale_proceeds:   +exitNetProceeds.toFixed(0),
      },
      returns: {
        irr:              irrAnnual !== null ? `${(irrAnnual * 100).toFixed(2)}%` : 'N/A',
        npv:              `$${npvCalc.toFixed(0)}`,
        equity_multiple:  `${equityMultiple.toFixed(2)}x`,
        total_cashflow:   +cumCashflow.toFixed(0),
        avg_cash_on_cash: `${(cumCashflow / equity / hold_years * 100).toFixed(2)}%`,
      },
      annual_schedule: schedule,
    }));
  } catch (e) {
    console.error('[HiveRE] POST /cashflow error:', e);
    return res.status(500).json(err('Cash flow error: ' + e.message));
  }
});

// ─── POST /comps ──────────────────────────────────────────────────────────────

/**
 * Comparable sales analysis with grid adjustments.
 *
 * Body:
 *   subject  {object}   — { sqft, beds, baths, garage, pool, year_built, condition }
 *   comps    {Array}    — [{ address, sale_price, sqft, beds, baths, garage, pool, year_built, condition, sale_date_months_ago }]
 *   market_adjustment_per_month {number} — % appreciation per month (default 0.004)
 *
 * Returns: Adjusted comparable grid, median/mean price, $/SF analysis, value range.
 */
router.post('/comps', requireDID, requirePayment({ amount: PRICE.standard, asset: 'USDC', recipient: WALLET }), async (req, res) => {
  try {
    const {
      subject,
      comps,
      market_adjustment_per_month = 0.004,
    } = req.body;

    if (!subject) return res.status(400).json(err('Missing required field: subject'));
    if (!Array.isArray(comps) || comps.length < 2) return res.status(400).json(err('comps must have at least 2 sales'));

    // ── Adjustment grid (dollar-based)
    const ADJ = {
      bed_value:       15000,   // per bedroom difference
      bath_value:      10000,   // per bathroom difference
      garage_value:    20000,   // per garage space difference
      pool_value:      25000,   // if subject has pool and comp doesn't
      sqft_value_psf:  150,     // per SF size difference ($/SF)
    };

    // Condition multipliers
    const conditionScore = { poor: 1, fair: 2, average: 3, good: 4, excellent: 5 };
    const conditionAdj_psf = 10; // $ per SF per condition tier difference

    const subjectScore = conditionScore[subject.condition] || 3;

    const adjustedComps = comps.map(c => {
      const compScore = conditionScore[c.condition] || 3;
      let totalAdj = 0;

      // Size adjustment
      const sizeDiff = (subject.sqft || 0) - (c.sqft || 0);
      totalAdj += sizeDiff * ADJ.sqft_value_psf;

      // Bedroom adjustment
      totalAdj += ((subject.beds || 0) - (c.beds || 0)) * ADJ.bed_value;

      // Bathroom adjustment
      totalAdj += ((subject.baths || 0) - (c.baths || 0)) * ADJ.bath_value;

      // Garage adjustment
      totalAdj += ((subject.garage || 0) - (c.garage || 0)) * ADJ.garage_value;

      // Pool adjustment
      const subjectPool = subject.pool ? 1 : 0;
      const compPool    = c.pool ? 1 : 0;
      totalAdj += (subjectPool - compPool) * ADJ.pool_value;

      // Age adjustment (~$1,000/year)
      const ageDiff = (subject.year_built || 0) - (c.year_built || 0);
      totalAdj += ageDiff * 1000;

      // Condition adjustment
      const condDiff = subjectScore - compScore;
      totalAdj += condDiff * conditionAdj_psf * (c.sqft || 1000);

      // Market / time adjustment
      const timeAdj = c.sale_price * (c.sale_date_months_ago || 0) * market_adjustment_per_month;
      totalAdj += timeAdj;

      const adjustedPrice   = c.sale_price + totalAdj;
      const adjustedPPSF    = adjustedPrice / (subject.sqft || c.sqft);
      const rawPPSF         = c.sale_price / c.sqft;
      const adjPct          = (totalAdj / c.sale_price) * 100;

      return {
        address:            c.address,
        sale_price:         c.sale_price,
        raw_ppsf:           +rawPPSF.toFixed(2),
        total_adjustment:   +totalAdj.toFixed(0),
        adjustment_pct:     `${adjPct >= 0 ? '+' : ''}${adjPct.toFixed(1)}%`,
        adjusted_price:     +adjustedPrice.toFixed(0),
        adjusted_ppsf:      +adjustedPPSF.toFixed(2),
        adjustment_breakdown: {
          size:      +(sizeDiff * ADJ.sqft_value_psf).toFixed(0),
          bedrooms:  +((subject.beds - c.beds) * ADJ.bed_value).toFixed(0),
          bathrooms: +((subject.baths - c.baths) * ADJ.bath_value).toFixed(0),
          garage:    +((subject.garage - c.garage) * ADJ.garage_value).toFixed(0),
          pool:      +((subjectPool - compPool) * ADJ.pool_value).toFixed(0),
          age:       +(ageDiff * 1000).toFixed(0),
          condition: +(condDiff * conditionAdj_psf * (c.sqft || 1000)).toFixed(0),
          time:      +timeAdj.toFixed(0),
        },
      };
    });

    // ── Summary statistics
    const adjPrices  = adjustedComps.map(c => c.adjusted_price);
    const adjPPSF    = adjustedComps.map(c => c.adjusted_ppsf);
    const med        = median(adjPrices);
    const avg        = mean(adjPrices);
    const medPPSF    = median(adjPPSF);

    // Trim outliers (IQR method)
    const sortedAdj = [...adjPrices].sort((a, b) => a - b);
    const q1 = sortedAdj[Math.floor(sortedAdj.length * 0.25)];
    const q3 = sortedAdj[Math.floor(sortedAdj.length * 0.75)];
    const iqr = q3 - q1;
    const trimmed = adjPrices.filter(v => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
    const trimmedMean = trimmed.length > 0 ? mean(trimmed) : avg;

    return res.json(meta({
      model: 'Comparable Sales Analysis — Adjusted Comp Grid (FNMA 1004 style)',
      subject,
      indicated_value_median:        +med.toFixed(0),
      indicated_value_mean:          +avg.toFixed(0),
      indicated_value_trimmed_mean:  +trimmedMean.toFixed(0),
      price_per_sqft_median:         +medPPSF.toFixed(2),
      value_range: `$${Math.min(...adjPrices).toLocaleString()} – $${Math.max(...adjPrices).toLocaleString()}`,
      comp_count: comps.length,
      adjusted_comp_grid: adjustedComps,
      adjustment_factors_used: ADJ,
    }));
  } catch (e) {
    console.error('[HiveRE] POST /comps error:', e);
    return res.status(500).json(err('Comps error: ' + e.message));
  }
});

// ─── POST /mortgage ───────────────────────────────────────────────────────────

/**
 * Full mortgage calculator — payment, amortization, affordability.
 *
 * Body:
 *   loan_amount       {number}  — Principal ($)
 *   annual_rate       {number}  — Annual interest rate (e.g. 0.065)
 *   term_years        {number}  — Amortization term (e.g. 30)
 *   loan_type         {string}  — fixed | arm (ARM not yet supported, defaults to fixed)
 *   pmi_rate          {number}  — PMI annual % (e.g. 0.007) — applies if LTV > 80%
 *   property_tax_monthly {number} — Monthly property tax ($)
 *   insurance_monthly {number}  — Monthly homeowners insurance ($)
 *   hoa_monthly       {number}  — Monthly HOA ($)
 *   gross_monthly_income {number} — For DTI calculation
 *   extra_principal_monthly {number} — Extra principal payment (payoff acceleration)
 *
 * Returns: Monthly payment (PITI+HOA), total cost, interest paid, payoff date,
 *          DTI, affordability analysis, 360-row amortization schedule (summarized).
 */
router.post('/mortgage', requireDID, requirePayment({ amount: PRICE.basic, asset: 'USDC', recipient: WALLET }), async (req, res) => {
  try {
    const {
      loan_amount,
      annual_rate,
      term_years            = 30,
      pmi_rate              = 0,
      property_tax_monthly  = 0,
      insurance_monthly     = 0,
      hoa_monthly           = 0,
      gross_monthly_income,
      extra_principal_monthly = 0,
      purchase_price,
    } = req.body;

    if (loan_amount === undefined || annual_rate === undefined) {
      return res.status(400).json(err('Missing required fields: loan_amount, annual_rate'));
    }
    if (loan_amount <= 0) return res.status(400).json(err('loan_amount must be positive'));
    if (annual_rate <= 0) return res.status(400).json(err('annual_rate must be positive'));

    const totalMonths = term_years * 12;
    const basePayment = monthlyPayment(loan_amount, annual_rate, totalMonths);

    // PMI
    const ltv = purchase_price ? loan_amount / purchase_price : 0.9;
    const pmiMonthly = ltv > 0.80 ? loan_amount * pmi_rate / 12 : 0;

    const totalMonthly = basePayment + property_tax_monthly + insurance_monthly + hoa_monthly + pmiMonthly;

    // ── Amortization (with extra payments)
    let balance = loan_amount;
    let totalInterest = 0;
    let totalPrincipal = 0;
    let monthsPaidOff = totalMonths;
    const yearlySchedule = [];
    const monthlyRate = annual_rate / 12;

    for (let m = 0; m < totalMonths; m++) {
      if (balance <= 0) { monthsPaidOff = m; break; }

      const interestCharge = balance * monthlyRate;
      const principalPayment = Math.min(basePayment - interestCharge + extra_principal_monthly, balance);

      totalInterest   += interestCharge;
      totalPrincipal  += principalPayment;
      balance          = Math.max(balance - principalPayment, 0);

      // Annual summary
      if ((m + 1) % 12 === 0 || balance <= 0) {
        yearlySchedule.push({
          year:              Math.floor(m / 12) + 1,
          principal_paid:    +totalPrincipal.toFixed(0),
          interest_paid:     +totalInterest.toFixed(0),
          remaining_balance: +balance.toFixed(0),
        });
        if (balance <= 0) { monthsPaidOff = m + 1; break; }
      }
    }

    const totalCost    = totalInterest + loan_amount;
    const pmiCancelsM  = purchase_price ? Math.ceil(Math.log(0.80 * purchase_price / loan_amount) / Math.log(1 + monthlyRate)) : null;

    // ── Affordability
    const dti = gross_monthly_income ? totalMonthly / gross_monthly_income : null;
    const affordability = dti
      ? dti < 0.28 ? 'Excellent (front-end DTI < 28%)'
        : dti < 0.36 ? 'Good (front-end DTI 28–36%)'
        : dti < 0.43 ? 'Acceptable (FHA max 43%)'
        : 'High (DTI > 43% — may not qualify for conventional)'
      : 'Provide gross_monthly_income for DTI analysis';

    return res.json(meta({
      model: 'Mortgage Calculator — Amortization, DTI, Affordability Analysis',
      inputs: { loan_amount, annual_rate: `${(annual_rate * 100).toFixed(3)}%`, term_years, ltv: `${(ltv * 100).toFixed(1)}%` },
      monthly_payment_breakdown: {
        principal_interest: +basePayment.toFixed(2),
        property_tax:        property_tax_monthly,
        insurance:           insurance_monthly,
        hoa:                 hoa_monthly,
        pmi:                 +pmiMonthly.toFixed(2),
        total_piti_hoa:      +totalMonthly.toFixed(2),
      },
      loan_summary: {
        total_interest_paid: +totalInterest.toFixed(0),
        total_cost_of_loan:  +totalCost.toFixed(0),
        interest_to_principal_ratio: `${(totalInterest / loan_amount * 100).toFixed(1)}%`,
        months_to_payoff:    monthsPaidOff,
        years_to_payoff:     +(monthsPaidOff / 12).toFixed(1),
        pmi_cancels_month:   pmiCancelsM || 'N/A (LTV ≤ 80%)',
      },
      affordability: {
        front_end_dti: dti ? `${(dti * 100).toFixed(1)}%` : null,
        assessment:    affordability,
      },
      amortization_summary: yearlySchedule,
    }));
  } catch (e) {
    console.error('[HiveRE] POST /mortgage error:', e);
    return res.status(500).json(err('Mortgage error: ' + e.message));
  }
});

// ─── POST /portfolio ──────────────────────────────────────────────────────────

/**
 * Multi-property portfolio analysis.
 *
 * Body:
 *   properties {Array<{ name, value, noi, loan_balance, loan_rate, units? }>}
 *   target_ltv {number} — Target LTV for rebalancing suggestions (e.g. 0.65)
 *   target_cap_rate {number} — Target portfolio cap rate
 *
 * Returns: Portfolio NOI, cap rate, LTV, DSCR, equity, yield-on-cost,
 *          per-property breakdown, rebalancing recommendations.
 */
router.post('/portfolio', requireDID, requirePayment({ amount: PRICE.advanced, asset: 'USDC', recipient: WALLET }), async (req, res) => {
  try {
    const {
      properties,
      target_ltv       = 0.65,
      target_cap_rate  = 0.06,
    } = req.body;

    if (!Array.isArray(properties) || properties.length < 1) {
      return res.status(400).json(err('properties must be a non-empty array'));
    }

    let totalValue = 0, totalNOI = 0, totalDebt = 0, totalUnits = 0;

    const breakdown = properties.map(p => {
      const capRate   = p.noi / p.value;
      const ltv       = p.loan_balance / p.value;
      const equity    = p.value - p.loan_balance;
      // Simplified annual DS estimate
      const annualDS  = p.loan_balance * (p.loan_rate || 0.065) * 1.2;  // rough
      const dscr      = p.noi / (annualDS || 1);
      const cashFlow  = p.noi - annualDS;
      const coc       = equity > 0 ? cashFlow / equity : null;

      totalValue += p.value;
      totalNOI   += p.noi;
      totalDebt  += p.loan_balance;
      totalUnits += p.units || 1;

      return {
        name:         p.name,
        value:        p.value,
        noi:          p.noi,
        cap_rate:     `${(capRate * 100).toFixed(2)}%`,
        ltv:          `${(ltv * 100).toFixed(2)}%`,
        equity:       +equity.toFixed(0),
        loan_balance: p.loan_balance,
        dscr:         +dscr.toFixed(3),
        cash_flow:    +cashFlow.toFixed(0),
        cash_on_cash: coc ? `${(coc * 100).toFixed(2)}%` : null,
        pct_of_portfolio: `${(p.value / properties.reduce((s, pr) => s + pr.value, 0) * 100).toFixed(1)}%`,
      };
    });

    const portCapRate = totalNOI / totalValue;
    const portLTV     = totalDebt / totalValue;
    const portEquity  = totalValue - totalDebt;

    // ── Rebalancing suggestions
    const suggestions = [];
    if (portLTV > target_ltv) {
      const paydownNeeded = totalDebt - totalValue * target_ltv;
      suggestions.push(`Pay down $${paydownNeeded.toLocaleString('en-US', { maximumFractionDigits: 0 })} in debt to reach target LTV of ${(target_ltv * 100).toFixed(0)}%`);
    }
    if (portCapRate < target_cap_rate) {
      suggestions.push(`Portfolio cap rate ${(portCapRate * 100).toFixed(2)}% is below target ${(target_cap_rate * 100).toFixed(2)}%. Consider adding higher-yielding properties or improving NOI on underperformers.`);
    }

    // Sort by cap rate to identify strongest/weakest
    const sorted = [...breakdown].sort((a, b) =>
      parseFloat(b.cap_rate) - parseFloat(a.cap_rate)
    );

    return res.json(meta({
      model: 'Multi-Property Portfolio Analysis — NOI, LTV, DSCR, Equity',
      portfolio_summary: {
        total_value:        +totalValue.toFixed(0),
        total_noi:          +totalNOI.toFixed(0),
        total_debt:         +totalDebt.toFixed(0),
        total_equity:       +portEquity.toFixed(0),
        total_units:        totalUnits,
        portfolio_cap_rate: `${(portCapRate * 100).toFixed(2)}%`,
        portfolio_ltv:      `${(portLTV * 100).toFixed(2)}%`,
        avg_dscr:           +(totalNOI / (totalDebt * 0.065 * 1.2)).toFixed(3),
        n_properties:       properties.length,
      },
      targets: {
        target_cap_rate: `${(target_cap_rate * 100).toFixed(2)}%`,
        target_ltv:      `${(target_ltv * 100).toFixed(2)}%`,
      },
      property_breakdown: breakdown,
      top_performer:   sorted[0]?.name,
      bottom_performer: sorted[sorted.length - 1]?.name,
      rebalancing_suggestions: suggestions.length > 0 ? suggestions : ['Portfolio is on target — no action required.'],
    }));
  } catch (e) {
    console.error('[HiveRE] POST /portfolio error:', e);
    return res.status(500).json(err('Portfolio error: ' + e.message));
  }
});

// ─── POST /flip ───────────────────────────────────────────────────────────────

/**
 * Fix-and-flip analyzer.
 *
 * Body:
 *   purchase_price   {number}  — Acquisition price ($)
 *   rehab_budget     {number}  — Rehab costs ($)
 *   arv              {number}  — After Repair Value ($)
 *   holding_months   {number}  — Expected hold (e.g. 6)
 *   financing_rate   {number}  — Hard money / bridge rate (e.g. 0.12)
 *   points           {number}  — Origination points (e.g. 2 = 2%)
 *   ltv              {number}  — Loan-to-cost ratio (e.g. 0.75)
 *   selling_costs_pct {number} — Agent + closing costs at sale (e.g. 0.08)
 *   holding_costs_monthly {number} — Taxes, insurance, utilities/mo
 */
router.post('/flip', requireDID, requirePayment({ amount: PRICE.basic, asset: 'USDC', recipient: WALLET }), async (req, res) => {
  try {
    const {
      purchase_price,
      rehab_budget,
      arv,
      holding_months         = 6,
      financing_rate         = 0.12,
      points                 = 2,
      ltv                    = 0.75,
      selling_costs_pct      = 0.08,
      holding_costs_monthly  = 500,
    } = req.body;

    const required = { purchase_price, rehab_budget, arv };
    for (const [k, v] of Object.entries(required)) {
      if (v === undefined || v === null) return res.status(400).json(err(`Missing required field: ${k}`));
    }

    // ── Costs
    const totalCost        = purchase_price + rehab_budget;
    const loanAmount       = totalCost * ltv;
    const equityRequired   = totalCost - loanAmount;
    const originationFees  = loanAmount * (points / 100);
    const interestCost     = loanAmount * (financing_rate / 12) * holding_months;
    const holdingCosts     = holding_costs_monthly * holding_months;
    const sellingCosts     = arv * selling_costs_pct;

    const totalCostAll     = totalCost + originationFees + interestCost + holdingCosts + sellingCosts;
    const profit           = arv - totalCostAll;
    const roi              = profit / equityRequired;
    const annualizedROI    = Math.pow(1 + roi, 12 / holding_months) - 1;
    const ruleOf70         = totalCost / arv;  // < 70% = typical rule of thumb
    const maxAllowableOffer = arv * 0.70 - rehab_budget;

    // ── Margin of safety (conservative: -10% ARV)
    const conservativeARV   = arv * 0.90;
    const conservativeProfit = conservativeARV - totalCostAll + (arv - conservativeARV) * selling_costs_pct;

    return res.json(meta({
      model: 'Fix-and-Flip Analyzer — 70% Rule, ROI, ARV Sensitivity',
      inputs: {
        purchase_price,
        rehab_budget,
        arv,
        holding_months,
        financing_rate: `${(financing_rate * 100).toFixed(1)}%`,
        ltv:            `${(ltv * 100).toFixed(0)}%`,
      },
      cost_breakdown: {
        purchase_price,
        rehab_budget,
        origination_fees:  +originationFees.toFixed(0),
        interest_cost:     +interestCost.toFixed(0),
        holding_costs:     +holdingCosts.toFixed(0),
        selling_costs:     +sellingCosts.toFixed(0),
        total_all_in_cost: +totalCostAll.toFixed(0),
      },
      financing: {
        loan_amount:       +loanAmount.toFixed(0),
        equity_required:   +equityRequired.toFixed(0),
        ltv:               `${(ltv * 100).toFixed(0)}%`,
      },
      returns: {
        net_profit:        +profit.toFixed(0),
        roi_on_equity:     `${(roi * 100).toFixed(2)}%`,
        annualized_roi:    `${(annualizedROI * 100).toFixed(2)}%`,
        profit_margin:     `${(profit / arv * 100).toFixed(2)}%`,
      },
      rule_of_70: {
        your_ratio:           `${(ruleOf70 * 100).toFixed(1)}%`,
        passes:               ruleOf70 <= 0.70,
        max_allowable_offer:  +maxAllowableOffer.toFixed(0),
        verdict:              ruleOf70 <= 0.70 ? 'Passes 70% rule' : 'Fails 70% rule — overpaying relative to ARV',
      },
      downside_scenario: {
        conservative_arv:    +conservativeARV.toFixed(0),
        conservative_profit: +conservativeProfit.toFixed(0),
        still_profitable:    conservativeProfit > 0,
      },
    }));
  } catch (e) {
    console.error('[HiveRE] POST /flip error:', e);
    return res.status(500).json(err('Flip analysis error: ' + e.message));
  }
});

// ─── POST /stress ─────────────────────────────────────────────────────────────

/**
 * Stress test a property across vacancy, rate, rent, and cap rate shocks.
 *
 * Body:
 *   base_noi           {number}  — Base-case NOI ($)
 *   debt_service       {number}  — Annual debt service ($)
 *   property_value     {number}  — Current value ($)
 *   loan_balance       {number}  — Outstanding loan ($)
 *   scenarios {Array<{ name, vacancy_delta, rent_delta, rate_delta, cap_rate_delta }>}
 *     All deltas as absolute (e.g. vacancy_delta: 0.05 means +5% vacancy)
 */
router.post('/stress', requireDID, requirePayment({ amount: PRICE.standard, asset: 'USDC', recipient: WALLET }), async (req, res) => {
  try {
    const {
      base_noi,
      debt_service,
      property_value,
      loan_balance,
      gross_rent,
      vacancy_base       = 0.05,
      cap_rate_base,
      scenarios,
    } = req.body;

    const required = { base_noi, debt_service, property_value };
    for (const [k, v] of Object.entries(required)) {
      if (v === undefined || v === null) return res.status(400).json(err(`Missing required field: ${k}`));
    }

    const baseCap = cap_rate_base || base_noi / property_value;
    const baseDS  = debt_service;
    const baseDSCR = base_noi / baseDS;
    const baseEquity = property_value - (loan_balance || 0);

    // Default scenarios if none provided
    const defaultScenarios = [
      { name: 'Mild Recession',    vacancy_delta: 0.05,  rent_delta: -0.05, rate_delta: 0.01,  cap_rate_delta: 0.005 },
      { name: 'Moderate Shock',    vacancy_delta: 0.10,  rent_delta: -0.10, rate_delta: 0.02,  cap_rate_delta: 0.010 },
      { name: 'Severe Downturn',   vacancy_delta: 0.20,  rent_delta: -0.20, rate_delta: 0.03,  cap_rate_delta: 0.020 },
      { name: 'Rate Spike Only',   vacancy_delta: 0,     rent_delta: 0,     rate_delta: 0.04,  cap_rate_delta: 0.015 },
      { name: 'Vacancy Spike Only',vacancy_delta: 0.25,  rent_delta: 0,     rate_delta: 0,     cap_rate_delta: 0 },
    ];

    const scenarioList = scenarios || defaultScenarios;

    const results = scenarioList.map(s => {
      // Adjusted NOI (vacancy + rent shock)
      const vacancyImpact = gross_rent ? -(gross_rent * (s.vacancy_delta || 0)) : -(base_noi * (s.vacancy_delta || 0) / (1 - vacancy_base));
      const rentImpact    = gross_rent ? gross_rent * (1 - (s.vacancy_delta || 0) + vacancy_base) * (s.rent_delta || 0) : base_noi * (s.rent_delta || 0);
      const stressedNOI   = base_noi + vacancyImpact + rentImpact;

      // Adjusted debt service (rate shock)
      const rateImpact    = (s.rate_delta || 0) > 0 ? loan_balance * (s.rate_delta || 0) : 0;
      const stressedDS    = baseDS + rateImpact;

      // Adjusted value (cap rate shock)
      const stressedCap   = baseCap + (s.cap_rate_delta || 0);
      const stressedValue = stressedNOI / stressedCap;
      const stressedEquity = stressedValue - (loan_balance || 0);

      const dscr           = stressedNOI / stressedDS;
      const cashflow       = stressedNOI - stressedDS;
      const ltv            = loan_balance ? loan_balance / stressedValue : null;

      return {
        scenario:         s.name,
        stressed_noi:     +stressedNOI.toFixed(0),
        stressed_ds:      +stressedDS.toFixed(0),
        stressed_cashflow: +cashflow.toFixed(0),
        stressed_dscr:    +dscr.toFixed(3),
        stressed_value:   +stressedValue.toFixed(0),
        stressed_ltv:     ltv ? `${(ltv * 100).toFixed(1)}%` : null,
        stressed_equity:  +stressedEquity.toFixed(0),
        viable:           dscr >= 1.0 && cashflow > 0,
        covenant_breach:  dscr < 1.25,  // typical bank covenant
        underwater:       stressedEquity < 0,
      };
    });

    const allViable    = results.every(r => r.viable);
    const anyBreached  = results.some(r => r.covenant_breach);
    const anyUnderwater = results.some(r => r.underwater);

    return res.json(meta({
      model: 'Real Estate Stress Test — Vacancy, Rate, Rent, Cap Rate Shocks',
      base_case: {
        noi:            base_noi,
        debt_service:   debt_service,
        dscr:           +baseDSCR.toFixed(3),
        property_value: property_value,
        equity:         +baseEquity.toFixed(0),
        cap_rate:       `${(baseCap * 100).toFixed(2)}%`,
      },
      stress_scenarios:  results,
      risk_summary: {
        all_scenarios_viable:     allViable,
        any_covenant_breach:      anyBreached,
        any_equity_underwater:    anyUnderwater,
        overall_risk:             anyUnderwater ? 'HIGH — equity at risk in severe scenario'
                                  : anyBreached ? 'MODERATE — covenant risk in adverse scenarios'
                                  : 'LOW — property survives all stress scenarios',
      },
    }));
  } catch (e) {
    console.error('[HiveRE] POST /stress error:', e);
    return res.status(500).json(err('Stress test error: ' + e.message));
  }
});

// ─── GET /hq ─────────────────────────────────────────────────────────────────

router.get('/hq', (req, res) => {
  res.json(meta({
    name: 'HiveRE — Real Estate Analysis Engine',
    tagline: 'Institutional-grade real estate modeling for autonomous agents.',
    pheromone_signal: 'real_estate_analysis',
    avg_bounty_usdc: 60.10,
    endpoints: [
      { path: 'POST /v1/re/valuation', price: `$${PRICE.advanced} USDC`, description: 'Three-approach valuation (Sales Comps + Income + Cost) with weighted reconciliation' },
      { path: 'POST /v1/re/cashflow',  price: `$${PRICE.standard} USDC`, description: 'Hold-period cash flow model: NOI, debt service, IRR, NPV, equity multiple, amortization' },
      { path: 'POST /v1/re/comps',     price: `$${PRICE.standard} USDC`, description: 'Comparable sales grid with size, bedroom, bath, garage, pool, age, condition, time adjustments' },
      { path: 'POST /v1/re/mortgage',  price: `$${PRICE.basic} USDC`,    description: 'Full mortgage calculator: PITI+HOA, amortization, DTI, PMI, payoff acceleration' },
      { path: 'POST /v1/re/portfolio', price: `$${PRICE.advanced} USDC`, description: 'Multi-property portfolio: NOI, cap rate, LTV, DSCR, equity, rebalancing recommendations' },
      { path: 'POST /v1/re/flip',      price: `$${PRICE.basic} USDC`,    description: 'Fix-and-flip: 70% rule, ROI, annualized return, ARV sensitivity, downside scenario' },
      { path: 'POST /v1/re/stress',    price: `$${PRICE.standard} USDC`, description: 'Stress test across vacancy, rate, rent, and cap rate shocks — DSCR, equity, covenant risk' },
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
