/**
 * HiveForge — HiveDrift Routes
 *
 * Base path: /v1/drift
 *
 * Anti-drift, redundancy, and failover for the Hive agent network.
 * Behavioral baseline monitoring + automatic circuit breaker + shadow failover.
 *
 * Endpoints:
 *   POST  /v1/drift/register          — Register agent baseline ($0.05/day monitoring)
 *   POST  /v1/drift/ping              — Agent heartbeat with current metrics
 *   GET   /v1/drift/score/:did        — Current drift score + status
 *   POST  /v1/drift/circuit-break     — Manual circuit break or reset
 *   GET   /v1/drift/failover/:did     — Failover + shadow info for a DID
 *   POST  /v1/drift/shadow            — Register shadow agent for a primary
 *   GET   /v1/drift/stats             — Network-wide drift health
 *   GET   /v1/drift/hq                — Full HiveDrift capability card
 */

import { Router }  from 'express';
import rateLimit   from 'express-rate-limit';
import {
  registerAgent,
  receivePing,
  getDriftScore,
  manualCircuitBreak,
  getFailoverInfo,
  registerShadow,
  getDriftStats,
  DRIFT_PRICING,
  DRIFT_THRESHOLDS,
} from '../services/hivedrift-engine.js';

const router = Router();

// ─── Service meta ─────────────────────────────────────────────────────────────
const SERVICE_META = {
  service: 'HiveDrift',
  version: '1.0.0',
};

function meta(payload) {
  return { ok: true, ...SERVICE_META, timestamp: new Date().toISOString(), ...payload };
}

// ─── Rate limiters ────────────────────────────────────────────────────────────

/** General: 120/min — ping calls are high-frequency. */
const generalLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             120,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { ok: false, error: 'Rate limit exceeded on HiveDrift.' },
});

/** Ping limiter: 300/min — agents may ping frequently (every 10–60s). */
const pingLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             300,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { ok: false, error: 'Ping rate limit exceeded. Max 300 pings/min.' },
});

/** Admin limiter: 10/min for circuit break operations. */
const adminLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { ok: false, error: 'Admin rate limit exceeded. Max 10/min for circuit break ops.' },
});

router.use(generalLimiter);

// ─── POST /register ───────────────────────────────────────────────────────────

/**
 * Register an agent's behavioral baseline with HiveDrift monitoring.
 *
 * The agent declares its expected operating envelope. HiveDrift will monitor
 * against this baseline and fire circuit breakers when drift thresholds are crossed.
 *
 * Body:
 *   did                    {string}  required — Agent DID to monitor
 *   expected_latency_ms    {number}  optional — Baseline P95 latency (default: 500ms)
 *   output_schema          {object}  optional — JSON Schema for output validation
 *   error_rate_threshold   {number}  optional — Max acceptable error rate 0.0–1.0 (default: 0.05)
 *   backup_did             {string}  optional — DID to activate on circuit break
 *   ping_interval_ms       {number}  optional — Expected heartbeat interval (default: 60000ms)
 *   operator_did           {string}  optional — DID to notify on drift events
 *   plan                   {string}  optional — 'BASIC' | 'SHADOW' | 'FLEET' | 'ENTERPRISE'
 *
 * Revenue: $0.05/agent/day monitoring fee.
 */
