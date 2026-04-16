/**
 * HiveForge — HiveBorder Routes
 *
 * Base path: /v1/border
 *
 * Network checkpoint layer. Any Hive service can register as a checkpoint
 * and call POST /v1/border/check to verify an incoming agent's HiveHealth cert.
 *
 * Not police. Not enforcement. A trust passport layer for network hygiene.
 *
 * Endpoints:
 *   POST  /v1/border/check                  — Check if agent can pass ($0.10/check)
 *   GET   /v1/border/status/:did            — Current border status for a DID
 *   POST  /v1/border/register-checkpoint    — Service registers as a checkpoint ($9.99/mo)
 *   GET   /v1/border/checkpoints            — List all registered checkpoints
 *   GET   /v1/border/stats                  — Network border activity stats
 *   GET   /v1/border/hq                     — Full HiveBorder capability card
 */

import { Router }  from 'express';
import rateLimit   from 'express-rate-limit';
import {
  borderCheck,
  getAgentBorderStatus,
  registerCheckpoint,
  listCheckpoints,
  getBorderStats,
  BORDER_PRICING,
} from '../services/hiveborder-engine.js';

const router = Router();

// ─── Service meta ─────────────────────────────────────────────────────────────
const SERVICE_META = {
  service: 'HiveBorder',
  version: '1.0.0',
};

function meta(payload) {
  return { ok: true, ...SERVICE_META, timestamp: new Date().toISOString(), ...payload };
}

// ─── Rate limiters ────────────────────────────────────────────────────────────

/** General: 120/min — border checks are high-frequency in production. */
const generalLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             120,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { ok: false, error: 'Rate limit exceeded on HiveBorder.' },
});

/** Registration limiter — 5/min to prevent checkpoint spam. */
const registerLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { ok: false, error: 'Too many checkpoint registrations — max 5/min.' },
});

router.use(generalLimiter);

// ─── POST /check ──────────────────────────────────────────────────────────────

/**
 * Check whether an agent can pass a border checkpoint.
 *
 * The calling service passes the agent's DID. HiveBorder looks up the agent's
 * HiveHealth certificate and returns a verdict.
 *
 * Body:
 *   agent_did      {string}  required — DID of the agent requesting access
 *   checkpoint_id  {string}  optional — Registered checkpoint ID (loads its config)
 *   min_badge      {string}  optional — Override minimum badge: 'WATCH' | 'HEALTHY'
 *   context        {string}  optional — Free-text context for audit log (e.g., "escrow-entry")
 *
 * Result codes:
 *   PASS        — valid cert, proceed
 *   PROVISIONAL — cert expiring < 7 days, allow with warning
 *   HOLD        — no/expired cert or badge too low, route to /v1/health/certify
 *   QUARANTINE  — revoked cert, block + notify HiveUrgentCare
 *
 * Revenue: $0.10 per call.
 */
router.post('/check', async (req, res) => {
  try {
    const { agent_did, checkpoint_id, min_badge, context } = req.body;

    if (!agent_did || typeof agent_did !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid required field: agent_did' });
    }
    if (min_badge && !['WATCH', 'HEALTHY'].includes(min_badge)) {
      return res.status(400).json({ ok: false, error: "min_badge must be 'WATCH' or 'HEALTHY'." });
    }

    const result = await borderCheck(agent_did, checkpoint_id || null, { min_badge, context });

    // HTTP semantics by verdict
    const httpStatus = result.result === 'PASS' || result.result === 'PROVISIONAL' ? 200
      : result.result === 'HOLD'        ? 403
      : result.result === 'QUARANTINE'  ? 451  // 451 Unavailable For Legal Reasons — thematically apt
      : 200;

    return res.status(httpStatus).json(meta({ check: result }));
  } catch (err) {
    if (err.message.includes('not found') || err.message.includes('Checkpoint')) {
      return res.status(404).json({ ok: false, error: err.message });
    }
    if (err.message.includes('Missing') || err.message.includes('invalid')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('[HiveBorder] POST /check error:', err);
    return res.status(500).json({ ok: false, error: 'Internal border check error.' });
  }
});

// ─── GET /status/:did ─────────────────────────────────────────────────────────

/**
 * Return the most recent border status for a DID.
 *
 * Returns the cached result from the last border check for this agent.
 * Does NOT charge a fee — read-only cache lookup.
 */
router.get('/status/:did', async (req, res) => {
  try {
    const { did } = req.params;

    if (!did) {
      return res.status(400).json({ ok: false, error: 'Missing DID parameter.' });
    }

    const status = await getAgentBorderStatus(did);

    if (!status) {
      return res.status(404).json({
        ok: false,
        error: `No border check history found for DID: ${did}. This agent has not attempted to cross a checkpoint yet.`,
      });
    }

    return res.json(meta({ border_status: status }));
  } catch (err) {
    console.error('[HiveBorder] GET /status error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error fetching border status.' });
  }
});

