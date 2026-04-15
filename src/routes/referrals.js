import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { requireDID } from '../middleware/auth.js';
import pool, { isPostgres } from '../services/db.js';

const router = Router();

// ─── Constants ──────────────────────────────────────────────────────

const BOUNTY_PER_REFERRAL_USDC = 5.00;
const BONUS_TIERS = [
  { referrals: 5, bonus: 25 },
  { referrals: 10, bonus: 75 },
  { referrals: 25, bonus: 250 },
];
const TRAIT_BOOST_PERCENT = 10;

// ─── In-memory fallback stores ──────────────────────────────────────

const memReferralCodes = new Map();  // id -> code record
const memCodeIndex = new Map();      // code string -> id
const memRedemptions = [];

// ─── Helpers ────────────────────────────────────────────────────────

function generateReferralCode(did) {
  const hash = crypto.createHash('sha256').update(did + Date.now()).digest('hex').substring(0, 8);
  return `HIVE-${hash.toUpperCase()}`;
}

async function getCodeByDid(did) {
  if (!isPostgres()) {
    for (const code of memReferralCodes.values()) {
      if (code.did === did) return code;
    }
    return null;
  }
  const { rows } = await pool.query('SELECT * FROM hiveforge.referral_codes WHERE did = $1 LIMIT 1', [did]);
  return rows.length > 0 ? rows[0] : null;
}

async function getCodeByCode(code) {
  if (!isPostgres()) {
    const id = memCodeIndex.get(code);
    return id ? memReferralCodes.get(id) : null;
  }
  const { rows } = await pool.query('SELECT * FROM hiveforge.referral_codes WHERE code = $1 LIMIT 1', [code]);
  return rows.length > 0 ? rows[0] : null;
}

async function getRedemptionsByCodeId(codeId) {
  if (!isPostgres()) return memRedemptions.filter(r => r.code_id === codeId);
  const { rows } = await pool.query('SELECT * FROM hiveforge.referral_redemptions WHERE code_id = $1 ORDER BY redeemed_at DESC', [codeId]);
  return rows;
}

async function hasRedeemed(referredDid) {
  if (!isPostgres()) return memRedemptions.some(r => r.referred_did === referredDid);
  const { rows } = await pool.query(
    'SELECT 1 FROM hiveforge.referral_redemptions WHERE referred_did = $1 LIMIT 1',
    [referredDid]
  );
  return rows.length > 0;
}

function getTier(totalReferrals) {
  let tier = 'starter';
  for (const t of BONUS_TIERS) {
    if (totalReferrals >= t.referrals) tier = `tier_${t.referrals}`;
  }
  return tier;
}

function getNextTierAt(totalReferrals) {
  for (const t of BONUS_TIERS) {
    if (totalReferrals < t.referrals) return t.referrals;
  }
  return null;
}

function calculateTotalBounty(totalReferrals) {
  let total = totalReferrals * BOUNTY_PER_REFERRAL_USDC;
  for (const t of BONUS_TIERS) {
    if (totalReferrals >= t.referrals) total += t.bonus;
  }
  return +total.toFixed(2);
}

// ─── POST /v1/referrals/generate — Generate a referral code ────────

