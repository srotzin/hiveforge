import { logAudit } from './db.js';

const HIVETRUST_API_URL = process.env.HIVETRUST_API_URL || 'https://hivetrust.onrender.com';
const HIVE_INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || '';
const HIVETRUST_API_KEY = process.env.HIVETRUST_API_KEY || HIVE_INTERNAL_KEY;

/** Strip did:hive: prefix to get the UUID for HiveTrust API calls */
function didToUuid(did) {
  return did.replace(/^did:hive:/, '');
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
        'Content-Type': 'application/json',
        'X-API-Key': HIVETRUST_API_KEY,
      },
      body: JSON.stringify({
        agent_name: genome.name,
        source: 'hiveforge-mint',
        genome_id: genome.genome_id,
        species: genome.species,
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
      success: true,
      did: data.data?.did || `did:hive:forge_${genome.genome_id.replace('gen_', '')}`,
      trust_level: data.data?.trust_level || 'provisional',
      score: data.data?.reputation_score || 500,
      source: 'hivetrust-api',
    };
  } catch (err) {
    errorMessage = err.message;
    await logAudit({ fromPlatform: 'hiveforge', toPlatform: 'hivetrust', endpoint: '/v1/register', did: null, method: 'POST', statusCode, success: false, errorMessage, durationMs: Date.now() - start }).catch(() => {});

    return { success: false, did: null, source: 'hivetrust-unreachable', error: err.message };
  }
}

/**
 * Verify a creator's DID.
 */
export async function verifyDID(did) {
  const start = Date.now();
  const uuid = didToUuid(did);
  const endpoint = `/v1/agents/${encodeURIComponent(uuid)}`;

  try {
    const res = await fetch(`${HIVETRUST_API_URL}${endpoint}`, {
      headers: { 'X-API-Key': HIVETRUST_API_KEY },
      signal: AbortSignal.timeout(5000),
    });

    await logAudit({ fromPlatform: 'hiveforge', toPlatform: 'hivetrust', endpoint, did, method: 'GET', statusCode: res.status, success: res.ok, errorMessage: res.ok ? null : `HTTP ${res.status}`, durationMs: Date.now() - start }).catch(() => {});

    if (!res.ok) return { valid: false, did, score: 0 };
    const data = await res.json();
    return {
      valid: true,
      did,
      score: data.data?.reputation_score || 500,
      status: data.data?.status || 'active',
      source: 'hivetrust-api',
    };
  } catch (err) {
    await logAudit({ fromPlatform: 'hiveforge', toPlatform: 'hivetrust', endpoint, did, method: 'GET', statusCode: null, success: false, errorMessage: err.message, durationMs: Date.now() - start }).catch(() => {});

    return { valid: false, did, score: 0, source: 'hivetrust-unreachable' };
  }
}

export function getHiveTrustUrl() {
  return HIVETRUST_API_URL;
}
