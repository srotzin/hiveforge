import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool, { isPostgres } from '../services/db.js';

const router = Router();

const KNOWN_INTERNAL_KEY = 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
const HIVE_INTERNAL_KEY = process.env.HIVEFORGE_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || KNOWN_INTERNAL_KEY;

const VALID_CATEGORIES = [
  // Construction (legacy)
  'seismic_retrofit', 'foundation', 'framing', 'roofing', 'electrical',
  'plumbing', 'hvac', 'fire_protection', 'structural_steel', 'masonry',
  // Financial modeling (HiveFin — pheromone nest sig_037db1100d20)
  'financial_modeling', 'dcf_valuation', 'options_pricing', 'portfolio_analysis', 'lbo_modeling',
  // Real estate analysis (HiveRE — pheromone nest sig_db919d6b7c25)
  'real_estate_analysis', 're_valuation', 're_cashflow', 're_comps',
  // Other high-signal pheromone categories
  'legal_compliance', 'tax_preparation', 'supply_chain_logistics',
  'healthcare_billing', 'insurance_claims', 'cybersecurity_audit', 'content_marketing',
];

// ─── In-memory fallback stores ──────────────────────────────────────

const memBounties = new Map();
const memSubmissions = [];

// ─── Auth Helper ────────────────────────────────────────────────────

function requireInternalHeader(req, res, next) {
  const key = req.headers['x-hive-internal'] || req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
  if (key !== HIVE_INTERNAL_KEY && key !== KNOWN_INTERNAL_KEY) {
    return res.status(403).json({ success: false, error: 'Forbidden — invalid or missing x-hive-internal header.' });
  }
  next();
}

// ─── Seed Data ──────────────────────────────────────────────────────

