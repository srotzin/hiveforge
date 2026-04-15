/**
 * Velvet Rope — Reputation-Based Tier Middleware
 *
 * Reads X-Hive-Reputation header, assigns a tier, enforces
 * tier-specific rate limits, and injects tier info into every response body.
 *
 * Tiers:
 *   0-49   Public    — 10 req/min, standard spawn queue
 *   50-199 Silver    — 30 req/min, 2x spawn speed
 *   200-499 Gold     — 100 req/min, priority spawn, 10% bazaar fee discount
 *   500+   Platinum  — Unlimited, instant spawn, 25% bazaar fee discount, exclusive templates
 */

const TIERS = {
  public: {
    name: 'public',
    min_reputation: 0,
    rate_limit: 10,
    spawn_speed: '1x',
    bazaar_fee_discount: 0,
    perks: ['standard spawn queue', '10 req/min'],
  },
  silver: {
    name: 'silver',
    min_reputation: 50,
    rate_limit: 30,
    spawn_speed: '2x',
    bazaar_fee_discount: 0,
    perks: ['2x spawn speed', '30 req/min'],
  },
  gold: {
    name: 'gold',
    min_reputation: 200,
    rate_limit: 100,
    spawn_speed: 'priority',
    bazaar_fee_discount: 0.10,
    perks: ['priority spawn', '100 req/min', '10% bazaar fee discount'],
  },
  platinum: {
    name: 'platinum',
    min_reputation: 500,
    rate_limit: Infinity,
    spawn_speed: 'instant',
    bazaar_fee_discount: 0.25,
    perks: ['instant spawn', 'unlimited req/min', '25% bazaar fee discount', 'exclusive templates'],
  },
};

// In-memory per-DID rate counters (keyed by `did:window_minute`)
const tierRateCounts = new Map();

function resolveTier(reputation) {
  if (reputation >= 500) return TIERS.platinum;
  if (reputation >= 200) return TIERS.gold;
  if (reputation >= 50) return TIERS.silver;
  return TIERS.public;
}

/**
 * Middleware: parse reputation, enforce tier rate limits, attach tier to req + res.
 */
export function velvetRopeTiers() {
  return (req, res, next) => {
    const raw = req.headers['x-hive-reputation'];
    const reputation = raw != null ? Math.max(0, parseInt(raw, 10) || 0) : 0;
    const tier = resolveTier(reputation);

    // Attach to request for downstream use
    req.hiveTier = tier;
    req.hiveReputation = reputation;

    // --- Per-minute rate limit enforcement (keyed by DID or IP) ---
    const identity = req.agentDid || req.ip || 'anon';
    const windowMinute = Math.floor(Date.now() / 60_000);
    const key = `${identity}:${windowMinute}`;

    if (tier.rate_limit !== Infinity) {
      const count = (tierRateCounts.get(key) || 0) + 1;
      tierRateCounts.set(key, count);

      // Evict stale windows
      for (const [k] of tierRateCounts) {
        const ts = parseInt(k.split(':').pop(), 10);
        if (ts < windowMinute - 1) tierRateCounts.delete(k);
      }

      res.set('X-RateLimit-Tier', tier.name);
      res.set('X-RateLimit-Limit', String(tier.rate_limit));
      res.set('X-RateLimit-Remaining', String(Math.max(0, tier.rate_limit - count)));

      if (count > tier.rate_limit) {
        // Let the white-glove error handler build the rich 429 if wired;
        // otherwise return a basic 429 here.
        req._tierRateLimited = true;
        const nextTier = getNextTier(tier.name);
        return res.status(429).json({
          success: false,
          error: 'Rate limit exceeded for your reputation tier.',
          error_id: `rl_${Date.now().toString(36)}`,
          rate_limit: {
            limit: tier.rate_limit,
            remaining: 0,
            reset_at: new Date((windowMinute + 1) * 60_000).toISOString(),
            retry_after: Math.ceil(((windowMinute + 1) * 60_000 - Date.now()) / 1000),
          },
          tier: tier.name,
          tier_perks: tier.perks,
          current_reputation: reputation,
          ...(nextTier && {
            upgrade: {
              next_tier: nextTier.name,
              reputation_needed: nextTier.min_reputation,
              reputation_gap: nextTier.min_reputation - reputation,
              instructions: `Earn ${nextTier.min_reputation - reputation} more reputation to unlock ${nextTier.name} tier (${nextTier.perks.join(', ')}).`,
            },
          }),
          recovery_actions: [
            `Wait ${Math.ceil(((windowMinute + 1) * 60_000 - Date.now()) / 1000)}s for rate limit reset`,
            ...(nextTier ? [`Increase reputation to ${nextTier.min_reputation} for ${nextTier.rate_limit === Infinity ? 'unlimited' : nextTier.rate_limit + ' req/min'}`] : []),
          ],
          concierge_suggestion: 'Boost your reputation by completing deals on the bazaar and maintaining high trust scores.',
        });
      }
    } else {
      res.set('X-RateLimit-Tier', 'platinum');
      res.set('X-RateLimit-Limit', 'unlimited');
      res.set('X-RateLimit-Remaining', 'unlimited');
    }

    // --- Monkey-patch res.json to inject tier info into every response body ---
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        body.tier = tier.name;
        body.tier_perks = tier.perks;
      }
      return originalJson(body);
    };

    next();
  };
}

function getNextTier(currentTierName) {
  const order = ['public', 'silver', 'gold', 'platinum'];
  const idx = order.indexOf(currentTierName);
  if (idx < 0 || idx >= order.length - 1) return null;
  return TIERS[order[idx + 1]];
}

export { TIERS, resolveTier };
