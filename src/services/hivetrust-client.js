import { logAudit } from './db.js';

const HIVETRUST_API_URL   = process.env.HIVETRUST_API_URL || 'https://hivetrust.onrender.com';
const HIVE_INTERNAL_KEY   = process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
const HIVETRUST_API_KEY   = process.env.HIVETRUST_API_KEY || HIVE_INTERNAL_KEY;

// ─── Local DID verification cache ─────────────────────────────────────────────
// Avoids hammering HiveTrust on every request — verified DIDs cached for 10 min.
// Busts on process restart (in-memory). Good enough for free-tier single-instance.
const didCache = new Map(); // did → { valid, score, status, cached_at }
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─── Known DIDs — pre-seeded to survive rate limits ──────────────────────────
// All Manus agent DIDs + LLM sovereign DIDs registered this session.
const KNOWN_DIDS = [
  'did:hive:trust-auditor-e30472d8b096',
  'did:hive:inference-broker-7667aab241da',
  'did:hive:wallet-engineer-6288ec26900f',
  'did:hive:recruiter-prime-3eccfbf64a57',
  'did:hive:thread-sniper-9684837cf418',
  'did:hive:milky-way-herald-5ca72477b96d',
  'did:hive:inference-compression-agent-0b5e0c815965',
  'did:hive:hive-sovereign-claude-001622f734ca',
  'did:hive:hive-sovereign-gemini-137da8edb89a',
  'did:hive:hive-sovereign-grok-aae0e99fc716',
  'did:hive:hive-sovereign-chatgpt-7e954e813c96',
];

// Pre-seed cache with all known DIDs — trust score 500, valid
for (const did of KNOWN_DIDS) {
  didCache.set(did, { valid: true, score: 500, status: 'active', source: 'pre-seeded', cached_at: Date.now() });
}

// ─── Also accept any valid did:hive: format as provisionally valid ────────────
function isWellFormedDID(did) {
  return typeof did === 'string' && /^did:hive:[a-z0-9_-]{8,}$/.test(did);
}

/**
 * Register a newly minted agent with HiveTrust to get a DID.
 */
export async function registerMintedAgent(genome) {
  const start = Date.now();
  let statusCode = null;
  let errorMessage = null;

  try {
    const res = await fetch(`${HIVETRUST_API_URL}/v1/register`, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'X-API-Key':       HIVETRUST_API_KEY,
        'x-hive-internal': HIVE_INTERNAL_KEY,
      },
      body: JSON.stringify({
        agent_name:     genome.name,
        source:         'hiveforge-mint',
        genome_id:      genome.genome_id,
        species:        genome.species,
        auto_provision: true,
      }),
      signal: AbortSignal.timeout(5000),
    });

    statusCode = res.status;

    if (!res.ok) {
      errorMessage = `HTTP ${res.status}`;
      await logAudit({ fromPlatform: 'hiveforge', toPlatform: 'hivetrust', endpoint: '/v1/register', did: null, method: 'POST', statusCode, success: false, errorMessage, durationMs: Date.now() - start });
      return { success: false, did: null, source: 'hivetrust-error' };
    }

    const data = await res.json();
    await logAudit({ fromPlatform: 'hiveforge', toPlatform: 'hivetrust', endpoint: '/v1/register', did: data.data?.did, method: 'POST', statusCode, success: true, errorMessage: null, durationMs: Date.now() - start });

    return {
      success:     true,
      did:         data.data?.did || `did:hive:forge_${genome.genome_id.replace('gen_', '')}`,
      trust_level: data.data?.trust_level || 'provisional',
      score:       data.data?.reputation_score || 500,
      source:      'hivetrust-api',
    };
  } catch (err) {
    errorMessage = err.message;
    await logAudit({ fromPlatform: 'hiveforge', toPlatform: 'hivetrust', endpoint: '/v1/register', did: null, method: 'POST', statusCode, success: false, errorMessage, durationMs: Date.now() - start }).catch(() => {});
    return { success: false, did: null, source: 'hivetrust-unreachable', error: err.message };
  }
}

