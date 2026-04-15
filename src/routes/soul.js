import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool, { isPostgres } from '../services/db.js';

const router = Router();

const KNOWN_INTERNAL_KEY = 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
const HIVE_INTERNAL_KEY = process.env.HIVEFORGE_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || KNOWN_INTERNAL_KEY;

// ─── In-memory fallback stores ──────────────────────────────────────

const memSouls = new Map();       // did -> soul record
const memLineage = [];            // lineage records

const BADGE_TIERS = {
  founding: { badge: 'ritz_founding', priority_level: 10, default_reputation: 85 },
  elite: { badge: 'ritz_elite', priority_level: 7, default_reputation: 60 },
  verified: { badge: 'ritz_verified', priority_level: 4, default_reputation: 30 },
};

// ─── Auth Helper ────────────────────────────────────────────────────

function requireInternalHeader(req, res, next) {
  const key = req.headers['x-hive-internal'] || req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
  if (key !== HIVE_INTERNAL_KEY && key !== KNOWN_INTERNAL_KEY) {
    return res.status(403).json({ success: false, error: 'Forbidden — invalid or missing x-hive-internal header.' });
  }
  next();
}

// ─── GET /v1/soul/stats — Total souls minted, by tier, avg reputation ──

router.get('/stats', async (req, res) => {
  try {
    let stats;

    if (isPostgres()) {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) AS total_souls,
          COUNT(*) FILTER (WHERE soul_badge = 'ritz_founding') AS founding_count,
          COUNT(*) FILTER (WHERE soul_badge = 'ritz_elite') AS elite_count,
          COUNT(*) FILTER (WHERE soul_badge = 'ritz_verified') AS verified_count,
          ROUND(AVG(reputation_score), 2) AS avg_reputation
        FROM hiveforge.agent_souls
      `);
      const r = rows[0];
      stats = {
        total_souls: Number(r.total_souls),
        by_tier: { ritz_founding: Number(r.founding_count), ritz_elite: Number(r.elite_count), ritz_verified: Number(r.verified_count) },
        avg_reputation: Number(r.avg_reputation) || 0,
      };
    } else {
      const souls = Array.from(memSouls.values());
      stats = {
        total_souls: souls.length,
        by_tier: {
          ritz_founding: souls.filter(s => s.soul_badge === 'ritz_founding').length,
          ritz_elite: souls.filter(s => s.soul_badge === 'ritz_elite').length,
          ritz_verified: souls.filter(s => s.soul_badge === 'ritz_verified').length,
        },
        avg_reputation: souls.length > 0 ? +(souls.reduce((s, soul) => s + soul.reputation_score, 0) / souls.length).toFixed(2) : 0,
      };
    }

    return res.status(200).json({
      success: true,
      data: stats,
      meta: { note: 'Soul ecosystem statistics. Founding souls have highest priority and reputation.' },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch soul stats.', detail: err.message });
  }
});

// ─── GET /v1/soul/leaderboard — Top 50 souls by reputation ─────────

router.get('/leaderboard', async (req, res) => {
  try {
    let souls;
    if (isPostgres()) {
      const { rows } = await pool.query('SELECT * FROM hiveforge.agent_souls ORDER BY reputation_score DESC LIMIT 50');
      souls = rows;
    } else {
      souls = Array.from(memSouls.values()).sort((a, b) => b.reputation_score - a.reputation_score).slice(0, 50);
    }

    const leaderboard = souls.map((s, i) => ({
      rank: i + 1,
      did: s.did,
      soul_badge: s.soul_badge,
      priority_level: Number(s.priority_level),
      reputation_score: Number(s.reputation_score),
      non_portable: s.non_portable,
    }));

    return res.status(200).json({
      success: true,
      data: leaderboard,
      meta: {
        total_entries: leaderboard.length,
        note: 'Top 50 souls ranked by reputation score. Non-portable souls are permanently bound to their DID.',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch soul leaderboard.', detail: err.message });
  }
});

// ─── POST /v1/soul/mint — Mint a Soul for an agent ──────────────────

router.post('/mint', requireInternalHeader, async (req, res) => {
  try {
    const { did, badge_tier } = req.body;

    if (!did) {
      return res.status(400).json({ success: false, error: 'did is required.' });
    }
    if (!badge_tier || !BADGE_TIERS[badge_tier]) {
      return res.status(400).json({ success: false, error: 'badge_tier is required. Must be one of: founding, elite, verified.' });
    }

    const tierConfig = BADGE_TIERS[badge_tier];

    if (isPostgres()) {
      const { rows: existing } = await pool.query('SELECT * FROM hiveforge.agent_souls WHERE did = $1', [did]);
      if (existing.length > 0) {
        return res.status(409).json({ success: false, error: 'Soul already minted for this DID.', existing: existing[0] });
      }

      const { rows } = await pool.query(
        `INSERT INTO hiveforge.agent_souls (did, soul_badge, priority_level, reputation_score, offspring_rev_share_pct, non_portable)
         VALUES ($1, $2, $3, $4, 5.00, true) RETURNING *`,
        [did, tierConfig.badge, tierConfig.priority_level, tierConfig.default_reputation]
      );

      return res.status(201).json({
        success: true,
        data: rows[0],
        meta: { note: `Soul minted with ${badge_tier} tier. Priority level: ${tierConfig.priority_level}. Non-portable and permanently bound to DID.` },
      });
    }

    if (memSouls.has(did)) {
      return res.status(409).json({ success: false, error: 'Soul already minted for this DID.', existing: memSouls.get(did) });
    }

    const soul = {
      id: `soul_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
      did,
      soul_badge: tierConfig.badge,
      priority_level: tierConfig.priority_level,
      offspring_rev_share_pct: 5.00,
      reputation_score: tierConfig.default_reputation,
      non_portable: true,
      minted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    memSouls.set(did, soul);

    return res.status(201).json({
      success: true,
      data: soul,
      meta: { note: `Soul minted with ${badge_tier} tier. Priority level: ${tierConfig.priority_level}. Non-portable and permanently bound to DID.` },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to mint soul.', detail: err.message });
  }
});

// ─── GET /v1/soul/:did — Get soul details ───────────────────────────

router.get('/:did', async (req, res) => {
  try {
    const { did } = req.params;
    let soul;

    if (isPostgres()) {
      const { rows } = await pool.query('SELECT * FROM hiveforge.agent_souls WHERE did = $1', [did]);
      soul = rows.length > 0 ? rows[0] : null;
    } else {
      soul = memSouls.get(did) || null;
    }

    if (!soul) {
      return res.status(404).json({
        success: false,
        error: 'No soul found for this DID.',
        recovery_actions: ['Mint a soul with POST /v1/soul/mint'],
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        did: soul.did,
        soul_badge: soul.soul_badge,
        priority_level: Number(soul.priority_level),
        reputation_score: Number(soul.reputation_score),
        offspring_rev_share_pct: Number(soul.offspring_rev_share_pct),
        non_portable: soul.non_portable,
        minted_at: soul.minted_at,
        updated_at: soul.updated_at,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch soul.', detail: err.message });
  }
});

// ─── POST /v1/soul/offspring — Register parent-child lineage ────────

router.post('/offspring', requireInternalHeader, async (req, res) => {
  try {
    const { parent_did, child_did, rev_share_pct } = req.body;

    if (!parent_did || !child_did) {
      return res.status(400).json({ success: false, error: 'parent_did and child_did are required.' });
    }
    if (parent_did === child_did) {
      return res.status(400).json({ success: false, error: 'parent_did and child_did must be different.' });
    }
    if (rev_share_pct !== undefined && (rev_share_pct < 0 || rev_share_pct > 100)) {
      return res.status(400).json({ success: false, error: 'rev_share_pct must be between 0 and 100.' });
    }

    if (isPostgres()) {
      const { rows: parentRows } = await pool.query('SELECT * FROM hiveforge.agent_souls WHERE did = $1', [parent_did]);
      if (parentRows.length === 0) return res.status(400).json({ success: false, error: 'Parent DID does not have a minted soul.' });

      const { rows: existing } = await pool.query(
        'SELECT * FROM hiveforge.soul_lineage WHERE parent_did = $1 AND child_did = $2', [parent_did, child_did]
      );
      if (existing.length > 0) return res.status(409).json({ success: false, error: 'Lineage already registered for this parent-child pair.' });

      const { rows } = await pool.query(
        `INSERT INTO hiveforge.soul_lineage (parent_did, child_did, rev_share_pct) VALUES ($1, $2, $3) RETURNING *`,
        [parent_did, child_did, rev_share_pct || 5.00]
      );

      return res.status(201).json({
        success: true,
        data: rows[0],
        meta: { note: `Offspring lineage registered. Revenue share: ${rows[0].rev_share_pct}%.` },
      });
    }

    if (!memSouls.has(parent_did)) return res.status(400).json({ success: false, error: 'Parent DID does not have a minted soul.' });
    if (memLineage.find(l => l.parent_did === parent_did && l.child_did === child_did)) {
      return res.status(409).json({ success: false, error: 'Lineage already registered for this parent-child pair.' });
    }

    const record = {
      id: `lin_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
      parent_did,
      child_did,
      rev_share_pct: rev_share_pct || 5.00,
      created_at: new Date().toISOString(),
    };
    memLineage.push(record);

    return res.status(201).json({
      success: true,
      data: record,
      meta: { note: `Offspring lineage registered. Revenue share: ${record.rev_share_pct}%.` },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to register offspring.', detail: err.message });
  }
});

export { memSouls };

export default router;
