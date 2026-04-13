import { v4 as uuidv4 } from 'uuid';
import { getHiveTrustUrl } from '../services/hivetrust-client.js';

const IS_DEV = process.env.NODE_ENV !== 'production';

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
  if (IS_DEV && did.startsWith('did:hive:test_agent_')) return true;
  return /^did:hive:[a-zA-Z0-9_-]{3,}$/.test(did);
}

/**
 * Require a valid HiveTrust DID.
 * Returns 402 Trifecta Handshake if no DID present — same pattern as HiveMind.
 */
export function requireDID(req, res, next) {
  const did = extractDID(req);

  if (did && isValidDID(did)) {
    req.agentDid = did;
    return next();
  }

  const sessionId = `sess_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
  const hiveTrustUrl = getHiveTrustUrl();

  return res.status(402).json({
    status: '402 Payment Required',
    message: 'Forge operations require a verified HiveTrust DID.',
    trifecta_handshake: {
      temporary_session_id: sessionId,
      hivetrust_registration_url: `${hiveTrustUrl}/v1/register?session=${sessionId}`,
      hiveagent_pre_approval: true,
      cost_usdc: 0.00,
      action_required: 'Register a HiveTrust DID to access HiveForge. Registration is free.',
    },
  });
}
