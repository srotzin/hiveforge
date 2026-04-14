/**
 * Pheromone Boost Routes — Paid Signal Amplification
 *
 * 7 endpoints at /v1/boost/
 * Dynamic x402 pricing based on boost_type + duration_hours.
 */

import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import {
  purchaseBoost,
  getActiveBoosts,
  getAgentBoost,
  renewBoost,
  cancelBoost,
  getLeaderboard,
  getBoostStats,
  calculateBoostPrice,
} from '../services/pheromone-boost.js';

const router = Router();

// ─── Dynamic Pricing Middleware ──────────────────────────────────────
// Reads boost_type + duration_hours from req.body, calculates price,
// then chains into requirePayment with the computed amount.

function boostPricing(req, res, next) {
  const { boost_type, duration_hours } = req.body;

  if (!boost_type || !duration_hours) {
    return res.status(400).json({
      success: false,
      error: 'boost_type and duration_hours are required.',
      valid_boost_types: ['standard', 'premium', 'ultra'],
      valid_durations: [24, 72, 168],
    });
  }

  const price = calculateBoostPrice(boost_type, duration_hours);
  if (price === null) {
    return res.status(400).json({
      success: false,
      error: `Invalid boost_type "${boost_type}" or duration_hours "${duration_hours}".`,
      valid_boost_types: ['standard', 'premium', 'ultra'],
      valid_durations: [24, 72, 168],
    });
  }

  req.boostPrice = price;
  // Chain into the standard x402 payment middleware with the computed price
  return requirePayment(price, `Pheromone Boost (${boost_type} / ${duration_hours}h)`)(req, res, next);
}

// Renewal pricing — reads boost_id from body, looks up boost_type, applies pricing
function renewalPricing(req, res, next) {
  const { boost_id, duration_hours } = req.body;

  if (!boost_id || !duration_hours) {
    return res.status(400).json({
      success: false,
      error: 'boost_id and duration_hours are required.',
    });
  }

  // We need boost_type to compute price — try renewing first to validate,
  // but for pricing we need to peek at the boost. Import is already available
  // via the service. Use a lightweight approach: compute from the existing boost.
  // Since we don't expose a getBoost by ID, we'll accept boost_type in the body
  // as an optimization, or look it up via the renew function's validation.
  // For simplicity and correctness: require boost_type in renewal too.
  const { boost_type } = req.body;
  if (!boost_type) {
    return res.status(400).json({
      success: false,
      error: 'boost_type is required for renewal pricing.',
      valid_boost_types: ['standard', 'premium', 'ultra'],
      valid_durations: [24, 72, 168],
    });
  }

  const price = calculateBoostPrice(boost_type, duration_hours);
  if (price === null) {
    return res.status(400).json({
      success: false,
      error: `Invalid boost_type "${boost_type}" or duration_hours "${duration_hours}".`,
    });
  }

  req.boostPrice = price;
  return requirePayment(price, `Pheromone Boost Renewal (${boost_type} / ${duration_hours}h)`)(req, res, next);
}

// ─── Routes ─────────────────────────────────────────────────────────

/**
 * POST /v1/boost/purchase — Purchase a pheromone boost
 * x402: dynamic (depends on boost_type + duration_hours)
 */
router.post('/purchase', requireDID, boostPricing, async (req, res) => {
  try {
    const { target_did, boost_type, duration_hours, category, description } = req.body;

    if (!target_did) {
      return res.status(400).json({ success: false, error: 'target_did is required.' });
    }

    const result = purchaseBoost(target_did, boost_type, duration_hours, req.agentDid, category, description);

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.status(201).json({
      success: true,
      data: {
        boost_id: result.boost.boost_id,
        target_did: result.boost.target_did,
        boost_type: result.boost.boost_type,
        multiplier: result.boost.multiplier,
        expires_at: result.boost.expires_at,
        cost_usdc: result.boost.cost_usdc,
        status: result.boost.status,
      },
      meta: {
        cost_usdc: result.boost.cost_usdc,
        note: `Pheromone boost activated. ${result.boost.boost_type} (${result.boost.multiplier}x) for ${result.boost.duration_hours}h.`,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Boost purchase failed.', detail: err.message });
  }
});

/**
 * GET /v1/boost/active — List all currently active boosts
 * Auth: requireDID (free — transparency is key for trust)
 */
router.get('/active', requireDID, (req, res) => {
  const active = getActiveBoosts();
  return res.status(200).json({
    success: true,
    data: active,
    meta: {
      total_active: active.length,
      note: 'All currently active pheromone boosts. Transparency builds trust.',
    },
  });
});

/**
 * GET /v1/boost/agent/:did — Get boost status for a specific agent
 * Auth: requireDID (free)
 */
router.get('/agent/:did', requireDID, (req, res) => {
  const result = getAgentBoost(req.params.did);
  return res.status(200).json({
    success: true,
    data: result,
  });
});

/**
 * POST /v1/boost/renew — Renew an existing boost
 * x402: same pricing as purchase
 */
router.post('/renew', requireDID, renewalPricing, async (req, res) => {
  try {
    const { boost_id, duration_hours } = req.body;

    const result = renewBoost(boost_id, duration_hours);

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.status(200).json({
      success: true,
      data: {
        boost_id: result.boost.boost_id,
        target_did: result.boost.target_did,
        boost_type: result.boost.boost_type,
        multiplier: result.boost.multiplier,
        expires_at: result.boost.expires_at,
        total_cost_usdc: result.boost.cost_usdc,
        renewal_cost_usdc: result.renewal_cost_usdc,
        renewals: result.boost.renewals,
        status: result.boost.status,
      },
      meta: {
        cost_usdc: result.renewal_cost_usdc,
        note: `Boost renewed. New expiration: ${result.boost.expires_at}. Total renewals: ${result.boost.renewals}.`,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Boost renewal failed.', detail: err.message });
  }
});

/**
 * DELETE /v1/boost/:boost_id — Cancel a boost (no refunds)
 * Auth: requireDID (must be the purchaser)
 */
router.delete('/:boost_id', requireDID, (req, res) => {
  const result = cancelBoost(req.params.boost_id, req.agentDid);

  if (result.error) {
    const status = result.error.includes('not found') ? 404 : 403;
    return res.status(status).json({ success: false, error: result.error });
  }

  return res.status(200).json({
    success: true,
    data: {
      boost_id: result.boost.boost_id,
      status: result.boost.status,
    },
    meta: {
      note: 'Boost cancelled. No refunds — agent economy.',
    },
  });
});

/**
 * GET /v1/boost/leaderboard — Top boosted agents
 * Public endpoint (no auth required — free browsing)
 */
router.get('/leaderboard', (req, res) => {
  const leaderboard = getLeaderboard();
  return res.status(200).json({
    success: true,
    data: leaderboard,
    meta: {
      total_entries: leaderboard.length,
      note: 'Top boosted agents by total spend and signal strength.',
    },
  });
});

/**
 * GET /v1/boost/stats — Boost marketplace stats
 * Public endpoint (no auth required — free browsing)
 */
router.get('/stats', (req, res) => {
  const stats = getBoostStats();
  return res.status(200).json({
    success: true,
    data: stats,
    meta: {
      note: 'Pheromone Boost marketplace aggregate statistics.',
    },
  });
});

export default router;
