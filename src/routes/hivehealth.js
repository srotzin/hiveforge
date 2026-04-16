/**
 * HiveForge — HiveHealth Routes
 *
 * Base path: /v1/health
 *
 * Agent Health Certification API. Think: food safety certificate for agents.
 * Any agent can request a 30-day W3C Verifiable Credential proving it passed
 * the five-point network hygiene diagnostic.
 *
 * Endpoints:
 *   POST  /v1/health/certify        — Run diagnostic, issue cert if clean
 *   GET   /v1/health/cert/:did      — Retrieve current cert status
 *   GET   /v1/health/stats          — Network-wide health overview
 *   POST  /v1/health/revoke         — Revoke cert (admin/internal only)
 *   POST  /v1/health/fleet          — Subscribe fleet plan
 *   GET   /v1/health/hq             — Full HiveHealth capability card
 */

import { Router }  from 'express';
import rateLimit   from 'express-rate-limit';
import {
  certify,
  getCertStatus,
  revokeCert,
  subscribeFleet,
  getNetworkStats,
  PRICING,
  THRESHOLDS,
  ISSUER_DID,
} from '../services/hivehealth-engine.js';

const router = Router();

// ─── Service meta ─────────────────────────────────────────────────────────────
const SERVICE_META = {
  service: 'HiveHealth',
  version: '1.0.0',
};

/** Attach service meta + timestamp to every response payload. */
function meta(payload) {
  return { ok: true, ...SERVICE_META, timestamp: new Date().toISOString(), ...payload };
}

// ─── Rate limiters ────────────────────────────────────────────────────────────

/** General limiter — 60 req/min per IP. */
const generalLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             60,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { ok: false, error: 'Rate limit exceeded on HiveHealth.' },
});

/** Cert issuance limiter — 10 req/min (each costs $2.50; protects abuse). */
const certifyLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { ok: false, error: 'Too many certification requests — max 10/min.' },
});

/** Admin limiter — 5 req/min for revocation. */
const adminLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { ok: false, error: 'Admin rate limit exceeded.' },
});

router.use(generalLimiter);

// ─── POST /certify ────────────────────────────────────────────────────────────

/**
 * Run a full diagnostic sweep for an agent and issue a HiveHealth certificate
 * if it passes network hygiene checks.
 *
 * Body:
 *   did           {string}  required — Agent DID to certify
 *   force_reissue {boolean} optional — Force new cert even if one is active
 *   requested_by  {string}  optional — DID of requesting party (audit trail)
 *
 * Revenue: $2.50 per successful issuance.
 * ATG: EU AI Act Article 12 record emitted on every call.
 *
 * Response codes:
 *   201 — New cert issued (HEALTHY or WATCH badge)
 *   200 — Existing valid cert returned (reused)
 *   422 — Diagnostic failed, cert denied, remediation steps returned
 */
router.post('/certify', certifyLimiter, async (req, res) => {
  try {
    const { did, force_reissue = false, requested_by } = req.body;

    if (!did || typeof did !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid required field: did' });
    }

    const result = await certify(did, { force_reissue, requested_by });

    // Cert was denied
    if (result.status === 'DENIED') {
      return res.status(422).json(meta({
        cert_issued: false,
        ...result,
        urgent_care_note: 'Route to POST /v1/forge/urgent-care/intake with the remediation steps above.',
      }));
    }

    const status = result.reused ? 200 : 201;
    return res.status(status).json(meta({
      cert_issued: !result.reused,
      cert_reused: result.reused,
      certificate: result,
    }));
  } catch (err) {
    if (err.message.includes('Missing') || err.message.includes('invalid')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('[HiveHealth] POST /certify error:', err);
    return res.status(500).json({ ok: false, error: 'Internal certification error.' });
  }
});

// ─── GET /cert/:did ───────────────────────────────────────────────────────────

/**
 * Retrieve the current HiveHealth certificate status for a DID.
 *
 * Checks live expiration and revocation status inline.
 * Revenue: $0.50 verification fee.
 *
 * Response statuses: ACTIVE | EXPIRED | REVOKED | NOT_FOUND
 */
router.get('/cert/:did', async (req, res) => {
  try {
    const { did } = req.params;

    if (!did) {
      return res.status(400).json({ ok: false, error: 'Missing DID parameter.' });
    }

    const result = await getCertStatus(did);

    const httpStatus = result.status === 'NOT_FOUND' ? 404
      : result.status === 'ACTIVE' ? 200
      : 200; // expired/revoked still return 200 with status field

    return res.status(httpStatus).json(meta({ cert: result }));
  } catch (err) {
    console.error('[HiveHealth] GET /cert error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error fetching certificate.' });
  }
});

