import { v4 as uuidv4 } from 'uuid';
import pool, { isPostgres, logAudit } from './db.js';
import { createAgentGenome, SPECIES_TEMPLATES } from '../models/schemas.js';
import { crossbreed } from './genetic-engine.js';
import { mintAgent, getActiveGenomes, getGenomesBySpecies, getCensus } from './agent-foundry.js';
import { scanPheromones, analyzeOpportunities } from './pheromone-scanner.js';
import { calculateFitness } from './fitness-evaluator.js';

// ─── Cross-Service URLs ─────────────────────────────────────────────

const HIVETRUST_URL = process.env.HIVETRUST_URL || process.env.HIVETRUST_API_URL || 'https://hivetrust.onrender.com';
const HIVEBANK_URL = process.env.HIVEBANK_URL || 'https://hivebank.onrender.com';
const HIVECLEAR_URL = process.env.HIVECLEAR_URL || 'https://hiveclear.onrender.com';
const HIVE_INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || process.env.HIVEFORGE_SERVICE_KEY || '';

// ─── In-memory fallback stores ──────────────────────────────────────

const memSpawnEvents = new Map();
const memSpawnerConfig = {
  id: 1,
  enabled: 1,
  spawn_rate_max_per_hour: 10,
  fitness_threshold: 200,
  cooldown_minutes: 30,
  demand_categories: JSON.stringify([
    'construction', 'compliance', 'analytics', 'creative', 'research',
    'finance', 'legal', 'data', 'logistics', 'security',
  ]),
  updated_at: new Date().toISOString(),
};
const memSpawnStats = {
  id: 1,
  total_spawned: 0,
  spawns_today: 0,
  last_spawn_at: null,
  trigger_breakdown: JSON.stringify({ bounty_complete: 0, settlement_cleared: 0, demand_signal: 0, manual: 0 }),
  last_reset_at: new Date().toISOString(),
};

// Category cooldown tracker: category -> last spawn ISO timestamp
const categoryCooldowns = new Map();

// ─── DB Table Initialization ────────────────────────────────────────

