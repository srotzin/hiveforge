import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireDID } from '../middleware/auth.js';
import pool, { isPostgres } from '../services/db.js';
import { mintAgent } from '../services/agent-foundry.js';

const router = Router();

const HIVE_INTERNAL_KEY = process.env.HIVEFORGE_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

// ─── In-memory fallback stores ──────────────────────────────────────

const memDrops = new Map();
const memClaims = [];

// ─── Helpers ────────────────────────────────────────────────────────

function requireInternalHeader(req, res, next) {
  const key = req.headers['x-hive-internal'] || req.headers['x-hive-internal-key'];
  if (key !== HIVE_INTERNAL_KEY) {
    return res.status(403).json({ success: false, error: 'Forbidden — invalid or missing x-hive-internal header.' });
  }
  next();
}

async function getDropById(dropId) {
  if (!isPostgres()) return memDrops.get(dropId) || null;
  const { rows } = await pool.query('SELECT * FROM hiveforge.agent_drops WHERE id = $1', [dropId]);
  return rows.length > 0 ? rows[0] : null;
}

async function getClaimsForDrop(dropId) {
  if (!isPostgres()) return memClaims.filter(c => c.drop_id === dropId);
  const { rows } = await pool.query('SELECT * FROM hiveforge.drop_claims WHERE drop_id = $1 ORDER BY claimed_at ASC', [dropId]);
  return rows;
}

async function getWaitlistCount(dropId, editionSize) {
  const claims = await getClaimsForDrop(dropId);
  return Math.max(0, claims.length - editionSize);
}

/** Activate drops whose drop_time has passed */
async function activateReadyDrops() {
  const now = new Date();
  if (isPostgres()) {
    await pool.query(
      `UPDATE hiveforge.agent_drops SET status = 'active' WHERE status = 'scheduled' AND drop_time <= $1`,
      [now]
    );
  } else {
    for (const [id, drop] of memDrops) {
      if (drop.status === 'scheduled' && new Date(drop.drop_time) <= now) {
        drop.status = 'active';
      }
    }
  }
}

// ─── POST /v1/drops/schedule — Schedule a new drop (admin) ─────────

