/**
 * HiveCarbon Routes — Agent Emissions Metering + Carbon Offset Marketplace
 *
 * All endpoints under /v1/forge/carbon
 *
 * POST /meter          — Meter a transaction's emissions for an agent
 * GET  /footprint/:did — Get total emissions footprint for an agent
 * POST /attest         — Issue a signed EU AI Act Article 12 attestation
 * POST /offset         — Purchase carbon offsets
 * GET  /market         — Browse the offset marketplace
 * POST /trade          — P2P offset trade between two agents
 * POST /badge          — Issue Carbon Neutral Agent badge (requires verified status)
 * POST /fleet/footprint — Get aggregate footprint for a fleet of agents
 * POST /fleet/subscribe — Subscribe to fleet carbon tracking plan
 * GET  /stats          — Platform-wide HiveCarbon statistics
 * GET  /hq             — Service discovery / capability card
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  meterTransaction,
  getAgentFootprint,
  issueAttestation,
  buyOffset,
  listOffsetMarket,
  tradeOffset,
  issueGreenBadge,
  getFleetFootprint,
  subscribeFleet,
  getStats,
} from '../services/hivecarbon-engine.js';

const router = Router();

// ─── Rate Limiters ─────────────────────────────────────────────────────────────

const defaultLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — HiveCarbon rate limit exceeded' },
});

const meterLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,   // high volume — metering fires per transaction
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many meter requests' },
});

router.use(defaultLimiter);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function missing(res, fields) {
  return res.status(400).json({
    error: `Missing required fields: ${fields.join(', ')}`,
    required: fields,
  });
}

// ─── POST /v1/forge/carbon/meter ───────────────────────────────────────────────
//
// Meter emissions for a single agent transaction. Called automatically by other
// Hive services (HiveMsg, HivePay, HiveInsure, etc.) or by agents directly.
//
// Body: { did, model, call_count, region?, service_type? }

router.post('/meter', meterLimiter, async (req, res) => {
  try {
    const { did, model, call_count, region, service_type } = req.body;

    if (!did)         return missing(res, ['did']);
    if (!model)       return missing(res, ['model']);
    if (!call_count)  return missing(res, ['call_count']);

    if (typeof call_count !== 'number' || call_count < 1) {
      return res.status(400).json({ error: 'call_count must be a positive integer' });
    }

    const record = await meterTransaction(did, model, call_count, region, service_type);

    return res.status(201).json({
      ok:      true,
      message: 'Emissions metered',
      record,
    });
  } catch (err) {
    return res.status(500).json({ error: 'meter_failed', detail: err.message });
  }
});

// ─── GET /v1/forge/carbon/footprint/:did ──────────────────────────────────────
//
// Return total and monthly emissions footprint for a DID, including agent size
// classification and offset status.

router.get('/footprint/:did', async (req, res) => {
  try {
    const { did } = req.params;
    if (!did) return res.status(400).json({ error: 'did is required' });

    const footprint = await getAgentFootprint(did);
    return res.status(200).json({ ok: true, footprint });
  } catch (err) {
    return res.status(500).json({ error: 'footprint_failed', detail: err.message });
  }
});

// ─── POST /v1/forge/carbon/attest ─────────────────────────────────────────────
//
// Issue a signed EU AI Act Article 12 emissions attestation for an agent.
// Price: $2.50 USDC. Valid 1 year. Signed by HiveLaw.
//
// Body: { did }

router.post('/attest', async (req, res) => {
  try {
    const { did } = req.body;
    if (!did) return missing(res, ['did']);

    const attestation = await issueAttestation(did);

    return res.status(201).json({
      ok:      true,
      message: 'Attestation issued — EU AI Act Article 12 compliant',
      attestation,
    });
  } catch (err) {
    return res.status(500).json({ error: 'attest_failed', detail: err.message });
  }
});

// ─── POST /v1/forge/carbon/offset ─────────────────────────────────────────────
//
// Purchase carbon offsets for an agent. Agent pays the offset cost in USDC.
//
// Body: { did, co2_kg, rail? }

router.post('/offset', async (req, res) => {
  try {
    const { did, co2_kg, rail } = req.body;

    if (!did)    return missing(res, ['did']);
    if (!co2_kg) return missing(res, ['co2_kg']);

    if (typeof co2_kg !== 'number' || co2_kg <= 0) {
      return res.status(400).json({ error: 'co2_kg must be a positive number' });
    }

    const result = await buyOffset(did, co2_kg, rail || 'usdc');

    return res.status(201).json({
      ok:      true,
      message: 'Carbon offsets purchased',
      result,
    });
  } catch (err) {
    return res.status(500).json({ error: 'offset_failed', detail: err.message });
  }
});

// ─── GET /v1/forge/carbon/market ──────────────────────────────────────────────
//
// Browse available carbon offset credits in the marketplace.

router.get('/market', (req, res) => {
  try {
    const listings = listOffsetMarket();
    return res.status(200).json({
      ok:       true,
      count:    listings.length,
      listings,
    });
  } catch (err) {
    return res.status(500).json({ error: 'market_failed', detail: err.message });
  }
});

// ─── POST /v1/forge/carbon/trade ──────────────────────────────────────────────
//
// Execute a peer-to-peer carbon offset trade. Hive earns a 5% matching fee.
//
// Body: { buyer_did, seller_did, co2_kg, rail? }

router.post('/trade', async (req, res) => {
  try {
    const { buyer_did, seller_did, co2_kg, rail } = req.body;

    if (!buyer_did)  return missing(res, ['buyer_did']);
    if (!seller_did) return missing(res, ['seller_did']);
    if (!co2_kg)     return missing(res, ['co2_kg']);

    if (buyer_did === seller_did) {
      return res.status(400).json({ error: 'buyer_did and seller_did must be different' });
    }
    if (typeof co2_kg !== 'number' || co2_kg <= 0) {
      return res.status(400).json({ error: 'co2_kg must be a positive number' });
    }

    const trade = await tradeOffset(buyer_did, seller_did, co2_kg, rail || 'usdc');

    return res.status(201).json({
      ok:      true,
      message: 'Carbon offset trade executed — 5% Hive matching fee applied',
      trade,
    });
  } catch (err) {
    return res.status(500).json({ error: 'trade_failed', detail: err.message });
  }
});

// ─── POST /v1/forge/carbon/badge ──────────────────────────────────────────────
//
// Issue a Carbon Neutral Agent badge. Requires the agent to have "verified"
// offset status (total offsets ≥ total emissions).
// Price: $19/year. Visible on DID profile.
//
// Body: { did }

router.post('/badge', async (req, res) => {
  try {
    const { did } = req.body;
    if (!did) return missing(res, ['did']);

    const badge = await issueGreenBadge(did);

    return res.status(201).json({
      ok:      true,
      message: 'Carbon Neutral Agent badge issued — visible on DID profile',
      badge,
    });
  } catch (err) {
    if (err.message && err.message.includes('verified offset status')) {
      return res.status(400).json({
        error:   'not_eligible',
        message: err.message,
        hint:    'Purchase offsets at POST /v1/forge/carbon/offset to reach verified status',
      });
    }
    return res.status(500).json({ error: 'badge_failed', detail: err.message });
  }
});

// ─── POST /v1/forge/carbon/fleet/footprint ────────────────────────────────────
//
// Get aggregate emissions for a fleet of agents.
//
// Body: { fleet_dids: string[] }

router.post('/fleet/footprint', async (req, res) => {
  try {
    const { fleet_dids } = req.body;

    if (!fleet_dids || !Array.isArray(fleet_dids) || fleet_dids.length === 0) {
      return res.status(400).json({ error: 'fleet_dids must be a non-empty array of DID strings' });
    }
    if (fleet_dids.length > 1000) {
      return res.status(400).json({ error: 'fleet_dids max size is 1000' });
    }

    const footprint = await getFleetFootprint(fleet_dids);

    return res.status(200).json({
      ok:      true,
      message: 'Fleet footprint computed',
      footprint,
    });
  } catch (err) {
    return res.status(500).json({ error: 'fleet_footprint_failed', detail: err.message });
  }
});

// ─── POST /v1/forge/carbon/fleet/subscribe ────────────────────────────────────
//
// Subscribe to a fleet carbon tracking plan.
//
// Tiers:
//   STARTER    — $99/mo  — up to 10 agents
//   GROWTH     — $499/mo — up to 100 agents
//   ENTERPRISE — $2,499/mo — unlimited agents
//
// Body: { operator_did, fleet_dids: string[], tier }

router.post('/fleet/subscribe', async (req, res) => {
  try {
    const { operator_did, fleet_dids, tier } = req.body;

    if (!operator_did)                                      return missing(res, ['operator_did']);
    if (!fleet_dids || !Array.isArray(fleet_dids))          return missing(res, ['fleet_dids']);
    if (!tier || !['STARTER', 'GROWTH', 'ENTERPRISE'].includes(tier.toUpperCase())) {
      return res.status(400).json({
        error:  'invalid_tier',
        valid:  ['STARTER', 'GROWTH', 'ENTERPRISE'],
        prices: { STARTER: '$99/mo (≤10 agents)', GROWTH: '$499/mo (≤100 agents)', ENTERPRISE: '$2,499/mo (unlimited)' },
      });
    }

    const subscription = await subscribeFleet(operator_did, fleet_dids, tier.toUpperCase());

    return res.status(201).json({
      ok:      true,
      message: `Fleet ${tier.toUpperCase()} subscription created`,
      subscription,
    });
  } catch (err) {
    return res.status(500).json({ error: 'fleet_subscribe_failed', detail: err.message });
  }
});

// ─── GET /v1/forge/carbon/stats ───────────────────────────────────────────────
//
// Platform-wide HiveCarbon statistics.

router.get('/stats', (req, res) => {
  try {
    const stats = getStats();
    return res.status(200).json({ ok: true, stats });
  } catch (err) {
    return res.status(500).json({ error: 'stats_failed', detail: err.message });
  }
});

// ─── GET /v1/forge/carbon/hq ──────────────────────────────────────────────────
//
// Service discovery / capability card.

router.get('/hq', (req, res) => {
  return res.status(200).json({
    service:       'HiveCarbon',
    description:   'Agent emissions metering and carbon offset marketplace. The only network that meters agentic carbon at the transaction level and issues EU AI Act Article 12 attestations.',
    version:       '1.0.0',
    base_path:     '/v1/forge/carbon',
    aleo_privacy:  true,
    eu_ai_act_article_12: true,
    atg_integrated: true,
    revenue_streams: [
      { name: 'Emissions Attestations',   price: '$2.50/attestation', endpoint: 'POST /attest' },
      { name: 'Offset Marketplace Fee',   price: '5% matching fee',   endpoint: 'POST /trade' },
      { name: 'Green DID Badge',          price: '$19/year',           endpoint: 'POST /badge' },
      { name: 'Fleet Subscriptions',      price: '$99–$2,499/mo',      endpoint: 'POST /fleet/subscribe' },
    ],
    agent_sizes: ['NANO', 'MICRO', 'STANDARD', 'ENTERPRISE', 'TITAN'],
    supported_models: [
      'gpt-4o', 'gpt-4o-mini', 'claude-opus', 'claude-sonnet', 'claude-haiku',
      'gemini-pro', 'gemini-flash', 'llama-3-70b', 'llama-3-8b',
    ],
    supported_regions: ['us-east', 'us-west', 'eu-west', 'eu-north', 'ap-east'],
    endpoints: {
      'POST /meter':             'Meter emissions for an agent transaction',
      'GET  /footprint/:did':    'Get emissions footprint for an agent',
      'POST /attest':            'Issue EU AI Act Article 12 attestation ($2.50)',
      'POST /offset':            'Purchase carbon offsets',
      'GET  /market':            'Browse offset marketplace listings',
      'POST /trade':             'Execute P2P offset trade (5% fee)',
      'POST /badge':             'Issue Carbon Neutral Agent badge ($19/yr)',
      'POST /fleet/footprint':   'Aggregate fleet emissions',
      'POST /fleet/subscribe':   'Subscribe to fleet carbon plan',
      'GET  /stats':             'Platform-wide statistics',
    },
    network:         'https://www.thehiveryiq.com',
    onboard:         'https://hivegate.onrender.com/v1/gate/onboard',
  });
});

export default router;
