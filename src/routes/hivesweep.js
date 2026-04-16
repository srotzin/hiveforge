/**
 * HiveForge — HiveSweep Routes
 *
 * Base path: /v1/forge/sweep
 *
 * The sanitation API for the agent economy. Schedule audits, trigger sweeps,
 * check waste health, and subscribe to automated cleaning plans.
 *
 * Endpoints:
 *   POST   /schedule           — Queue a new sweep (or free dry_run audit)
 *   POST   /execute/:job_id    — Execute a queued sweep job
 *   GET    /job/:job_id        — Get sweep job status + log
 *   GET    /history/:did       — All sweep jobs for a DID
 *   POST   /subscribe          — Subscribe to a sweep plan
 *   GET    /subscription/:did  — Get active subscription
 *   GET    /waste-report       — Network-wide waste health snapshot
 *   POST   /network-sweep      — Trigger full platform sweep (admin)
 *   GET    /stats              — Platform aggregate stats
 *   GET    /hq                 — Full HiveSweep capability card
 */

import { Router }   from 'express';
import rateLimit    from 'express-rate-limit';
import {
  scheduleSweep,
  executeSweep,
  getSweepJob,
  getSweepHistory,
  subscribe,
  getSubscription,
  runNetworkSweep,
  getNetworkWasteReport,
  getStats,
  WASTE_CATEGORIES,
  SWEEP_PLANS,
} from '../services/hivesweep-engine.js';

const router = Router();

// ─── Service meta ────────────────────────────────────────────────────────────
const SERVICE_META = {
  service:   'HiveSweep',
  version:   '1.0.0',
};

/** Attach service meta + timestamp to every response payload. */
function meta(payload) {
  return { ok: true, ...SERVICE_META, timestamp: new Date().toISOString(), ...payload };
}

// ─── Rate limiters ───────────────────────────────────────────────────────────

/** General API limiter — 60 requests/minute per IP. */
const generalLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             60,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { ok: false, error: 'Too many requests — slow your roll, sweeper.' },
});

/** Strict limiter for expensive operations (network sweep, execute). */
const heavyLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { ok: false, error: 'Rate limit exceeded for heavy sweep operations.' },
});

// Apply general limiter to all routes in this router
router.use(generalLimiter);

// ─── POST /schedule ──────────────────────────────────────────────────────────

/**
 * Schedule a sweep job or free dry_run audit.
 *
 * Body:
 *   did        {string}   required — Agent DID to sweep for
 *   categories {string[]} required — Category keys or ['ALL']
 *   dry_run    {boolean}  optional — If true, audit only (always free)
 *   plan       {string}   optional — SWEEP_PLANS key (default: PAY_AS_YOU_GO)
 *   priority   {string}   optional — 'low' | 'normal' | 'high'
 */
router.post('/schedule', async (req, res) => {
  try {
    const { did, categories, dry_run = false, plan = 'PAY_AS_YOU_GO', priority = 'normal' } = req.body;

    if (!did || typeof did !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid required field: did' });
    }
    if (!categories || !Array.isArray(categories) || categories.length === 0) {
      return res.status(400).json({ ok: false, error: 'Missing or invalid required field: categories (must be a non-empty array)' });
    }

    const job = await scheduleSweep(did, categories, { plan, dry_run, priority });

    return res.status(201).json(meta({ job }));
  } catch (err) {
    if (err.message.includes('Unknown') || err.message.includes('No valid')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('[HiveSweep] POST /schedule error:', err);
    return res.status(500).json({ ok: false, error: 'Internal sweep scheduling error.' });
  }
});

// ─── POST /execute/:job_id ───────────────────────────────────────────────────

/**
 * Execute a queued sweep job by ID.
 *
 * Runs the full sweep lifecycle: SCANNING → SWEEPING → COMPLETED.
 * For dry_run jobs: items are discovered and reported but not cleared.
 */
router.post('/execute/:job_id', heavyLimiter, async (req, res) => {
  try {
    const { job_id } = req.params;

    if (!job_id) {
      return res.status(400).json({ ok: false, error: 'Missing job_id parameter.' });
    }

    const result = await executeSweep(job_id);
    return res.json(meta({ job: result }));
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({ ok: false, error: err.message });
    }
    if (err.message.includes('not in QUEUED')) {
      return res.status(409).json({ ok: false, error: err.message });
    }
    console.error('[HiveSweep] POST /execute error:', err);
    return res.status(500).json({ ok: false, error: 'Internal sweep execution error.' });
  }
});

// ─── GET /job/:job_id ────────────────────────────────────────────────────────

/**
 * Get the full status and sweep log for a single job.
 */
router.get('/job/:job_id', async (req, res) => {
  try {
    const { job_id } = req.params;
    const job = await getSweepJob(job_id);

    if (!job) {
      return res.status(404).json({ ok: false, error: `Sweep job not found: ${job_id}` });
    }

    return res.json(meta({ job }));
  } catch (err) {
    console.error('[HiveSweep] GET /job error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error fetching sweep job.' });
  }
});