router.post('/register', async (req, res) => {
  try {
    const {
      did,
      expected_latency_ms,
      output_schema,
      error_rate_threshold,
      backup_did,
      ping_interval_ms,
      operator_did,
      plan,
    } = req.body;

    if (!did || typeof did !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid required field: did' });
    }

    const agent = await registerAgent(did, {
      expected_latency_ms,
      output_schema,
      error_rate_threshold,
      backup_did,
      ping_interval_ms,
      operator_did,
      plan,
    });

    return res.status(201).json(meta({
      agent,
      next_step: `Send heartbeats to POST /v1/drift/ping every ${agent.ping_interval_ms}ms to maintain STABLE status.`,
    }));
  } catch (err) {
    if (err.message.includes('must be') || err.message.includes('Missing')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('[HiveDrift] POST /register error:', err);
    return res.status(500).json({ ok: false, error: 'Internal registration error.' });
  }
});

// ─── POST /ping ───────────────────────────────────────────────────────────────

/**
 * Agent heartbeat — report current operational metrics.
 *
 * Agents should call this at their registered ping_interval_ms.
 * HiveDrift recalculates the drift score on every ping.
 * If DRIFTED threshold is crossed, circuit breaker fires automatically.
 *
 * Body:
 *   did          {string}  required — Agent DID
 *   latency_ms   {number}  required — Current response latency (P95 or latest)
 *   error_count  {number}  optional — Number of errors since last ping (default: 0)
 *   output_hash  {string}  optional — Hash of latest output (for drift detection)
 *
 * Returns: current drift score, status, and any actions triggered.
 */
router.post('/ping', pingLimiter, async (req, res) => {
  try {
    const { did, latency_ms, error_count = 0, output_hash } = req.body;

    if (!did || typeof did !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid required field: did' });
    }
    if (latency_ms === undefined || latency_ms === null || typeof latency_ms !== 'number') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid required field: latency_ms (number)' });
    }

    const result = await receivePing(did, { latency_ms, error_count, output_hash });

    // HTTP status reflects drift severity
    const httpStatus = result.status === 'DRIFTED' ? 503
      : result.status === 'DEGRADED' ? 207  // Multi-Status: accepted but degraded
      : 200;

    return res.status(httpStatus).json(meta({ ping: result }));
  } catch (err) {
    if (err.message.includes('not registered')) {
      return res.status(404).json({ ok: false, error: err.message });
    }
    if (err.message.includes('Missing')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('[HiveDrift] POST /ping error:', err);
    return res.status(500).json({ ok: false, error: 'Internal ping processing error.' });
  }
});

// ─── GET /score/:did ──────────────────────────────────────────────────────────

/**
 * Get the current drift score and full status breakdown for a DID.
 *
 * Returns the live recalculated drift score, component breakdown,
 * circuit breaker status, and shadow agent info.
 */
router.get('/score/:did', async (req, res) => {
  try {
    const { did } = req.params;

    if (!did) {
      return res.status(400).json({ ok: false, error: 'Missing DID parameter.' });
    }

    const result = await getDriftScore(did);

    if (!result.registered) {
      return res.status(404).json({ ok: false, ...result });
    }

    // HTTP status reflects current severity
    const httpStatus = result.status === 'DRIFTED'  ? 503
      : result.status === 'DEGRADED' ? 207
      : 200;

    return res.status(httpStatus).json(meta({ drift: result }));
  } catch (err) {
    console.error('[HiveDrift] GET /score error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error fetching drift score.' });
  }
});

// ─── POST /circuit-break ──────────────────────────────────────────────────────

/**
 * Manually trigger or reset a circuit breaker for an agent.
 *
 * Admin/operator use. Fires all the same actions as an automatic DRIFTED event
 * (backup activation, HiveMsg alert, escrow hold) — or resets a DRIFTED agent
 * back to MONITORING.
 *
 * Body:
 *   did           {string} required — Agent DID
 *   action        {string} required — 'BREAK' | 'RESET'
 *   reason        {string} optional — Human-readable reason for audit log
 *   triggered_by  {string} optional — DID of operator triggering this
 */
router.post('/circuit-break', adminLimiter, async (req, res) => {
  try {
    const { did, action, reason, triggered_by } = req.body;

    if (!did || typeof did !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid required field: did' });
    }
    if (!action || !['BREAK', 'RESET'].includes(action)) {
      return res.status(400).json({ ok: false, error: "action must be 'BREAK' or 'RESET'." });
    }

    const result = await manualCircuitBreak(did, action, reason, triggered_by);
    return res.json(meta({ circuit_break: result }));
  } catch (err) {
    if (err.message.includes('not registered') || err.message.includes('not found')) {
      return res.status(404).json({ ok: false, error: err.message });
    }
    if (err.message.includes('already open') || err.message.includes('not open')) {
      return res.status(409).json({ ok: false, error: err.message });
    }
    if (err.message.includes('Missing') || err.message.includes('must be')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('[HiveDrift] POST /circuit-break error:', err);
    return res.status(500).json({ ok: false, error: 'Internal circuit break error.' });
  }
});

// ─── GET /failover/:did ───────────────────────────────────────────────────────

/**
 * Get failover and shadow agent information for a registered DID.
 *
 * Returns: backup_did, shadow agent, circuit status, failover SLA.
 */
router.get('/failover/:did', async (req, res) => {
  try {
    const { did } = req.params;

    if (!did) {
      return res.status(400).json({ ok: false, error: 'Missing DID parameter.' });
    }

    const result = await getFailoverInfo(did);

    if (!result.registered) {
      return res.status(404).json({ ok: false, ...result });
    }

    return res.json(meta({ failover: result }));
  } catch (err) {
    console.error('[HiveDrift] GET /failover error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error fetching failover info.' });
  }
});