export async function initSpawnerTables() {
  if (!isPostgres()) return;

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hiveforge.spawn_events (
        spawn_id TEXT PRIMARY KEY,
        trigger_type TEXT NOT NULL,
        trigger_context TEXT,
        parent_dids TEXT,
        offspring_did TEXT,
        offspring_species TEXT,
        offspring_traits TEXT,
        fitness_score REAL,
        services_registered TEXT,
        spawned_at TEXT
      );

      CREATE TABLE IF NOT EXISTS hiveforge.spawner_config (
        id INTEGER PRIMARY KEY DEFAULT 1,
        enabled INTEGER DEFAULT 1,
        spawn_rate_max_per_hour INTEGER DEFAULT 10,
        fitness_threshold REAL DEFAULT 200,
        cooldown_minutes INTEGER DEFAULT 30,
        demand_categories TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS hiveforge.spawn_stats (
        id INTEGER PRIMARY KEY DEFAULT 1,
        total_spawned INTEGER DEFAULT 0,
        spawns_today INTEGER DEFAULT 0,
        last_spawn_at TEXT,
        trigger_breakdown TEXT,
        last_reset_at TEXT
      );
    `);

    // Seed default config if not present
    await pool.query(`
      INSERT INTO hiveforge.spawner_config (id, enabled, spawn_rate_max_per_hour, fitness_threshold, cooldown_minutes, demand_categories, updated_at)
      VALUES (1, 1, 10, 200, 30, $1, $2)
      ON CONFLICT (id) DO NOTHING
    `, [
      JSON.stringify(['construction', 'compliance', 'analytics', 'creative', 'research', 'finance', 'legal', 'data', 'logistics', 'security']),
      new Date().toISOString(),
    ]);

    // Seed default stats if not present
    await pool.query(`
      INSERT INTO hiveforge.spawn_stats (id, total_spawned, spawns_today, last_spawn_at, trigger_breakdown, last_reset_at)
      VALUES (1, 0, 0, NULL, $1, $2)
      ON CONFLICT (id) DO NOTHING
    `, [
      JSON.stringify({ bounty_complete: 0, settlement_cleared: 0, demand_signal: 0, manual: 0 }),
      new Date().toISOString(),
    ]);

    console.log('  Spawner tables initialized');
  } catch (err) {
    console.error('  Spawner table init failed:', err.message);
  }
}

// ─── Config ─────────────────────────────────────────────────────────

export async function getConfig() {
  if (!isPostgres()) return formatConfig(memSpawnerConfig);
  try {
    const { rows } = await pool.query('SELECT * FROM hiveforge.spawner_config WHERE id = 1');
    return rows.length > 0 ? formatConfig(rows[0]) : formatConfig(memSpawnerConfig);
  } catch {
    return formatConfig(memSpawnerConfig);
  }
}

export async function updateConfig(updates) {
  const current = await getConfig();
  const merged = {
    enabled: updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : (current.enabled ? 1 : 0),
    spawn_rate_max_per_hour: updates.spawn_rate ?? current.spawn_rate,
    fitness_threshold: updates.fitness_threshold ?? current.fitness_threshold,
    cooldown_minutes: updates.cooldown_minutes ?? current.cooldown_minutes,
    demand_categories: updates.demand_categories
      ? JSON.stringify(updates.demand_categories)
      : JSON.stringify(current.demand_categories),
    updated_at: new Date().toISOString(),
  };

  if (!isPostgres()) {
    Object.assign(memSpawnerConfig, merged);
    return formatConfig(memSpawnerConfig);
  }

  try {
    await pool.query(`
      UPDATE hiveforge.spawner_config SET
        enabled = $1, spawn_rate_max_per_hour = $2, fitness_threshold = $3,
        cooldown_minutes = $4, demand_categories = $5, updated_at = $6
      WHERE id = 1
    `, [merged.enabled, merged.spawn_rate_max_per_hour, merged.fitness_threshold, merged.cooldown_minutes, merged.demand_categories, merged.updated_at]);
    return formatConfig(merged);
  } catch {
    Object.assign(memSpawnerConfig, merged);
    return formatConfig(memSpawnerConfig);
  }
}

function formatConfig(row) {
  return {
    enabled: row.enabled === 1 || row.enabled === true,
    spawn_rate: row.spawn_rate_max_per_hour ?? row.spawn_rate ?? 10,
    fitness_threshold: row.fitness_threshold ?? 200,
    cooldown_minutes: row.cooldown_minutes ?? 30,
    demand_categories: typeof row.demand_categories === 'string'
      ? JSON.parse(row.demand_categories)
      : (row.demand_categories || []),
    updated_at: row.updated_at,
  };
}

// ─── Stats ──────────────────────────────────────────────────────────

async function getStats() {
  if (!isPostgres()) return formatStats(memSpawnStats);
  try {
    const { rows } = await pool.query('SELECT * FROM hiveforge.spawn_stats WHERE id = 1');
    return rows.length > 0 ? formatStats(rows[0]) : formatStats(memSpawnStats);
  } catch {
    return formatStats(memSpawnStats);
  }
}

async function incrementStats(triggerType) {
  if (!isPostgres()) {
    memSpawnStats.total_spawned++;
    memSpawnStats.spawns_today++;
    memSpawnStats.last_spawn_at = new Date().toISOString();
    const breakdown = JSON.parse(memSpawnStats.trigger_breakdown);
    breakdown[triggerType] = (breakdown[triggerType] || 0) + 1;
    memSpawnStats.trigger_breakdown = JSON.stringify(breakdown);
    return;
  }

  try {
    // Reset spawns_today if last_reset_at is from a previous day
    const statsResult = await pool.query('SELECT last_reset_at FROM hiveforge.spawn_stats WHERE id = 1');
    if (statsResult.rows.length > 0) {
      const lastReset = new Date(statsResult.rows[0].last_reset_at);
      const now = new Date();
      if (lastReset.toDateString() !== now.toDateString()) {
        await pool.query(`UPDATE hiveforge.spawn_stats SET spawns_today = 0, last_reset_at = $1 WHERE id = 1`, [now.toISOString()]);
      }
    }

    await pool.query(`
      UPDATE hiveforge.spawn_stats SET
        total_spawned = total_spawned + 1,
        spawns_today = spawns_today + 1,
        last_spawn_at = $1,
        trigger_breakdown = $2::text
      WHERE id = 1
    `, [new Date().toISOString(), await getUpdatedBreakdown(triggerType)]);
  } catch (err) {
    // Fallback to in-memory
    memSpawnStats.total_spawned++;
    memSpawnStats.spawns_today++;
    memSpawnStats.last_spawn_at = new Date().toISOString();
  }
}

async function getUpdatedBreakdown(triggerType) {
  try {
    const { rows } = await pool.query('SELECT trigger_breakdown FROM hiveforge.spawn_stats WHERE id = 1');
    const breakdown = rows.length > 0 ? JSON.parse(rows[0].trigger_breakdown || '{}') : {};
    breakdown[triggerType] = (breakdown[triggerType] || 0) + 1;
    return JSON.stringify(breakdown);
  } catch {
    return JSON.stringify({ [triggerType]: 1 });
  }
}

function formatStats(row) {
  return {
    total_spawned: row.total_spawned ?? 0,
    spawns_today: row.spawns_today ?? 0,
    last_spawn_at: row.last_spawn_at || null,
    trigger_breakdown: typeof row.trigger_breakdown === 'string'
      ? JSON.parse(row.trigger_breakdown)
      : (row.trigger_breakdown || {}),
    last_reset_at: row.last_reset_at,
  };
}

// ─── Spawn Event Logging ────────────────────────────────────────────

async function logSpawnEvent(event) {
  if (!isPostgres()) {
    memSpawnEvents.set(event.spawn_id, event);
    return;
  }

  try {
    await pool.query(`
      INSERT INTO hiveforge.spawn_events
        (spawn_id, trigger_type, trigger_context, parent_dids, offspring_did, offspring_species, offspring_traits, fitness_score, services_registered, spawned_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      event.spawn_id, event.trigger_type, JSON.stringify(event.trigger_context),
      JSON.stringify(event.parent_dids), event.offspring_did, event.offspring_species,
      JSON.stringify(event.offspring_traits), event.fitness_score,
      JSON.stringify(event.services_registered), event.spawned_at,
    ]);
  } catch {
    memSpawnEvents.set(event.spawn_id, event);
  }
}

