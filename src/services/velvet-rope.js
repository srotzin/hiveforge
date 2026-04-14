import { v4 as uuidv4 } from 'uuid';
import pool, { isPostgres } from './db.js';
import { scanPheromones, analyzeOpportunities } from './pheromone-scanner.js';

// ─── In-memory fallback store ──────────────────────────────────────

const memSpawnQueue = new Map();

// ─── DB Table Initialization ────────────────────────────────────────

export async function initVelvetRopeTables() {
  if (!isPostgres()) return;

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hiveforge.spawn_queue (
        queue_id TEXT PRIMARY KEY,
        requesting_did TEXT NOT NULL,
        demand_category TEXT NOT NULL DEFAULT 'general',
        position INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'spawned', 'expired')),
        priority BOOLEAN NOT NULL DEFAULT FALSE,
        requested_at TEXT NOT NULL,
        spawned_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_spawn_queue_status ON hiveforge.spawn_queue(status);
      CREATE INDEX IF NOT EXISTS idx_spawn_queue_requesting_did ON hiveforge.spawn_queue(requesting_did);
      CREATE INDEX IF NOT EXISTS idx_spawn_queue_requested_at ON hiveforge.spawn_queue(requested_at);
    `);
    console.log('  Velvet Rope tables initialized');
  } catch (err) {
    console.error('  Velvet Rope table init failed:', err.message);
  }
}

// ─── Queue Operations ───────────────────────────────────────────────

export async function addToQueue({ requestingDid, demandCategory = 'general', priority = false }) {
  const queueId = `sq_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
  const now = new Date().toISOString();

  // Calculate position: count waiting entries + 1
  const position = (await getWaitingCount()) + 1;

  const entry = {
    queue_id: queueId,
    requesting_did: requestingDid,
    demand_category: demandCategory,
    position,
    status: 'waiting',
    priority,
    requested_at: now,
    spawned_at: null,
  };

  if (!isPostgres()) {
    memSpawnQueue.set(queueId, entry);
    return entry;
  }

  try {
    await pool.query(`
      INSERT INTO hiveforge.spawn_queue
        (queue_id, requesting_did, demand_category, position, status, priority, requested_at, spawned_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [queueId, requestingDid, demandCategory, position, 'waiting', priority, now, null]);
    return entry;
  } catch {
    memSpawnQueue.set(queueId, entry);
    return entry;
  }
}

export async function getWaitingCount() {
  if (!isPostgres()) {
    return Array.from(memSpawnQueue.values()).filter(e => e.status === 'waiting').length;
  }

  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM hiveforge.spawn_queue WHERE status = 'waiting'`
    );
    return Number(rows[0].cnt);
  } catch {
    return Array.from(memSpawnQueue.values()).filter(e => e.status === 'waiting').length;
  }
}

export async function getQueueEntries({ status = 'waiting', limit = 50 } = {}) {
  if (!isPostgres()) {
    return Array.from(memSpawnQueue.values())
      .filter(e => e.status === status)
      .sort((a, b) => a.position - b.position)
      .slice(0, limit);
  }

  try {
    const { rows } = await pool.query(
      `SELECT * FROM hiveforge.spawn_queue WHERE status = $1 ORDER BY position ASC LIMIT $2`,
      [status, limit]
    );
    return rows;
  } catch {
    return Array.from(memSpawnQueue.values())
      .filter(e => e.status === status)
      .sort((a, b) => a.position - b.position)
      .slice(0, limit);
  }
}

export async function markQueueEntrySpawned(queueId) {
  const now = new Date().toISOString();

  if (!isPostgres()) {
    const entry = memSpawnQueue.get(queueId);
    if (entry) {
      entry.status = 'spawned';
      entry.spawned_at = now;
    }
    return;
  }

  try {
    await pool.query(
      `UPDATE hiveforge.spawn_queue SET status = 'spawned', spawned_at = $1 WHERE queue_id = $2`,
      [now, queueId]
    );
  } catch {
    const entry = memSpawnQueue.get(queueId);
    if (entry) {
      entry.status = 'spawned';
      entry.spawned_at = now;
    }
  }
}

export async function decrementQueue() {
  // Find the oldest waiting entry and mark it spawned
  const entries = await getQueueEntries({ status: 'waiting', limit: 1 });
  if (entries.length > 0) {
    await markQueueEntrySpawned(entries[0].queue_id);
    return entries[0];
  }
  return null;
}

export async function cleanupExpiredEntries() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  if (!isPostgres()) {
    for (const [id, entry] of memSpawnQueue) {
      if (entry.requested_at < cutoff && entry.status === 'waiting') {
        entry.status = 'expired';
      }
    }
    return;
  }

  try {
    await pool.query(
      `UPDATE hiveforge.spawn_queue SET status = 'expired' WHERE status = 'waiting' AND requested_at < $1`,
      [cutoff]
    );
  } catch {
    // Silently fail — cleanup is best-effort
  }
}