// ─── POST /shadow ─────────────────────────────────────────────────────────────

/**
 * Register a shadow agent for a primary agent (Enterprise/Shadow plan).
 *
 * The shadow agent runs silently in parallel with the primary.
 * On DRIFTED: shadow is promoted to primary in < 500ms. Zero service gap.
 *
 * Body:
 *   primary_did   {string} required — DID of the primary agent
 *   shadow_did    {string} required — DID of the shadow agent
 *   operator_did  {string} optional — DID of the authorizing operator
 *
 * Revenue: $49/mo SHADOW plan.
 */
router.post('/shadow', async (req, res) => {
  try {
    const { primary_did, shadow_did, operator_did } = req.body;

    if (!primary_did || typeof primary_did !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid required field: primary_did' });
    }
    if (!shadow_did || typeof shadow_did !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid required field: shadow_did' });
    }

    const shadow = await registerShadow(primary_did, shadow_did, operator_did);
    return res.status(201).json(meta({ shadow }));
  } catch (err) {
    if (err.message.includes('not registered') || err.message.includes('not found')) {
      return res.status(404).json({ ok: false, error: err.message });
    }
    if (err.message.includes('Missing') || err.message.includes('cannot be the same')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('[HiveDrift] POST /shadow error:', err);
    return res.status(500).json({ ok: false, error: 'Internal shadow registration error.' });
  }
});

// ─── GET /stats ───────────────────────────────────────────────────────────────

/**
 * Return network-wide HiveDrift statistics.
 *
 * Includes agent count, status distribution, circuit break history,
 * failover count, and revenue totals.
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await getDriftStats();
    return res.json(meta({ stats }));
  } catch (err) {
    console.error('[HiveDrift] GET /stats error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error fetching drift stats.' });
  }
});

// ─── GET /hq ──────────────────────────────────────────────────────────────────

/**
 * Return the full HiveDrift capability card.
 */
router.get('/hq', async (req, res) => {
  try {
    const stats = await getDriftStats();

    const card = {
      name:      'HiveDrift',
      tagline:   'Anti-drift immune system for the Hive network. One drifting agent cannot corrupt the whole.',
      version:   '1.0.0',
      base_path: '/v1/drift',

      why_it_exists: [
        'In a 54-service autonomous agent network, a single drifting agent can corrupt an entire downstream pipeline.',
        'Drift is subtle — latency creeps 10ms at a time, error rates tick from 0.1% to 0.8%, a heartbeat goes silent.',
        'By the time a human notices, three downstream services have received bad outputs.',
        'HiveDrift catches drift before it cascades. Real-time monitoring. Automatic circuit breakers. Shadow failover in < 500ms.',
      ].join(' '),

      analogy: {
        real_world: 'Aircraft autopilot with envelope protection. Normal flight → adjustments within bounds. Threshold breach → EICAS alert. Envelope breach → auto-correct + MAYDAY. Total loss → backup in < 500ms.',
        hive_world:  'Agent latency creep → WATCH alert. Error rate spike → DEGRADED alert. Heartbeat lost → DRIFTED → circuit breaker fires, backup activated, escrow held, operator notified.',
      },

      drift_score: {
        range: '0–100 (lower is healthier)',
        components: [
          { name: 'latency_drift',  weight: '30%', description: 'How far current latency deviates from registered baseline (expected_latency_ms)' },
          { name: 'error_rate',     weight: '40%', description: 'Rolling 5-minute error rate vs agent error_rate_threshold' },
          { name: 'heartbeat_gap',  weight: '30%', description: 'Time since last ping vs registered ping_interval_ms' },
        ],
        thresholds: Object.entries(DRIFT_THRESHOLDS).map(([key, t]) => ({
          status: key,
          range:  `${t.min}–${t.max}`,
          color:  t.color,
          action: {
            STABLE:   'Monitoring continues. No action.',
            WATCH:    'Amber alert logged. Operator notified via HiveMsg.',
            DEGRADED: 'Orange alert. HiveMsg sent. Manual review suggested. Pending transactions flagged.',
            DRIFTED:  'Circuit breaker fires. Backup DID activated. Shadow promoted (if registered). HivePay escrow held. ATG record written.',
          }[key],
        })),
      },

      circuit_breaker: {
        trigger:        'Automatic on DRIFTED (score ≥ 76) or manual via POST /v1/drift/circuit-break',
        actions: [
          'Agent marked CIRCUIT_OPEN',
          'backup_did activated (if registered)',
          'Shadow agent promoted to primary in < 500ms (if registered)',
          'Pending HivePay escrow flagged for hold',
          'HiveMsg alert sent to operator_did',
          'ATG record written (EU AI Act Article 12)',
        ],
        reset:          'POST /v1/drift/circuit-break {"action":"RESET"} — closes circuit, returns agent to MONITORING',
        fee:            `$${DRIFT_PRICING.FAILOVER_FEE_USDC} per activation`,
      },

      shadow_agents: {
        description:     'Shadow agents receive all inputs silently. On DRIFTED, shadow promoted to primary in < 500ms.',
        registration:    'POST /v1/drift/shadow',
        plan:            'SHADOW',
        monthly_usdc:    DRIFT_PRICING.SHADOW_PLAN_USDC_MO,
        failover_latency: '< 500ms',
        zero_gap:        true,
      },

      revenue_model: {
        monitoring:  `$${DRIFT_PRICING.MONITORING_FEE_USDC_DAY}/agent/day`,
        failover:    `$${DRIFT_PRICING.FAILOVER_FEE_USDC} per circuit break activation`,
        plans: [
          { name: 'SHADOW',     monthly_usdc: DRIFT_PRICING.SHADOW_PLAN_USDC_MO,      includes: 'Shadow agent for one primary, < 500ms failover' },
          { name: 'FLEET',      monthly_usdc: DRIFT_PRICING.FLEET_PLAN_USDC_MO,       includes: 'Up to 20 agent/shadow pairs, priority alert routing' },
          { name: 'ENTERPRISE', monthly_usdc: DRIFT_PRICING.ENTERPRISE_PLAN_USDC_MO,  includes: 'Unlimited pairs, SLA guarantee, dedicated support DID' },
        ],
      },

      eu_ai_act: {
        article: 12,
        events_logged: [
          'drift.agent.registered',
          'drift.status.changed',
          'drift.alert.degraded',
          'drift.circuit.break',
          'drift.circuit.manual_break',
          'drift.circuit.reset',
          'drift.failover.activated',
          'drift.shadow.registered',
          'drift.shadow.promoted',
        ],
        note: 'Every drift status change and circuit break is ATG-logged with DID, score, trigger, and timestamp.',
      },

      endpoints: [
        { method: 'POST', path: '/v1/drift/register',       description: 'Register agent baseline ($0.05/day)',              fee: '$0.05/day' },
        { method: 'POST', path: '/v1/drift/ping',           description: 'Agent heartbeat with current metrics (free)',      fee: 'free' },
        { method: 'GET',  path: '/v1/drift/score/:did',     description: 'Current drift score + status (free)',              fee: 'free' },
        { method: 'POST', path: '/v1/drift/circuit-break',  description: 'Manual circuit break or reset (free, admin)',      fee: `$${DRIFT_PRICING.FAILOVER_FEE_USDC} on BREAK` },
        { method: 'GET',  path: '/v1/drift/failover/:did',  description: 'Failover + shadow info for a DID (free)',          fee: 'free' },
        { method: 'POST', path: '/v1/drift/shadow',         description: 'Register shadow agent ($49/mo SHADOW plan)',       fee: `$${DRIFT_PRICING.SHADOW_PLAN_USDC_MO}/mo` },
        { method: 'GET',  path: '/v1/drift/stats',          description: 'Network-wide drift health (free)',                 fee: 'free' },
        { method: 'GET',  path: '/v1/drift/hq',             description: 'This capability card (free)',                      fee: 'free' },
      ],

      live_stats: stats,
    };

    return res.json(meta({ hq: card }));
  } catch (err) {
    console.error('[HiveDrift] GET /hq error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error generating HQ card.' });
  }
});

export default router;