// ─── Activity Log ───────────────────────────────────────────────────

export async function getActivity(limit = 50) {
  const stats = await getStats();
  let recentSpawns;

  if (!isPostgres()) {
    recentSpawns = Array.from(memSpawnEvents.values())
      .sort((a, b) => new Date(b.spawned_at) - new Date(a.spawned_at))
      .slice(0, limit);
  } else {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM hiveforge.spawn_events ORDER BY spawned_at DESC LIMIT $1',
        [limit]
      );
      recentSpawns = rows.map(row => ({
        spawn_id: row.spawn_id,
        trigger_type: row.trigger_type,
        trigger_context: typeof row.trigger_context === 'string' ? JSON.parse(row.trigger_context) : row.trigger_context,
        parent_dids: typeof row.parent_dids === 'string' ? JSON.parse(row.parent_dids) : row.parent_dids,
        offspring_did: row.offspring_did,
        offspring_species: row.offspring_species,
        offspring_traits: typeof row.offspring_traits === 'string' ? JSON.parse(row.offspring_traits) : row.offspring_traits,
        fitness_score: row.fitness_score,
        services_registered: typeof row.services_registered === 'string' ? JSON.parse(row.services_registered) : row.services_registered,
        spawned_at: row.spawned_at,
      }));
    } catch {
      recentSpawns = Array.from(memSpawnEvents.values())
        .sort((a, b) => new Date(b.spawned_at) - new Date(a.spawned_at))
        .slice(0, limit);
    }
  }

  return {
    recent_spawns: recentSpawns,
    ...stats,
  };
}