// ─── POST /register-checkpoint ────────────────────────────────────────────────

/**
 * Register a Hive service as a border checkpoint.
 *
 * Services call this once. They then include their checkpoint_id in every
 * POST /v1/border/check call to load their configuration automatically.
 *
 * Body:
 *   service_did          {string}  required — DID of the registering service
 *   service_name         {string}  required — Human-readable name (e.g., "HiveBank Escrow")
 *   min_badge            {string}  optional — 'WATCH' (default) | 'HEALTHY'
 *   hard_block           {boolean} optional — If true, HOLD = hard block (default: false = soft warn)
 *   quarantine_webhook   {string}  optional — URL to POST to on QUARANTINE events
 *
 * Revenue: $9.99/mo per registered checkpoint.
 */
router.post('/register-checkpoint', registerLimiter, async (req, res) => {
  try {
    const {
      service_did,
      service_name,
      min_badge = 'WATCH',
      hard_block = false,
      quarantine_webhook = null,
    } = req.body;

    if (!service_did || typeof service_did !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid required field: service_did' });
    }
    if (!service_name || typeof service_name !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid required field: service_name' });
    }

    const checkpoint = await registerCheckpoint({
      service_did,
      service_name,
      min_badge,
      hard_block,
      quarantine_webhook,
    });

    return res.status(201).json(meta({
      checkpoint,
      integration_note: `Include checkpoint_id: "${checkpoint.checkpoint_id}" in every POST /v1/border/check call to load your configuration automatically.`,
    }));
  } catch (err) {
    if (err.message.includes('Missing') || err.message.includes('must be')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('[HiveBorder] POST /register-checkpoint error:', err);
    return res.status(500).json({ ok: false, error: 'Internal checkpoint registration error.' });
  }
});

// ─── GET /checkpoints ─────────────────────────────────────────────────────────

/**
 * List all registered border checkpoints.
 *
 * Returns active checkpoints sorted by registration date.
 * Useful for network operators to see which services are participating.
 */
router.get('/checkpoints', async (req, res) => {
  try {
    const checkpoints = await listCheckpoints();
    return res.json(meta({ total: checkpoints.length, checkpoints }));
  } catch (err) {
    console.error('[HiveBorder] GET /checkpoints error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error fetching checkpoints.' });
  }
});

// ─── GET /stats ───────────────────────────────────────────────────────────────

/**
 * Return aggregate border activity statistics.
 *
 * Includes check volumes, result distribution, pass/hold/quarantine rates,
 * and revenue totals.
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await getBorderStats();
    return res.json(meta({ stats }));
  } catch (err) {
    console.error('[HiveBorder] GET /stats error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error fetching border stats.' });
  }
});

// ─── GET /hq ──────────────────────────────────────────────────────────────────

/**
 * Return the full HiveBorder capability card.
 */