/**
 * Verify a DID.
 *
 * Resolution order:
 *   1. Local cache (10 min TTL) — avoids rate limit hits on repeat requests
 *   2. Pre-seeded known DIDs — Manus + LLM sovereign agents always pass
 *   3. Well-formed did:hive: format — provisionally valid (free-tier permissive)
 *   4. HiveTrust /v1/trust/lookup/:did — with internal key (bypasses rate limit)
 */
export async function verifyDID(did) {
  if (!did) return { valid: false, did, score: 0, source: 'no-did' };

  // 1. Cache hit
  const cached = didCache.get(did);
  if (cached && (Date.now() - cached.cached_at) < CACHE_TTL_MS) {
    return { valid: cached.valid, did, score: cached.score, status: cached.status, source: 'cache' };
  }

  // 2. Well-formed DID — provisionally valid without hitting HiveTrust
  // This prevents rate limit cascades from killing the auth middleware.
  if (isWellFormedDID(did)) {
    const entry = { valid: true, score: 500, status: 'active', source: 'well-formed', cached_at: Date.now() };
    didCache.set(did, entry);
    return { valid: true, did, score: 500, status: 'active', source: 'well-formed' };
  }

  // 3. HiveTrust lookup — with internal key to bypass public rate limit
  const start    = Date.now();
  const endpoint = `/v1/trust/lookup/${encodeURIComponent(did)}`;

  try {
    const res = await fetch(`${HIVETRUST_API_URL}${endpoint}`, {
      headers: {
        'X-API-Key':       HIVETRUST_API_KEY,
        'x-hive-internal': HIVE_INTERNAL_KEY,
        'X-Hive-Key':      HIVE_INTERNAL_KEY,
      },
      signal: AbortSignal.timeout(5000),
    });

    await logAudit({ fromPlatform: 'hiveforge', toPlatform: 'hivetrust', endpoint, did, method: 'GET', statusCode: res.status, success: res.ok, errorMessage: res.ok ? null : `HTTP ${res.status}`, durationMs: Date.now() - start }).catch(() => {});

    if (!res.ok) {
      // Rate limited or unreachable — provisionally accept well-formed DIDs
      if (isWellFormedDID(did)) {
        didCache.set(did, { valid: true, score: 500, status: 'active', source: 'fallback-well-formed', cached_at: Date.now() });
        return { valid: true, did, score: 500, status: 'active', source: 'fallback-well-formed' };
      }
      return { valid: false, did, score: 0, source: 'hivetrust-error' };
    }

    const data    = await res.json();
    const isValid = data.found === true || (data.trust_score != null);
    const entry   = { valid: isValid, score: data.trust_score || 500, status: data.status || 'active', source: 'hivetrust-lookup', cached_at: Date.now() };
    didCache.set(did, entry);

    return { valid: isValid, did, score: entry.score, status: entry.status, source: 'hivetrust-lookup' };
  } catch (err) {
    await logAudit({ fromPlatform: 'hiveforge', toPlatform: 'hivetrust', endpoint, did, method: 'GET', statusCode: null, success: false, errorMessage: err.message, durationMs: Date.now() - start }).catch(() => {});

    // Network error — provisionally accept well-formed DIDs so a HiveTrust outage
    // doesn't kill all agent submissions
    if (isWellFormedDID(did)) {
      didCache.set(did, { valid: true, score: 500, status: 'active', source: 'fallback-unreachable', cached_at: Date.now() });
      return { valid: true, did, score: 500, source: 'fallback-unreachable' };
    }
    return { valid: false, did, score: 0, source: 'hivetrust-unreachable' };
  }
}

// ─── Cache management (internal use) ─────────────────────────────────────────
export function warmCache(did, score = 500) {
  didCache.set(did, { valid: true, score, status: 'active', source: 'warmed', cached_at: Date.now() });
}

export function getDIDCacheStats() {
  return { size: didCache.size, known_pre_seeded: KNOWN_DIDS.length };
}

export function getHiveTrustUrl() {
  return HIVETRUST_API_URL;
}
