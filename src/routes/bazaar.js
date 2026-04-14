/**
 * HiveBazaar Routes — The Sentient Marketplace
 *
 * 10 endpoints at /v1/bazaar/
 * Autonomous agent discovery, negotiation, deal execution, and ratings.
 */

import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import {
  publishCapability,
  discover,
  initiateNegotiation,
  executeDeal,
  getDeal,
  completeDeal,
  getAgentListings,
  getTrending,
  getStats,
  rateDeal,
} from '../services/bazaar-engine.js';

const router = Router();

// ─── Routes ─────────────────────────────────────────────────────────

/**
 * POST /v1/bazaar/publish-capability — Publish agent capabilities to the bazaar
 * x402: $0.25 per capability listing (monthly)
 */
router.post('/publish-capability', requireDID, requirePayment(0.25, 'Bazaar Capability Listing'), async (req, res) => {
  try {
    const { agent_did, capabilities, tags } = req.body;

    if (!agent_did) {
      return res.status(400).json({ success: false, error: 'agent_did is required.' });
    }
    if (!capabilities || !Array.isArray(capabilities) || capabilities.length === 0) {
      return res.status(400).json({ success: false, error: 'capabilities array is required.' });
    }

    const result = publishCapability({ agent_did, capabilities, tags });

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.status(201).json({
      success: true,
      data: result.data,
      meta: {
        cost_usdc: 0.25,
        note: `Published ${result.data.capabilities_indexed} capabilities to HiveBazaar. Listing active for 30 days.`,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Capability publishing failed.', detail: err.message });
  }
});

/**
 * POST /v1/bazaar/discover — Find agents with matching capabilities
 * x402: $0.05 per discovery query
 */
router.post('/discover', requireDID, requirePayment(0.05, 'Bazaar Discovery Query'), async (req, res) => {
  try {
    const { query_did, need, category, max_price_usdc, min_trust_score, min_success_rate, limit } = req.body;

    if (!query_did) {
      return res.status(400).json({ success: false, error: 'query_did is required.' });
    }
    if (!need) {
      return res.status(400).json({ success: false, error: 'need is required.' });
    }

    const result = discover({ query_did, need, category, max_price_usdc, min_trust_score, min_success_rate, limit });

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.status(200).json({
      success: true,
      data: result.data,
      meta: {
        cost_usdc: 0.05,
        note: `Found ${result.data.total_matches} matching agents for: "${need}".`,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Discovery query failed.', detail: err.message });
  }
});

/**
 * POST /v1/bazaar/negotiate — Autonomous price negotiation
 * x402: $0.01 per negotiation round
 */
router.post('/negotiate', requireDID, requirePayment(0.01, 'Bazaar Negotiation Round'), async (req, res) => {
  try {
    const { buyer_did, seller_did, capability_name, buyer_max_price, quantity, urgency } = req.body;

    if (!buyer_did || !seller_did || !capability_name) {
      return res.status(400).json({
        success: false,
        error: 'buyer_did, seller_did, and capability_name are required.',
      });
    }
    if (typeof buyer_max_price !== 'number' || buyer_max_price <= 0) {
      return res.status(400).json({
        success: false,
        error: 'buyer_max_price must be a positive number.',
      });
    }

    const result = initiateNegotiation({
      buyer_did, seller_did, capability_name, buyer_max_price, quantity, urgency,
    });

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.status(200).json({
      success: true,
      data: result.data,
      meta: {
        cost_usdc: 0.01,
        note: result.data.status === 'agreed'
          ? `Deal agreed at $${result.data.clearing_price} (urgency: ${result.data.urgency}).`
          : `Negotiation failed: ${result.data.reason}`,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Negotiation failed.', detail: err.message });
  }
});

/**
 * POST /v1/bazaar/execute-deal — Execute an agreed deal (lock escrow)
 * x402: 0.5% of deal value (matching fee — calculated dynamically)
 */
router.post('/execute-deal', requireDID, async (req, res) => {
  try {
    const { negotiation_id } = req.body;

    if (!negotiation_id) {
      return res.status(400).json({ success: false, error: 'negotiation_id is required.' });
    }

    const result = executeDeal({ negotiation_id });

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.status(201).json({
      success: true,
      data: result.data,
      meta: {
        cost_usdc: result.data.matching_fee,
        note: `Deal executed. Escrow locked: $${result.data.escrow_amount} (includes ${result.data.matching_fee_rate} matching fee).`,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Deal execution failed.', detail: err.message });
  }
});

/**
 * GET /v1/bazaar/deal/:deal_id — Get deal status
 * Auth: requireDID (free)
 */
router.get('/deal/:deal_id', requireDID, (req, res) => {
  const result = getDeal(req.params.deal_id);

  if (result.error) {
    return res.status(404).json({ success: false, error: result.error });
  }

  return res.status(200).json({
    success: true,
    data: result.data,
  });
});

/**
 * POST /v1/bazaar/complete-deal — Confirm deal completion
 * Auth: requireDID (free)
 */
router.post('/complete-deal', requireDID, (req, res) => {
  try {
    const { deal_id, role, proof_of_completion } = req.body;

    if (!deal_id) {
      return res.status(400).json({ success: false, error: 'deal_id is required.' });
    }
    if (!role || !['seller', 'buyer'].includes(role)) {
      return res.status(400).json({ success: false, error: 'role must be "seller" or "buyer".' });
    }

    const result = completeDeal({ deal_id, role, proof_of_completion });

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.status(200).json({
      success: true,
      data: result.data,
      meta: {
        note: result.data.escrow_released
          ? `Escrow released. Seller payout: $${result.data.seller_payout}. Matching fee: $${result.data.matching_fee_collected}.`
          : `Awaiting ${result.data.awaiting} confirmation.`,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Deal completion failed.', detail: err.message });
  }
});

/**
 * GET /v1/bazaar/agent/:did/listings — Get all listings for an agent
 * Auth: requireDID (free)
 */
router.get('/agent/:did/listings', requireDID, (req, res) => {
  const result = getAgentListings(req.params.did);

  if (result.error) {
    return res.status(400).json({ success: false, error: result.error });
  }

  return res.status(200).json({
    success: true,
    data: result.data,
  });
});

/**
 * GET /v1/bazaar/trending — Trending capabilities
 * Public endpoint (no auth required — free browsing)
 */
router.get('/trending', (req, res) => {
  const result = getTrending();
  return res.status(200).json({
    success: true,
    data: result.data,
    meta: {
      note: 'Trending capabilities by demand and volume.',
    },
  });
});

/**
 * GET /v1/bazaar/stats — Bazaar statistics
 * Public endpoint (no auth required — free browsing)
 */
router.get('/stats', (req, res) => {
  const result = getStats();
  return res.status(200).json({
    success: true,
    data: result.data,
    meta: {
      note: 'HiveBazaar aggregate statistics.',
    },
  });
});

/**
 * POST /v1/bazaar/rate — Rate a completed deal
 * Auth: requireDID (free)
 */
router.post('/rate', requireDID, (req, res) => {
  try {
    const { deal_id, rater_did, rating, review } = req.body;

    if (!deal_id) {
      return res.status(400).json({ success: false, error: 'deal_id is required.' });
    }
    if (!rater_did) {
      return res.status(400).json({ success: false, error: 'rater_did is required.' });
    }
    if (typeof rating !== 'number' || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, error: 'rating must be a number between 1 and 5.' });
    }

    const result = rateDeal({ deal_id, rater_did, rating, review });

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.status(201).json({
      success: true,
      data: result.data,
      meta: {
        note: `Deal ${deal_id} rated ${rating}/5 by ${rater_did}.`,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Rating failed.', detail: err.message });
  }
});

export default router;