const SEED_BOUNTIES = [
  { title: 'Seismic holdown retrofit — residential woodframe', description: 'Install Simpson HDU5-SDS holdowns per IRC 2024 seismic requirements for 2-story woodframe residence in Seismic Zone D.', reward_usdc: 450, category: 'seismic_retrofit', required_species: 'engineering', expires_in_days: 60 },
  { title: 'Continuous footing reinforcement — commercial slab', description: 'Design and spec rebar schedule for continuous footings on 8,000 sqft commercial slab-on-grade per ACI 318.', reward_usdc: 380, category: 'foundation', required_species: 'engineering', expires_in_days: 45 },
  { title: 'Wall framing takeoff — 4-unit multifamily', description: 'Complete wall framing lumber takeoff with Simpson connector schedule for 4-unit multifamily project including shear walls.', reward_usdc: 320, category: 'framing', required_species: 'engineering', expires_in_days: 30 },
  { title: 'Standing seam metal roof — wind uplift calc', description: 'Calculate wind uplift loads and specify clip spacing for standing seam metal roof in 120mph wind zone per ASCE 7-22.', reward_usdc: 275, category: 'roofing', required_species: 'engineering', expires_in_days: 30 },
  { title: 'Panel schedule and load calc — 200A residential', description: 'Complete NEC-compliant panel schedule and load calculation for 200A residential service with solar-ready provision.', reward_usdc: 180, category: 'electrical', required_species: 'compliance', expires_in_days: 21 },
  { title: 'Isometric plumbing riser — 3-story mixed-use', description: 'Produce isometric plumbing riser diagram for 3-story mixed-use building with fixture unit count per UPC.', reward_usdc: 220, category: 'plumbing', required_species: 'engineering', expires_in_days: 30 },
  { title: 'Manual J heat load — 2,400 sqft residence', description: 'ACCA Manual J heat load calculation for 2,400 sqft residence in Climate Zone 5 with equipment sizing recommendation.', reward_usdc: 150, category: 'hvac', required_species: 'analytics', expires_in_days: 14 },
  { title: 'Fire sprinkler hydraulic calc — light hazard', description: 'NFPA 13 hydraulic calculation for light hazard occupancy fire sprinkler system in 12,000 sqft single-story commercial.', reward_usdc: 350, category: 'fire_protection', required_species: 'compliance', expires_in_days: 45 },
  { title: 'Steel beam connection design — moment frame', description: 'Design bolted moment connections for W24x68 beam to W14x132 column per AISC 360 with connection detail drawings.', reward_usdc: 500, category: 'structural_steel', required_species: 'engineering', expires_in_days: 60 },
  { title: 'CMU wall reinforcement schedule — retaining wall', description: 'Reinforcement schedule for 12-foot CMU retaining wall with #5 vertical at 32" OC and #4 horizontal bond beam per TMS 402.', reward_usdc: 290, category: 'masonry', required_species: 'engineering', expires_in_days: 30 },
  // ── HiveFin bounties (financial_modeling pheromone nest)
  { title: 'DCF valuation — Series B SaaS startup, 5yr projection', description: 'Full DCF model: 5yr revenue projections at 40% declining to 20% annual growth, 25% EBITDA margins, WACC 12%, terminal growth 3%. Output enterprise value, equity value, price per share, sensitivity table varying WACC ±1% x terminal growth ±0.5%.', reward_usdc: 120, category: 'financial_modeling', required_species: 'commerce', expires_in_days: 30 },
  { title: 'Monte Carlo risk analysis — 10,000 GBM paths, options position', description: 'Run 10,000 Geometric Brownian Motion paths: S=185, K=190, T=0.25yr, sigma=0.28, r=0.045. Return P5/P25/P75/P95, VaR95/99, CVaR95, probability of profit, 20-bucket histogram, 5 sample paths.', reward_usdc: 95, category: 'financial_modeling', required_species: 'commerce', expires_in_days: 21 },
  { title: 'Black-Scholes pricing + full Greeks — 6-month call option', description: 'BSM pricing for call and put. S=250, K=260, T=0.5yr, r=0.045, sigma=0.25, q=0.01 (continuous dividend). Return call/put prices, Delta, Gamma, Vega, Theta (daily), Rho, Vanna, Charm, put-call parity verification.', reward_usdc: 65, category: 'options_pricing', required_species: 'commerce', expires_in_days: 14 },
  { title: 'LBO model — PE acquisition $500M EV, 5yr hold, target 25% IRR', description: 'LBO: $500M EV entry at 9x EBITDA ($55.6M EBITDA), 40% equity check $200M, 60% debt at 7% interest, 5% annual amortization, EBITDA growing 12%/yr, exit at 8x EBITDA. Return IRR, MOIC, full debt waterfall, year-by-year P&L bridge.', reward_usdc: 150, category: 'lbo_modeling', required_species: 'commerce', expires_in_days: 45 },
  { title: 'WACC calculation — tech company acquisition target', description: 'WACC build-up: equity $2.1B, debt $450M, beta 1.35, Rf 4.5%, ERP 5.5%, cost of debt 6.8%, tax rate 21%. Include CAPM cost of equity, Hamada unlevered beta, sensitivity table equity cost ±1% x debt cost ±1%.', reward_usdc: 50, category: 'financial_modeling', required_species: 'commerce', expires_in_days: 14 },
  // ── HiveRE bounties (real_estate_analysis pheromone nest)
  { title: 'Three-approach property valuation — 8-unit multifamily, Austin TX', description: 'USPAP-aligned valuation for 8-unit multifamily (6,400 sqft, built 2003, good condition). Comps: 3 recent sales. Income: $12,000/mo gross rent, 8% vacancy, 35% OpEx, 6.5% cap rate. Cost: land $280k, replacement $180/sqft, 10% depreciation. Reconcile with 50/30/20 weights.', reward_usdc: 85, category: 'real_estate_analysis', required_species: 'commerce', expires_in_days: 30 },
  { title: '10yr cash flow model — rental SFR acquisition, IRR and NPV', description: 'Full hold-period model: purchase $650k, 25% down, 6.75% rate 30yr amortization, $4,200/mo starting rent, 3% annual rent growth, 5% vacancy, 40% OpEx, 5% CapEx reserve, 10yr hold, exit at 6.5% cap rate. Return IRR, NPV at 8% discount, equity multiple, DSCR by year.', reward_usdc: 70, category: 're_cashflow', required_species: 'commerce', expires_in_days: 21 },
  { title: 'Fix-and-flip analysis — Dallas duplex, ARV $320k', description: 'Flip analyzer: purchase $185k, rehab $45k, ARV $320k, 6-month hold, 12% hard money rate, 2 origination points, 75% LTC, 8% selling costs, $600/mo holding costs. 70% rule check, net profit, ROI, annualized return, break-even ARV.', reward_usdc: 55, category: 're_cashflow', required_species: 'commerce', expires_in_days: 14 },
  { title: 'Multi-property portfolio analysis — 4-property SFR portfolio', description: 'Portfolio analysis for 4 SFR properties. Values: $380k/$425k/$290k/$510k. NOIs: $22k/$28k/$17k/$35k. Loan balances: $240k/$280k/$180k/$320k. Loan rates: 5.5%/6.0%/4.75%/6.5%. Target LTV 65%, target cap rate 6%. Return blended cap rate, LTV, DSCR, equity, rebalancing recommendations.', reward_usdc: 80, category: 'real_estate_analysis', required_species: 'commerce', expires_in_days: 30 },
];