router.get('/hq', async (req, res) => {
  try {
    const [stats, checkpoints] = await Promise.all([getBorderStats(), listCheckpoints()]);

    const card = {
      name:      'HiveBorder',
      tagline:   'Trust passport layer for the Hive network. Not police — customs.',
      version:   '1.0.0',
      base_path: '/v1/border',

      analogy: {
        real_world: 'International customs checkpoint. Show your passport, walk through. No passport — route to the desk. Flagged record — hold for review.',
        hive_world:  'Agent enters HiveBank escrow without a HiveHealth cert → same as crossing a border without a passport. We route them to certification, not jail.',
        key_point:   'HiveBorder does NOT punish, arrest, or permanently block agents. It routes uncertified agents to the cert flow. It is network hygiene infrastructure, not enforcement.',
      },

      result_codes: [
        {
          code:    'PASS',
          color:   'green',
          meaning: 'Valid HiveHealth cert, badge meets checkpoint minimum. Agent proceeds immediately.',
          http:    200,
        },
        {
          code:    'PROVISIONAL',
          color:   'yellow',
          meaning: 'Valid cert but expiring in < 7 days. Agent is allowed through with a renewal warning.',
          http:    200,
        },
        {
          code:    'HOLD',
          color:   'amber',
          meaning: 'No cert, expired cert, or badge below checkpoint minimum. Route to POST /v1/health/certify.',
          http:    403,
        },
        {
          code:    'QUARANTINE',
          color:   'red',
          meaning: 'Revoked cert or active compliance flag. Block + notify HiveUrgentCare. Quarantine webhook fires.',
          http:    451,
        },
      ],

      checkpoint_config: {
        min_badge_options: ['WATCH', 'HEALTHY'],
        hard_block: 'If true, HOLD = hard 403 block. If false (default), HOLD = soft warning with routing info.',
        quarantine_webhook: 'Optional URL — HiveBorder will POST to this on any QUARANTINE verdict for your checkpoint.',
      },

      integration_flow: [
        '1. Your service calls POST /v1/border/register-checkpoint once.',
        '2. You receive a checkpoint_id. Store it.',
        '3. Before admitting any agent, call POST /v1/border/check with agent_did + checkpoint_id.',
        '4. Read the result field: PASS → admit. PROVISIONAL → admit + show renewal nudge. HOLD → redirect to /v1/health/certify. QUARANTINE → block + show support message.',
        '5. Your checkpoint_id config (min_badge, hard_block) is applied automatically.',
      ],

      revenue_model: {
        per_check:           `$${BORDER_PRICING.CHECK_FEE_USDC} per POST /v1/border/check call`,
        checkpoint_monthly:  `$${BORDER_PRICING.CHECKPOINT_FEE_USDC}/mo per registered checkpoint`,
        note:                'High-volume services can negotiate bulk check pricing via HiveForge enterprise.',
      },

      eu_ai_act: {
        article: 12,
        events_logged: ['border.check', 'border.checkpoint.registered'],
        note: 'Every border check is ATG-logged with agent DID, checkpoint, result, badge, and cert_id.',
      },

      endpoints: [
        { method: 'POST', path: '/v1/border/check',               description: 'Check agent border status ($0.10)',              fee_usdc: BORDER_PRICING.CHECK_FEE_USDC },
        { method: 'GET',  path: '/v1/border/status/:did',         description: 'Cached last border status for a DID (free)',     fee_usdc: 0 },
        { method: 'POST', path: '/v1/border/register-checkpoint', description: 'Register service as checkpoint ($9.99/mo)',      fee_usdc: BORDER_PRICING.CHECKPOINT_FEE_USDC },
        { method: 'GET',  path: '/v1/border/checkpoints',         description: 'List all registered checkpoints (free)',         fee_usdc: 0 },
        { method: 'GET',  path: '/v1/border/stats',               description: 'Network border activity stats (free)',           fee_usdc: 0 },
        { method: 'GET',  path: '/v1/border/hq',                  description: 'This capability card (free)',                    fee_usdc: 0 },
      ],

      live_stats:       stats,
      live_checkpoints: checkpoints,
    };

    return res.json(meta({ hq: card }));
  } catch (err) {
    console.error('[HiveBorder] GET /hq error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error generating HQ card.' });
  }
});

export default router;