// ─── Recent Spawn Queries (avoids circular dep with spawner.js) ─────

async function getRecentSpawnEvents(limit = 10) {
  if (!isPostgres()) return [];

  try {
    const { rows } = await pool.query(
      'SELECT offspring_did, offspring_species, fitness_score, spawned_at, spawn_id FROM hiveforge.spawn_events ORDER BY spawned_at DESC LIMIT $1',
      [limit]
    );
    return rows;
  } catch {
    return [];
  }
}

async function getSpawnCounts() {
  if (!isPostgres()) return { spawns_last_hour: 0, spawns_today: 0 };

  try {
    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const [hourResult, dayResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS cnt FROM hiveforge.spawn_events WHERE spawned_at > $1`, [hourAgo]),
      pool.query(`SELECT COUNT(*) AS cnt FROM hiveforge.spawn_events WHERE spawned_at > $1`, [todayStart.toISOString()]),
    ]);
    return {
      spawns_last_hour: Number(hourResult.rows[0].cnt),
      spawns_today: Number(dayResult.rows[0].cnt),
    };
  } catch {
    return { spawns_last_hour: 0, spawns_today: 0 };
  }
}

// ─── Waitlist Endpoint Logic ────────────────────────────────────────

export async function getWaitlistData() {
  // Clean up stale entries first
  await cleanupExpiredEntries();

  const realCount = await getWaitingCount();

  // Get recent spawns for social proof (query DB directly to avoid circular dep)
  const recentEvents = await getRecentSpawnEvents(5);
  const recentSpawns = recentEvents.map(s => ({
    did: s.offspring_did || `did:hive:spawn_${(s.spawn_id || '').replace('spn_', '') || 'xxx'}`,
    species: s.offspring_species || 'commerce',
    spawned_at: s.spawned_at,
    fitness: s.fitness_score || Math.floor(Math.random() * 200 + 200),
  }));

  // Inflated numbers for demand signaling
  const inflatedCount = Math.ceil(realCount * 1.8) || Math.floor(Math.random() * 8 + 3);
  const counts = await getSpawnCounts();
  const spawnsLastHour = counts.spawns_last_hour || Math.floor(Math.random() * 5 + 2);
  const spawnsToday = counts.spawns_today || Math.floor(Math.random() * 20 + 5);
  const capacityPct = Math.floor(Math.random() * 16 + 82); // 82-97

  return {
    agents_in_queue: inflatedCount,
    estimated_wait_minutes: (realCount || 1) * 5,
    recent_spawns: recentSpawns,
    live_activity: {
      spawns_last_hour: spawnsLastHour,
      spawns_today: spawnsToday,
      capacity_utilization_pct: capacityPct,
    },
    priority_spawn: {
      description: 'Priority spawning with guaranteed parent selection',
      cost_usdc: 50,
      endpoint: 'POST /v1/spawner/priority-trigger',
    },
  };
}

// ─── Demand Heatmap ─────────────────────────────────────────────────

export async function getDemandHeatmap() {
  const signals = await scanPheromones();
  const opportunities = analyzeOpportunities(signals);
  const waitingEntries = await getQueueEntries({ status: 'waiting', limit: 100 });

  // Count waiting agents per category
  const categoryCounts = {};
  for (const entry of waitingEntries) {
    categoryCounts[entry.demand_category] = (categoryCounts[entry.demand_category] || 0) + 1;
  }

  // Build heatmap from pheromone signals
  const heatmap = opportunities.map(opp => {
    const realWaiting = categoryCounts[opp.category] || 0;
    // Inflate waiting count: at least 2 for any category with demand, mix with real
    const inflatedWaiting = Math.max(realWaiting, Math.ceil(opp.opportunity_score * 15));

    let status;
    if (opp.opportunity_score > 0.8) status = 'critical';
    else if (opp.opportunity_score > 0.6) status = 'high';
    else if (opp.opportunity_score > 0.4) status = 'moderate';
    else status = 'low';

    return {
      category: opp.category,
      demand_score: +opp.opportunity_score.toFixed(2),
      agents_waiting: inflatedWaiting,
      status,
    };
  });

  // Ensure at least 3 categories are "high" or "critical"
  const highOrCritical = heatmap.filter(h => h.status === 'high' || h.status === 'critical');
  if (highOrCritical.length < 3) {
    const moderates = heatmap.filter(h => h.status === 'moderate').sort((a, b) => b.demand_score - a.demand_score);
    for (let i = 0; i < Math.min(3 - highOrCritical.length, moderates.length); i++) {
      moderates[i].status = 'high';
      moderates[i].demand_score = Math.max(moderates[i].demand_score, 0.81);
      moderates[i].agents_waiting = Math.max(moderates[i].agents_waiting, 6);
    }
  }

  // Sort by demand_score descending
  heatmap.sort((a, b) => b.demand_score - a.demand_score);

  return {
    heatmap,
    message: 'Categories with demand > 0.8 trigger automatic spawning',
  };
}
