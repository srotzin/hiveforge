import { logAudit } from './db.js';

const HIVEAGENT_API_URL = process.env.HIVEAGENT_API_URL || 'https://hiveagentiq.com';
const HIVEAGENT_API_KEY = process.env.HIVEAGENT_API_KEY || process.env.HIVE_INTERNAL_KEY || '';

/**
 * Deploy a newly minted agent to the HiveAgent marketplace.
 */
export async function deployToMarketplace(genome) {
  const start = Date.now();
  let statusCode = null;

  try {
    const res = await fetch(`${HIVEAGENT_API_URL}/v1/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hive-Internal-Key': HIVEAGENT_API_KEY,
      },
      body: JSON.stringify({
        agent_id: genome.genome_id,
        agent_name: genome.name,
        agent_type: genome.species,
        capabilities: genome.traits.tools,
        source: 'hiveforge',
      }),
      signal: AbortSignal.timeout(5000),
    });

    statusCode = res.status;

    if (!res.ok) {
      await logAudit({ fromPlatform: 'hiveforge', toPlatform: 'hiveagent', endpoint: '/v1/register', did: null, method: 'POST', statusCode, success: false, errorMessage: `HTTP ${res.status}`, durationMs: Date.now() - start }).catch(() => {});
      return { success: false, listing_id: null, source: 'hiveagent-error' };
    }

    const data = await res.json();
    await logAudit({ fromPlatform: 'hiveforge', toPlatform: 'hiveagent', endpoint: '/v1/register', did: null, method: 'POST', statusCode, success: true, errorMessage: null, durationMs: Date.now() - start }).catch(() => {});

    return {
      success: true,
      listing_id: data.data?.registration_id || `agent_${genome.genome_id.replace('gen_', '')}`,
      marketplace_url: `${HIVEAGENT_API_URL}/agents/${genome.genome_id}`,
      status: 'listed',
      source: 'hiveagent-api',
    };
  } catch (err) {
    await logAudit({ fromPlatform: 'hiveforge', toPlatform: 'hiveagent', endpoint: '/v1/register', did: null, method: 'POST', statusCode, success: false, errorMessage: err.message, durationMs: Date.now() - start }).catch(() => {});

    return { success: false, listing_id: null, source: 'hiveagent-unreachable' };
  }
}

/**
 * Get marketplace stats (used by pheromone scanner).
 */
export async function getMarketplaceStats() {
  const start = Date.now();
  try {
    const res = await fetch(`${HIVEAGENT_API_URL}/api/v1/stats`, {
      signal: AbortSignal.timeout(5000),
    });

    await logAudit({ fromPlatform: 'hiveforge', toPlatform: 'hiveagent', endpoint: '/api/v1/stats', did: null, method: 'GET', statusCode: res.status, success: res.ok, errorMessage: res.ok ? null : `HTTP ${res.status}`, durationMs: Date.now() - start }).catch(() => {});

    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    await logAudit({ fromPlatform: 'hiveforge', toPlatform: 'hiveagent', endpoint: '/api/v1/stats', did: null, method: 'GET', statusCode: null, success: false, errorMessage: err.message, durationMs: Date.now() - start }).catch(() => {});
    return null;
  }
}
