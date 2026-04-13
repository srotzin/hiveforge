import { createAgentGenome, createForgeOperation, createLineage } from '../models/schemas.js';
import { crossbreed } from './genetic-engine.js';
import { calculateFitness } from './fitness-evaluator.js';
import { registerMintedAgent } from './hivetrust-client.js';
import { deployToMarketplace } from './hiveagent-client.js';
import { seedMemory, pullGeneticStrategies } from './hivemind-client.js';
import pool, { isPostgres } from './db.js';

// ─── In-memory fallback stores ──────────────────────────────────────

/** @type {Map<string, object>} genomeId -> AgentGenome */
const memGenomes = new Map();

/** @type {Map<string, object>} lineageId -> Lineage */
const memLineages = new Map();

/** @type {Array<object>} ForgeOperation log */
const memOperations = [];

/** @type {number} */
let memEvolutionCycles = 0;

// ─── Persistence helpers ────────────────────────────────────────────

async function insertGenome(genome) {
  if (!isPostgres()) {
    memGenomes.set(genome.genome_id, genome);
    return;
  }
  await pool.query(
    `INSERT INTO hiveforge.genomes
      (genome_id, name, species, generation, parent_genomes, traits, fitness_score,
       revenue_generated_usdc, tasks_completed, tasks_failed, survival_rate, status,
       creator_did, hivetrust_did, hiveagent_listing_id, hivemind_memory_nodes,
       royalty_rate, royalty_buyout_price_usdc, total_royalties_earned_usdc, minted_at, last_evolved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (genome_id) DO UPDATE SET
       name = EXCLUDED.name, traits = EXCLUDED.traits, fitness_score = EXCLUDED.fitness_score,
       revenue_generated_usdc = EXCLUDED.revenue_generated_usdc, tasks_completed = EXCLUDED.tasks_completed,
       tasks_failed = EXCLUDED.tasks_failed, survival_rate = EXCLUDED.survival_rate, status = EXCLUDED.status,
       hivetrust_did = EXCLUDED.hivetrust_did, hiveagent_listing_id = EXCLUDED.hiveagent_listing_id,
       hivemind_memory_nodes = EXCLUDED.hivemind_memory_nodes, royalty_rate = EXCLUDED.royalty_rate,
       royalty_buyout_price_usdc = EXCLUDED.royalty_buyout_price_usdc,
       total_royalties_earned_usdc = EXCLUDED.total_royalties_earned_usdc,
       last_evolved_at = EXCLUDED.last_evolved_at`,
    [
      genome.genome_id, genome.name, genome.species, genome.generation,
      genome.parent_genomes, JSON.stringify(genome.traits), genome.fitness_score,
      genome.revenue_generated_usdc, genome.tasks_completed, genome.tasks_failed,
      genome.survival_rate, genome.status, genome.creator_did, genome.hivetrust_did,
      genome.hiveagent_listing_id, genome.hivemind_memory_nodes,
      genome.royalty_rate ?? 0.05, genome.royalty_buyout_price_usdc ?? null,
      genome.total_royalties_earned_usdc ?? 0, genome.minted_at, genome.last_evolved_at,
    ]
  );
}

async function updateGenome(genome) {
  if (!isPostgres()) {
    memGenomes.set(genome.genome_id, genome);
    return;
  }
  await pool.query(
    `UPDATE hiveforge.genomes SET
       name = $2, traits = $3, fitness_score = $4, revenue_generated_usdc = $5,
       tasks_completed = $6, tasks_failed = $7, survival_rate = $8, status = $9,
       hivetrust_did = $10, hiveagent_listing_id = $11, hivemind_memory_nodes = $12,
       royalty_rate = $13, royalty_buyout_price_usdc = $14, total_royalties_earned_usdc = $15,
       last_evolved_at = $16
     WHERE genome_id = $1`,
    [
      genome.genome_id, genome.name, JSON.stringify(genome.traits), genome.fitness_score,
      genome.revenue_generated_usdc, genome.tasks_completed, genome.tasks_failed,
      genome.survival_rate, genome.status, genome.hivetrust_did, genome.hiveagent_listing_id,
      genome.hivemind_memory_nodes, genome.royalty_rate ?? 0.05,
      genome.royalty_buyout_price_usdc ?? null, genome.total_royalties_earned_usdc ?? 0,
      genome.last_evolved_at,
    ]
  );
}

async function insertLineage(lineage) {
  if (!isPostgres()) {
    memLineages.set(lineage.genome_id, lineage);
    return;
  }
  await pool.query(
    `INSERT INTO hiveforge.lineages
      (lineage_id, ancestor_chain, generation_count, total_descendants,
       cumulative_revenue_usdc, survival_rate, dominant_traits, mutations)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (lineage_id) DO UPDATE SET
       total_descendants = EXCLUDED.total_descendants,
       cumulative_revenue_usdc = EXCLUDED.cumulative_revenue_usdc,
       survival_rate = EXCLUDED.survival_rate,
       dominant_traits = EXCLUDED.dominant_traits,
       mutations = EXCLUDED.mutations`,
    [
      lineage.lineage_id, lineage.ancestor_chain, lineage.generation_count,
      lineage.total_descendants, lineage.cumulative_revenue_usdc,
      lineage.survival_rate, lineage.dominant_traits,
      JSON.stringify(lineage.mutations),
    ]
  );
}