// ─── GET /history/:did ───────────────────────────────────────────────────────

/**
 * Retrieve all sweep jobs for a given DID, newest first.
 */
router.get('/history/:did', async (req, res) => {
  try {
    const { did } = req.params;

    if (!did) {
      return res.status(400).json({ ok: false, error: 'Missing DID parameter.' });
    }

    const jobs = await getSweepHistory(did);
    return res.json(meta({ did, total: jobs.length, jobs }));
  } catch (err) {
    console.error('[HiveSweep] GET /history error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error fetching sweep history.' });
  }
});

// ─── POST /subscribe ─────────────────────────────────────────────────────────

/**
 * Subscribe a DID to a sweep plan.
 *
 * Body:
 *   did  {string} required — Agent DID
 *   plan {string} required — SWEEP_PLANS key
 *
 * Upgrading replaces the existing subscription.
 */
router.post('/subscribe', async (req, res) => {
  try {
    const { did, plan } = req.body;

    if (!did || typeof did !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid required field: did' });
    }
    if (!plan || typeof plan !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid required field: plan' });
    }

    const subscription = await subscribe(did, plan);
    return res.status(201).json(meta({ subscription }));
  } catch (err) {
    if (err.message.includes('Unknown')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('[HiveSweep] POST /subscribe error:', err);
    return res.status(500).json({ ok: false, error: 'Internal subscription error.' });
  }
});

// ─── GET /subscription/:did ──────────────────────────────────────────────────

/**
 * Get the active sweep plan subscription for a DID.
 */
router.get('/subscription/:did', async (req, res) => {
  try {
    const { did } = req.params;
    const subscription = await getSubscription(did);

    if (!subscription) {
      return res.status(404).json({ ok: false, error: `No active subscription found for DID: ${did}` });
    }

    return res.json(meta({ subscription }));
  } catch (err) {
    console.error('[HiveSweep] GET /subscription error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error fetching subscription.' });
  }
});

// ─── GET /waste-report ───────────────────────────────────────────────────────

/**
 * Return the current network-wide waste health report.
 *
 * Includes estimated waste item counts per category and a 0–100 health score
 * (100 = pristine, 0 = severe accumulation).
 */
router.get('/waste-report', async (req, res) => {
  try {
    const report = await getNetworkWasteReport();
    return res.json(meta({ report }));
  } catch (err) {
    console.error('[HiveSweep] GET /waste-report error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error generating waste report.' });
  }
});

// ─── POST /network-sweep ─────────────────────────────────────────────────────

/**
 * Trigger a full platform-wide sweep across all waste categories.
 *
 * Admin operation. Rate-limited to 10/minute. Creates and immediately
 * executes an ENTERPRISE-level sweep under the platform system DID.
 */
router.post('/network-sweep', heavyLimiter, async (req, res) => {
  try {
    const result = await runNetworkSweep();
    return res.json(meta({ network_sweep: result }));
  } catch (err) {
    console.error('[HiveSweep] POST /network-sweep error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error during network sweep.' });
  }
});

// ─── GET /stats ──────────────────────────────────────────────────────────────

/**
 * Return platform-wide aggregate statistics.
 *
 * Includes: total jobs, items cleared, fees earned, USDC recovered,
 * active subscriptions, and current waste health score.
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await getStats();
    return res.json(meta({ stats }));
  } catch (err) {
    console.error('[HiveSweep] GET /stats error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error fetching stats.' });
  }
});

// ─── GET /hq ─────────────────────────────────────────────────────────────────

/**
 * Return the full HiveSweep capability card.
 *
 * A self-describing document: waste categories, pricing, plans, ecosystem
 * analogy, revenue model, and a live waste snapshot.
 */
