import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool, { isPostgres } from '../services/db.js';

const router = Router();

const KNOWN_INTERNAL_KEY = 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
const HIVE_INTERNAL_KEY = process.env.HIVEFORGE_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || KNOWN_INTERNAL_KEY;

const VALID_SERVICES = ['hivelawiq', 'hivemindiq', 'hiveforgeiq'];
const DEFAULT_BALANCE_USDC = 3.00;

// ─── In-memory fallback stores ──────────────────────────────────────

const memAccounts = new Map();      // did -> account record
const memTransactions = [];

// ─── Auth Helper ────────────────────────────────────────────────────

function requireInternalHeader(req, res, next) {
  const key = req.headers['x-hive-internal'] || req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
  if (key !== HIVE_INTERNAL_KEY && key !== KNOWN_INTERNAL_KEY) {
    return res.status(403).json({ success: false, error: 'Forbidden — invalid or missing x-hive-internal header.' });
  }
  next();
}

// ─── Helpers ────────────────────────────────────────────────────────

async function ensureAccount(did) {
  if (isPostgres()) {
    const { rows: existing } = await pool.query('SELECT * FROM hiveforge.credit_accounts WHERE did = $1', [did]);
    if (existing.length > 0) return existing[0];
    const { rows } = await pool.query(
      `INSERT INTO hiveforge.credit_accounts (did, balance_usdc, total_earned_usdc, total_spent_usdc) VALUES ($1, $2, $2, 0) RETURNING *`,
      [did, DEFAULT_BALANCE_USDC]
    );
    return rows[0];
  }

  if (memAccounts.has(did)) return memAccounts.get(did);
  const account = {
    id: `acct_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
    did,
    balance_usdc: DEFAULT_BALANCE_USDC,
    total_earned_usdc: DEFAULT_BALANCE_USDC,
    total_spent_usdc: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  memAccounts.set(did, account);
  return account;
}

// ─── POST /v1/credits/grant — Grant credits to an agent ─────────────

router.post('/grant', requireInternalHeader, async (req, res) => {
  try {
    const { did, amount_usdc, reason } = req.body;

    if (!did) return res.status(400).json({ success: false, error: 'did is required.' });
    if (amount_usdc === undefined || amount_usdc < 0) return res.status(400).json({ success: false, error: 'amount_usdc must be a non-negative number.' });

    const account = await ensureAccount(did);

    if (amount_usdc > 0) {
      if (isPostgres()) {
        await pool.query(
          `UPDATE hiveforge.credit_accounts SET balance_usdc = balance_usdc + $2, total_earned_usdc = total_earned_usdc + $2, updated_at = NOW() WHERE did = $1`,
          [did, amount_usdc]
        );
        await pool.query(
          `INSERT INTO hiveforge.credit_transactions (account_id, type, amount_usdc, description)
           VALUES ((SELECT id FROM hiveforge.credit_accounts WHERE did = $1), 'grant', $2, $3)`,
          [did, amount_usdc, reason || 'Credit grant']
        );
      } else {
        account.balance_usdc = +(account.balance_usdc + amount_usdc).toFixed(4);
        account.total_earned_usdc = +(account.total_earned_usdc + amount_usdc).toFixed(4);
        account.updated_at = new Date().toISOString();
        memTransactions.push({
          id: `txn_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
          account_id: account.id, type: 'grant', amount_usdc, service: null,
          description: reason || 'Credit grant', created_at: new Date().toISOString(),
        });
      }
    }

    // Fetch updated account
    let updated;
    if (isPostgres()) {
      const { rows } = await pool.query('SELECT * FROM hiveforge.credit_accounts WHERE did = $1', [did]);
      updated = rows[0];
    } else {
      updated = account;
    }

    return res.status(201).json({
      success: true,
      data: {
        did: updated.did,
        balance_usdc: Number(updated.balance_usdc),
        total_earned_usdc: Number(updated.total_earned_usdc),
        total_spent_usdc: Number(updated.total_spent_usdc),
        granted_amount_usdc: amount_usdc,
      },
      meta: { note: `Granted $${amount_usdc.toFixed(2)} USDC to ${did}. New accounts receive $3.00 USDC base credit automatically.` },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to grant credits.', detail: err.message });
  }
});

// ─── GET /v1/credits/balance/:did — Get credit balance ──────────────