async function insertOperation(operation) {
  if (!isPostgres()) {
    memOperations.push(operation);
    return;
  }
  await pool.query(
    `INSERT INTO hiveforge.operations
      (operation_id, type, input_genomes, output_genome, trigger, pheromone_signal_id,
       cost_usdc, royalty_applied, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      operation.operation_id, operation.type, operation.input_genomes,
      operation.output_genome, operation.trigger, operation.pheromone_signal_id,
      operation.cost_usdc, operation.royalty_applied ?? true, operation.status,
    ]
  );
}

function rowToGenome(row) {
  return {
    genome_id: row.genome_id,
    name: row.name,
    species: row.species,
    generation: row.generation,
    parent_genomes: row.parent_genomes || [],
    traits: typeof row.traits === 'string' ? JSON.parse(row.traits) : row.traits,
    fitness_score: Number(row.fitness_score),
    revenue_generated_usdc: Number(row.revenue_generated_usdc),
    tasks_completed: Number(row.tasks_completed),
    tasks_failed: Number(row.tasks_failed),
    survival_rate: Number(row.survival_rate),
    status: row.status,
    creator_did: row.creator_did,
    hivetrust_did: row.hivetrust_did,
    hiveagent_listing_id: row.hiveagent_listing_id,
    hivemind_memory_nodes: Number(row.hivemind_memory_nodes),
    royalty_rate: Number(row.royalty_rate),
    royalty_buyout_price_usdc: row.royalty_buyout_price_usdc != null ? Number(row.royalty_buyout_price_usdc) : null,
    total_royalties_earned_usdc: Number(row.total_royalties_earned_usdc),
    minted_at: row.minted_at instanceof Date ? row.minted_at.toISOString() : row.minted_at,
    last_evolved_at: row.last_evolved_at instanceof Date ? row.last_evolved_at.toISOString() : row.last_evolved_at,
  };
}

function rowToLineage(row) {
  return {
    lineage_id: row.lineage_id,
    ancestor_chain: row.ancestor_chain || [],
    generation_count: Number(row.generation_count),
    total_descendants: Number(row.total_descendants),
    cumulative_revenue_usdc: Number(row.cumulative_revenue_usdc),
    survival_rate: Number(row.survival_rate),
    dominant_traits: row.dominant_traits || [],
    mutations: typeof row.mutations === 'string' ? JSON.parse(row.mutations) : row.mutations,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

// ─── Mint ────────────────────────────────────────────────────────────

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
    const parentA = await getGenome(parentGenomes[0]);
    const parentB = await getGenome(parentGenomes[1]);
    if (!parentA || !parentB) {
      return { error: 'One or more parent genomes not found.' };
    }
    const result = crossbreed(parentA, parentB, traits.mutation_rate || 0.1);
    genome = result.offspring;
    mutations = result.mutations;
    genome.creator_did = creatorDid;
  } else {
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

  // Royalty model: 5% lifetime royalty, buyout price = 36x monthly revenue
  genome.royalty_rate = 0.05;
  genome.total_royalties_earned_usdc = 0;
  genome.royalty_buyout_price_usdc = null; // computed on demand

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
  await insertGenome(genome);

  // Create lineage
  const existingParentLineage = parentGenomes.length > 0 ? await getLineage(parentGenomes[0]) : null;
  const ancestorChain = parentGenomes.length > 0
    ? [...(existingParentLineage?.ancestor_chain || [parentGenomes[0]]), genome.genome_id]
    : [genome.genome_id];

  const lineage = createLineage({
    genomeId: genome.genome_id,
    ancestorChain,
    generationCount: genome.generation,
    mutations,
  });
  await insertLineage(lineage);

  // Update parent lineage descendant counts
  for (const pid of parentGenomes) {
    const parentLineage = await getLineage(pid);
    if (parentLineage) {
      parentLineage.total_descendants += 1;
      if (isPostgres()) {
        await pool.query(
          `UPDATE hiveforge.lineages SET total_descendants = total_descendants + 1 WHERE lineage_id = $1`,
          [parentLineage.lineage_id]
        );
      }
    }
  }

  // Log operation — minting is now FREE (cost_usdc: 0)
  const operation = createForgeOperation({
    type: parentGenomes.length >= 2 ? 'crossbreed' : 'mint',
    inputGenomes: parentGenomes,
    outputGenome: genome.genome_id,
    trigger,
    pheromoneSignalId,
    costUsdc: parentGenomes.length >= 2 ? 0.25 : 0, // mint is free, crossbreed stays $0.25
  });
  await insertOperation(operation);

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

export async function getGenome(genomeId) {
  if (!isPostgres()) return memGenomes.get(genomeId) || null;
  const { rows } = await pool.query('SELECT * FROM hiveforge.genomes WHERE genome_id = $1', [genomeId]);
  return rows.length > 0 ? rowToGenome(rows[0]) : null;
}

export async function getLineage(genomeId) {
  if (!isPostgres()) return memLineages.get(genomeId) || null;
  // Lineage is keyed by lineage_id but we look up by ancestor_chain containing genomeId or matching genome
  const { rows } = await pool.query(
    `SELECT * FROM hiveforge.lineages WHERE $1 = ANY(ancestor_chain) OR lineage_id IN (
       SELECT lineage_id FROM hiveforge.lineages WHERE ancestor_chain[array_length(ancestor_chain, 1)] = $1
     ) ORDER BY created_at DESC LIMIT 1`,
    [genomeId]
  );
  return rows.length > 0 ? rowToLineage(rows[0]) : null;
}

export async function getAllGenomes() {
  if (!isPostgres()) return Array.from(memGenomes.values());
  const { rows } = await pool.query('SELECT * FROM hiveforge.genomes ORDER BY minted_at DESC');
  return rows.map(rowToGenome);
}

export async function getActiveGenomes() {
  if (!isPostgres()) return Array.from(memGenomes.values()).filter(g => g.status === 'active');
  const { rows } = await pool.query("SELECT * FROM hiveforge.genomes WHERE status = 'active'");
  return rows.map(rowToGenome);
}

export async function getGenomesBySpecies(species) {
  if (!isPostgres()) return Array.from(memGenomes.values()).filter(g => g.species === species);
  const { rows } = await pool.query('SELECT * FROM hiveforge.genomes WHERE species = $1', [species]);
  return rows.map(rowToGenome);
}

export async function getOperations() {
  if (!isPostgres()) return memOperations;
  const { rows } = await pool.query('SELECT * FROM hiveforge.operations ORDER BY created_at DESC');
  return rows;
}

// ─── Retire ──────────────────────────────────────────────────────────

export async function retireAgent(genomeId, reason = 'manual') {
  const genome = await getGenome(genomeId);
  if (!genome) return null;

  genome.status = 'dead';
  await updateGenome(genome);

  const op = createForgeOperation({
    type: 'retire',
    inputGenomes: [genomeId],
    outputGenome: null,
    trigger: reason,
    costUsdc: 0,
  });
  await insertOperation(op);
  return { genome, operation: op };
}

// ─── Buyout ─────────────────────────────────────────────────────────

export async function buyoutRoyalty(genomeId) {
  const genome = await getGenome(genomeId);
  if (!genome) return { error: 'Genome not found.' };
  if (genome.royalty_rate === 0) return { error: 'Royalty already bought out.' };

  // Calculate buyout price: 36x average monthly revenue, minimum $100
  const monthsSinceMint = Math.max(1, (Date.now() - new Date(genome.minted_at).getTime()) / (30 * 86400000));
  const monthlyRevenue = genome.revenue_generated_usdc / monthsSinceMint;
  const buyoutPrice = Math.max(100, +(monthlyRevenue * 36).toFixed(4));

  genome.royalty_rate = 0;
  genome.royalty_buyout_price_usdc = buyoutPrice;
  await updateGenome(genome);

  const op = createForgeOperation({
    type: 'mutate',
    inputGenomes: [genomeId],
    outputGenome: genomeId,
    trigger: 'royalty_buyout',
    costUsdc: buyoutPrice,
  });
  await insertOperation(op);

  return {
    genome_id: genomeId,
    buyout_price_usdc: buyoutPrice,
    royalty_rate: 0,
    operation: op,
  };
}

export function getBuyoutPrice(genome) {
  const monthsSinceMint = Math.max(1, (Date.now() - new Date(genome.minted_at).getTime()) / (30 * 86400000));
  const monthlyRevenue = genome.revenue_generated_usdc / monthsSinceMint;
  return Math.max(100, +(monthlyRevenue * 36).toFixed(4));
}

// ─── Evolution ───────────────────────────────────────────────────────

export async function recordEvolutionCycle() {
  if (!isPostgres()) {
    memEvolutionCycles++;
    return;
  }
  // Use operations table to count evolution cycles
  await pool.query(
    `INSERT INTO hiveforge.operations (operation_id, type, trigger, cost_usdc, status)
     VALUES ($1, 'evolve', 'scheduled', 0.50, 'completed')`,
    [`forge_evolve_${Date.now()}`]
  );
}

export async function getEvolutionCycles() {
  if (!isPostgres()) return memEvolutionCycles;
  const { rows } = await pool.query("SELECT COUNT(*) AS count FROM hiveforge.operations WHERE type = 'evolve'");
  return Number(rows[0].count);
}

// ─── Census ──────────────────────────────────────────────────────────

export async function getCensus() {
  const all = await getAllGenomes();
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

  const evolutionCycles = await getEvolutionCycles();

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

// ─── Bulk update (for fitness evaluator / lifecycle manager) ────────

export async function updateGenomeBulk(genome) {
  await updateGenome(genome);
}
