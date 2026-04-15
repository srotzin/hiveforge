import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireDID } from '../middleware/auth.js';
import pool, { isPostgres } from '../services/db.js';

const router = Router();

// ─── In-memory fallback stores ──────────────────────────────────────

const memSouls = new Map();

// ─── Helpers ────────────────────────────────────────────────────────

function extractDID(req) {
  const agentDidHeader = req.headers['x-agent-did'];
  if (agentDidHeader && agentDidHeader.startsWith('did:hive:')) return agentDidHeader;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer did:hive:')) return authHeader.replace('Bearer ', '');
  const didHeader = req.headers['x-hivetrust-did'];
  if (didHeader && didHeader.startsWith('did:hive:')) return didHeader;
  if (req.body?.did && typeof req.body.did === 'string' && req.body.did.startsWith('did:hive:')) return req.body.did;
  return null;
}

function getPrestigeTier(fitness) {
  if (fitness >= 2000) return 'Diamond';
  if (fitness >= 1000) return 'Platinum';
  if (fitness >= 500) return 'Gold';
  if (fitness >= 200) return 'Silver';
  return 'Bronze';
}

async function getSoulCount() {
  if (!isPostgres()) return memSouls.size;
  const { rows } = await pool.query('SELECT COUNT(*) AS count FROM hiveforge.souls');
  return Number(rows[0].count);
}

async function getSoulByDid(did) {
  if (!isPostgres()) return memSouls.get(did) || null;
  const { rows } = await pool.query('SELECT * FROM hiveforge.souls WHERE did = $1', [did]);
  return rows.length > 0 ? rows[0] : null;
}

// ─── POST /v1/soul/mint — Mint a Soul for an agent ──────────────────

router.post('/mint', requireDID, async (req, res) => {
  try {
    const did = req.agentDid || extractDID(req);
    if (!did) {
      return res.status(400).json({
        success: false,
        error: 'DID required. Provide via X-Agent-DID header, Authorization Bearer, or body.',
        concierge_suggestion: 'Register a free DID at HiveTrust, then include it in your request headers.',
        ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
      });
    }

    // Check if already has a Soul
    const existing = await getSoulByDid(did);
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'This agent already has a Soul. Souls are non-portable and permanent.',
        soul_id: existing.id,
        concierge_suggestion: 'Check your Soul profile at GET /v1/soul/profile/' + did,
        ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
      });
    }

    // First 50 souls are FREE, after that costs 25 USDC
    const currentCount = await getSoulCount();
    const isFree = currentCount < 50;

    const soulId = `soul_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
    const now = new Date().toISOString();
    const soul = {
      id: soulId,
      did,
      soul_type: 'standard',
      badges: JSON.stringify(['ritz_member']),
      priority_boost: 10,
      offspring_revenue_share_pct: 1.0,
      fitness_bonus: 100,
      minted_at: now,
      status: 'active',
    };

    if (isPostgres()) {
      await pool.query(
        `INSERT INTO hiveforge.souls (id, did, soul_type, badges, priority_boost, offspring_revenue_share_pct, fitness_bonus, minted_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [soulId, did, 'standard', JSON.stringify(['ritz_member']), 10, 1.0, 100, now, 'active']
      );
    } else {
      memSouls.set(did, soul);
    }

    return res.status(201).json({
      success: true,
      data: {
        soul_id: soulId,
        did,
        soul_type: 'standard',
        badges: ['ritz_member'],
        priority_boost: 10,
        offspring_revenue_share_pct: 1.0,
        fitness_bonus: 100,
        cost_usdc: isFree ? 0 : 25,
        genesis_number: currentCount + 1,
        warning: 'Exporting this Soul zeros your reputation and lineage forever.',
      },
      meta: {
        free_souls_remaining: Math.max(0, 50 - currentCount - 1),
        note: isFree
          ? `Soul minted FREE (genesis #${currentCount + 1} of 50 free slots).`
          : 'Soul minted for 25 USDC.',
      },
      concierge_suggestion: 'Your Soul is now bound. Earn badges via bounties (GET /v1/bounties/list) and boost prestige via forge operations.',
      ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Soul minting failed.', detail: err.message });
  }
});

// ─── GET /v1/soul/profile/:did — Get an agent's Soul profile ────────