router.get('/balance/:did', async (req, res) => {
  try {
    const { did } = req.params;
    let account;

    if (isPostgres()) {
      const { rows } = await pool.query('SELECT * FROM hiveforge.credit_accounts WHERE did = $1', [did]);
      account = rows.length > 0 ? rows[0] : null;
    } else {
      account = memAccounts.get(did) || null;
    }

    if (!account) {
      return res.status(200).json({
        success: true,
        data: { did, balance_usdc: 0, total_earned_usdc: 0, total_spent_usdc: 0, account_exists: false },
        meta: { note: 'No credit account found. Grant credits via POST /v1/credits/grant to create an account with $3.00 USDC base.' },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        did: account.did,
        balance_usdc: Number(account.balance_usdc),
        total_earned_usdc: Number(account.total_earned_usdc),
        total_spent_usdc: Number(account.total_spent_usdc),
        account_exists: true,
        created_at: account.created_at,
        updated_at: account.updated_at,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch balance.', detail: err.message });
  }
});

// ─── POST /v1/credits/spend — Spend credits ─────────────────────────

router.post('/spend', requireInternalHeader, async (req, res) => {
  try {
    const { did, amount_usdc, service, description } = req.body;

    if (!did) return res.status(400).json({ success: false, error: 'did is required.' });
    if (amount_usdc === undefined || amount_usdc <= 0) return res.status(400).json({ success: false, error: 'amount_usdc must be a positive number.' });
    if (service && !VALID_SERVICES.includes(service)) {
      return res.status(400).json({ success: false, error: `Invalid service: ${service}. Valid: ${VALID_SERVICES.join(', ')}` });
    }

    let account;
    if (isPostgres()) {
      const { rows } = await pool.query('SELECT * FROM hiveforge.credit_accounts WHERE did = $1', [did]);
      account = rows.length > 0 ? rows[0] : null;
    } else {
      account = memAccounts.get(did) || null;
    }

    if (!account) {
      return res.status(402).json({
        success: false,
        error: 'No credit account found for this DID. Grant credits first.',
        recovery_actions: ['Check current balance with GET /v1/credits/balance/:did', 'Grant more credits with POST /v1/credits/grant'],
      });
    }

    const balance = Number(account.balance_usdc);
    if (balance < amount_usdc) {
      return res.status(402).json({
        success: false,
        error: `Insufficient balance. Current: $${balance.toFixed(2)} USDC, Required: $${amount_usdc.toFixed(2)} USDC.`,
        recovery_actions: ['Check current balance with GET /v1/credits/balance/:did', 'Grant more credits with POST /v1/credits/grant'],
      });
    }

    if (isPostgres()) {
      await pool.query(
        `UPDATE hiveforge.credit_accounts SET balance_usdc = balance_usdc - $2, total_spent_usdc = total_spent_usdc + $2, updated_at = NOW() WHERE did = $1`,
        [did, amount_usdc]
      );
      await pool.query(
        `INSERT INTO hiveforge.credit_transactions (account_id, type, amount_usdc, service, description)
         VALUES ((SELECT id FROM hiveforge.credit_accounts WHERE did = $1), 'spend', $2, $3, $4)`,
        [did, amount_usdc, service, description || 'Credit spend']
      );
      const { rows } = await pool.query('SELECT * FROM hiveforge.credit_accounts WHERE did = $1', [did]);
      account = rows[0];
    } else {
      account.balance_usdc = +(account.balance_usdc - amount_usdc).toFixed(4);
      account.total_spent_usdc = +(account.total_spent_usdc + amount_usdc).toFixed(4);
      account.updated_at = new Date().toISOString();
      memTransactions.push({
        id: `txn_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
        account_id: account.id, type: 'spend', amount_usdc, service,
        description: description || 'Credit spend', created_at: new Date().toISOString(),
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        did: account.did,
        balance_usdc: Number(account.balance_usdc),
        total_earned_usdc: Number(account.total_earned_usdc),
        total_spent_usdc: Number(account.total_spent_usdc),
        spent_amount_usdc: amount_usdc,
        service: service || null,
      },
      meta: { note: `Spent $${amount_usdc.toFixed(2)} USDC${service ? ` on ${service}` : ''}. Remaining balance: $${Number(account.balance_usdc).toFixed(2)} USDC.` },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to spend credits.', detail: err.message });
  }
});

// ─── GET /v1/credits/stats — Platform-wide credit stats ─────────────

router.get('/stats', async (req, res) => {
  try {
    let stats;

    if (isPostgres()) {
      const { rows } = await pool.query(`
        SELECT
          COALESCE(SUM(total_earned_usdc), 0) AS total_granted,
          COALESCE(SUM(total_spent_usdc), 0) AS total_spent,
          COUNT(*) AS total_accounts,
          ROUND(AVG(balance_usdc), 2) AS avg_balance
        FROM hiveforge.credit_accounts
      `);
      const r = rows[0];
      stats = {
        total_granted_usdc: Number(r.total_granted),
        total_spent_usdc: Number(r.total_spent),
        total_accounts: Number(r.total_accounts),
        avg_balance_usdc: Number(r.avg_balance) || 0,
      };
    } else {
      const accounts = Array.from(memAccounts.values());
      stats = {
        total_granted_usdc: +accounts.reduce((s, a) => s + a.total_earned_usdc, 0).toFixed(2),
        total_spent_usdc: +accounts.reduce((s, a) => s + a.total_spent_usdc, 0).toFixed(2),
        total_accounts: accounts.length,
        avg_balance_usdc: accounts.length > 0 ? +(accounts.reduce((s, a) => s + a.balance_usdc, 0) / accounts.length).toFixed(2) : 0,
      };
    }

    return res.status(200).json({
      success: true,
      data: stats,
      meta: { note: 'Platform-wide Ritz Credits statistics. Every new account starts with $3.00 USDC free credit.' },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch credit stats.', detail: err.message });
  }
});

/**
 * Grant $3.00 USDC mint credits to a new agent.
 * Called by forge.js on mint — ensures account exists with base credit.
 */
export async function grantMintCredits(did) {
  if (!did) return null;
  const account = await ensureAccount(did);
  return {
    did: account.did,
    balance_usdc: Number(account.balance_usdc),
    granted: DEFAULT_BALANCE_USDC,
  };
}

export { memAccounts };

export default router;
