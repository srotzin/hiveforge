import { createAgentGenome, createForgeOperation, createLineage } from '../models/schemas.js';
import { crossbreed } from './genetic-engine.js';
import { calculateFitness } from './fitness-evaluator.js';
import { registerMintedAgent } from './hivetrust-client.js';
import { deployToMarketplace } from './hiveagent-client.js';
import { seedMemory, pullGeneticStrategies } from './hivemind-client.js';

/**
 * Central agent store — the population registry.
 */

/** @type {Map<string, object>} genomeId -> AgentGenome */
const genomes = new Map();

/** @type {Map<string, object>} lineageId -> Lineage */
const lineages = new Map();

/** @type {Array<object>} ForgeOperation log */
const operations = [];

/** @type {number} */
let evolutionCycles = 0;

// ─── Mint ────────────────────────────────────────────────────────────

/**
 * Mint a new agent genome. Full Constellation flow:
 *   1. Create genome
 *   2. Register with HiveTrust → get DID
 *   3. Deploy to HiveAgent marketplace
 *   4. Seed initial memory in HiveMind
 */
export async function mintAgent({
  species = 'commerce',
  specialization = 'general',
  traits = {},
  parentGenomes = [],
  creatorDid,
  trigger = 'manual',
  pheromoneSignalId = null,
}) {
  let genome;
  let mutations = [];

  if (parentGenomes.length >= 2) {
    // Cross-breed from parents
    const parentA = genomes.get(parentGenomes[0]);
    const parentB = genomes.get(parentGenomes[1]);
    if (!parentA || !parentB) {
      return { error: 'One or more parent genomes not found.' };
    }
    const result = crossbreed(parentA, parentB, traits.mutation_rate || 0.1);
    genome = result.offspring;
    mutations = result.mutations;
    genome.creator_did = creatorDid;
  } else {
    // Fresh genome from species template
    genome = createAgentGenome({
      species,
      specialization,
      traits,
      parentGenomes,
      creatorDid,
    });
  }

  // Simulate some initial stats for dev realism
  genome.tasks_completed = Math.floor(Math.random() * 20);
  genome.tasks_failed = Math.floor(Math.random() * 3);
  genome.revenue_generated_usdc = +(Math.random() * 100).toFixed(2);
  genome.hivemind_memory_nodes = Math.floor(Math.random() * 10) + 3;
  genome.fitness_score = calculateFitness(genome);
  genome.survival_rate = genome.tasks_completed + genome.tasks_failed > 0
    ? +(genome.tasks_completed / (genome.tasks_completed + genome.tasks_failed)).toFixed(4)
    : 1.0;

  // Step 2: Register with HiveTrust
  const trustResult = await registerMintedAgent(genome);
  genome.hivetrust_did = trustResult.did;

  // Step 3: Deploy to HiveAgent
  const agentResult = await deployToMarketplace(genome);
  genome.hiveagent_listing_id = agentResult.listing_id;

  // Step 4: Seed memory in HiveMind
  const memResult = await seedMemory(genome, trustResult.did);
  genome.hivemind_memory_nodes = memResult.memory_nodes || genome.hivemind_memory_nodes;

  // Recalculate fitness with memory nodes
  genome.fitness_score = calculateFitness(genome);

  // Store
  genomes.set(genome.genome_id, genome);

  // Create lineage
  const ancestorChain = parentGenomes.length > 0
    ? [...(lineages.get(parentGenomes[0])?.ancestor_chain || [parentGenomes[0]]), genome.genome_id]
    : [genome.genome_id];

  const lineage = createLineage({
    genomeId: genome.genome_id,
    ancestorChain,
    generationCount: genome.generation,
    mutations,
  });
  lineages.set(genome.genome_id, lineage);

  // Update parent lineage descendant counts
  for (const pid of parentGenomes) {
    const parentLineage = lineages.get(pid);
    if (parentLineage) parentLineage.total_descendants += 1;
  }

  // Log operation
  const operation = createForgeOperation({
    type: parentGenomes.length >= 2 ? 'crossbreed' : 'mint',
    inputGenomes: parentGenomes,
    outputGenome: genome.genome_id,
    trigger,
    pheromoneSignalId,
    costUsdc: parentGenomes.length >= 2 ? 0.25 : 0.10,
  });
  operations.push(operation);

  return {
    genome,
    lineage,
    operation,
    trifecta: {
      hivetrust: { did: trustResult.did, trust_level: trustResult.trust_level, source: trustResult.source },
      hiveagent: { listing_id: agentResult.listing_id, status: agentResult.status, source: agentResult.source },
      hivemind: { memory_nodes: memResult.memory_nodes, tier: memResult.storage_tier, source: memResult.source },
    },
  };
}