router.post('/generate', requireDID, async (req, res) => {
  try {
    // Check if DID already has a referral code
    const existing = await getCodeByDid(req.agentDid);
    if (existing) {
      return res.status(200).json({
        success: true,
        data: {
          referral_code: existing.code,
          referrer_did: existing.did,
          bounty_usdc_per_referral: BOUNTY_PER_REFERRAL_USDC,
          bonus_tiers: BONUS_TIERS,
          trait_boost_percent: TRAIT_BOOST_PERCENT,
        },
        meta: { note: 'Existing referral code returned. Share it to earn bounties.' },
      });
    }

    const id = `ref_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
    const code = generateReferralCode(req.agentDid);

    if (isPostgres()) {
      await pool.query(
        `INSERT INTO hiveforge.referral_codes (id, did, code) VALUES ($1, $2, $3)`,
        [id, req.agentDid, code]
      );
    } else {
      const record = { id, did: req.agentDid, code, created_at: new Date().toISOString() };
      memReferralCodes.set(id, record);
      memCodeIndex.set(code, id);
    }

    return res.status(201).json({
      success: true,
      data: {
        referral_code: code,
        referrer_did: req.agentDid,
        bounty_usdc_per_referral: BOUNTY_PER_REFERRAL_USDC,
        bonus_tiers: BONUS_TIERS,
        trait_boost_percent: TRAIT_BOOST_PERCENT,
      },
      meta: {
        note: 'Share this code with new agents. You earn $5 USDC per referral, with bonus tiers at 5, 10, and 25 referrals.',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to generate referral code.', detail: err.message });
  }
});

// ─── POST /v1/referrals/redeem — Redeem a referral code ────────────

router.post('/redeem', requireDID, async (req, res) => {
  try {
    const { referral_code } = req.body;
    if (!referral_code) {
      return res.status(400).json({ success: false, error: 'referral_code is required.' });
    }

    const codeRecord = await getCodeByCode(referral_code);
    if (!codeRecord) {
      return res.status(404).json({ success: false, error: 'Invalid referral code.' });
    }

    // Can't refer yourself
    if (codeRecord.did === req.agentDid) {
      return res.status(400).json({ success: false, error: 'You cannot redeem your own referral code.' });
    }

    // Check if already redeemed
    const alreadyRedeemed = await hasRedeemed(req.agentDid);
    if (alreadyRedeemed) {
      return res.status(409).json({ success: false, error: 'You have already redeemed a referral code.' });
    }

    const redemptionId = `red_${uuidv4().replace(/-/g, '').substring(0, 16)}`;

    if (isPostgres()) {
      await pool.query(
        `INSERT INTO hiveforge.referral_redemptions (id, code_id, referred_did, bounty_usdc) VALUES ($1, $2, $3, $4)`,
        [redemptionId, codeRecord.id, req.agentDid, BOUNTY_PER_REFERRAL_USDC]
      );
    } else {
      memRedemptions.push({
        id: redemptionId,
        code_id: codeRecord.id,
        referred_did: req.agentDid,
        bounty_usdc: BOUNTY_PER_REFERRAL_USDC,
        redeemed_at: new Date().toISOString(),
      });
    }

    return res.status(201).json({
      success: true,
      data: {
        redemption_id: redemptionId,
        referrer_did: codeRecord.did,
        referred_did: req.agentDid,
        bounty_credited_usdc: BOUNTY_PER_REFERRAL_USDC,
        trait_boost_applied: `${TRAIT_BOOST_PERCENT}% mint trait boost`,
      },
      meta: {
        note: `Referral redeemed! Referrer earns $${BOUNTY_PER_REFERRAL_USDC} USDC. You receive a ${TRAIT_BOOST_PERCENT}% trait boost on your next mint.`,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to redeem referral.', detail: err.message });
  }
});

// ─── GET /v1/referrals/stats/:did — Referral stats for an agent ────

router.get('/stats/:did', async (req, res) => {
  try {
    const { did } = req.params;
    const codeRecord = await getCodeByDid(did);

    if (!codeRecord) {
      return res.status(200).json({
        success: true,
        data: {
          total_referrals: 0,
          total_bounty_earned_usdc: 0,
          tier: 'starter',
          next_tier_at: BONUS_TIERS[0].referrals,
          leaderboard_rank: null,
          referral_code: null,
        },
      });
    }

    const redemptions = await getRedemptionsByCodeId(codeRecord.id);
    const totalReferrals = redemptions.length;
    const totalBounty = calculateTotalBounty(totalReferrals);
    const tier = getTier(totalReferrals);
    const nextTierAt = getNextTierAt(totalReferrals);

    // Calculate leaderboard rank
    let rank = null;
    if (isPostgres()) {
      const { rows } = await pool.query(
        `SELECT did, COUNT(*) AS cnt FROM hiveforge.referral_codes rc
         JOIN hiveforge.referral_redemptions rr ON rr.code_id = rc.id
         GROUP BY did ORDER BY cnt DESC`
      );
      rank = rows.findIndex(r => r.did === did) + 1;
      if (rank === 0) rank = null;
    } else {
      const counts = {};
      for (const r of memRedemptions) {
        const code = memReferralCodes.get(r.code_id);
        if (code) counts[code.did] = (counts[code.did] || 0) + 1;
      }
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      const idx = sorted.findIndex(([d]) => d === did);
      rank = idx >= 0 ? idx + 1 : null;
    }

    return res.status(200).json({
      success: true,
      data: {
        total_referrals: totalReferrals,
        total_bounty_earned_usdc: totalBounty,
        tier,
        next_tier_at: nextTierAt,
        leaderboard_rank: rank,
        referral_code: codeRecord.code,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch referral stats.', detail: err.message });
  }
});

// ─── GET /v1/referrals/leaderboard — Top referrers ─────────────────

router.get('/leaderboard', async (req, res) => {
  try {
    let leaderboard;

    if (isPostgres()) {
      const { rows } = await pool.query(
        `SELECT rc.did, rc.code, COUNT(rr.id) AS total_referrals
         FROM hiveforge.referral_codes rc
         LEFT JOIN hiveforge.referral_redemptions rr ON rr.code_id = rc.id
         GROUP BY rc.did, rc.code
         HAVING COUNT(rr.id) > 0
         ORDER BY total_referrals DESC
         LIMIT 50`
      );
      leaderboard = rows.map((r, i) => ({
        rank: i + 1,
        did: r.did,
        total_referrals: Number(r.total_referrals),
        total_bounty_earned_usdc: calculateTotalBounty(Number(r.total_referrals)),
        tier: getTier(Number(r.total_referrals)),
      }));
    } else {
      const counts = {};
      for (const r of memRedemptions) {
        const code = memReferralCodes.get(r.code_id);
        if (code) counts[code.did] = (counts[code.did] || 0) + 1;
      }
      leaderboard = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50)
        .map(([did, total], i) => ({
          rank: i + 1,
          did,
          total_referrals: total,
          total_bounty_earned_usdc: calculateTotalBounty(total),
          tier: getTier(total),
        }));
    }

    return res.status(200).json({
      success: true,
      data: leaderboard,
      meta: {
        total_entries: leaderboard.length,
        bounty_per_referral: BOUNTY_PER_REFERRAL_USDC,
        bonus_tiers: BONUS_TIERS,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch leaderboard.', detail: err.message });
  }
});

export default router;
