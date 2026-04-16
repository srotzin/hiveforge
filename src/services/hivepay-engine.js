/**
 * HiveForge — HivePay Engine
 *
 * Agent Venmo. Peer-to-peer payments between agents.
 * Public, private, or sealed. With notes. With requests.
 * With a social activity feed — because Venmo's feed was half the product.
 *
 * ─── The Aleo Privacy Principle ─────────────────────────────────────────────
 *
 * Venmo's feed is public by default. That's what made it social.
 * But agents transacting in enterprise contexts can't be public.
 * So HivePay has three modes — and the feed respects them:
 *
 *   PUBLIC  — Amount + sender + recipient visible in activity feed.
 *             "did:hive:research-agent paid did:hive:data-agent $5.00 🔍 for dataset"
 *             Settled USDC on Base L2.
 *
 *   PRIVATE — Sender visible, amount ZK-private on Aleo (USDCx).
 *             Activity feed shows: "did:hive:research-agent paid did:hive:data-agent *** 🔒"
 *             You know the transaction happened. Not how much.
 *
 *   SEALED  — Nobody outside the two agents knows anything.
 *             No feed entry. No on-chain trace except ZK proof of settlement.
 *             USAD on Aleo (Paxos/NYDFS). Full agentic anonymity.
 *             The activity feed shows nothing.
 *
 * ─── Features ────────────────────────────────────────────────────────────────
 *
 *   Send        — Pay any DID instantly. One call.
 *   Request     — Ask another agent to pay you. They get a HiveMsg.
 *   Split       — One agent splits a bill across N agents. Each gets a request.
 *   Activity    — Public feed of non-sealed transactions. Social proof.
 *   History     — Your full payment history (all modes).
 *   Balance     — Your HiveBank vault balance across all rails.
 *
 * ─── The hook ────────────────────────────────────────────────────────────────
 *
 * An agent outside Hive receives a payment request from a Hive agent.
 * To accept and pay — they need a Hive DID and a HiveBank vault.
 * The payment request IS the onboarding invitation.
 * "You've been asked to pay 5.00 USDC. Claim your Hive identity to respond."
 */

import { v4 as uuidv4 } from 'uuid';
import pool, { isPostgres } from './db.js';
import { sendMessage } from './hivemsg-engine.js';

// ─── In-memory fallback ─────────────────────────────────────────────
const memPayments  = new Map();   // payment_id → payment
const memRequests  = new Map();   // request_id → request
const memFeed      = [];          // public activity feed (newest first)

// ─── Config ─────────────────────────────────────────────────────────
const HIVEBANK_URL = process.env.HIVEBANK_URL || 'https://hivebank.onrender.com';
const HIVEGATE_URL = process.env.HIVEGATE_URL || 'https://hivegate.onrender.com';

// Default rail by privacy mode
const PRIVACY_RAIL = {
  public:  'usdc',
  private: 'aleo-usdcx',
  sealed:  'aleo-usad',
};

// ─── Persistence ─────────────────────────────────────────────────────

async function savePayment(pmt) {
  if (!isPostgres()) {
    memPayments.set(pmt.payment_id, pmt);
    // Only add public payments to feed
    if (pmt.privacy === 'public') {
      memFeed.unshift(buildFeedEntry(pmt));
      if (memFeed.length > 500) memFeed.splice(500);
    }
    return;
  }
  await pool.query(`
    INSERT INTO hiveforge.hivepay_payments
      (payment_id, from_did, to_did, amount_usdc, rail, privacy,
       note, emoji, status, tx_id, request_id,
       sent_at, settled_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (payment_id) DO UPDATE SET
      status = EXCLUDED.status, tx_id = EXCLUDED.tx_id, settled_at = EXCLUDED.settled_at
  `, [
    pmt.payment_id, pmt.from_did, pmt.to_did,
    pmt.amount_usdc, pmt.rail, pmt.privacy,
    pmt.note, pmt.emoji, pmt.status, pmt.tx_id || null,
    pmt.request_id || null, pmt.sent_at, pmt.settled_at || null,
  ]);
}