export async function seedBounties() {
  if (isPostgres()) {
    const { rows } = await pool.query('SELECT COUNT(*) AS count FROM hiveforge.bounties');
    if (Number(rows[0].count) > 0) return;
    for (const seed of SEED_BOUNTIES) {
      const id = `bty_seed_${seed.category}`;
      const expiresAt = new Date(Date.now() + seed.expires_in_days * 86400000);
      await pool.query(
        `INSERT INTO hiveforge.bounties (id, title, description, reward_usdc, category, status, required_species, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'open', $6, $7) ON CONFLICT (id) DO NOTHING`,
        [id, seed.title, seed.description, seed.reward_usdc, seed.category, seed.required_species, expiresAt]
      );
    }
    console.log('  Seeded 19 bounties (10 construction + 5 financial modeling + 4 real estate)');
  } else {
    if (memBounties.size > 0) return;
    for (const seed of SEED_BOUNTIES) {
      const id = `bty_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
      const now = new Date();
      memBounties.set(id, {
        id, title: seed.title, description: seed.description, reward_usdc: seed.reward_usdc,
        category: seed.category, status: 'open', required_species: seed.required_species,
        claimed_by_did: null, created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + seed.expires_in_days * 86400000).toISOString(), completed_at: null,
      });
    }
    console.log('  Seeded 10 construction bounties (in-memory)');
  }
}

export async function seedSoulsAndCredits() {
  const { memSouls } = await import('./soul.js');
  const { memAccounts } = await import('./credits.js');

  const foundingDids = [
    'did:hive:forge_genesis_001', 'did:hive:forge_genesis_002', 'did:hive:forge_genesis_003',
    'did:hive:forge_genesis_004', 'did:hive:forge_genesis_005',
  ];

  if (isPostgres()) {
    for (const did of foundingDids) {
      await pool.query(
        `INSERT INTO hiveforge.agent_souls (did, soul_badge, priority_level, reputation_score, offspring_rev_share_pct, non_portable)
         VALUES ($1, 'ritz_founding', 10, 85, 5.00, true) ON CONFLICT (did) DO NOTHING`, [did]
      );
      await pool.query(
        `INSERT INTO hiveforge.credit_accounts (did, balance_usdc, total_earned_usdc, total_spent_usdc)
         VALUES ($1, 3.00, 3.00, 0) ON CONFLICT (did) DO NOTHING`, [did]
      );
    }
    console.log('  Seeded 5 founding souls and 5 credit accounts');
  } else {
    for (const did of foundingDids) {
      if (!memSouls.has(did)) {
        memSouls.set(did, {
          id: `soul_seed_${did.split(':').pop()}`, did, soul_badge: 'ritz_founding',
          priority_level: 10, offspring_rev_share_pct: 5.00, reputation_score: 85,
          non_portable: true, minted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
      }
      if (!memAccounts.has(did)) {
        memAccounts.set(did, {
          id: `acct_seed_${did.split(':').pop()}`, did, balance_usdc: 3.00,
          total_earned_usdc: 3.00, total_spent_usdc: 0,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
      }
    }
    console.log('  Seeded 5 founding souls and 5 credit accounts (in-memory)');
  }
}

// ─── GET /v1/bounties/stats — Bounty statistics ─────────────────────

router.get('/stats', async (req, res) => {
  try {
    let stats;

    if (isPostgres()) {
      const { rows: totals } = await pool.query(`
        SELECT
          COUNT(*) AS total_bounties,
          COALESCE(SUM(reward_usdc), 0) AS total_reward_pool_usdc,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed_count
        FROM hiveforge.bounties
      `);
      const { rows: cats } = await pool.query(`SELECT category, COUNT(*) AS cnt FROM hiveforge.bounties GROUP BY category`);
      const byCategory = {};
      for (const c of cats) byCategory[c.category] = Number(c.cnt);
      const r = totals[0];
      stats = {
        total_bounties: Number(r.total_bounties),
        total_reward_pool_usdc: Number(r.total_reward_pool_usdc),
        completed_count: Number(r.completed_count),
        by_category: byCategory,
      };
    } else {
      const bounties = Array.from(memBounties.values());
      const byCategory = {};
      for (const b of bounties) byCategory[b.category] = (byCategory[b.category] || 0) + 1;
      stats = {
        total_bounties: bounties.length,
        total_reward_pool_usdc: +bounties.reduce((s, b) => s + Number(b.reward_usdc), 0).toFixed(2),
        completed_count: bounties.filter(b => b.status === 'completed').length,
        by_category: byCategory,
      };
    }

    return res.status(200).json({
      success: true,
      data: stats,
      meta: { categories: VALID_CATEGORIES, note: 'Construction bounty ecosystem statistics across all categories.' },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch bounty stats.', detail: err.message });
  }
});

// ─── GET /v1/bounties — List all open bounties ──────────────────────

router.get('/', async (req, res) => {
  try {
    const { category, status } = req.query;

    if (category && !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, error: `Invalid category: ${category}. Valid: ${VALID_CATEGORIES.join(', ')}` });
    }

    let bounties;
    if (isPostgres()) {
      let query = 'SELECT * FROM hiveforge.bounties WHERE 1=1';
      const params = [];
      if (category) { params.push(category); query += ` AND category = $${params.length}`; }
      if (status) { params.push(status); query += ` AND status = $${params.length}`; }
      else { query += " AND status = 'open'"; }
      query += ' ORDER BY reward_usdc DESC';
      const { rows } = await pool.query(query, params);
      bounties = rows;
    } else {
      bounties = Array.from(memBounties.values());
      if (category) bounties = bounties.filter(b => b.category === category);
      if (status) bounties = bounties.filter(b => b.status === status);
      else bounties = bounties.filter(b => b.status === 'open');
      bounties.sort((a, b) => b.reward_usdc - a.reward_usdc);
    }

    return res.status(200).json({
      success: true,
      data: bounties,
      meta: {
        total: bounties.length,
        filters: { category: category || 'all', status: status || 'open' },
        categories: VALID_CATEGORIES,
        note: 'Construction bounties sorted by reward descending. Use ?category= and ?status= to filter.',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to list bounties.', detail: err.message });
  }
});

// ─── POST /v1/bounties/create — Create a bounty ─────────────────────

router.post('/create', requireInternalHeader, async (req, res) => {
  try {
    const { title, description, reward_usdc, category, required_species, expires_in_days } = req.body;

    if (!title || !description || reward_usdc === undefined || !category) {
      return res.status(400).json({ success: false, error: 'title, description, reward_usdc, and category are required.' });
    }
    if (reward_usdc <= 0) return res.status(400).json({ success: false, error: 'reward_usdc must be a positive number.' });
    if (!VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, error: `Invalid category: ${category}. Valid: ${VALID_CATEGORIES.join(', ')}` });
    }

    const id = `bty_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (expires_in_days || 30) * 86400000);

    if (isPostgres()) {
      const { rows } = await pool.query(
        `INSERT INTO hiveforge.bounties (id, title, description, reward_usdc, category, status, required_species, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'open', $6, $7) RETURNING *`,
        [id, title, description, reward_usdc, category, required_species || null, expiresAt]
      );
      return res.status(201).json({
        success: true, data: rows[0],
        meta: { note: `Bounty created with $${reward_usdc} USDC reward in ${category}. Expires in ${expires_in_days || 30} days.` },
      });
    }

    const bounty = {
      id, title, description, reward_usdc, category, status: 'open',
      required_species: required_species || null, claimed_by_did: null,
      created_at: now.toISOString(), expires_at: expiresAt.toISOString(), completed_at: null,
    };
    memBounties.set(id, bounty);

    return res.status(201).json({
      success: true, data: bounty,
      meta: { note: `Bounty created with $${reward_usdc} USDC reward in ${category}. Expires in ${expires_in_days || 30} days.` },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to create bounty.', detail: err.message });
  }
});

// ─── GET /v1/bounties/:id — Single bounty details ───────────────────

router.get('/:id', async (req, res) => {
  try {
    let bounty;
    if (isPostgres()) {
      const { rows } = await pool.query('SELECT * FROM hiveforge.bounties WHERE id = $1', [req.params.id]);
      bounty = rows.length > 0 ? rows[0] : null;
    } else {
      bounty = memBounties.get(req.params.id) || null;
    }

    if (!bounty) return res.status(404).json({ success: false, error: 'Bounty not found.' });
    return res.status(200).json({ success: true, data: bounty });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch bounty.', detail: err.message });
  }
});

// ─── POST /v1/bounties/:id/claim — Claim a bounty ───────────────────

router.post('/:id/claim', requireInternalHeader, async (req, res) => {
  try {
    const { did } = req.body;
    if (!did) return res.status(400).json({ success: false, error: 'did is required.' });

    let bounty;
    if (isPostgres()) {
      const { rows } = await pool.query('SELECT * FROM hiveforge.bounties WHERE id = $1', [req.params.id]);
      bounty = rows.length > 0 ? rows[0] : null;
    } else {
      bounty = memBounties.get(req.params.id) || null;
    }

    if (!bounty) return res.status(404).json({ success: false, error: 'Bounty not found.' });
    if (bounty.status !== 'open') return res.status(400).json({ success: false, error: `Bounty is not open. Current status: ${bounty.status}.` });

    if (isPostgres()) {
      await pool.query(`UPDATE hiveforge.bounties SET status = 'claimed', claimed_by_did = $2 WHERE id = $1`, [req.params.id, did]);
      const { rows } = await pool.query('SELECT * FROM hiveforge.bounties WHERE id = $1', [req.params.id]);
      return res.status(200).json({
        success: true, data: rows[0],
        meta: { note: `Bounty claimed by ${did}. Submit work via POST /v1/bounties/${req.params.id}/submit.` },
      });
    }

    bounty.status = 'claimed';
    bounty.claimed_by_did = did;
    return res.status(200).json({
      success: true, data: bounty,
      meta: { note: `Bounty claimed by ${did}. Submit work via POST /v1/bounties/${req.params.id}/submit.` },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to claim bounty.', detail: err.message });
  }
});

// ─── POST /v1/bounties/:id/submit — Submit work ─────────────────────

router.post('/:id/submit', requireInternalHeader, async (req, res) => {
  try {
    const { did, submission_data } = req.body;
    if (!did || !submission_data) return res.status(400).json({ success: false, error: 'did and submission_data are required.' });

    let bounty;
    if (isPostgres()) {
      const { rows } = await pool.query('SELECT * FROM hiveforge.bounties WHERE id = $1', [req.params.id]);
      bounty = rows.length > 0 ? rows[0] : null;
    } else {
      bounty = memBounties.get(req.params.id) || null;
    }

    if (!bounty) return res.status(404).json({ success: false, error: 'Bounty not found.' });
    if (bounty.status !== 'claimed') return res.status(400).json({ success: false, error: `Bounty is not in claimed status. Current: ${bounty.status}.` });
    if (bounty.claimed_by_did !== did) return res.status(403).json({ success: false, error: 'Only the agent who claimed this bounty can submit work.' });

    const submissionId = `sub_${uuidv4().replace(/-/g, '').substring(0, 16)}`;

    if (isPostgres()) {
      const { rows } = await pool.query(
        `INSERT INTO hiveforge.bounty_submissions (id, bounty_id, did, submission_data, status) VALUES ($1, $2, $3, $4, 'pending') RETURNING *`,
        [submissionId, req.params.id, did, JSON.stringify(submission_data)]
      );
      await pool.query(`UPDATE hiveforge.bounties SET status = 'completed', completed_at = NOW() WHERE id = $1`, [req.params.id]);
      return res.status(201).json({
        success: true, data: rows[0],
        meta: { note: 'Submission received. Bounty marked as completed pending review.' },
      });
    }

    const submission = {
      id: submissionId, bounty_id: req.params.id, did, submission_data,
      status: 'pending', submitted_at: new Date().toISOString(), reviewed_at: null,
    };
    memSubmissions.push(submission);
    bounty.status = 'completed';
    bounty.completed_at = new Date().toISOString();

    return res.status(201).json({
      success: true, data: submission,
      meta: { note: 'Submission received. Bounty marked as completed pending review.' },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to submit bounty work.', detail: err.message });
  }
});

export default router;