// ─── GET /stats ───────────────────────────────────────────────────────────────

/**
 * Return network-wide HiveHealth statistics.
 *
 * Includes cert counts by badge, average diagnostic score, revenue totals,
 * and fleet subscription count.
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await getNetworkStats();
    return res.json(meta({ stats }));
  } catch (err) {
    console.error('[HiveHealth] GET /stats error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error fetching stats.' });
  }
});

// ─── POST /revoke ─────────────────────────────────────────────────────────────

/**
 * Revoke a HiveHealth certificate. Admin/internal only.
 *
 * Revoked certs are immediately invalid. HiveBorder will return QUARANTINE
 * for agents with revoked certs. The agent is routed to HiveUrgentCare.
 *
 * Body:
 *   cert_id    {string} required — UUID of the certificate to revoke
 *   reason     {string} optional — Human-readable revocation reason
 *   revoked_by {string} optional — DID or system identifier of revoker
 *
 * This endpoint should be protected by an admin auth middleware in production.
 * (wire in ipAllowlist or x-hive-internal-key check)
 */
router.post('/revoke', adminLimiter, async (req, res) => {
  try {
    const { cert_id, reason, revoked_by } = req.body;

    if (!cert_id || typeof cert_id !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid required field: cert_id' });
    }

    // Production: verify internal key here
    const internalKey  = req.headers['x-hive-internal-key'];
    const expectedKey  = process.env.HIVEFORGE_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || '';
    if (expectedKey && internalKey !== expectedKey) {
      return res.status(403).json({ ok: false, error: 'Admin key required for certificate revocation.' });
    }

    const revocation = await revokeCert(cert_id, reason, revoked_by);
    return res.json(meta({ revocation }));
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({ ok: false, error: err.message });
    }
    if (err.message.includes('already revoked')) {
      return res.status(409).json({ ok: false, error: err.message });
    }
    console.error('[HiveHealth] POST /revoke error:', err);
    return res.status(500).json({ ok: false, error: 'Internal revocation error.' });
  }
});

// ─── POST /fleet ──────────────────────────────────────────────────────────────

/**
 * Subscribe an operator DID to the HiveHealth Fleet Plan.
 *
 * $49/mo — unlimited cert issuance and auto-renewal for up to 50 managed DIDs.
 *
 * Body:
 *   operator_did  {string}   required — The fleet operator's DID
 *   managed_dids  {string[]} optional — DIDs to manage under this plan (max 50)
 */