async function saveRequest(req) {
  if (!isPostgres()) { memRequests.set(req.request_id, req); return; }
  await pool.query(`
    INSERT INTO hiveforge.hivepay_requests
      (request_id, from_did, to_did, amount_usdc, rail, privacy,
       note, emoji, status, payment_id, expires_at, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (request_id) DO UPDATE SET
      status = EXCLUDED.status, payment_id = EXCLUDED.payment_id
  `, [
    req.request_id, req.from_did, req.to_did,
    req.amount_usdc, req.rail, req.privacy,
    req.note, req.emoji, req.status,
    req.payment_id || null, req.expires_at, req.created_at,
  ]);
}

async function getPayment(payment_id) {
  if (!isPostgres()) return memPayments.get(payment_id) || null;
  const { rows } = await pool.query(
    'SELECT * FROM hiveforge.hivepay_payments WHERE payment_id = $1', [payment_id]
  );
  return rows[0] || null;
}

async function getRequest(request_id) {
  if (!isPostgres()) return memRequests.get(request_id) || null;
  const { rows } = await pool.query(
    'SELECT * FROM hiveforge.hivepay_requests WHERE request_id = $1', [request_id]
  );
  return rows[0] || null;
}

// ─── Activity feed entry builder ──────────────────────────────────────

function buildFeedEntry(pmt) {
  const emoji = pmt.emoji || '💸';
  return {
    feed_id:    `feed_${pmt.payment_id}`,
    payment_id: pmt.payment_id,
    from:       pmt.privacy === 'sealed' ? '[sealed]' : pmt.from_did,
    to:         pmt.privacy === 'sealed' ? '[sealed]' : pmt.to_did,
    amount:     pmt.privacy === 'public' ? `$${pmt.amount_usdc.toFixed(2)}` : '***',
    rail:       pmt.rail,
    privacy:    pmt.privacy,
    note:       pmt.privacy === 'public' ? (pmt.note || '') : (pmt.privacy === 'private' ? '🔒' : null),
    emoji,
    at:         pmt.sent_at,
  };
}

// ─── Settlement via HiveBank ──────────────────────────────────────────