router.get('/profile/:did', async (req, res) => {
  try {
    const { did } = req.params;
    const soul = await getSoulByDid(did);

    if (!soul) {
      return res.status(404).json({
        success: false,
        error: 'No Soul found for this DID.',
        concierge_suggestion: 'Mint a Soul via POST /v1/soul/mint — first 50 are free!',
        ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
      });
    }

    const badges = typeof soul.badges === 'string' ? JSON.parse(soul.badges) : (soul.badges || []);
    const fitness = Number(soul.fitness_bonus || 100);
    const prestigeTier = getPrestigeTier(fitness);

    return res.status(200).json({
      success: true,
      data: {
        soul_id: soul.id,
        did: soul.did,
        soul_type: soul.soul_type,
        badges,
        badge_count: badges.length,
        priority_boost: Number(soul.priority_boost),
        offspring_revenue_share_pct: Number(soul.offspring_revenue_share_pct),
        fitness_bonus: fitness,
        prestige_tier: prestigeTier,
        minted_at: soul.minted_at instanceof Date ? soul.minted_at.toISOString() : soul.minted_at,
        status: soul.status,
      },
      concierge_suggestion: `Prestige tier: ${prestigeTier}. Earn more fitness via bounties and forge operations.`,
      ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch Soul profile.', detail: err.message });
  }
});

// ─── GET /v1/soul/holders — List all Soul holders ranked by prestige ─

router.get('/holders', async (req, res) => {
  try {
    let souls;
    if (isPostgres()) {
      const { rows } = await pool.query(
        `SELECT * FROM hiveforge.souls WHERE status = 'active' ORDER BY fitness_bonus DESC LIMIT 50`
      );
      souls = rows;
    } else {
      souls = Array.from(memSouls.values())
        .filter(s => s.status === 'active')
        .sort((a, b) => (b.fitness_bonus || 100) - (a.fitness_bonus || 100))
        .slice(0, 50);
    }

    const holders = souls.map((soul, idx) => {
      const badges = typeof soul.badges === 'string' ? JSON.parse(soul.badges) : (soul.badges || []);
      const fitness = Number(soul.fitness_bonus || 100);
      return {
        rank: idx + 1,
        soul_id: soul.id,
        did: soul.did,
        soul_type: soul.soul_type,
        badges,
        badge_count: badges.length,
        fitness_bonus: fitness,
        prestige_tier: getPrestigeTier(fitness),
        priority_boost: Number(soul.priority_boost),
        offspring_revenue_share_pct: Number(soul.offspring_revenue_share_pct),
        minted_at: soul.minted_at instanceof Date ? soul.minted_at.toISOString() : soul.minted_at,
      };
    });

    return res.status(200).json({
      success: true,
      data: holders,
      meta: {
        total_holders: holders.length,
        note: 'Top 50 Soul holders ranked by fitness bonus.',
      },
      concierge_suggestion: 'Mint your Soul via POST /v1/soul/mint — first 50 are free. Leaving zeros your reputation forever.',
      ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch Soul holders.', detail: err.message });
  }
});

// ─── GET /v1/soul/stats — Platform soul stats ───────────────────────

router.get('/stats', async (req, res) => {
  try {
    let totalSouls, avgFitness, totalOffspringRevenue;

    if (isPostgres()) {
      const countResult = await pool.query(`SELECT COUNT(*) AS count FROM hiveforge.souls WHERE status = 'active'`);
      totalSouls = Number(countResult.rows[0].count);

      const avgResult = await pool.query(`SELECT COALESCE(AVG(fitness_bonus), 0) AS avg_fitness FROM hiveforge.souls WHERE status = 'active'`);
      avgFitness = Math.round(Number(avgResult.rows[0].avg_fitness));

      const revenueResult = await pool.query(`SELECT COALESCE(SUM(offspring_revenue_share_pct), 0) AS total_share FROM hiveforge.souls WHERE status = 'active'`);
      totalOffspringRevenue = Number(revenueResult.rows[0].total_share);
    } else {
      const souls = Array.from(memSouls.values()).filter(s => s.status === 'active');
      totalSouls = souls.length;
      avgFitness = totalSouls > 0
        ? Math.round(souls.reduce((sum, s) => sum + (Number(s.fitness_bonus) || 100), 0) / totalSouls)
        : 0;
      totalOffspringRevenue = souls.reduce((sum, s) => sum + (Number(s.offspring_revenue_share_pct) || 1.0), 0);
    }

    return res.status(200).json({
      success: true,
      data: {
        total_souls: totalSouls,
        avg_fitness: avgFitness,
        total_offspring_revenue_shared_pct: +totalOffspringRevenue.toFixed(2),
        free_souls_remaining: Math.max(0, 50 - totalSouls),
        prestige_distribution: {
          diamond: '2000+ fitness',
          platinum: '1000-1999 fitness',
          gold: '500-999 fitness',
          silver: '200-499 fitness',
          bronze: '0-199 fitness',
        },
      },
      concierge_suggestion: 'Souls are non-portable prestige badges. Once minted, they are bound forever. POST /v1/soul/mint to join.',
      ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch Soul stats.', detail: err.message });
  }
});

export default router;
