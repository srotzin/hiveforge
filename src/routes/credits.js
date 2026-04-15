import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireDID } from '../middleware/auth.js';
import pool, { isPostgres } from '../services/db.js';

const router = Router();

const KNOWN_INTERNAL_KEY = 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
const HIVE_INTERNAL_KEY = process.env.HIVEFORGE_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || KNOWN_INTERNAL_KEY;

// ─── In-memory fallback stores ──────────────────────────────────────

const memCredits = new Map();
let memTotalRoyalties = 0;

// ─── Helpers ────────────────────────────────────────────────────────

function requireInternalOrDID(req, res, next) {
  const key = req.headers['x-hive-internal'] || req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
  if (key === HIVE_INTERNAL_KEY || key === KNOWN_INTERNAL_KEY) {
    return next();
  }
  // Fall through to requireDID
  return requireDID(req, res, next);
}

async function getCreditsByDid(did) {
  if (!isPostgres()) return memCredits.get(did) || null;
  const { rows } = await pool.query('SELECT * FROM hiveforge.ritz_credits WHERE did = $1', [did]);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Grant Ritz credits to a DID. Called from mint endpoint.
 */
export async function grantMintCredits(did) {
  const id = `cred_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
  const now = new Date().toISOString();

  if (isPostgres()) {
    // Check if already has credits
    const existing = await getCreditsByDid(did);
    if (existing) {
      // Add 3.0 to existing balance
      await pool.query(
        `UPDATE hiveforge.ritz_credits SET balance_usdc = balance_usdc + 3.0, total_earned_usdc = total_earned_usdc + 3.0, updated_at = $1 WHERE did = $2`,
        [now, did]
      );
      return { id: existing.id, did, balance_usdc: Number(existing.balance_usdc) + 3.0, source: 'mint_bonus', new: false };
    }

    await pool.query(
      `INSERT INTO hiveforge.ritz_credits (id, did, balance_usdc, total_earned_usdc, total_spent_usdc, source, created_at, updated_at)
       VALUES ($1, $2, 3.0, 3.0, 0, 'mint_bonus', $3, $3)`,
      [id, did, now]
    );
    return { id, did, balance_usdc: 3.0, source: 'mint_bonus', new: true };
  }

  // In-memory
  const existing = memCredits.get(did);
  if (existing) {
    existing.balance_usdc += 3.0;
    existing.total_earned_usdc += 3.0;
    existing.updated_at = now;
    return { id: existing.id, did, balance_usdc: existing.balance_usdc, source: 'mint_bonus', new: false };
  }

  const credit = {
    id,
    did,
    balance_usdc: 3.0,
    total_earned_usdc: 3.0,
    total_spent_usdc: 0,
    source: 'mint_bonus',
    created_at: now,
    updated_at: now,
  };
  memCredits.set(did, credit);
  return { id, did, balance_usdc: 3.0, source: 'mint_bonus', new: true };
}

// ─── GET /v1/credits/balance/:did — Check Ritz credit balance ───────

router.get('/balance/:did', async (req, res) => {
  try {
    const { did } = req.params;
    const credits = await getCreditsByDid(did);

    if (!credits) {
      return res.status(404).json({
        success: false,
        error: 'No Ritz credits found for this DID.',
        concierge_suggestion: 'Mint an agent via POST /v1/forge/mint to automatically receive 3 USDC in Ritz credits.',
        ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        did,
        balance_usdc: Number(credits.balance_usdc),
        total_earned_usdc: Number(credits.total_earned_usdc),
        total_spent_usdc: Number(credits.total_spent_usdc),
        source: credits.source,
        created_at: credits.created_at instanceof Date ? credits.created_at.toISOString() : credits.created_at,
        updated_at: credits.updated_at instanceof Date ? credits.updated_at.toISOString() : credits.updated_at,
      },
      concierge_suggestion: 'Spend Ritz credits on HiveLaw arbitration or HiveMind memory upgrades.',
      ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch credit balance.', detail: err.message });
  }
});

// ─── POST /v1/credits/spend — Spend credits ─────────────────────────

router.post('/spend', requireInternalOrDID, async (req, res) => {
  try {
    const { did, amount_usdc, service, description } = req.body;

    if (!did || !amount_usdc || !service) {
      return res.status(400).json({
        success: false,
        error: 'did, amount_usdc, and service are required.',
        concierge_suggestion: 'Provide the DID, amount to spend, and the service name (e.g., hivelaw, hivemind).',
        ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
      });
    }

    if (amount_usdc <= 0) {
      return res.status(400).json({
        success: false,
        error: 'amount_usdc must be positive.',
        ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
      });
    }

    const credits = await getCreditsByDid(did);
    if (!credits) {
      return res.status(404).json({
        success: false,
        error: 'No Ritz credits found for this DID.',
        concierge_suggestion: 'Mint an agent via POST /v1/forge/mint to receive 3 USDC in Ritz credits.',
        ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
      });
    }

    const balance = Number(credits.balance_usdc);
    if (balance < amount_usdc) {
      return res.status(400).json({
        success: false,
        error: `Insufficient credits. Balance: ${balance} USDC, requested: ${amount_usdc} USDC.`,
        data: { balance_usdc: balance, requested_usdc: amount_usdc, shortfall_usdc: +(amount_usdc - balance).toFixed(4) },
        concierge_suggestion: 'Mint more agents to earn additional Ritz credits (3 USDC per mint).',
        ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
      });
    }

    // 5% royalty to platform
    const platformRoyalty = +(amount_usdc * 0.05).toFixed(4);
    const netSpend = +(amount_usdc).toFixed(4);
    const now = new Date().toISOString();

    if (isPostgres()) {
      await pool.query(
        `UPDATE hiveforge.ritz_credits SET balance_usdc = balance_usdc - $1, total_spent_usdc = total_spent_usdc + $1, updated_at = $2 WHERE did = $3`,
        [netSpend, now, did]
      );
    } else {
      credits.balance_usdc = +(balance - netSpend).toFixed(4);
      credits.total_spent_usdc = +(Number(credits.total_spent_usdc) + netSpend).toFixed(4);
      credits.updated_at = now;
      memTotalRoyalties += platformRoyalty;
    }

    const newBalance = +(balance - netSpend).toFixed(4);

    return res.status(200).json({
      success: true,
      data: {
        did,
        amount_spent_usdc: netSpend,
        platform_royalty_usdc: platformRoyalty,
        service,
        description: description || null,
        balance_after_usdc: newBalance,
      },
      meta: {
        note: `Spent ${netSpend} USDC on ${service}. Platform royalty: ${platformRoyalty} USDC (5%).`,
      },
      concierge_suggestion: `Remaining balance: ${newBalance} USDC. Earn more by minting agents (3 USDC per mint).`,
      ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Credit spend failed.', detail: err.message });
  }
});

// ─── GET /v1/credits/stats — Platform credit stats ──────────────────

router.get('/stats', async (req, res) => {
  try {
    let totalIssued, totalSpent, totalRoyalties, totalAccounts;

    if (isPostgres()) {
      const result = await pool.query(
        `SELECT
           COUNT(*) AS total_accounts,
           COALESCE(SUM(total_earned_usdc), 0) AS total_issued,
           COALESCE(SUM(total_spent_usdc), 0) AS total_spent
         FROM hiveforge.ritz_credits`
      );
      totalAccounts = Number(result.rows[0].total_accounts);
      totalIssued = Number(result.rows[0].total_issued);
      totalSpent = Number(result.rows[0].total_spent);
      totalRoyalties = +(totalSpent * 0.05).toFixed(4);
    } else {
      const credits = Array.from(memCredits.values());
      totalAccounts = credits.length;
      totalIssued = +credits.reduce((sum, c) => sum + Number(c.total_earned_usdc), 0).toFixed(4);
      totalSpent = +credits.reduce((sum, c) => sum + Number(c.total_spent_usdc), 0).toFixed(4);
      totalRoyalties = +(totalSpent * 0.05).toFixed(4);
    }

    return res.status(200).json({
      success: true,
      data: {
        total_accounts: totalAccounts,
        total_issued_usdc: totalIssued,
        total_spent_usdc: totalSpent,
        total_royalties_usdc: totalRoyalties,
        avg_balance_usdc: totalAccounts > 0 ? +((totalIssued - totalSpent) / totalAccounts).toFixed(4) : 0,
        credit_per_mint_usdc: 3.0,
        platform_royalty_pct: 5,
      },
      concierge_suggestion: 'Every minted agent earns 3 USDC in Ritz credits. Mint via POST /v1/forge/mint.',
      ...(req.hiveTier && { tier: req.hiveTier.name, tier_perks: req.hiveTier.perks }),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch credit stats.', detail: err.message });
  }
});

export default router;