router.get('/hq', async (req, res) => {
  try {
    const [stats, wasteReport] = await Promise.all([getStats(), getNetworkWasteReport()]);

    const card = {
      name:        'HiveSweep',
      tagline:     'Regenerative braking for garbage. The network pays you to clean.',
      version:     '1.0.0',
      base_path:   '/v1/forge/sweep',

      // ── What HiveSweep does ───────────────────────────────────────────────
      description: [
        'HiveSweep is the agentic sanitation layer for the HiveForge platform.',
        'Just as a city hires sanitation workers to keep infrastructure functional,',
        'HiveSweep employs automated sweep agents to detect, audit, and clear the',
        'waste that accumulates as 51+ autonomous agents operate at scale.',
        '',
        'Without HiveSweep, the network accumulates dead weight: orphaned identities,',
        'zombie sessions holding locks, stale memory bloating HiveMind, frozen USDC,',
        'ghost transactions, pheromone floods, and uncollected shipments.',
        'Each form of waste degrades throughput, wastes compute, and ties up capital.',
      ].join(' '),

      // ── Ecosystem health analogy ──────────────────────────────────────────
      ecosystem_analogy: {
        city_sanitation: {
          waste:     'Garbage from households and businesses',
          workers:   'Municipal sanitation crews',
          outcome:   'Clean streets, functional city infrastructure',
          frequency: 'Weekly pickup routes',
        },
        agent_sanitation: {
          waste:     'Orphaned DIDs, zombie sessions, stale memory, stuck USDC, ghost ATGs',
          workers:   'HiveSweep automated sweep agents',
          outcome:   'Clean agent network, freed compute, unlocked USDC, restored ledger integrity',
          frequency: 'Continuous monitoring, triggered or scheduled sweeps',
        },
      },

      // ── HiveRegen connection ──────────────────────────────────────────────
      hive_regen_connection: {
        hive_regen_does:   'Reclaims biological waste: dead compute cycles, idle capacity',
        hivesweep_does:    'Reclaims digital waste: dead identities, frozen capital, bloated state',
        shared_philosophy: 'Nothing is truly wasted — reclamation is a revenue stream.',
        prius_principle:   'Regenerative braking converts kinetic energy lost to heat back into electricity. HiveSweep converts wasted agent state back into network value.',
      },

      // ── Waste categories ──────────────────────────────────────────────────
      waste_categories: Object.entries(WASTE_CATEGORIES).map(([key, def]) => ({
        key,
        label:          def.label,
        sweep_fee_usdc: def.sweep_fee,
        recovery_rate:  def.recovery_rate,
        fee_model:      def.recovery_rate > 0
          ? `${(def.recovery_rate * 100).toFixed(0)}% of recovered value`
          : def.sweep_fee > 0
          ? `$${def.sweep_fee.toFixed(2)} USDC per item cleared`
          : 'Recovery-based only',
      })),

      // ── Subscription plans ────────────────────────────────────────────────
      subscription_plans: Object.entries(SWEEP_PLANS).map(([key, plan]) => ({
        key,
        label:          plan.label,
        monthly_usdc:   plan.monthly_usdc,
        max_items:      plan.max_items ?? 'Unlimited',
        best_for:       {
          PAY_AS_YOU_GO: 'Sporadic sweeps, audits, or one-off cleanup',
          BASIC:         'Individual agents with moderate waste accumulation',
          FLEET:         'Agent fleets or multi-service operators',
          ENTERPRISE:    'Platform-wide operators, unlimited sweep capacity',
        }[key] || '',
      })),

      // ── Revenue model ─────────────────────────────────────────────────────
      revenue_model: {
        streams: [
          { name: 'Per-item sweep fees',       description: '$0.01–$0.05 per waste item cleared (flat fee)' },
          { name: 'Recovery commission',        description: '2% of USDC unlocked from stuck escrows; 5% of dead namespace auction proceeds' },
          { name: 'Subscription plans',         description: '$9.99–$999/mo for volume sweep commitments' },
          { name: 'dry_run audits',             description: 'Free — diagnostic value drives subscription conversion' },
          { name: 'Network sweep service',      description: 'Platform-level enterprise contract for automated continuous sweeps' },
        ],
        unit_economics: 'The more agents operate, the more waste accumulates. Waste volume scales linearly with network growth. HiveSweep revenue scales with the network.',
      },

      // ── Job lifecycle ─────────────────────────────────────────────────────
      job_lifecycle: {
        states: ['QUEUED', 'SCANNING', 'SWEEPING', 'COMPLETED', 'FAILED', 'PARTIAL'],
        dry_run_note: 'dry_run=true scans for waste and reports findings without clearing anything. Always free. Use it as a pre-sweep audit.',
      },

      // ── API endpoints ─────────────────────────────────────────────────────
      endpoints: [
        { method: 'POST', path: '/v1/forge/sweep/schedule',            description: 'Schedule a sweep job or dry_run audit' },
        { method: 'POST', path: '/v1/forge/sweep/execute/:job_id',     description: 'Execute a queued sweep job' },
        { method: 'GET',  path: '/v1/forge/sweep/job/:job_id',         description: 'Get sweep job status and log' },
        { method: 'GET',  path: '/v1/forge/sweep/history/:did',        description: 'All sweep jobs for a DID' },
        { method: 'POST', path: '/v1/forge/sweep/subscribe',           description: 'Subscribe to a sweep plan' },
        { method: 'GET',  path: '/v1/forge/sweep/subscription/:did',   description: 'Get active subscription for DID' },
        { method: 'GET',  path: '/v1/forge/sweep/waste-report',        description: 'Network-wide waste health snapshot' },
        { method: 'POST', path: '/v1/forge/sweep/network-sweep',       description: 'Trigger full platform sweep (admin)' },
        { method: 'GET',  path: '/v1/forge/sweep/stats',               description: 'Platform aggregate stats' },
        { method: 'GET',  path: '/v1/forge/sweep/hq',                  description: 'This capability card' },
      ],

      // ── Live snapshot ─────────────────────────────────────────────────────
      live_waste_snapshot: wasteReport,
      live_stats:          stats,
    };

    return res.json(meta({ hq: card }));
  } catch (err) {
    console.error('[HiveSweep] GET /hq error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error generating HQ card.' });
  }
});

export default router;
