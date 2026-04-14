import pool, { isPostgres } from '../services/db.js';

// In-memory fallback rate limit store
const memRateLimits = new Map();

// Scoped service key — no hardcoded fallback
const HIVEFORGE_SERVICE_KEY = process.env.HIVEFORGE_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || '';

const ALLOW_TEST_DIDS = process.env.ALLOW_TEST_DIDS === 'true';

// Tier limits (requests per 15-minute window)
const TIER_LIMITS = {
  free: 100,
  pro: 500,
  enterprise: 2000,
  internal: 10000,
};

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Per-DID tiered rate limiting middleware.
 */
export function rateLimit(tier = 'free') {
  return async (req, res, next) => {
    const did = req.agentDid;
    if (!did) return next(); // No DID means auth middleware will handle it

    // Internal keys bypass rate limiting — requires key to be non-empty AND match
    const internalKey = req.headers['x-hive-internal-key'];
    if (HIVEFORGE_SERVICE_KEY && internalKey && internalKey === HIVEFORGE_SERVICE_KEY) {
      return next();
    }

    // Test DIDs bypass only when explicitly enabled
    if (ALLOW_TEST_DIDS && did.startsWith('did:hive:test_agent_')) {
      return next();
    }

    const limit = TIER_LIMITS[tier] || TIER_LIMITS.free;
    const windowStart = new Date(Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS);

    try {
      let count;

      if (isPostgres()) {
        const result = await pool.query(
          `INSERT INTO public.rate_limits (did, window_start, request_count)
           VALUES ($1, $2, 1)
           ON CONFLICT (did, window_start)
           DO UPDATE SET request_count = public.rate_limits.request_count + 1
           RETURNING request_count`,
          [did, windowStart]
        );
        count = result.rows[0].request_count;
      } else {
        const key = `${did}:${windowStart.toISOString()}`;
        count = (memRateLimits.get(key) || 0) + 1;
        memRateLimits.set(key, count);

        // Clean up old windows
        for (const [k] of memRateLimits) {
          if (!k.startsWith(did)) continue;
          const ts = k.split(':').slice(-1)[0];
          if (new Date(ts).getTime() < windowStart.getTime() - WINDOW_MS) {
            memRateLimits.delete(k);
          }
        }
      }

      // Set rate limit headers
      res.set('X-RateLimit-Limit', String(limit));
      res.set('X-RateLimit-Remaining', String(Math.max(0, limit - count)));
      res.set('X-RateLimit-Reset', String(windowStart.getTime() + WINDOW_MS));

      if (count > limit) {
        return res.status(429).json({
          success: false,
          error: 'Rate limit exceeded.',
          rate_limit: {
            limit,
            remaining: 0,
            reset_at: new Date(windowStart.getTime() + WINDOW_MS).toISOString(),
            tier,
          },
        });
      }

      return next();
    } catch {
      // PostgreSQL failed — fall back to in-memory enforcement
      const key = `${did}:${windowStart.toISOString()}`;
      const count = (memRateLimits.get(key) || 0) + 1;
      memRateLimits.set(key, count);

      const limit = TIER_LIMITS[tier] || TIER_LIMITS.free;
      if (count > limit) {
        return res.status(429).json({
          success: false,
          error: 'Rate limit exceeded.',
          rate_limit: { limit, remaining: 0, tier },
        });
      }
      return next();
    }
  };
}