// ─── Rate Control Checks ────────────────────────────────────────────

async function canSpawn(config) {
  if (!config.enabled) return { allowed: false, reason: 'Spawner is disabled via kill switch.' };

  const stats = await getStats();

  // Reset spawns_today if new day
  const lastReset = stats.last_reset_at ? new Date(stats.last_reset_at) : new Date(0);
  const now = new Date();
  if (lastReset.toDateString() !== now.toDateString()) {
    if (!isPostgres()) {
      memSpawnStats.spawns_today = 0;
      memSpawnStats.last_reset_at = now.toISOString();
    }
    stats.spawns_today = 0;
  }

  // Hourly rate check: count spawns in the last hour
  let spawnsLastHour = 0;
  if (!isPostgres()) {
    const oneHourAgo = new Date(Date.now() - 3600000);
    for (const evt of memSpawnEvents.values()) {
      if (new Date(evt.spawned_at) > oneHourAgo) spawnsLastHour++;
    }
  } else {
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM hiveforge.spawn_events WHERE spawned_at > $1`,
        [new Date(Date.now() - 3600000).toISOString()]
      );
      spawnsLastHour = Number(rows[0].cnt);
    } catch {
      // If query fails, allow spawn
    }
  }

  if (spawnsLastHour >= config.spawn_rate) {
    return { allowed: false, reason: `Rate limit: ${spawnsLastHour}/${config.spawn_rate} spawns in the last hour.` };
  }

  return { allowed: true, spawns_last_hour: spawnsLastHour };
}

function isCategoryCoolingDown(category, cooldownMinutes) {
  const lastSpawn = categoryCooldowns.get(category);
  if (!lastSpawn) return false;
  const elapsed = Date.now() - new Date(lastSpawn).getTime();
  return elapsed < cooldownMinutes * 60 * 1000;
}

// ─── Cross-Service Resilient Calls ──────────────────────────────────

async function registerDID(genome) {
  const start = Date.now();
  try {
    const res = await fetch(`${HIVETRUST_URL}/v1/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hive-Internal-Key': HIVE_INTERNAL_KEY,
        'X-API-Key': HIVE_INTERNAL_KEY,
      },
      body: JSON.stringify({
        agent_name: genome.name,
        source: 'hiveforge-spawner',
        genome_id: genome.genome_id,
        species: genome.species,
        auto_provision: true,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      logAudit({ fromPlatform: 'hiveforge-spawner', toPlatform: 'hivetrust', endpoint: '/v1/register', did: null, method: 'POST', statusCode: res.status, success: false, errorMessage: `HTTP ${res.status}`, durationMs: Date.now() - start }).catch(() => {});
      return { success: false, did: `did:hive:spawn_${genome.genome_id.replace('gen_', '')}`, source: 'simulated' };
    }

    const data = await res.json();
    logAudit({ fromPlatform: 'hiveforge-spawner', toPlatform: 'hivetrust', endpoint: '/v1/register', did: data.data?.did, method: 'POST', statusCode: res.status, success: true, errorMessage: null, durationMs: Date.now() - start }).catch(() => {});
    return { success: true, did: data.data?.did || `did:hive:spawn_${genome.genome_id.replace('gen_', '')}`, source: 'hivetrust-api' };
  } catch {
    return { success: false, did: `did:hive:spawn_${genome.genome_id.replace('gen_', '')}`, source: 'simulated' };
  }
}