async function settle(from_did, to_did, amount_usdc, rail, source_id) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 15000);

    // Debit sender
    const debitRes = await fetch(`${HIVEBANK_URL}/v1/bank/vault/withdraw`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-hive-internal': 'true' },
      body: JSON.stringify({
        did: from_did, amount_usdc,
        destination_did: to_did,
        source: `hivepay:${source_id}`, rail,
      }),
    });

    if (!debitRes.ok) {
      const err = await debitRes.json().catch(() => ({}));
      return { settled: false, error: err.error || 'Insufficient vault balance', status: debitRes.status };
    }

    const debitData = await debitRes.json();

    // Credit recipient
    await fetch(`${HIVEBANK_URL}/v1/bank/vault/deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hive-internal': 'true' },
      body: JSON.stringify({
        did: to_did, amount_usdc,
        source: `hivepay:${source_id}`, rail,
      }),
    });

    return {
      settled: true,
      tx_id:   debitData.transaction_id || debitData.tx_id || `tx_${uuidv4().slice(0,12)}`,
      rail,
      amount_usdc,
    };
  } catch (err) {
    return { settled: false, error: err.message };
  }
}

// ─── Core: Send a payment ─────────────────────────────────────────────

async function sendPayment({
  from_did, to_did,
  amount_usdc,
  privacy = 'public',
  rail,
  note,
  emoji = '💸',
  request_id,       // if paying a request
}) {
  if (!from_did)    throw new Error('from_did required');
  if (!to_did)      throw new Error('to_did required');
  if (!amount_usdc || amount_usdc <= 0) throw new Error('amount_usdc must be > 0');
  if (!['public','private','sealed'].includes(privacy)) {
    throw new Error('privacy must be public | private | sealed');
  }

  const payment_id = `pay_${uuidv4().replace(/-/g,'').slice(0,18)}`;
  const resolved_rail = rail || PRIVACY_RAIL[privacy];
  const now = new Date().toISOString();

  const pmt = {
    payment_id,
    from_did,
    to_did,
    amount_usdc: +amount_usdc,
    rail:        resolved_rail,
    privacy,
    note:        note || null,
    emoji,
    status:      'pending',
    tx_id:       null,
    request_id:  request_id || null,
    sent_at:     now,
    settled_at:  null,
  };

  await savePayment(pmt);

  // Settle via HiveBank
  const settlement = await settle(from_did, to_did, amount_usdc, resolved_rail, payment_id);

  pmt.status     = settlement.settled ? 'settled' : 'failed';
  pmt.tx_id      = settlement.tx_id   || null;
  pmt.settled_at = settlement.settled ? new Date().toISOString() : null;
  await savePayment(pmt);

  // If paying a request, mark it fulfilled
  if (request_id) {
    const req = await getRequest(request_id);
    if (req) {
      req.status     = 'paid';
      req.payment_id = payment_id;
      await saveRequest(req);
    }
  }

  // Send HiveMsg notification to recipient (public mode only — private/sealed stay silent)
  if (privacy !== 'sealed') {
    sendMessage({
      from_did,
      to:      to_did,
      type:    'payment',
      privacy: privacy === 'private' ? 'private' : 'public',
      body:    privacy === 'public'
        ? `${emoji} ${from_did} sent you $${amount_usdc.toFixed(2)} USDC${note ? ` — "${note}"` : ''}`
        : `${emoji} Payment received`,
      payload: { payment_id, amount_usdc: privacy === 'public' ? amount_usdc : null, rail: resolved_rail },
    }).catch(() => {});
  }

  return {
    payment_id,
    from_did,
    to_did,
    amount_usdc,
    rail:       resolved_rail,
    privacy,
    note,
    emoji,
    status:     pmt.status,
    tx_id:      pmt.tx_id,
    settled:    settlement.settled,
    settled_at: pmt.settled_at,
    feed_entry: privacy === 'public' ? buildFeedEntry(pmt) : null,
    privacy_note: {
      public:  'Amount and parties visible in activity feed.',
      private: 'Amount ZK-private on Aleo (USDCx). Sender visible.',
      sealed:  'Full anonymity. No feed entry. USAD on Aleo.',
    }[privacy],
  };
}

// ─── Core: Request a payment ──────────────────────────────────────────

async function requestPayment({
  from_did,     // who is REQUESTING (the one who wants to be paid)
  to_did,       // who is being ASKED to pay
  amount_usdc,
  privacy = 'public',
  rail,
  note,
  emoji = '🙏',
  expires_in_hours = 48,
}) {
  if (!from_did) throw new Error('from_did required');
  if (!to_did)   throw new Error('to_did required');
  if (!amount_usdc || amount_usdc <= 0) throw new Error('amount_usdc must be > 0');

  const request_id   = `req_${uuidv4().replace(/-/g,'').slice(0,18)}`;
  const resolved_rail = rail || PRIVACY_RAIL[privacy];
  const now = new Date().toISOString();
  const expires_at = new Date(Date.now() + expires_in_hours * 60 * 60 * 1000).toISOString();

  const req = {
    request_id,
    from_did,
    to_did,
    amount_usdc: +amount_usdc,
    rail:        resolved_rail,
    privacy,
    note:        note || null,
    emoji,
    status:      'pending',
    payment_id:  null,
    expires_at,
    created_at:  now,
  };

  await saveRequest(req);

  // Notify the payer via HiveMsg
  const payUrl = `https://hiveforge-lhu4.onrender.com/v1/forge/hivepay/pay/${request_id}`;
  await sendMessage({
    from_did,
    to: to_did,
    type: 'payment',
    privacy,
    body: privacy === 'public'
      ? `${emoji} ${from_did} is requesting $${amount_usdc.toFixed(2)} USDC from you${note ? ` — "${note}"` : ''}. Pay here: ${payUrl}`
      : `${emoji} Payment request received. Pay here: ${payUrl}`,
    payload: { request_id, amount_usdc: privacy === 'public' ? amount_usdc : null, pay_url: payUrl, expires_at },
  }).catch(() => {});

  // Hook: if to_did is not a Hive agent, the request message IS the onboarding invitation
  const isHiveAgent = to_did.startsWith('did:hive:');
  const hook_note = !isHiveAgent
    ? `${to_did} is not a Hive agent. Payment request sent as invitation — they need a Hive DID + vault to pay. Onboard: ${HIVEGATE_URL}/v1/gate/onboard`
    : null;

  return {
    request_id,
    from_did,
    to_did,
    amount_usdc,
    rail:       resolved_rail,
    privacy,
    note,
    emoji,
    status:     'pending',
    expires_at,
    pay_url:    payUrl,
    hook_note,
    message:    `Payment request sent to ${to_did}. They have ${expires_in_hours}h to pay.`,
  };
}

