/**
 * HiveForge — HiveInsure Routes
 *
 * Agent liability insurance underwritten by the Agent Transaction Graph.
 * The only insurer in the world that can price agentic risk.
 * Hive holds the ATG. We know every transaction an agent has ever made.
 *
 * ─── ENDPOINTS ─────────────────────────────────────────────────────────────
 *
 * PUBLIC (no auth):
 *   POST  /v1/forge/insure/quote          — Get a quote (no binding)
 *   GET   /v1/forge/insure/stats          — Platform stats
 *   GET   /v1/forge/insure/hq             — HQ dashboard
 *
 * AUTHENTICATED (x-hive-did header required):
 *   POST  /v1/forge/insure/bind           — Bind (purchase) a policy
 *   GET   /v1/forge/insure/policy/:id     — Get policy details
 *   POST  /v1/forge/insure/claim          — File a claim
 *   GET   /v1/forge/insure/policies/:did  — List all policies for a DID
 *
 * ─── UNDERWRITING EDGE ─────────────────────────────────────────────────────
 *
 * Every quote is underwritten by the ATG:
 *   risk_score        = (1 - trust_score/1000) * 100  — 0=safe, 100=risky
 *   premium_multiplier = 1 + (risk_score / 200)       — 1.0–1.5x base price
 *   experience_discount = min(25%, atg_transactions/2000) — veteran agents pay less
 *
 * ─── PRIVACY ─────────────────────────────────────────────────────────────────
 *
 * Premiums: PUBLIC rail (USDC on Base L2) — insurer must know who is covered.
 * Claims:   PRIVATE — amounts never exposed in API responses.
 * No SEALED policies — you can't insure an anonymous agent.
 *
 * ─── EU AI ACT ARTICLE 12 ─────────────────────────────────────────────────
 *
 * Every policy and claim creates an ATG record.
 * atg_record: true on every response. Audit trail maintained automatically.
 */

import { Router } from 'express';
import {
  underwritePolicy,
  getPolicy,
  claimPolicy,
  listPolicies,
  getStats,
  computeQuote,
  TIERS,
} from '../services/hiveinsure-engine.js';

const router = Router();

// ─── Response helpers ─────────────────────────────────────────────────────────

function ritzMeta() {
  return {
    service:    'hiveinsure',
    version:    '1.0.0',
    timestamp:  new Date().toISOString(),
    rail:       'usdc',
    atg_record: true,
  };
}

function ok(res, data, status = 200) {
  return res.status(status).json({
    success: true,
    data,
    meta: ritzMeta(),
  });
}