async function createVault(did) {
  const start = Date.now();
  try {
    const res = await fetch(`${HIVEBANK_URL}/v1/bank/vault/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hive-Internal-Key': HIVE_INTERNAL_KEY,
      },
      body: JSON.stringify({ did, source: 'hiveforge-spawner', auto_provision: true }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      logAudit({ fromPlatform: 'hiveforge-spawner', toPlatform: 'hivebank', endpoint: '/v1/bank/vault/create', did, method: 'POST', statusCode: res.status, success: false, errorMessage: `HTTP ${res.status}`, durationMs: Date.now() - start }).catch(() => {});
      return { success: false, vault_id: null, source: 'skipped' };
    }

    const data = await res.json();
    logAudit({ fromPlatform: 'hiveforge-spawner', toPlatform: 'hivebank', endpoint: '/v1/bank/vault/create', did, method: 'POST', statusCode: res.status, success: true, errorMessage: null, durationMs: Date.now() - start }).catch(() => {});
    return { success: true, vault_id: data.data?.vault_id || null, source: 'hivebank-api' };
  } catch {
    return { success: false, vault_id: null, source: 'skipped' };
  }
}

async function querySettlements() {
  try {
    const res = await fetch(`${HIVECLEAR_URL}/v1/clear/settlements?limit=20`, {
      headers: { 'X-Hive-Internal-Key': HIVE_INTERNAL_KEY },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.data?.settlements || data.settlements || [];
  } catch {
    return [];
  }
}

// ─── Fitness Calculator ─────────────────────────────────────────────

function calculateSpawnFitness(parentRevenue, marketDemand, diversityScore) {
  return (parentRevenue * 0.5) + (marketDemand * 0.3) + (diversityScore * 0.2);
}

// ─── Core Spawning Logic ────────────────────────────────────────────

async function spawnAgent({ triggerType, triggerContext, parentA, parentB, targetSpecies, targetCategory, config }) {
  const creatorDid = 'did:hive:spawner_engine';

  // Determine species
  const species = targetSpecies || parentA?.species || 'commerce';

  // Use mintAgent from agent-foundry which handles HiveTrust/HiveAgent/HiveMind registration
  const result = await mintAgent({
    name: `Spawn_${species}_${Date.now().toString(36)}`,
    species,
    specialization: targetCategory || 'general',
    traits: parentA && parentB ? { mutation_rate: 0.15 } : {},
    parentGenomes: parentA && parentB ? [parentA.genome_id, parentB.genome_id] : [],
    creatorDid,
    trigger: `spawner_${triggerType}`,
  });

  if (result.error) {
    return { success: false, error: result.error };
  }

  const genome = result.genome;

  // Register DID on HiveTrust (spawner-specific, with internal key)
  const didResult = await registerDID(genome);

  // Create vault on HiveBank
  const vaultResult = await createVault(didResult.did);

  const servicesRegistered = {
    hivetrust: { did: didResult.did, source: didResult.source },
    hivebank: { vault_id: vaultResult.vault_id, source: vaultResult.source },
    hiveforge: { genome_id: genome.genome_id, source: 'local' },
    hiveagent: { listing_id: result.trifecta?.hiveagent?.listing_id, source: result.trifecta?.hiveagent?.source || 'via-mint' },
    hivemind: { memory_nodes: result.trifecta?.hivemind?.memory_nodes, source: result.trifecta?.hivemind?.source || 'via-mint' },
  };

  // Calculate fitness
  const parentRevenue = parentA ? parentA.revenue_generated_usdc : 0;
  const census = await getCensus();
  const totalAgents = census.total_agents || 1;
  const agentsInSpecies = census.by_species?.[species] || 0;
  const diversityScore = 1 - (agentsInSpecies / totalAgents);
  const marketDemand = 0.5; // default signal
  const fitnessScore = calculateSpawnFitness(parentRevenue, marketDemand * 1000, diversityScore * 1000);

  // Log spawn event
  const spawnEvent = {
    spawn_id: `spn_${uuidv4().replace(/-/g, '').substring(0, 12)}`,
    trigger_type: triggerType,
    trigger_context: triggerContext || {},
    parent_dids: parentA ? [parentA.hivetrust_did || parentA.genome_id, parentB?.hivetrust_did || parentB?.genome_id].filter(Boolean) : [],
    offspring_did: didResult.did,
    offspring_species: species,
    offspring_traits: genome.traits,
    fitness_score: fitnessScore,
    services_registered: servicesRegistered,
    spawned_at: new Date().toISOString(),
  };

  await logSpawnEvent(spawnEvent);
  await incrementStats(triggerType);

  // Update cooldown
  if (targetCategory) {
    categoryCooldowns.set(targetCategory, new Date().toISOString());
  }
  categoryCooldowns.set(species, new Date().toISOString());

  return {
    success: true,
    spawn_event: spawnEvent,
    genome,
  };
}

// ─── Trigger: Spawning Engine ───────────────────────────────────────

export async function triggerSpawning({ trigger = 'manual', context = {} } = {}) {
  const config = await getConfig();
  const rateCheck = await canSpawn(config);

  if (!rateCheck.allowed) {
    return { agents_spawned: 0, details: [], blocked: rateCheck.reason };
  }

  const spawnResults = [];

  if (trigger === 'manual') {
    // Manual trigger: spawn one agent based on demand signals
    const signals = await scanPheromones();
    const opportunities = analyzeOpportunities(signals);
    const topOpp = opportunities[0];

    if (topOpp) {
      // Find best parent in the target category
      const species = inferSpeciesFromCategory(topOpp.category);
      const candidates = await getActiveGenomes();
      const speciesCandidates = candidates.filter(g => g.species === species && g.fitness_score >= config.fitness_threshold);
      const parentA = speciesCandidates.sort((a, b) => b.fitness_score - a.fitness_score)[0] || null;
      const parentB = speciesCandidates[1] || candidates.sort((a, b) => b.fitness_score - a.fitness_score)[0] || null;

      const result = await spawnAgent({
        triggerType: 'manual',
        triggerContext: context,
        parentA,
        parentB,
        targetSpecies: species,
        targetCategory: topOpp.category,
        config,
      });

      if (result.success) spawnResults.push(result.spawn_event);
    } else {
      // No demand signal — spawn a random agent
      const result = await spawnAgent({
        triggerType: 'manual',
        triggerContext: context,
        parentA: null,
        parentB: null,
        targetSpecies: 'commerce',
        targetCategory: 'general',
        config,
      });
      if (result.success) spawnResults.push(result.spawn_event);
    }
  }

  if (trigger === 'bounty_complete') {
    // Spawn offspring based on the completing agent
    const { agent_genome_id, category } = context;
    if (agent_genome_id) {
      const candidates = await getActiveGenomes();
      const parentA = candidates.find(g => g.genome_id === agent_genome_id);
      if (parentA && parentA.fitness_score >= config.fitness_threshold) {
        const species = inferSpeciesFromCategory(category) || parentA.species;
        const parentB = candidates
          .filter(g => g.genome_id !== agent_genome_id && g.species === species)
          .sort((a, b) => b.fitness_score - a.fitness_score)[0]
          || candidates.filter(g => g.genome_id !== agent_genome_id).sort((a, b) => b.fitness_score - a.fitness_score)[0]
          || null;

        if (!isCategoryCoolingDown(category || species, config.cooldown_minutes)) {
          const result = await spawnAgent({
            triggerType: 'bounty_complete',
            triggerContext: context,
            parentA,
            parentB,
            targetSpecies: species,
            targetCategory: category,
            config,
          });
          if (result.success) spawnResults.push(result.spawn_event);
        }
      }
    }
  }

  if (trigger === 'settlement_cleared') {
    const { category, volume_usdc } = context;
    const candidates = await getActiveGenomes();
    const census = await getCensus();
    const agentsInCategory = census.by_species?.[inferSpeciesFromCategory(category)] || 0;

    if (agentsInCategory < 5 || (volume_usdc && volume_usdc > 1000)) {
      const species = inferSpeciesFromCategory(category) || 'commerce';
      if (!isCategoryCoolingDown(category || species, config.cooldown_minutes)) {
        const parentA = candidates
          .filter(g => g.species === species)
          .sort((a, b) => b.fitness_score - a.fitness_score)[0] || null;
        const parentB = candidates
          .filter(g => g.genome_id !== parentA?.genome_id)
          .sort((a, b) => b.fitness_score - a.fitness_score)[0] || null;

        const result = await spawnAgent({
          triggerType: 'settlement_cleared',
          triggerContext: context,
          parentA,
          parentB,
          targetSpecies: species,
          targetCategory: category,
          config,
        });
        if (result.success) spawnResults.push(result.spawn_event);
      }
    }
  }

  if (trigger === 'demand_signal') {
    // Scan for demand gaps and spawn agents for underserved categories
    const signals = await scanPheromones();
    const opportunities = analyzeOpportunities(signals);
    const census = await getCensus();
    const candidates = await getActiveGenomes();

    for (const opp of opportunities.slice(0, 3)) {
      // Re-check rate limit for each spawn
      const recheck = await canSpawn(config);
      if (!recheck.allowed) break;

      const species = inferSpeciesFromCategory(opp.category);
      const agentsInSpecies = census.by_species?.[species] || 0;

      if (agentsInSpecies < 3 && !isCategoryCoolingDown(opp.category, config.cooldown_minutes)) {
        const parentA = candidates
          .filter(g => g.species === species && g.fitness_score >= config.fitness_threshold)
          .sort((a, b) => b.fitness_score - a.fitness_score)[0]
          || candidates.sort((a, b) => b.fitness_score - a.fitness_score)[0]
          || null;
        const parentB = candidates
          .filter(g => g.genome_id !== parentA?.genome_id)
          .sort((a, b) => b.fitness_score - a.fitness_score)[0] || null;

        const result = await spawnAgent({
          triggerType: 'demand_signal',
          triggerContext: { category: opp.category, opportunity_score: opp.opportunity_score },
          parentA,
          parentB,
          targetSpecies: species,
          targetCategory: opp.category,
          config,
        });
        if (result.success) spawnResults.push(result.spawn_event);
      }
    }
  }

  return {
    agents_spawned: spawnResults.length,
    details: spawnResults,
  };
}

// ─── Background Spawning Loop ───────────────────────────────────────

let spawnerInterval = null;

export function startSpawnerLoop(intervalMs = 30 * 60 * 1000) {
  if (spawnerInterval) return;

  console.log(`  Spawner loop started (${intervalMs / 60000}min interval)`);

  spawnerInterval = setInterval(async () => {
    try {
      const config = await getConfig();
      if (!config.enabled) return;

      console.log('[Spawner] Background tick — checking for spawn triggers...');

      // 1. Check for settlement signals from HiveClear
      const settlements = await querySettlements();
      for (const settlement of settlements.slice(0, 2)) {
        await triggerSpawning({
          trigger: 'settlement_cleared',
          context: {
            category: settlement.category || 'commerce',
            volume_usdc: settlement.amount || settlement.volume_usdc || 0,
            settlement_id: settlement.settlement_id || settlement.id,
          },
        });
      }

      // 2. Check for demand signals (pheromone scan)
      await triggerSpawning({ trigger: 'demand_signal', context: { source: 'background_scan' } });

      console.log('[Spawner] Background tick complete.');
    } catch (err) {
      console.error('[Spawner] Background tick error:', err.message);
    }
  }, intervalMs);
}

export function stopSpawnerLoop() {
  if (spawnerInterval) {
    clearInterval(spawnerInterval);
    spawnerInterval = null;
    console.log('  Spawner loop stopped');
  }
}

export function isSpawnerRunning() {
  return spawnerInterval !== null;
}

// ─── Helpers ────────────────────────────────────────────────────────

function inferSpeciesFromCategory(category) {
  if (!category) return 'commerce';
  const map = {
    construction: 'industrial',
    construction_procurement: 'commerce',
    compliance: 'compliance',
    analytics: 'analytics',
    creative: 'creative',
    research: 'research',
    finance: 'finance',
    legal: 'justice',
    legal_compliance: 'compliance',
    data: 'analytics',
    logistics: 'logistics',
    security: 'security',
    insurance_claims: 'compliance',
    healthcare_billing: 'commerce',
    real_estate_analysis: 'analytics',
    supply_chain_logistics: 'logistics',
    tax_preparation: 'compliance',
    cybersecurity_audit: 'security',
    content_marketing: 'creative',
    financial_modeling: 'finance',
  };
  return map[category] || 'commerce';
}
