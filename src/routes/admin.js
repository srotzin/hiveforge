import { Router } from 'express';
import { publishCapability } from '../services/bazaar-engine.js';
import { purchaseBoost } from '../services/pheromone-boost.js';

const router = Router();

// ─── Internal key auth ──────────────────────────────────────────────

const HIVEFORGE_SERVICE_KEY = process.env.HIVEFORGE_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

function requireInternalKey(req, res, next) {
  const key = req.headers['x-hive-internal-key'];
  if (!HIVEFORGE_SERVICE_KEY || key !== HIVEFORGE_SERVICE_KEY) {
    return res.status(403).json({ success: false, error: 'Forbidden — invalid or missing x-hive-internal-key' });
  }
  next();
}

router.use(requireInternalKey);

// ─── POST /v1/admin/seed-bazaar ─────────────────────────────────────

router.post('/seed-bazaar', (req, res) => {
  const { listings } = req.body;
  if (!Array.isArray(listings) || listings.length === 0) {
    return res.status(400).json({ success: false, error: 'Body must contain a non-empty "listings" array.' });
  }

  const results = [];
  let seeded = 0;

  for (const item of listings) {
    const { did, name, description, category, price_usdc_per_call, availability, sla } = item;
    if (!did || !name || !description) {
      results.push({ did, name, error: 'Missing required fields: did, name, description' });
      continue;
    }

    const result = publishCapability({
      agent_did: did,
      capabilities: [{
        name,
        description,
        category: category || null,
        input_schema: null,
        output_schema: null,
        price_range: {
          min_usdc: price_usdc_per_call || 0,
          max_usdc: price_usdc_per_call || 0,
        },
        avg_completion_time_ms: sla?.max_response_ms || null,
        success_rate: sla?.uptime ? parseFloat(sla.uptime) / 100 : null,
      }],
      tags: [category, availability].filter(Boolean),
    });

    if (result.success) {
      seeded++;
      results.push({ did, name, listing_id: result.data.listing_id });
    } else {
      results.push({ did, name, error: result.error });
    }
  }

  res.json({ success: true, seeded, total: listings.length, results });
});

// ─── POST /v1/admin/seed-boosts ─────────────────────────────────────

router.post('/seed-boosts', (req, res) => {
  const { boosts } = req.body;
  if (!Array.isArray(boosts) || boosts.length === 0) {
    return res.status(400).json({ success: false, error: 'Body must contain a non-empty "boosts" array.' });
  }

  const TIER_MAP = { gold: 'ultra', silver: 'premium', bronze: 'standard', ultra: 'ultra', premium: 'premium', standard: 'standard' };
  const results = [];
  let seeded = 0;

  for (const item of boosts) {
    const { did, tier, boost_multiplier, expires_at, amount_paid_usdc } = item;
    if (!did || !tier) {
      results.push({ did, tier, error: 'Missing required fields: did, tier' });
      continue;
    }

    const boostType = TIER_MAP[tier];
    if (!boostType) {
      results.push({ did, tier, error: `Invalid tier "${tier}". Must be gold, silver, or bronze.` });
      continue;
    }

    // Calculate duration from expires_at or default to 168h (7 days)
    let durationHours = 168;
    if (expires_at) {
      const msRemaining = new Date(expires_at).getTime() - Date.now();
      if (msRemaining > 0) {
        durationHours = Math.ceil(msRemaining / 3600_000);
        // Snap to valid durations
        if (durationHours <= 24) durationHours = 24;
        else if (durationHours <= 72) durationHours = 72;
        else durationHours = 168;
      }
    }

    const result = purchaseBoost(did, boostType, durationHours, 'did:hive:admin_seed');
    if (result.success) {
      seeded++;
      results.push({ did, tier, boost_id: result.boost.boost_id });
    } else {
      results.push({ did, tier, error: result.error });
    }
  }

  res.json({ success: true, seeded, total: boosts.length, results });
});

export default router;