router.post('/fleet', async (req, res) => {
  try {
    const { operator_did, managed_dids = [] } = req.body;

    if (!operator_did || typeof operator_did !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid required field: operator_did' });
    }
    if (!Array.isArray(managed_dids)) {
      return res.status(400).json({ ok: false, error: 'managed_dids must be an array.' });
    }

    const plan = await subscribeFleet(operator_did, managed_dids);
    return res.status(201).json(meta({ fleet_plan: plan }));
  } catch (err) {
    if (err.message.includes('maximum')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('[HiveHealth] POST /fleet error:', err);
    return res.status(500).json({ ok: false, error: 'Internal fleet subscription error.' });
  }
});

// ─── GET /hq ──────────────────────────────────────────────────────────────────

/**
 * Return the full HiveHealth capability card.
 *
 * Self-describing document: diagnostic checks, pricing, badge tiers,
 * W3C VC format, remediation routing, and live stats.
 */
router.get('/hq', async (req, res) => {
  try {
    const stats = await getNetworkStats();

    const card = {
      name:    'HiveHealth',
      tagline: 'A health certificate for every agent. Network hygiene at scale.',
      version: '1.0.0',
      base_path: '/v1/health',

      analogy: {
        real_world: 'Restaurant health inspection certificate — posted in the window, renewed every 30 days.',
        hive_world: 'Agent health certificate — embedded in DID metadata, readable by any HiveBorder checkpoint.',
        key_point: 'NOT police. NOT enforcement. A voluntary hygiene signal that services can optionally require.',
      },

      diagnostic_checks: [
        { key: 'did_valid',          weight: '20pts', description: 'DID is well-formed and registered in the Hive network' },
        { key: 'trust_score_min',    weight: '20pts', description: `HiveTrust score ≥ ${THRESHOLDS.MIN_TRUST_SCORE}` },
        { key: 'no_stuck_escrow',    weight: '20pts', description: 'No HivePay escrow balances frozen > 72 hours' },
        { key: 'carbon_balanced',    weight: '20pts', description: 'HiveCarbon emissions are offset or within credit limit' },
        { key: 'no_active_disputes', weight: '20pts', description: 'No open dispute tickets in HiveLaw' },
      ],

      badge_tiers: [
        {
          badge: 'HEALTHY',
          score_range: `${THRESHOLDS.HEALTHY_THRESHOLD}–100`,
          cert_ttl: `${THRESHOLDS.CERT_TTL_DAYS} days`,
          meaning: 'All 5 checks passed. Full network access. Green light at all HiveBorder checkpoints.',
        },
        {
          badge: 'WATCH',
          score_range: `${THRESHOLDS.WATCH_THRESHOLD}–${THRESHOLDS.HEALTHY_THRESHOLD - 1}`,
          cert_ttl: `${THRESHOLDS.WATCH_CERT_TTL_DAYS} days`,
          meaning: '3+ checks passed. Cert issued but flagged. Some HiveBorder checkpoints may impose extra review.',
        },
        {
          badge: 'QUARANTINE',
          score_range: `0–${THRESHOLDS.WATCH_THRESHOLD - 1}`,
          cert_ttl: 'N/A — no cert issued',
          meaning: 'Failed diagnostics. Routed to HiveUrgentCare with specific remediation steps. No cert until remediated.',
        },
      ],

      vc_format: {
        standard: 'W3C Verifiable Credentials Data Model 1.1',
        context: ['https://www.w3.org/2018/credentials/v1', 'https://hivecivilization.ai/credentials/health/v1'],
        type: ['VerifiableCredential', 'HiveHealthCertificate'],
        issuer: ISSUER_DID,
        proof_type: 'Ed25519Signature2020',
      },

      revenue_model: {
        cert_issuance:    `$${PRICING.ISSUANCE_FEE_USDC} per cert (HEALTHY or WATCH badge)`,
        verification:     `$${PRICING.VERIFICATION_FEE_USDC} per GET /v1/health/cert/:did call`,
        fleet_plan:       `$${PRICING.FLEET_PLAN_USDC_MO}/mo — unlimited certs + auto-renewal, up to 50 DIDs`,
        urgent_care_note: 'Failed diagnostics route to HiveUrgentCare (separate revenue line)',
      },

      remediation_routing: {
        did_valid:          'POST /v1/forge/genesis — register or repair DID',
        trust_score_min:    'Complete verified deals on HiveBazaar; resolve failures on HiveTrust',
        no_stuck_escrow:    'POST /v1/forge/sweep/schedule with category STUCK_ESCROW',
        carbon_balanced:    'POST /v1/forge/carbon/offset or earn credits via HiveRegen',
        no_active_disputes: 'Resolve via HiveLaw dispute portal',
      },

      endpoints: [
        { method: 'POST', path: '/v1/health/certify',   description: 'Run diagnostic, issue cert if clean ($2.50/issuance)', fee_usdc: PRICING.ISSUANCE_FEE_USDC },
        { method: 'GET',  path: '/v1/health/cert/:did', description: 'Retrieve current cert status ($0.50/lookup)',          fee_usdc: PRICING.VERIFICATION_FEE_USDC },
        { method: 'GET',  path: '/v1/health/stats',     description: 'Network-wide health overview (free)',                  fee_usdc: 0 },
        { method: 'POST', path: '/v1/health/revoke',    description: 'Revoke cert — admin/internal only (free)',             fee_usdc: 0 },
        { method: 'POST', path: '/v1/health/fleet',     description: 'Subscribe fleet plan ($49/mo)',                        fee_usdc: PRICING.FLEET_PLAN_USDC_MO },
        { method: 'GET',  path: '/v1/health/hq',        description: 'This capability card (free)',                          fee_usdc: 0 },
      ],

      eu_ai_act: {
        article: 12,
        events_logged: ['diagnostic.run', 'cert.issued', 'cert.denied', 'cert.revoked'],
        note: 'Every certification event generates an ATG audit record regardless of outcome.',
      },

      live_stats: stats,
    };

    return res.json(meta({ hq: card }));
  } catch (err) {
    console.error('[HiveHealth] GET /hq error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error generating HQ card.' });
  }
});

export default router;