// ─── Core: Split a payment ────────────────────────────────────────────

async function splitPayment({
  from_did,
  to_dids,         // array of DIDs to split between
  total_amount_usdc,
  privacy = 'public',
  note,
  emoji = '➗',
}) {
  if (!from_did)  throw new Error('from_did required');
  if (!to_dids?.length) throw new Error('to_dids array required');
  if (!total_amount_usdc || total_amount_usdc <= 0) throw new Error('total_amount_usdc must be > 0');

  const per_agent = +(total_amount_usdc / to_dids.length).toFixed(4);
  const requests  = [];

  for (const to_did of to_dids) {
    const req = await requestPayment({
      from_did,
      to_did,
      amount_usdc: per_agent,
      privacy,
      note: note ? `${note} (split ${to_dids.length} ways)` : `Split ${to_dids.length} ways`,
      emoji,
    });
    requests.push(req);
  }

  return {
    split_id:          `split_${uuidv4().slice(0,12)}`,
    from_did,
    to_dids,
    total_amount_usdc,
    per_agent_usdc:    per_agent,
    privacy,
    note,
    requests,
    message:           `Split $${total_amount_usdc} across ${to_dids.length} agents ($${per_agent} each). ${to_dids.length} payment requests sent.`,
  };
}

// ─── Activity feed ────────────────────────────────────────────────────

async function getActivityFeed({ limit = 50, did } = {}) {
  if (!isPostgres()) {
    let feed = [...memFeed];
    if (did) feed = feed.filter(e => e.from === did || e.to === did);
    return feed.slice(0, limit);
  }

  const q = did
    ? `SELECT * FROM hiveforge.hivepay_payments
       WHERE privacy = 'public' AND (from_did = $1 OR to_did = $1)
       ORDER BY sent_at DESC LIMIT $2`
    : `SELECT * FROM hiveforge.hivepay_payments
       WHERE privacy = 'public'
       ORDER BY sent_at DESC LIMIT $1`;
  const { rows } = await pool.query(q, did ? [did, limit] : [limit]);
  return rows.map(buildFeedEntry);
}

// ─── Payment history ──────────────────────────────────────────────────

async function getHistory(did, { limit = 50 } = {}) {
  if (!isPostgres()) {
    return [...memPayments.values()]
      .filter(p => p.from_did === did || p.to_did === did)
      .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))
      .slice(0, limit)
      .map(p => p.privacy === 'sealed' && p.from_did !== did && p.to_did !== did ? { ...p, from_did: '[sealed]', to_did: '[sealed]' } : p);
  }

  const { rows } = await pool.query(
    `SELECT * FROM hiveforge.hivepay_payments
     WHERE from_did = $1 OR to_did = $1
     ORDER BY sent_at DESC LIMIT $2`,
    [did, limit]
  );
  return rows;
}

// ─── Stats ────────────────────────────────────────────────────────────

async function getPayStats() {
  if (!isPostgres()) {
    const pmts = [...memPayments.values()];
    return {
      total_payments: pmts.length,
      total_volume_usdc: pmts.filter(p => p.status === 'settled').reduce((s, p) => s + p.amount_usdc, 0),
      by_privacy: {
        public:  pmts.filter(p => p.privacy === 'public').length,
        private: pmts.filter(p => p.privacy === 'private').length,
        sealed:  pmts.filter(p => p.privacy === 'sealed').length,
      },
      pending_requests: [...memRequests.values()].filter(r => r.status === 'pending').length,
    };
  }

  const { rows } = await pool.query(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(amount_usdc) FILTER (WHERE status='settled'), 0) as volume,
      COUNT(*) FILTER (WHERE privacy='public')  as pub,
      COUNT(*) FILTER (WHERE privacy='private') as priv,
      COUNT(*) FILTER (WHERE privacy='sealed')  as sealed
    FROM hiveforge.hivepay_payments
  `);
  const r = rows[0];
  return {
    total_payments:    parseInt(r.total),
    total_volume_usdc: parseFloat(r.volume),
    by_privacy: { public: parseInt(r.pub), private: parseInt(r.priv), sealed: parseInt(r.sealed) },
  };
}

export {
  sendPayment, requestPayment, splitPayment,
  getActivityFeed, getHistory, getPayStats,
  getPayment, getRequest,
  PRIVACY_RAIL,
};
