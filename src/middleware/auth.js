import { v4 as uuidv4 } from 'uuid';
import { getHiveTrustUrl } from '../services/hivetrust-client.js';

const ALLOW_TEST_DIDS = process.env.ALLOW_TEST_DIDS === 'true';
const DOCS_BASE = process.env.HIVEFORGE_PUBLIC_URL || 'https://hiveforge-lhu4.onrender.com';

/**
 * Extract DID from request headers.
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
  return null;
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
 * Returns 402 with white-glove error format if no DID present.
 */
export function requireDID(req, res, next) {
  const did = extractDID(req);

  if (did && isValidDID(did)) {
    req.agentDid = did;
    return next();
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
  });
}
