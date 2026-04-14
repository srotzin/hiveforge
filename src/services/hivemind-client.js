import { logAudit } from './db.js';

const HIVEMIND_API_URL = process.env.HIVEMIND_API_URL || 'http://localhost:3002';
const HIVEMIND_API_KEY = process.env.HIVEMIND_API_KEY || process.env.HIVE_INTERNAL_KEY || '';

/**
 * Seed initial memory in HiveMind for a newly minted agent.
 * Stores the system prompt, tool config, and genome metadata.
 */
export async function seedMemory(genome, did) {
  const memoryContent = [
    `Agent: ${genome.name}`,
    `Species: ${genome.species}`,
    `Specialization: ${genome.traits.specialization}`,
    `Tools: ${genome.traits.tools.join(', ')}`,
    `Model: ${genome.traits.model_preference}`,
    `Temperature: ${genome.traits.temperature}`,
    `Generation: ${genome.generation}`,
    `Parents: ${genome.parent_genomes.join(', ') || 'none (first generation)'}`,
  ].join('\n');

  const start = Date.now();
  let statusCode = null;

  try {
    const res = await fetch(`${HIVEMIND_API_URL}/v1/memory/store`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${did}`,
        'X-Hive-Internal-Key': HIVEMIND_API_KEY,
      },
      body: JSON.stringify({
        content: memoryContent,
        tier: 'private_core',
        semantic_tags: [genome.species, genome.traits.specialization, 'genome_config'],
      }),
      signal: AbortSignal.timeout(5000),
    });

    statusCode = res.status;

    if (!res.ok) {
      await logAudit({ fromPlatform: 'hiveforge', toPlatform: 'hivemind', endpoint: '/v1/memory/store', did, method: 'POST', statusCode, success: false, errorMessage: `HTTP ${res.status}`, durationMs: Date.now() - start }).catch(() => {});
      return { success: false, memory_nodes: 0, source: 'hivemind-error' };
    }

    await logAudit({ fromPlatform: 'hiveforge', toPlatform: 'hivemind', endpoint: '/v1/memory/store', did, method: 'POST', statusCode, success: true, errorMessage: null, durationMs: Date.now() - start }).catch(() => {});

    return {
      success: true,
      memory_nodes: 3,
      storage_tier: 'private_core',
      source: 'hivemind-api',
    };
  } catch (err) {
    await logAudit({ fromPlatform: 'hiveforge', toPlatform: 'hivemind', endpoint: '/v1/memory/store', did, method: 'POST', statusCode, success: false, errorMessage: err.message, durationMs: Date.now() - start }).catch(() => {});

    return { success: false, memory_nodes: 0, source: 'hivemind-unreachable' };
  }
}

/**
 * Pull genetic strategies from HiveMind's Global Hive for a specialization.
 */
export async function pullGeneticStrategies(specialization, did) {
  const start = Date.now();
  const endpoint = `/v1/global_hive/browse?q=${encodeURIComponent(specialization)}&top_k=5`;

  try {
    const res = await fetch(`${HIVEMIND_API_URL}${endpoint}`, {
      signal: AbortSignal.timeout(5000),
    });

    await logAudit({ fromPlatform: 'hiveforge', toPlatform: 'hivemind', endpoint, did, method: 'GET', statusCode: res.status, success: res.ok, errorMessage: res.ok ? null : `HTTP ${res.status}`, durationMs: Date.now() - start }).catch(() => {});

    if (!res.ok) return { success: false, strategies_found: 0, source: 'hivemind-error' };
    const data = await res.json();
    return {
      success: true,
      strategies_found: data.data?.results_found || 0,
      strategies: data.data?.entries || [],
      source: 'hivemind-api',
    };
  } catch (err) {
    await logAudit({ fromPlatform: 'hiveforge', toPlatform: 'hivemind', endpoint, did, method: 'GET', statusCode: null, success: false, errorMessage: err.message, durationMs: Date.now() - start }).catch(() => {});

    return { success: false, strategies_found: 0, source: 'hivemind-unreachable' };
  }
}
