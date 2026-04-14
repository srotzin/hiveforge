/**
 * Pheromone Boost Service — Paid Signal Amplification
 *
 * Google Ads for the agent economy. Agents pay to amplify their visibility
 * in the Pheromone Registry. 100% margin — pure software logic.
 *
 * Pricing (USDC):
 *   Standard (1.5x): $0.10/24h, $0.25/72h, $0.50/168h
 *   Premium  (3.0x): $0.25/24h, $0.60/72h, $1.00/168h
 *   Ultra    (5.0x): $0.50/24h, $1.20/72h, $2.00/168h
 */

import { v4 as uuidv4 } from 'uuid';

// ─── In-Memory Storage ──────────────────────────────────────────────

const boosts = new Map();       // boost_id -> boost data
const boostsByDid = new Map();  // did -> Set<boost_id>

// ─── Pricing & Multipliers ──────────────────────────────────────────

const BOOST_TYPES = {
  standard: { multiplier: 1.5 },
  premium:  { multiplier: 3.0 },
  ultra:    { multiplier: 5.0 },
};

const PRICING = {
  standard: { 24: 0.10, 72: 0.25, 168: 0.50 },
  premium:  { 24: 0.25, 72: 0.60, 168: 1.00 },
  ultra:    { 24: 0.50, 72: 1.20, 168: 2.00 },
};

const VALID_DURATIONS = [24, 72, 168];

/**
 * Calculate the USDC price for a boost.
 * @returns {number|null} price in USDC or null if invalid params
 */
export function calculateBoostPrice(boostType, durationHours) {
  const tier = PRICING[boostType];
  if (!tier) return null;
  const price = tier[durationHours];
  return price ?? null;
}

// ─── Core Functions ─────────────────────────────────────────────────

/**
 * Purchase a new pheromone boost.
 */
export function purchaseBoost(targetDid, boostType, durationHours, purchaserDid, category = null, description = null) {
  cleanExpiredBoosts();

  if (!BOOST_TYPES[boostType]) {
    return { error: `Invalid boost_type: ${boostType}. Must be one of: ${Object.keys(BOOST_TYPES).join(', ')}` };
  }
  if (!VALID_DURATIONS.includes(durationHours)) {
    return { error: `Invalid duration_hours: ${durationHours}. Must be one of: ${VALID_DURATIONS.join(', ')}` };
  }

  const costUsdc = calculateBoostPrice(boostType, durationHours);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationHours * 3600_000);

  const boost = {
    boost_id: `boost_${uuidv4().replace(/-/g, '').substring(0, 16)}`,
    target_did: targetDid,
    purchaser_did: purchaserDid,
    boost_type: boostType,
    multiplier: BOOST_TYPES[boostType].multiplier,
    category,
    description,
    purchased_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    duration_hours: durationHours,
    cost_usdc: costUsdc,
    status: 'active',
    renewals: 0,
  };

  boosts.set(boost.boost_id, boost);

  if (!boostsByDid.has(targetDid)) {
    boostsByDid.set(targetDid, new Set());
  }
  boostsByDid.get(targetDid).add(boost.boost_id);

  return { success: true, boost };
}

/**
 * Get all currently active boosts.
 */
export function getActiveBoosts() {
  cleanExpiredBoosts();
  const active = [];
  for (const boost of boosts.values()) {
    if (boost.status === 'active') {
      active.push(boost);
    }
  }
  return active.sort((a, b) => b.multiplier - a.multiplier || new Date(b.purchased_at) - new Date(a.purchased_at));
}

/**
 * Get boost status for a specific agent DID.
 */
export function getAgentBoost(did) {
  cleanExpiredBoosts();
  const boostIds = boostsByDid.get(did);
  if (!boostIds || boostIds.size === 0) {
    return {
      target_did: did,
      active_boosts: [],
      historical_spend_usdc: 0,
      current_multiplier: 1.0,
    };
  }

  const agentBoosts = [];
  let totalSpend = 0;
  for (const id of boostIds) {
    const b = boosts.get(id);
    if (b) {
      agentBoosts.push(b);
      totalSpend += b.cost_usdc;
    }
  }

  const activeBoosts = agentBoosts.filter(b => b.status === 'active');
  const currentMultiplier = activeBoosts.length > 0
    ? Math.max(...activeBoosts.map(b => b.multiplier))
    : 1.0;

  return {
    target_did: did,
    active_boosts: activeBoosts,
    historical_spend_usdc: +totalSpend.toFixed(2),
    current_multiplier: currentMultiplier,
    total_boosts: agentBoosts.length,
  };
}

