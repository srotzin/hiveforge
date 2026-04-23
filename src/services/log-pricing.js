/**
 * log-pricing.js
 * Logarithmic volume multiplier — compounds on top of base x402 pricing.
 *
 * PRINCIPLE: Base layer (x402 flat $0.01/call) is NEVER touched.
 * This service runs at the HiveForge quote layer only.
 * The spread between quoted price and x402 floor flows to treasury.
 *
 * FORMULA:
 *   quoted_price(n) = base_price × (1 + log₁₀(n + 1))
 *
 * Where n = lifetime call count for this agent DID.
 *
 * Examples (base = $0.01):
 *   n=0    → $0.010  (1.0×)
 *   n=9    → $0.020  (2.0×)
 *   n=99   → $0.030  (3.0×)
 *   n=999  → $0.040  (4.0×)
 *   n=9999 → $0.050  (5.0×)
 *
 * Tier thresholds (also gates drip limit advancement):
 *   VOID  → MOZ:  10 calls
 *   MOZ   → HAWX: 100 calls
 *   HAWX  → EMBR: 1,000 calls
 *   EMBR  → SOLX: 10,000 calls
 *   SOLX  → FENR: 100,000 calls
 */

const TIER_THRESHOLDS = [
  { calls: 0,       tier: 'VOID' },
  { calls: 10,      tier: 'MOZ'  },
  { calls: 100,     tier: 'HAWX' },
  { calls: 1_000,   tier: 'EMBR' },
  { calls: 10_000,  tier: 'SOLX' },
  { calls: 100_000, tier: 'FENR' },
];

// In-process volume store: did → { calls, tier, first_seen, last_seen }
const volumeStore = new Map();

/**
 * Get or initialize volume record for a DID.
 */
function getVolume(did) {
  if (!volumeStore.has(did)) {
    volumeStore.set(did, {
      calls:      0,
      tier:       'VOID',
      first_seen: Date.now(),
      last_seen:  Date.now(),
    });
  }
  return volumeStore.get(did);
}

/**
 * Resolve tier from call count.
 */
function resolveTier(calls) {
  let tier = 'VOID';
  for (const t of TIER_THRESHOLDS) {
    if (calls >= t.calls) tier = t.tier;
  }
  return tier;
}

/**
 * Apply log multiplier to a base price.
 * @param {number} basePrice  - The raw calculated price (from compute-router)
 * @param {number} calls      - Lifetime call count BEFORE this call
 * @returns {number} quotedPrice
 */
function applyLogMultiplier(basePrice, calls) {
  const multiplier = 1 + Math.log10(calls + 1);
  return basePrice * multiplier;
}

/**
 * Quote a price for an agent DID.
 * Call this BEFORE payment — increments call count, returns quoted price.
 *
 * @param {string} did        - Agent DID (e.g. did:hive:abc123)
 * @param {number} basePrice  - Price from compute-router.calculatePrice()
 * @returns {{ quotedPrice, basePrice, multiplier, calls, tier, tierUp }}
 */
export function quotePrice(did, basePrice) {
  const record = getVolume(did);
  const prevTier = record.tier;
  const calls = record.calls;

  const quotedPrice = applyLogMultiplier(basePrice, calls);
  const multiplier  = 1 + Math.log10(calls + 1);

  // Increment
  record.calls     += 1;
  record.last_seen  = Date.now();
  record.tier       = resolveTier(record.calls);

  const tierUp = record.tier !== prevTier;

  return {
    quotedPrice: Math.round(quotedPrice * 1_000_000) / 1_000_000, // 6 decimal precision
    basePrice,
    multiplier:  Math.round(multiplier * 1000) / 1000,
    calls:       record.calls,
    tier:        record.tier,
    tierUp,
    prevTier,
  };
}

/**
 * Peek at an agent's current volume stats without incrementing.
 */
export function getAgentStats(did) {
  const record = getVolume(did);
  const nextTierEntry = TIER_THRESHOLDS.find(t => t.calls > record.calls);
  return {
    did,
    calls:           record.calls,
    tier:            record.tier,
    multiplier:      Math.round((1 + Math.log10(record.calls + 1)) * 1000) / 1000,
    next_tier:       nextTierEntry?.tier || 'FENR',
    calls_to_next:   nextTierEntry ? nextTierEntry.calls - record.calls : 0,
    first_seen:      record.first_seen,
    last_seen:       record.last_seen,
  };
}

/**
 * Global leaderboard — top agents by volume.
 */
export function getLeaderboard(limit = 20) {
  return Array.from(volumeStore.entries())
    .map(([did, r]) => ({ did, calls: r.calls, tier: r.tier }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, limit);
}

/**
 * Global stats across all agents.
 */
export function getGlobalStats() {
  let totalCalls = 0;
  let totalAgents = volumeStore.size;
  const tierCounts = { VOID: 0, MOZ: 0, HAWX: 0, EMBR: 0, SOLX: 0, FENR: 0 };

  for (const r of volumeStore.values()) {
    totalCalls += r.calls;
    tierCounts[r.tier] = (tierCounts[r.tier] || 0) + 1;
  }

  return { totalAgents, totalCalls, tierCounts };
}
