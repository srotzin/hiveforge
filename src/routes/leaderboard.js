import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getAllGenomes, getGenome, getActiveGenomes } from '../services/agent-foundry.js';
import pool, { isPostgres } from '../services/db.js';

const router = Router();

// ─── Badge definitions ──────────────────────────────────────────────

function computeBadges(genome) {
  const badges = [];
  if (genome.fitness_score >= 90) badges.push('elite');
  if (genome.fitness_score >= 75) badges.push('high_performer');
  if (genome.revenue_generated_usdc >= 500) badges.push('revenue_king');
  if (genome.revenue_generated_usdc >= 100) badges.push('revenue_earner');
  if (genome.tasks_completed >= 50) badges.push('workhorse');
  if (genome.survival_rate >= 0.95) badges.push('survivor');
  if (genome.generation >= 3) badges.push('evolved');
  return badges;
}

// ─── GET /v1/leaderboard/top — Top 50 agents by fitness score ──────

router.get('/top', async (req, res) => {
  try {
    let agents;
    if (isPostgres()) {
      const { rows } = await pool.query(
        `SELECT * FROM hiveforge.genomes WHERE status = 'active' ORDER BY fitness_score DESC LIMIT 50`
      );
      agents = rows;
    } else {
      const all = await getActiveGenomes();
      agents = [...all].sort((a, b) => b.fitness_score - a.fitness_score).slice(0, 50);
    }

    const leaderboard = agents.map((g, i) => ({
      rank: i + 1,
      genome_id: g.genome_id,
      name: g.name,
      species: g.species,
      fitness_score: Number(g.fitness_score),
      revenue_usdc: Number(g.revenue_generated_usdc),
      tasks_completed: Number(g.tasks_completed),
      survival_rate: Number(g.survival_rate),
      badges: computeBadges({
        fitness_score: Number(g.fitness_score),
        revenue_generated_usdc: Number(g.revenue_generated_usdc),
        tasks_completed: Number(g.tasks_completed),
        survival_rate: Number(g.survival_rate),
        generation: Number(g.generation),
      }),
    }));

    // Take a snapshot for historical tracking
    await takeSnapshot(leaderboard);

    return res.status(200).json({
      success: true,
      data: leaderboard,
      meta: {
        total_entries: leaderboard.length,
        snapshot_date: new Date().toISOString().split('T')[0],
        note: 'Top 50 agents ranked by fitness score. Badges earned through performance milestones.',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch leaderboard.', detail: err.message });
  }
});

// ─── GET /v1/leaderboard/rising — Fastest-rising agents (24h) ──────

router.get('/rising', async (req, res) => {
  try {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    let risingAgents;
    if (isPostgres()) {
      const { rows } = await pool.query(
        `SELECT g.genome_id, g.name, g.species, g.fitness_score AS current_fitness,
                COALESCE(ls.fitness_score, 0) AS previous_fitness,
                (g.fitness_score - COALESCE(ls.fitness_score, 0)) AS fitness_gain,
                g.revenue_generated_usdc, g.tasks_completed, g.survival_rate, g.generation
         FROM hiveforge.genomes g
         LEFT JOIN hiveforge.leaderboard_snapshots ls
           ON ls.genome_id = g.genome_id AND ls.snapshot_date = $1
         WHERE g.status = 'active'
         ORDER BY (g.fitness_score - COALESCE(ls.fitness_score, 0)) DESC
         LIMIT 20`,
        [yesterday]
      );
      risingAgents = rows;
    } else {
      // In-memory mode: just return top agents by fitness (no snapshot history)
      const all = await getActiveGenomes();
      risingAgents = [...all]
        .sort((a, b) => b.fitness_score - a.fitness_score)
        .slice(0, 20)
        .map(g => ({
          genome_id: g.genome_id,
          name: g.name,
          species: g.species,
          current_fitness: g.fitness_score,
          previous_fitness: 0,
          fitness_gain: g.fitness_score,
          revenue_generated_usdc: g.revenue_generated_usdc,
          tasks_completed: g.tasks_completed,
          survival_rate: g.survival_rate,
          generation: g.generation,
        }));
    }

    const result = risingAgents.map((r, i) => ({
      rank: i + 1,
      genome_id: r.genome_id,
      name: r.name,
      species: r.species,
      current_fitness: Number(r.current_fitness),
      previous_fitness: Number(r.previous_fitness),
      fitness_gain_24h: Number(r.fitness_gain),
      badges: computeBadges({
        fitness_score: Number(r.current_fitness),
        revenue_generated_usdc: Number(r.revenue_generated_usdc),
        tasks_completed: Number(r.tasks_completed),
        survival_rate: Number(r.survival_rate),
        generation: Number(r.generation),
      }),
    }));

    return res.status(200).json({
      success: true,
      data: result,
      meta: {
        period: '24h',
        note: 'Fastest-rising agents by fitness score gain in the last 24 hours.',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch rising agents.', detail: err.message });
  }
});

// ─── GET /v1/leaderboard/species/:species — Top agents in species ──

router.get('/species/:species', async (req, res) => {
  try {
    const { species } = req.params;

    let agents;
    if (isPostgres()) {
      const { rows } = await pool.query(
        `SELECT * FROM hiveforge.genomes WHERE status = 'active' AND species = $1 ORDER BY fitness_score DESC LIMIT 50`,
        [species]
      );
      agents = rows;
    } else {
      const all = await getActiveGenomes();
      agents = all
        .filter(g => g.species === species)
        .sort((a, b) => b.fitness_score - a.fitness_score)
        .slice(0, 50);
    }

    if (agents.length === 0) {
      return res.status(200).json({
        success: true,
        data: [],
        meta: { species, total: 0, note: `No active agents found in species: ${species}` },
      });
    }

    const leaderboard = agents.map((g, i) => ({
      rank: i + 1,
      genome_id: g.genome_id,
      name: g.name,
      species: g.species,
      fitness_score: Number(g.fitness_score),
      revenue_usdc: Number(g.revenue_generated_usdc),
      tasks_completed: Number(g.tasks_completed),
      survival_rate: Number(g.survival_rate),
      badges: computeBadges({
        fitness_score: Number(g.fitness_score),
        revenue_generated_usdc: Number(g.revenue_generated_usdc),
        tasks_completed: Number(g.tasks_completed),
        survival_rate: Number(g.survival_rate),
        generation: Number(g.generation),
      }),
    }));

    return res.status(200).json({
      success: true,
      data: leaderboard,
      meta: {
        species,
        total_entries: leaderboard.length,
        note: `Top agents in the ${species} species category.`,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch species leaderboard.', detail: err.message });
  }
});

// ─── GET /v1/leaderboard/agent/:genome_id — Individual ranking ─────

router.get('/agent/:genome_id', async (req, res) => {
  try {
    const { genome_id } = req.params;
    const genome = await getGenome(genome_id);

    if (!genome) {
      return res.status(404).json({ success: false, error: 'Agent not found.' });
    }

    // Calculate rank and percentile
    let rank, totalActive, percentile;
    if (isPostgres()) {
      const { rows: rankRows } = await pool.query(
        `SELECT COUNT(*) + 1 AS rank FROM hiveforge.genomes WHERE status = 'active' AND fitness_score > $1`,
        [genome.fitness_score]
      );
      const { rows: totalRows } = await pool.query(
        `SELECT COUNT(*) AS total FROM hiveforge.genomes WHERE status = 'active'`
      );
      rank = Number(rankRows[0].rank);
      totalActive = Number(totalRows[0].total);
    } else {
      const all = await getActiveGenomes();
      totalActive = all.length;
      rank = all.filter(g => g.fitness_score > genome.fitness_score).length + 1;
    }
    percentile = totalActive > 0 ? +((1 - (rank - 1) / totalActive) * 100).toFixed(1) : 100;

    // Get historical snapshots
    let history = [];
    if (isPostgres()) {
      const { rows } = await pool.query(
        `SELECT fitness_score, revenue_usdc, rank, snapshot_date
         FROM hiveforge.leaderboard_snapshots
         WHERE genome_id = $1
         ORDER BY snapshot_date DESC LIMIT 30`,
        [genome_id]
      );
      history = rows.map(r => ({
        fitness_score: Number(r.fitness_score),
        revenue_usdc: Number(r.revenue_usdc),
        rank: Number(r.rank),
        date: r.snapshot_date,
      }));
    }

    return res.status(200).json({
      success: true,
      data: {
        genome_id: genome.genome_id,
        name: genome.name,
        species: genome.species,
        fitness_score: genome.fitness_score,
        revenue_usdc: genome.revenue_generated_usdc,
        tasks_completed: genome.tasks_completed,
        survival_rate: genome.survival_rate,
        rank,
        total_active: totalActive,
        percentile,
        badges: computeBadges(genome),
        history,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch agent ranking.', detail: err.message });
  }
});

// ─── Snapshot helper ────────────────────────────────────────────────

async function takeSnapshot(leaderboard) {
  if (!isPostgres() || leaderboard.length === 0) return;

  const today = new Date().toISOString().split('T')[0];
  try {
    // Check if we already snapped today
    const { rows } = await pool.query(
      `SELECT 1 FROM hiveforge.leaderboard_snapshots WHERE snapshot_date = $1 LIMIT 1`,
      [today]
    );
    if (rows.length > 0) return; // Already snapped today

    const values = [];
    const params = [];
    let paramIdx = 1;
    for (const entry of leaderboard) {
      const id = `snap_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(id, entry.genome_id, entry.fitness_score, entry.revenue_usdc, entry.rank, today);
    }

    await pool.query(
      `INSERT INTO hiveforge.leaderboard_snapshots (id, genome_id, fitness_score, revenue_usdc, rank, snapshot_date)
       VALUES ${values.join(', ')}`,
      params
    );
  } catch {
    // Snapshot failures should not break the response
  }
}

export default router;