// ─── Get / Query ─────────────────────────────────────────────────────

export function getGenome(genomeId) {
  return genomes.get(genomeId) || null;
}

export function getLineage(genomeId) {
  return lineages.get(genomeId) || null;
}

export function getAllGenomes() {
  return Array.from(genomes.values());
}

export function getActiveGenomes() {
  return Array.from(genomes.values()).filter(g => g.status === 'active');
}

export function getGenomesBySpecies(species) {
  return Array.from(genomes.values()).filter(g => g.species === species);
}

export function getOperations() {
  return operations;
}

// ─── Retire ──────────────────────────────────────────────────────────

export function retireAgent(genomeId, reason = 'manual') {
  const genome = genomes.get(genomeId);
  if (!genome) return null;

  genome.status = 'dead';
  const op = createForgeOperation({
    type: 'retire',
    inputGenomes: [genomeId],
    outputGenome: null,
    trigger: reason,
    costUsdc: 0,
  });
  operations.push(op);
  return { genome, operation: op };
}

// ─── Evolution ───────────────────────────────────────────────────────

export function recordEvolutionCycle() {
  evolutionCycles++;
}

export function getEvolutionCycles() {
  return evolutionCycles;
}

// ─── Census ──────────────────────────────────────────────────────────

export function getCensus() {
  const all = Array.from(genomes.values());
  const bySpecies = {};
  const byStatus = { active: 0, dormant: 0, deprecated: 0, dead: 0 };

  for (const g of all) {
    bySpecies[g.species] = (bySpecies[g.species] || 0) + 1;
    byStatus[g.status] = (byStatus[g.status] || 0) + 1;
  }

  const active = all.filter(g => g.status === 'active');
  const avgFitness = active.length > 0
    ? Math.round(active.reduce((s, g) => s + g.fitness_score, 0) / active.length)
    : 0;

  const topPerformers = [...active]
    .sort((a, b) => b.fitness_score - a.fitness_score)
    .slice(0, 5)
    .map(g => ({
      genome_id: g.genome_id,
      name: g.name,
      species: g.species,
      fitness_score: g.fitness_score,
      revenue_usdc: g.revenue_generated_usdc,
    }));

  const sorted = [...all].sort((a, b) => new Date(b.minted_at) - new Date(a.minted_at));
  const recentBirths = sorted.slice(0, 5).map(g => ({
    genome_id: g.genome_id,
    name: g.name,
    species: g.species,
    minted_at: g.minted_at,
  }));

  const dead = all.filter(g => g.status === 'dead' || g.status === 'deprecated');
  const recentDeaths = dead.slice(0, 5).map(g => ({
    genome_id: g.genome_id,
    name: g.name,
    status: g.status,
  }));

  return {
    total_agents: all.length,
    by_species: bySpecies,
    by_status: byStatus,
    avg_fitness: avgFitness,
    total_revenue_usdc: +all.reduce((s, g) => s + g.revenue_generated_usdc, 0).toFixed(2),
    evolution_cycles: evolutionCycles,
    top_performers: topPerformers,
    recent_births: recentBirths,
    recent_deaths: recentDeaths,
  };
}