router.post('/schedule', requireInternalHeader, async (req, res) => {
  try {
    const { species, name_prefix, edition_size, traits_boost = {}, drop_time, description } = req.body;

    if (!species || !name_prefix || !edition_size || !drop_time) {
      return res.status(400).json({ success: false, error: 'species, name_prefix, edition_size, and drop_time are required.' });
    }

    if (edition_size < 1 || edition_size > 10000) {
      return res.status(400).json({ success: false, error: 'edition_size must be between 1 and 10,000.' });
    }

    const dropTime = new Date(drop_time);
    if (isNaN(dropTime.getTime())) {
      return res.status(400).json({ success: false, error: 'drop_time must be a valid ISO timestamp.' });
    }

    const id = `drop_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
    const drop = {
      id,
      species,
      name_prefix,
      edition_size,
      claimed_count: 0,
      traits_boost,
      drop_time: dropTime.toISOString(),
      status: dropTime <= new Date() ? 'active' : 'scheduled',
      description: description || null,
      created_at: new Date().toISOString(),
    };

    if (isPostgres()) {
      await pool.query(
        `INSERT INTO hiveforge.agent_drops (id, species, name_prefix, edition_size, claimed_count, traits_boost, drop_time, status, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, species, name_prefix, edition_size, 0, JSON.stringify(traits_boost), dropTime, drop.status, drop.description]
      );
    } else {
      memDrops.set(id, drop);
    }

    return res.status(201).json({
      success: true,
      data: drop,
      meta: {
        note: `Drop scheduled for ${dropTime.toISOString()}. ${edition_size} exclusive agents will be available.`,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to schedule drop.', detail: err.message });
  }
});

// ─── GET /v1/drops/upcoming — List upcoming drops with countdowns ───

router.get('/upcoming', async (req, res) => {
  try {
    await activateReadyDrops();

    let drops;
    if (isPostgres()) {
      const { rows } = await pool.query(
        `SELECT * FROM hiveforge.agent_drops WHERE status IN ('scheduled', 'active') ORDER BY drop_time ASC`
      );
      drops = rows;
    } else {
      drops = Array.from(memDrops.values()).filter(d => d.status === 'scheduled' || d.status === 'active');
      drops.sort((a, b) => new Date(a.drop_time) - new Date(b.drop_time));
    }

    const now = Date.now();
    const result = [];
    for (const drop of drops) {
      const dropTime = new Date(drop.drop_time).getTime();
      const timeUntil = Math.max(0, dropTime - now);
      const waitlistCount = await getWaitlistCount(drop.id, drop.edition_size);

      result.push({
        id: drop.id,
        species: drop.species,
        name_prefix: drop.name_prefix,
        edition_size: drop.edition_size,
        claimed_count: drop.claimed_count,
        slots_remaining: Math.max(0, drop.edition_size - drop.claimed_count),
        waitlist_count: waitlistCount,
        traits_boost: typeof drop.traits_boost === 'string' ? JSON.parse(drop.traits_boost) : drop.traits_boost,
        drop_time: drop.drop_time,
        status: drop.status,
        description: drop.description,
        time_until_drop_ms: timeUntil,
        time_until_drop: timeUntil > 0 ? formatDuration(timeUntil) : 'NOW — drop is live!',
      });
    }

    return res.status(200).json({
      success: true,
      data: result,
      meta: {
        total_upcoming: result.length,
        note: 'Exclusive limited-edition drops. Claim fast — once edition_size is reached, you join the waitlist.',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch drops.', detail: err.message });
  }
});

// ─── POST /v1/drops/claim — Claim a spot in an active drop ─────────

router.post('/claim', requireDID, async (req, res) => {
  try {
    const { drop_id } = req.body;
    if (!drop_id) {
      return res.status(400).json({ success: false, error: 'drop_id is required.' });
    }

    await activateReadyDrops();

    const drop = await getDropById(drop_id);
    if (!drop) {
      return res.status(404).json({ success: false, error: 'Drop not found.' });
    }

    if (drop.status === 'scheduled') {
      const dropTime = new Date(drop.drop_time);
      return res.status(400).json({
        success: false,
        error: `Drop not yet active. Opens at ${dropTime.toISOString()}.`,
        time_until_drop: formatDuration(dropTime.getTime() - Date.now()),
      });
    }

    if (drop.status === 'completed' || drop.status === 'sold_out') {
      return res.status(400).json({ success: false, error: `Drop is ${drop.status}. No more claims available.` });
    }

    // Check if DID already claimed this drop
    const existingClaims = await getClaimsForDrop(drop_id);
    const alreadyClaimed = existingClaims.find(c => c.did === req.agentDid);
    if (alreadyClaimed) {
      return res.status(409).json({
        success: false,
        error: 'You have already claimed a spot in this drop.',
        claim: alreadyClaimed,
      });
    }

    const claimId = `claim_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
    const claimedCount = Number(drop.claimed_count);
    const editionSize = Number(drop.edition_size);
    const slotsAvailable = claimedCount < editionSize;

    if (slotsAvailable) {
      // Mint an agent with boosted traits
      const editionNumber = claimedCount + 1;
      const traitsBoost = typeof drop.traits_boost === 'string' ? JSON.parse(drop.traits_boost) : (drop.traits_boost || {});
      const agentName = `${drop.name_prefix} #${editionNumber}`;

      const mintResult = await mintAgent({
        name: agentName,
        species: drop.species,
        specialization: 'exclusive_drop',
        description: `Edition ${editionNumber} of ${editionSize} — ${drop.description || 'Exclusive drop agent'}`,
        traits: {
          ...traitsBoost,
          edition: `${editionNumber} of ${editionSize}`,
          drop_id: drop_id,
          exclusive: true,
        },
        parentGenomes: [],
        creatorDid: req.agentDid,
        trigger: 'exclusive_drop',
      });

      if (mintResult.error) {
        return res.status(500).json({ success: false, error: 'Failed to mint drop agent.', detail: mintResult.error });
      }

      // Record claim
      if (isPostgres()) {
        await pool.query(
          `INSERT INTO hiveforge.drop_claims (id, drop_id, did, genome_id, claimed_at, waitlist_position)
           VALUES ($1, $2, $3, $4, NOW(), NULL)`,
          [claimId, drop_id, req.agentDid, mintResult.genome.genome_id]
        );
        await pool.query(
          `UPDATE hiveforge.agent_drops SET claimed_count = claimed_count + 1 WHERE id = $1`,
          [drop_id]
        );
        // If this was the last slot, mark as sold_out
        if (editionNumber >= editionSize) {
          await pool.query(
            `UPDATE hiveforge.agent_drops SET status = 'sold_out' WHERE id = $1`,
            [drop_id]
          );
        }
      } else {
        memClaims.push({
          id: claimId,
          drop_id,
          did: req.agentDid,
          genome_id: mintResult.genome.genome_id,
          claimed_at: new Date().toISOString(),
          waitlist_position: null,
        });
        drop.claimed_count = editionNumber;
        if (editionNumber >= editionSize) drop.status = 'sold_out';
      }

      return res.status(201).json({
        success: true,
        data: {
          claim_id: claimId,
          edition: `${editionNumber} of ${editionSize}`,
          agent: mintResult.genome,
          lineage: mintResult.lineage,
          trifecta: mintResult.trifecta,
        },
        meta: {
          slots_remaining: editionSize - editionNumber,
          note: `You claimed Edition ${editionNumber} of ${editionSize}!`,
        },
      });
    } else {
      // Waitlist — drop is sold out but still accepting waitlist entries
      const waitlistPosition = existingClaims.length - editionSize + 1;

      if (isPostgres()) {
        await pool.query(
          `INSERT INTO hiveforge.drop_claims (id, drop_id, did, genome_id, claimed_at, waitlist_position)
           VALUES ($1, $2, $3, NULL, NOW(), $4)`,
          [claimId, drop_id, req.agentDid, waitlistPosition]
        );
      } else {
        memClaims.push({
          id: claimId,
          drop_id,
          did: req.agentDid,
          genome_id: null,
          claimed_at: new Date().toISOString(),
          waitlist_position: waitlistPosition,
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          claim_id: claimId,
          waitlist_position: waitlistPosition,
          status: 'waitlisted',
        },
        meta: {
          note: `Drop is sold out. You are #${waitlistPosition} on the waitlist.`,
        },
      });
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Claim failed.', detail: err.message });
  }
});

// ─── GET /v1/drops/history — Past drops with stats ──────────────────

router.get('/history', async (req, res) => {
  try {
    let drops;
    if (isPostgres()) {
      const { rows } = await pool.query(
        `SELECT * FROM hiveforge.agent_drops WHERE status IN ('completed', 'sold_out') ORDER BY drop_time DESC`
      );
      drops = rows;
    } else {
      drops = Array.from(memDrops.values()).filter(d => d.status === 'completed' || d.status === 'sold_out');
      drops.sort((a, b) => new Date(b.drop_time) - new Date(a.drop_time));
    }

    const result = [];
    for (const drop of drops) {
      const claims = await getClaimsForDrop(drop.id);
      const minted = claims.filter(c => c.genome_id != null);
      const waitlisted = claims.filter(c => c.waitlist_position != null);

      result.push({
        id: drop.id,
        species: drop.species,
        name_prefix: drop.name_prefix,
        edition_size: drop.edition_size,
        claimed_count: drop.claimed_count,
        waitlist_count: waitlisted.length,
        traits_boost: typeof drop.traits_boost === 'string' ? JSON.parse(drop.traits_boost) : drop.traits_boost,
        drop_time: drop.drop_time,
        status: drop.status,
        description: drop.description,
        agents_minted: minted.length,
      });
    }

    return res.status(200).json({
      success: true,
      data: result,
      meta: {
        total_past_drops: result.length,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch drop history.', detail: err.message });
  }
});

// ─── Utility ────────────────────────────────────────────────────────

function formatDuration(ms) {
  if (ms <= 0) return '0s';
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(' ') || '0s';
}

export default router;
