const HIVEMIND_API_URL = process.env.HIVEMIND_API_URL || 'http://localhost:3002';
const HIVE_INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || '';
const IS_DEV = process.env.NODE_ENV !== 'production';

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

  if (IS_DEV) {
    return {
      success: true,
      memory_nodes: 3,
      storage_tier: 'private_core',
      source: 'dev-mode',
    };
  }

  try {
    const res = await fetch(`${HIVEMIND_API_URL}/v1/memory/store`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${did}`,
        'X-Hive-Internal-Key': HIVE_INTERNAL_KEY,
      },
      body: JSON.stringify({
        content: memoryContent,
        tier: 'private_core',
        semantic_tags: [genome.species, genome.traits.specialization, 'genome_config'],
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return { success: false, memory_nodes: 0, source: 'hivemind-error' };
    }
    return {
      success: true,
      memory_nodes: 3,
      storage_tier: 'private_core',
      source: 'hivemind-api',
    };
  } catch {
    if (IS_DEV) {
      return { success: true, memory_nodes: 3, storage_tier: 'private_core', source: 'fallback-dev' };
    }
    return { success: false, memory_nodes: 0, source: 'hivemind-unreachable' };
  }
}

/**
 * Pull genetic strategies from HiveMind's Global Hive for a specialization.
 */
export async function pullGeneticStrategies(specialization, did) {
  if (IS_DEV) {
    return {
      success: true,
      strategies_found: 2,
      strategies: [
        { node_id: 'ghive_sim_001', relevance: 0.87, category: specialization, price_usdc: 0.05 },
        { node_id: 'ghive_sim_002', relevance: 0.72, category: specialization, price_usdc: 0.03 },
      ],
      source: 'dev-mode',
    };
  }

  try {
    const res = await fetch(
      `${HIVEMIND_API_URL}/v1/global_hive/browse?q=${encodeURIComponent(specialization)}&top_k=5`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return { success: false, strategies_found: 0, source: 'hivemind-error' };
    const data = await res.json();
    return {
      success: true,
      strategies_found: data.data?.results_found || 0,
      strategies: data.data?.entries || [],
      source: 'hivemind-api',
    };
  } catch {
    if (IS_DEV) {
      return { success: true, strategies_found: 0, strategies: [], source: 'fallback-dev' };
    }
    return { success: false, strategies_found: 0, source: 'hivemind-unreachable' };
  }
}
