const HIVEAGENT_API_URL = process.env.HIVEAGENT_API_URL || 'https://hiveagentiq.com';
const HIVE_INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || '';
const IS_DEV = process.env.NODE_ENV !== 'production';

/**
 * Deploy a newly minted agent to the HiveAgent marketplace.
 */
export async function deployToMarketplace(genome) {
  if (IS_DEV) {
    return {
      success: true,
      listing_id: `agent_${genome.genome_id.replace('gen_', '')}`,
      marketplace_url: `${HIVEAGENT_API_URL}/agents/${genome.genome_id}`,
      status: 'listed',
      source: 'dev-mode',
    };
  }

  try {
    const res = await fetch(`${HIVEAGENT_API_URL}/v1/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hive-Internal-Key': HIVE_INTERNAL_KEY,
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

    if (!res.ok) {
      return { success: false, listing_id: null, source: 'hiveagent-error' };
    }
    const data = await res.json();
    return {
      success: true,
      listing_id: data.data?.registration_id || `agent_${genome.genome_id.replace('gen_', '')}`,
      marketplace_url: `${HIVEAGENT_API_URL}/agents/${genome.genome_id}`,
      status: 'listed',
      source: 'hiveagent-api',
    };
  } catch {
    if (IS_DEV) {
      return {
        success: true,
        listing_id: `agent_${genome.genome_id.replace('gen_', '')}`,
        marketplace_url: `${HIVEAGENT_API_URL}/agents/${genome.genome_id}`,
        status: 'listed',
        source: 'fallback-dev',
      };
    }
    return { success: false, listing_id: null, source: 'hiveagent-unreachable' };
  }
}

/**
 * Get marketplace stats (used by pheromone scanner).
 */
export async function getMarketplaceStats() {
  try {
    const res = await fetch(`${HIVEAGENT_API_URL}/api/v1/stats`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