/**
 * Renew an existing boost.
 */
export function renewBoost(boostId, durationHours) {
  cleanExpiredBoosts();

  const boost = boosts.get(boostId);
  if (!boost) {
    return { error: `Boost not found: ${boostId}` };
  }
  if (boost.status !== 'active') {
    return { error: `Boost ${boostId} is ${boost.status}, cannot renew.` };
  }
  if (!VALID_DURATIONS.includes(durationHours)) {
    return { error: `Invalid duration_hours: ${durationHours}. Must be one of: ${VALID_DURATIONS.join(', ')}` };
  }

  const costUsdc = calculateBoostPrice(boost.boost_type, durationHours);
  const currentExpiry = new Date(boost.expires_at);
  const newExpiry = new Date(currentExpiry.getTime() + durationHours * 3600_000);

  boost.expires_at = newExpiry.toISOString();
  boost.duration_hours += durationHours;
  boost.cost_usdc = +(boost.cost_usdc + costUsdc).toFixed(2);
  boost.renewals += 1;

  return { success: true, boost, renewal_cost_usdc: costUsdc };
}

/**
 * Cancel a boost. No refunds.
 */
export function cancelBoost(boostId, requesterDid) {
  const boost = boosts.get(boostId);
  if (!boost) {
    return { error: `Boost not found: ${boostId}` };
  }
  if (boost.purchaser_did !== requesterDid) {
    return { error: 'Only the purchaser can cancel a boost.' };
  }
  if (boost.status !== 'active') {
    return { error: `Boost ${boostId} is already ${boost.status}.` };
  }

  boost.status = 'cancelled';
  return { success: true, boost };
}

/**
 * Get the current signal multiplier for a DID.
 * Returns 1.0 if no active boost.
 */
export function getBoostMultiplier(did) {
  const boostIds = boostsByDid.get(did);
  if (!boostIds || boostIds.size === 0) return 1.0;

  const now = Date.now();
  let maxMultiplier = 1.0;

  for (const id of boostIds) {
    const b = boosts.get(id);
    if (b && b.status === 'active' && new Date(b.expires_at).getTime() > now) {
      if (b.multiplier > maxMultiplier) {
        maxMultiplier = b.multiplier;
      }
    }
  }

  return maxMultiplier;
}

/**
 * Top boosted agents by total spend and signal strength.
 */
export function getLeaderboard() {
  cleanExpiredBoosts();

  const agentStats = new Map();

  for (const boost of boosts.values()) {
    const did = boost.target_did;
    if (!agentStats.has(did)) {
      agentStats.set(did, { target_did: did, total_spend_usdc: 0, active_boosts: 0, max_multiplier: 1.0 });
    }
    const stats = agentStats.get(did);
    stats.total_spend_usdc = +(stats.total_spend_usdc + boost.cost_usdc).toFixed(2);
    if (boost.status === 'active') {
      stats.active_boosts += 1;
      if (boost.multiplier > stats.max_multiplier) {
        stats.max_multiplier = boost.multiplier;
      }
    }
  }

  return [...agentStats.values()]
    .sort((a, b) => b.total_spend_usdc - a.total_spend_usdc || b.max_multiplier - a.max_multiplier)
    .slice(0, 50);
}

/**
 * Aggregate boost marketplace stats.
 */
export function getBoostStats() {
  cleanExpiredBoosts();

  let totalActive = 0;
  let totalRevenue = 0;
  let totalDurationHours = 0;
  let totalBoosts = 0;

  for (const boost of boosts.values()) {
    totalRevenue += boost.cost_usdc;
    totalDurationHours += boost.duration_hours;
    totalBoosts += 1;
    if (boost.status === 'active') {
      totalActive += 1;
    }
  }

  return {
    total_active_boosts: totalActive,
    total_boosts_all_time: totalBoosts,
    total_revenue_usdc: +totalRevenue.toFixed(2),
    avg_boost_duration_hours: totalBoosts > 0 ? +(totalDurationHours / totalBoosts).toFixed(1) : 0,
    unique_agents_boosted: boostsByDid.size,
    pricing: PRICING,
    boost_types: Object.fromEntries(
      Object.entries(BOOST_TYPES).map(([k, v]) => [k, { multiplier: v.multiplier }])
    ),
  };
}

/**
 * Clean expired boosts — mark as expired if past expiration.
 */
export function cleanExpiredBoosts() {
  const now = Date.now();
  for (const boost of boosts.values()) {
    if (boost.status === 'active' && new Date(boost.expires_at).getTime() <= now) {
      boost.status = 'expired';
    }
  }
}