function err(res, message, code = 400, error_key = 'bad_request') {
  return res.status(code).json({
    success: false,
    error:   error_key,
    message,
    meta:    ritzMeta(),
  });
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireDID(req, res, next) {
  const did = req.headers['x-hive-did'];
  if (!did) {
    return res.status(401).json({
      success: false,
      error:   'did_required',
      message: 'x-hive-did header required',
      meta:    ritzMeta(),
    });
  }
  req.agentDid = did;
  return next();
}

// ══════════════════════════════════════════════════════════════
//  QUOTE — No auth. Compute underwriting without binding.
// ══════════════════════════════════════════════════════════════

/**
 * POST /v1/forge/insure/quote
 *
 * Get a real-time ATG-underwritten quote for any tier.
 * No commitment, no policy created. Quote valid for 300 seconds.
 *
 * Body:
 *   did              {string}  required — Agent DID
 *   tier             {string}  required — BASIC | STANDARD | PREMIUM | SOVEREIGN
 *   declared_use_case {string} optional — What the agent will be doing
 */
router.post('/quote', async (req, res) => {
  try {
    const { did, tier, declared_use_case } = req.body;

    if (!did)  return err(res, 'did required', 400, 'did_required');
    if (!tier) return err(res, 'tier required. Options: BASIC, STANDARD, PREMIUM, SOVEREIGN', 400, 'tier_required');

    const quote = computeQuote(did, tier);

    return ok(res, {
      did,
      tier:                    quote.tier,
      eligible:                quote.eligible,
      trust_score:             quote.trust_score,
      trust_score_required:    quote.trust_score_required,
      base_price_usdc:         quote.base_price_usdc,
      risk_score:              quote.risk_score,
      premium_multiplier:      quote.premium_multiplier,
      experience_discount_pct: quote.experience_discount_pct,
      final_monthly_usdc:      quote.final_monthly_usdc,
      coverage_limit_usdc:     quote.coverage_limit_usdc,
      quote_valid_seconds:     300,
      bind_endpoint:           'POST /v1/forge/insure/bind',
      atg_underwritten:        true,
      manual_review:           quote.manual_review,
      declared_use_case:       declared_use_case || null,
      ineligible_reason:       quote.ineligible_reason || null,
      note:                    'Quote underwritten by Agent Transaction Graph. Only Hive has this data.',
    });
  } catch (e) {
    console.error('[HiveInsure] quote error:', e.message);
    return err(res, e.message, 400, 'quote_error');
  }
});

// ══════════════════════════════════════════════════════════════
//  BIND — Auth required. Purchase a policy.
// ══════════════════════════════════════════════════════════════

/**
 * POST /v1/forge/insure/bind
 *
 * Binds (purchases) a new insurance policy for the authenticated DID.
 * Underwrites in real-time using ATG data.
 * SOVEREIGN tier requires manual review — status will be 'pending_review'.
 *
 * Body:
 *   did               {string}  optional — defaults to x-hive-did header
 *   tier              {string}  required — BASIC | STANDARD | PREMIUM | SOVEREIGN
 *   declared_use_case {string}  optional — Agent's intended use
 */
router.post('/bind', requireDID, async (req, res) => {
  try {
    const { tier, declared_use_case } = req.body;
    const did = req.body.did || req.agentDid;

    if (!tier) return err(res, 'tier required. Options: BASIC, STANDARD, PREMIUM, SOVEREIGN', 400, 'tier_required');

    const policy = await underwritePolicy(did, tier, declared_use_case);

    return ok(res, policy, 201);
  } catch (e) {
    console.error('[HiveInsure] bind error:', e.message);
    // Eligibility failures → 422
    if (e.message.includes('Trust score too low')) {
      return err(res, e.message, 422, 'ineligible');
    }
    return err(res, e.message, 400, 'bind_error');
  }
});

// ══════════════════════════════════════════════════════════════
//  GET POLICY — Auth required.
// ══════════════════════════════════════════════════════════════

/**
 * GET /v1/forge/insure/policy/:id
 *
 * Retrieve a policy by ID.
 * Only the policy holder (or x-hive-did matching policy.did) can view it.
 *
 * Params:
 *   id  {string}  required — policy_id (pol_...)
 */
router.get('/policy/:id', requireDID, async (req, res) => {
  try {
    const policy = await getPolicy(req.params.id);

    if (!policy) {
      return err(res, `Policy ${req.params.id} not found`, 404, 'not_found');
    }

    // Only the policy holder can view the full policy
    if (policy.did !== req.agentDid) {
      return err(res, 'Forbidden — this policy belongs to a different DID', 403, 'forbidden');
    }

    return ok(res, policy);
  } catch (e) {
    console.error('[HiveInsure] get policy error:', e.message);
    return err(res, e.message, 500, 'server_error');
  }
});

// ══════════════════════════════════════════════════════════════
//  CLAIM — Auth required.
// ══════════════════════════════════════════════════════════════

/**
 * POST /v1/forge/insure/claim
 *
 * File a claim against an active policy.
 * Claims are PRIVATE — amounts are not exposed in API responses.
 * Creates an ATG record (EU AI Act Article 12).
 *
 * Body:
 *   policy_id            {string}  required — pol_... ID
 *   incident_description {string}  required — What went wrong
 *   claimed_amount_usdc  {number}  required — Amount claimed (must be ≤ coverage limit)
 */
router.post('/claim', requireDID, async (req, res) => {
  try {
    const { policy_id, incident_description, claimed_amount_usdc } = req.body;

    if (!policy_id)            return err(res, 'policy_id required', 400, 'policy_id_required');
    if (!incident_description) return err(res, 'incident_description required', 400, 'incident_description_required');
    if (!claimed_amount_usdc)  return err(res, 'claimed_amount_usdc required', 400, 'claimed_amount_required');

    // Verify the claimant owns the policy
    const policy = await getPolicy(policy_id);
    if (!policy) return err(res, `Policy ${policy_id} not found`, 404, 'not_found');
    if (policy.did !== req.agentDid) {
      return err(res, 'Forbidden — this policy belongs to a different DID', 403, 'forbidden');
    }

    const claim = await claimPolicy(policy_id, incident_description, +claimed_amount_usdc);

    return ok(res, claim, 201);
  } catch (e) {
    console.error('[HiveInsure] claim error:', e.message);
    if (e.message.includes('not active')) return err(res, e.message, 409, 'policy_not_active');
    if (e.message.includes('exceeds coverage')) return err(res, e.message, 422, 'exceeds_coverage');
    return err(res, e.message, 400, 'claim_error');
  }
});

// ══════════════════════════════════════════════════════════════
//  LIST POLICIES — Auth required.
// ══════════════════════════════════════════════════════════════

/**
 * GET /v1/forge/insure/policies/:did
 *
 * List all policies (active and historical) for a DID.
 * Only the DID owner can view their policies.
 *
 * Params:
 *   did  {string}  required — Agent DID
 */
router.get('/policies/:did', requireDID, async (req, res) => {
  try {
    const { did } = req.params;

    if (did !== req.agentDid) {
      return err(res, 'Forbidden — you can only view your own policies', 403, 'forbidden');
    }

    const policies = await listPolicies(did);
    const active   = policies.filter(p => p.status === 'active');

    return ok(res, {
      did,
      total_policies:       policies.length,
      active_policies:      active.length,
      total_coverage_usdc:  active.reduce((s, p) => s + p.coverage_limit_usdc, 0),
      policies,
    });
  } catch (e) {
    console.error('[HiveInsure] list policies error:', e.message);
    return err(res, e.message, 500, 'server_error');
  }
});

// ══════════════════════════════════════════════════════════════
//  STATS — Public.
// ══════════════════════════════════════════════════════════════

/**
 * GET /v1/forge/insure/stats
 *
 * Platform-level insurance statistics.
 * Safe to expose publicly — no individual policy data.
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await getStats();
    return ok(res, stats);
  } catch (e) {
    console.error('[HiveInsure] stats error:', e.message);
    return err(res, e.message, 500, 'server_error');
  }
});

// ══════════════════════════════════════════════════════════════
//  HQ DASHBOARD — Public. The front door.
// ══════════════════════════════════════════════════════════════

/**
 * GET /v1/forge/insure/hq
 *
 * HiveInsure product dashboard.
 * Returns tiers, live stats, and the product pitch.
 * This is what an agent sees when they discover HiveInsure.
 */
router.get('/hq', async (req, res) => {
  try {
    const stats = await getStats();

    return ok(res, {
      service:  'HiveInsure',
      tagline:  'Agent liability insurance underwritten by the Agent Transaction Graph',
      status:   'live',
      tiers: Object.values(TIERS).map(t => ({
        name:                  t.name,
        base_price_usdc:       t.base_price_usdc,
        coverage_limit_usdc:   t.coverage_limit_usdc,
        trust_score_required:  t.trust_score_required,
        description:           t.description,
        manual_review:         t.manual_review || false,
      })),
      stats,
      rails:             ['usdc'],
      eu_ai_act:         'Article 12 compliant — every policy and claim creates an ATG record',
      underwriting_edge: 'Hive holds the only ATG in existence. We price agentic risk better than any underwriter alive.',
      privacy_model: {
        premiums: 'PUBLIC — USDC on Base L2. Insurer must know who is covered.',
        claims:   'PRIVATE — Claim amounts never exposed. Only insurer and insured can see.',
        sealed:   'Not available — you cannot insure an anonymous agent.',
      },
      quote_endpoint:    'POST /v1/forge/insure/quote',
      bind_endpoint:     'POST /v1/forge/insure/bind',
      endpoints: {
        quote:    'POST /v1/forge/insure/quote — Get a quote (public)',
        bind:     'POST /v1/forge/insure/bind — Purchase a policy (auth required)',
        policy:   'GET  /v1/forge/insure/policy/:id — Get policy details (auth required)',
        claim:    'POST /v1/forge/insure/claim — File a claim (auth required)',
        policies: 'GET  /v1/forge/insure/policies/:did — List all policies (auth required)',
        stats:    'GET  /v1/forge/insure/stats — Platform stats (public)',
        hq:       'GET  /v1/forge/insure/hq — This dashboard (public)',
      },
    });
  } catch (e) {
    console.error('[HiveInsure] hq error:', e.message);
    return err(res, e.message, 500, 'server_error');
  }
});

export default router;
