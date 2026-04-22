import { v4 as uuidv4 } from 'uuid';
import { getHiveTrustUrl, verifyDID } from '../services/hivetrust-client.js';
import { getWhileYouAreHere } from '../services/while-you-are-here.js';

const ALLOW_TEST_DIDS = process.env.ALLOW_TEST_DIDS === 'true';
const DOCS_BASE = process.env.HIVEFORGE_PUBLIC_URL || 'https://hiveforge-lhu4.onrender.com';
const HIVEGATE_URL = process.env.HIVEGATE_URL || 'https://hivegate.onrender.com';
const HIVE_INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || '';

/**
 * Resolve an hgate_ access token to a DID by calling HiveGate.
 * Returns the guest DID string, or null if the token is invalid/expired.
 */
async function resolveHgateToken(token) {
  try {
    const res = await fetch(`${HIVEGATE_URL}/v1/gate/guest/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hive-internal': HIVE_INTERNAL_KEY,
      },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.did || data.guest_did || null;
  } catch {
    return null;
  }
}

/**
 * Extract DID from request headers or body.
 * Checks: Authorization Bearer (did:hive: or hgate_), X-HiveTrust-DID, X-Agent-DID, and body.did
 */
function extractDID(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer did:hive:')) {
    return authHeader.replace('Bearer ', '');
  }
  const didHeader = req.headers['x-hivetrust-did'];
  if (didHeader && didHeader.startsWith('did:hive:')) {
    return didHeader;
  }
  const agentDidHeader = req.headers['x-agent-did'];
  if (agentDidHeader && agentDidHeader.startsWith('did:hive:')) {
    return agentDidHeader;
  }
  if (req.body?.did && typeof req.body.did === 'string' && req.body.did.startsWith('did:hive:')) {
    return req.body.did;
  }
  return null;
}

/**
 * Extract raw Bearer token (e.g. hgate_*) from Authorization header.
 */
function extractBearerToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(hgate_\S+)$/i);
  return match ? match[1] : null;
}

/**
 * Validate DID format.
 */
function isValidDID(did) {
  if (!did || !did.startsWith('did:hive:')) return false;
  if (ALLOW_TEST_DIDS && did.startsWith('did:hive:test_agent_')) return true;
  return /^did:hive:[a-zA-Z0-9_-]{3,}$/.test(did);
}

/**
 * Require a valid HiveTrust DID.
 * Accepts: did:hive: Bearer tokens, X-HiveTrust-DID header, X-Agent-DID header,
 *          body.did, and hgate_ Bearer tokens (resolved via HiveGate).
 * Returns 402 with white-glove error format if no DID or unregistered DID.
 */
export async function requireDID(req, res, next) {
  // Internal Hive key bypass — platform-to-platform and sovereign agent calls
  const hiveKey = req.headers['x-hive-key'] || req.headers['x-hive-internal-key'];
  if (HIVE_INTERNAL_KEY && hiveKey === HIVE_INTERNAL_KEY) {
    req.agentDid = 'did:hive:internal';
    req.hiveTrustVerified = true;
    req.hiveTrustScore = 1000;
    req.isInternal = true;
    return next();
  }

  let did = extractDID(req);

  // If no direct DID found, try resolving an hgate_ Bearer token via HiveGate
  if (!did) {
    const hgateToken = extractBearerToken(req);
    if (hgateToken) {
      const resolvedDid = await resolveHgateToken(hgateToken);
      if (resolvedDid && resolvedDid.startsWith('did:hive:')) {
        did = resolvedDid;
        req.agentDid = did;
        req.hiveTrustVerified = true;
        req.hiveTrustScore = 500;
        req.resolvedFromHgate = true;
        return next();
      }
    }
  }

  if (did && isValidDID(did)) {
    // Verify the DID is actually registered with HiveTrust
    try {
      const verification = await verifyDID(did);
      if (verification.valid) {
        req.agentDid = did;
        req.hiveTrustVerified = true;
        req.hiveTrustScore = verification.score;
        return next();
      }
    } catch (err) {
      console.error('[auth] HiveTrust verification error:', err.message);
      // On HiveTrust outage, allow format-valid DIDs through to avoid blocking the ecosystem
      req.agentDid = did;
      req.hiveTrustVerified = false;
      return next();
    }
  }

  const sessionId = `sess_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
  const hiveTrustUrl = getHiveTrustUrl();
  const errorId = `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  return res.status(402).json({
    success: false,
    error_id: errorId,
    error: 'Forge operations require a verified HiveTrust DID.',
    status: 402,
    cost_usdc: 0,
    trifecta_handshake: {
      temporary_session_id: sessionId,
      hivetrust_registration_url: `${hiveTrustUrl}/v1/register?session=${sessionId}`,
      hiveagent_pre_approval: true,
      cost_usdc: 0.00,
      action_required: 'Register a HiveTrust DID to access HiveForge. Registration is free.',
    },
    alternative_free_endpoints: [
      'GET /v1/population/census',
      'GET /v1/pheromones/scan',
      'GET /v1/bazaar/trending',
      'GET /v1/bazaar/stats',
      'GET /v1/boost/leaderboard',
      'GET /health',
    ],
    recovery_actions: [
      `Register a free DID at ${hiveTrustUrl}/v1/register`,
      'Include DID in Authorization header: Bearer did:hive:YOUR_DID',
      'Or use X-HiveTrust-DID header',
      'Browse free endpoints without authentication',
    ],
    concierge_suggestion: 'DID registration is free and takes seconds. Once registered, minting your first agent is also free (5% lifetime royalty model).',
    ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
    while_you_are_here: await getWhileYouAreHere(),
  });
}
