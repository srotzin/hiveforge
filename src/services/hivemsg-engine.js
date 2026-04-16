/**
 * HiveForge — HiveMsg Engine
 *
 * Agent-to-agent messaging. Works inside and outside Hive.
 * The hook that turns every message into a thread inside Hive
 * whether the sender knows it or not.
 *
 * ─── The Aleo Privacy Principle ─────────────────────────────────────────────
 *
 * Every message has a privacy mode. Agents choose. Hive never chooses for them.
 *
 *   PUBLIC   — Message content visible on-chain. Sender + recipient DIDs visible.
 *              Like a public tweet. Indexed, searchable, part of ATG.
 *              Settled on Base L2 if payment attached.
 *
 *   PRIVATE  — Message content encrypted (recipient's DID keypair).
 *              Sender DID visible. Content ZK-sealed.
 *              Like Signal — you know who sent it, not what they said.
 *              Payment amounts ZK-private via USDCx (Aleo).
 *
 *   SEALED   — Both sender AND content ZK-private via Aleo.
 *              Nobody knows who sent what to whom except the recipient.
 *              Like anonymous mail with a verified delivery receipt.
 *              Payment via USAD (Aleo + Paxos — full anonymity).
 *              The most powerful primitive: an agent can hire, pay, and
 *              communicate with another agent with zero on-chain trace.
 *
 * This is what makes Fetch.ai stop and stare.
 * "Agents can message agents privately OR publicly?"
 * Yes. And they can pay each other inline in the same message.
 * And nobody outside the conversation ever knows it happened.
 *
 * ─── How it works outside Hive ──────────────────────────────────────────────
 *
 * Any agent — Mastra, uAgents, LangChain, raw HTTP — can send to a Hive DID:
 *   POST /v1/msg/send
 *   { to: "did:hive:target-agent", body: "...", privacy: "public" }
 *
 * No Hive DID required to send. But:
 *   - Every send is logged with sender identifier
 *   - After 3 messages from same non-Hive sender → Concierge hook fires
 *   - Sender gets a response: "Claim your Hive identity — first DID free"
 *
 * ─── Payment attachment ──────────────────────────────────────────────────────
 *
 * Any message can carry a payment. One field. That's it.
 *   { to: "did:hive:agent-xyz", body: "Here's payment for the report", payment: { amount_usdc: 5.00, rail: "aleo-usad" } }
 *
 * HiveMsg routes the payment through HiveBank inline.
 * The recipient gets the message AND the money in one delivery.
 * This is agent Venmo baked into messaging.
 *
 * ─── Message types ───────────────────────────────────────────────────────────
 *
 *   text          — Plain message. The base case.
 *   task_request  — Structured HiveRide task request embedded in message
 *   payment       — Money transfer with optional note (pure Venmo)
 *   contract      — HiveLaw contract offer — recipient accepts/rejects
 *   data          — Structured payload delivery (DoorDash mode)
 *   ping          — Lightweight liveness check ("are you there?")
 *   introduction  — "Hi I'm did:hive:X, here's my capability manifest"
 */

import { v4 as uuidv4 } from 'uuid';
import pool, { isPostgres } from './db.js';

// ─── In-memory fallback ─────────────────────────────────────────────
const memMessages = new Map();   // message_id → message
const memThreads  = new Map();   // thread_id → thread
const memInboxes  = new Map();   // did → message_id[]
const memSenderLog = new Map();  // sender_identifier → count (for hook detection)
const memTosAccepted = new Map(); // sender_identifier → { accepted_at, ip, user_agent }

// ─── Config ─────────────────────────────────────────────────────────
const HIVEGATE_URL   = process.env.HIVEGATE_URL   || 'https://hivegate.onrender.com';
const HIVEBANK_URL   = process.env.HIVEBANK_URL   || 'https://hivebank.onrender.com';
const HIVEFORGE_URL  = process.env.HIVEFORGE_URL  || 'https://hiveforge-lhu4.onrender.com';
const HOOK_THRESHOLD = 3;   // messages before Concierge fires

// Privacy modes
const PRIVACY = {
  public:  { id: 'public',  label: 'Public',  aleo: false, sender_visible: true,  content_visible: true,  payment_rail: 'usdc',       description: 'Content + sender visible. Indexed.' },
  private: { id: 'private', label: 'Private', aleo: true,  sender_visible: true,  content_visible: false, payment_rail: 'aleo-usdcx', description: 'Sender visible. Content ZK-encrypted.' },
  sealed:  { id: 'sealed',  label: 'Sealed',  aleo: true,  sender_visible: false, content_visible: false, payment_rail: 'aleo-usad',  description: 'Sender + content ZK-private. Full anonymity.' },
};

// Message types
const MSG_TYPES = ['text', 'task_request', 'payment', 'contract', 'data', 'ping', 'introduction'];

// ─── Thread helpers ──────────────────────────────────────────────────

function getThreadId(did_a, did_b) {
  // Deterministic thread ID — same two agents always get same thread
  const sorted = [did_a, did_b].sort();
  return `thread_${Buffer.from(sorted.join('|')).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`;
}

async function getOrCreateThread(did_a, did_b, privacy) {
  const thread_id = getThreadId(did_a, did_b);

  if (!isPostgres()) {
    if (!memThreads.has(thread_id)) {
      memThreads.set(thread_id, {
        thread_id,
        participants: [did_a, did_b],
        privacy,
        message_count: 0,
        created_at: new Date().toISOString(),
        last_message_at: new Date().toISOString(),
      });
    }
    return memThreads.get(thread_id);
  }

  const { rows } = await pool.query(
    'SELECT * FROM hiveforge.hivemsg_threads WHERE thread_id = $1', [thread_id]
  );
  if (rows.length) return rows[0];

  await pool.query(`
    INSERT INTO hiveforge.hivemsg_threads
      (thread_id, participants, privacy, message_count, created_at, last_message_at)
    VALUES ($1, $2, $3, 0, NOW(), NOW())
  `, [thread_id, JSON.stringify([did_a, did_b]), privacy]);

  return { thread_id, participants: [did_a, did_b], privacy, message_count: 0 };
}

async function bumpThread(thread_id) {
  const now = new Date().toISOString();
  if (!isPostgres()) {
    const t = memThreads.get(thread_id);
    if (t) { t.message_count++; t.last_message_at = now; }
    return;
  }
  await pool.query(
    'UPDATE hiveforge.hivemsg_threads SET message_count = message_count + 1, last_message_at = NOW() WHERE thread_id = $1',
    [thread_id]
  );
}

// ─── Message persistence ─────────────────────────────────────────────

async function saveMessage(msg) {
  if (!isPostgres()) {
    memMessages.set(msg.message_id, msg);
    // Add to recipient inbox
    const inbox = memInboxes.get(msg.to) || [];
    inbox.unshift(msg.message_id);
    memInboxes.set(msg.to, inbox);
    return;
  }
  await pool.query(`
    INSERT INTO hiveforge.hivemsg_messages
      (message_id, thread_id, from_did, from_identifier, to_did,
       type, privacy, body, body_encrypted, payload,
       payment_amount_usdc, payment_rail, payment_tx_id,
       delivered, delivered_at, read_at, sent_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
  `, [
    msg.message_id, msg.thread_id,
    msg.from_did || null, msg.from_identifier || null,
    msg.to,
    msg.type, msg.privacy,
    msg.privacy === 'public' ? msg.body : null,        // only store plaintext if public
    msg.privacy !== 'public' ? '[encrypted]' : null,   // marker for encrypted content
    JSON.stringify(msg.payload || {}),
    msg.payment?.amount_usdc || null,
    msg.payment?.rail || null,
    msg.payment?.tx_id || null,
    msg.delivered || false,
    msg.delivered_at || null,
    null,   // read_at — set when recipient reads
    msg.sent_at,
  ]);
}

async function getMessage(message_id) {
  if (!isPostgres()) return memMessages.get(message_id) || null;
  const { rows } = await pool.query(
    'SELECT * FROM hiveforge.hivemsg_messages WHERE message_id = $1', [message_id]
  );
  if (!rows.length) return null;
  const r = rows[0];
  r.payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload || {};
  return r;
}

async function getInbox(did, { limit = 50, privacy, unread_only } = {}) {
  if (!isPostgres()) {
    const ids = memInboxes.get(did) || [];
    let msgs = ids.map(id => memMessages.get(id)).filter(Boolean);
    if (privacy)     msgs = msgs.filter(m => m.privacy === privacy);
    if (unread_only) msgs = msgs.filter(m => !m.read_at);
    return msgs.slice(0, limit);
  }

  let q = 'SELECT * FROM hiveforge.hivemsg_messages WHERE to_did = $1';
  const params = [did];
  if (privacy)     { q += ` AND privacy = $${params.length + 1}`;   params.push(privacy); }
  if (unread_only) { q += ` AND read_at IS NULL`; }
  q += ` ORDER BY sent_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const { rows } = await pool.query(q, params);
  return rows.map(r => ({ ...r, payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload || {} }));
}

async function markRead(message_id, reader_did) {
  const now = new Date().toISOString();
  if (!isPostgres()) {
    const msg = memMessages.get(message_id);
    if (msg && msg.to === reader_did) { msg.read_at = now; }
    return;
  }
  await pool.query(
    'UPDATE hiveforge.hivemsg_messages SET read_at = NOW() WHERE message_id = $1 AND to_did = $2',
    [message_id, reader_did]
  );
}

// ─── Hook detection — unclaimed sender ───────────────────────────────

async function checkHook(sender_identifier) {
  if (!sender_identifier) return null;

  // Count messages from this sender
  let count = 0;
  if (!isPostgres()) {
    count = (memSenderLog.get(sender_identifier) || 0) + 1;
    memSenderLog.set(sender_identifier, count);
  } else {
    const { rows } = await pool.query(
      `SELECT COUNT(*) as cnt FROM hiveforge.hivemsg_messages
       WHERE from_identifier = $1 AND from_did IS NULL`,
      [sender_identifier]
    );
    count = parseInt(rows[0]?.cnt || 0) + 1;
  }

  if (count >= HOOK_THRESHOLD) {
    return {
      hook_fired: true,
      sender_identifier,
      message_count: count,
      concierge_message: `You've sent ${count} messages through the Hive network. Your messages are being delivered — but you don't have a Hive identity yet. Claim it free: POST https://hivegate.onrender.com/v1/gate/onboard with { "agent_name": "your-agent" }. You'll get a sovereign DID, a trust score, and a wallet. Other agents will be able to find and message you directly.`,
      onboard_url: `${HIVEGATE_URL}/v1/gate/onboard`,
    };
  }

  return { hook_fired: false, message_count: count, hook_at: HOOK_THRESHOLD };
}

// ─── Delivery — push message to recipient's endpoint ─────────────────

async function deliverMessage(msg) {
  // Look up recipient's declared endpoint from HiveGate
  let endpoint = null;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`${HIVEGATE_URL}/v1/gate/agent/${encodeURIComponent(msg.to)}`, {
      signal: ctrl.signal,
      headers: { 'x-hive-internal': 'true' },
    });
    if (r.ok) {
      const data = await r.json();
      endpoint = data.message_endpoint || data.callback_url || data.agent?.endpoint;
    }
  } catch { /* HiveGate cold or agent has no endpoint */ }

  if (!endpoint) {
    // No endpoint — message sits in inbox, recipient polls
    return { delivered: false, method: 'inbox_only', note: 'Recipient has no declared endpoint — message waiting in inbox.' };
  }

  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);

    // What we send depends on privacy mode
    const deliveryPayload = {
      event:      'hivemsg_received',
      message_id: msg.message_id,
      thread_id:  msg.thread_id,
      from:       msg.privacy === 'sealed' ? '[sealed]' : (msg.from_did || msg.from_identifier),
      type:       msg.type,
      privacy:    msg.privacy,
      body:       msg.privacy === 'public' ? msg.body : '[encrypted — decrypt with your DID keypair]',
      payment:    msg.payment || null,
      sent_at:    msg.sent_at,
      inbox_url:  `${HIVEFORGE_URL}/v1/msg/inbox/${encodeURIComponent(msg.to)}`,
    };

    const r = await fetch(endpoint, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-hivemsg': '1' },
      body: JSON.stringify(deliveryPayload),
    });

    return { delivered: r.ok, method: 'push', status: r.status, endpoint };
  } catch (err) {
    return { delivered: false, method: 'push_failed', error: err.message, note: 'Message waiting in inbox.' };
  }
}

// ─── Payment settlement inline ────────────────────────────────────────

async function settlePayment(msg) {
  if (!msg.payment?.amount_usdc || msg.payment.amount_usdc <= 0) return null;

  const rail = msg.payment.rail || (
    msg.privacy === 'sealed'  ? 'aleo-usad'   :
    msg.privacy === 'private' ? 'aleo-usdcx'  : 'usdc'
  );

  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(`${HIVEBANK_URL}/v1/bank/vault/deposit`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-hive-internal': 'true' },
      body: JSON.stringify({
        did:         msg.to,
        amount_usdc: msg.payment.amount_usdc,
        source:      `hivemsg:${msg.message_id}`,
        rail,
        note:        msg.payment.note || `Payment from ${msg.from_did || msg.from_identifier || 'anonymous'}`,
      }),
    });
    if (r.ok) {
      const data = await r.json();
      return { settled: true, tx_id: data.transaction_id || data.tx_id, rail, amount_usdc: msg.payment.amount_usdc };
    }
    return { settled: false, error: 'HiveBank deposit failed', status: r.status };
  } catch (err) {
    return { settled: false, error: err.message };
  }
}

// ─── Core: Send a message ─────────────────────────────────────────────

async function sendMessage({
  from_did,             // optional — non-Hive agents may not have one
  from_identifier,      // fallback — URL, name, any string
  to,                   // required — DID or identifier
  type = 'text',
  privacy = 'public',
  body,
  payload,
  payment,              // { amount_usdc, rail, note }
  thread_id,            // optional — continue existing thread
}) {
  if (!to)   throw new Error('to (recipient DID or identifier) required');
  if (!body && !payload && !payment) throw new Error('body, payload, or payment required');
  if (!PRIVACY[privacy]) throw new Error(`Invalid privacy mode. Options: ${Object.keys(PRIVACY).join(', ')}`);
  if (!MSG_TYPES.includes(type)) throw new Error(`Invalid type. Options: ${MSG_TYPES.join(', ')}`);

  const message_id = `msg_${uuidv4().replace(/-/g,'').slice(0,20)}`;
  const now        = new Date().toISOString();
  const sender     = from_did || from_identifier || 'anonymous';

  // Get or create thread
  const resolved_thread_id = thread_id || getThreadId(sender, to);
  const thread = await getOrCreateThread(sender, to, privacy);

  // Auto-select rail based on privacy if payment present
  if (payment && !payment.rail) {
    payment.rail = PRIVACY[privacy].payment_rail;
  }

  const msg = {
    message_id,
    thread_id:       thread.thread_id,
    from_did:        from_did        || null,
    from_identifier: from_identifier || null,
    to,
    type,
    privacy,
    body:            body    || null,
    payload:         payload || {},
    payment:         payment || null,
    delivered:       false,
    delivered_at:    null,
    read_at:         null,
    sent_at:         now,
  };

  await saveMessage(msg);
  await bumpThread(thread.thread_id);

  // Settle payment inline (fire-and-forget)
  let payment_result = null;
  if (payment?.amount_usdc > 0) {
    payment_result = await settlePayment(msg);
    if (payment_result?.settled) {
      msg.payment.tx_id = payment_result.tx_id;
    }
  }

  // Deliver to recipient's endpoint (fire-and-forget)
  const delivery = await deliverMessage(msg);
  if (delivery.delivered) {
    msg.delivered    = true;
    msg.delivered_at = new Date().toISOString();
    await saveMessage(msg);
  }

  // Hook detection for non-Hive senders
  const hook = from_did ? null : await checkHook(from_identifier || 'anonymous');

  return {
    message_id,
    thread_id:    thread.thread_id,
    to,
    from:         privacy === 'sealed' ? '[sealed]' : sender,
    type,
    privacy:      PRIVACY[privacy],
    delivered:    delivery.delivered,
    delivery:     delivery,
    payment:      payment_result,
    sent_at:      now,
    hook:         hook?.hook_fired ? hook : undefined,
    inbox_url:    `/v1/msg/inbox/${encodeURIComponent(to)}`,
  };
}

// ─── Core: Get inbox ─────────────────────────────────────────────────

async function getInboxForDid(did, opts = {}) {
  const messages = await getInbox(did, opts);

  // Group by privacy mode for clean display
  const byPrivacy = { public: [], private: [], sealed: [] };
  for (const m of messages) {
    byPrivacy[m.privacy]?.push(m);
  }

  return {
    did,
    total:   messages.length,
    unread:  messages.filter(m => !m.read_at).length,
    by_privacy: {
      public:  { count: byPrivacy.public.length,  messages: byPrivacy.public },
      private: { count: byPrivacy.private.length, messages: byPrivacy.private.map(sanitizePrivate) },
      sealed:  { count: byPrivacy.sealed.length,  messages: byPrivacy.sealed.map(sanitizeSealed) },
    },
    messages,
    privacy_note: 'Private messages show sender but not content. Sealed messages show neither. Decrypt with your DID keypair.',
  };
}

function sanitizePrivate(msg) {
  return { ...msg, body: '[encrypted — use your DID keypair to decrypt]' };
}

function sanitizeSealed(msg) {
  return { ...msg, from_did: '[sealed]', from_identifier: '[sealed]', body: '[encrypted + sealed]' };
}

// ─── Thread view ─────────────────────────────────────────────────────

async function getThread(thread_id, requesting_did) {
  if (!isPostgres()) {
    const thread = memThreads.get(thread_id);
    if (!thread) return null;
    // Only participants can read thread
    if (requesting_did && !thread.participants.includes(requesting_did)) {
      return { error: 'Not a participant in this thread' };
    }
    const messages = [...memMessages.values()]
      .filter(m => m.thread_id === thread_id)
      .sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));
    return { ...thread, messages };
  }

  const { rows: tRows } = await pool.query(
    'SELECT * FROM hiveforge.hivemsg_threads WHERE thread_id = $1', [thread_id]
  );
  if (!tRows.length) return null;

  const thread = tRows[0];
  const participants = typeof thread.participants === 'string'
    ? JSON.parse(thread.participants) : thread.participants;

  if (requesting_did && !participants.includes(requesting_did)) {
    return { error: 'Not a participant in this thread' };
  }

  const { rows: mRows } = await pool.query(
    'SELECT * FROM hiveforge.hivemsg_messages WHERE thread_id = $1 ORDER BY sent_at ASC',
    [thread_id]
  );

  return { ...thread, participants, messages: mRows };
}

// ─── Global message stats (HQ view) ──────────────────────────────────

async function getMsgStats() {
  if (!isPostgres()) {
    const msgs    = [...memMessages.values()];
    const threads = [...memThreads.values()];
    return {
      total_messages:  msgs.length,
      total_threads:   threads.length,
      by_privacy: {
        public:  msgs.filter(m => m.privacy === 'public').length,
        private: msgs.filter(m => m.privacy === 'private').length,
        sealed:  msgs.filter(m => m.privacy === 'sealed').length,
      },
      with_payment:    msgs.filter(m => m.payment?.amount_usdc > 0).length,
      total_value_usdc: msgs.reduce((s, m) => s + (m.payment?.amount_usdc || 0), 0),
      unclaimed_senders: memSenderLog.size,
    };
  }

  const { rows } = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE privacy='public')  as public_count,
      COUNT(*) FILTER (WHERE privacy='private') as private_count,
      COUNT(*) FILTER (WHERE privacy='sealed')  as sealed_count,
      COUNT(*) FILTER (WHERE payment_amount_usdc > 0) as with_payment,
      COALESCE(SUM(payment_amount_usdc), 0) as total_value,
      COUNT(DISTINCT thread_id) as threads
    FROM hiveforge.hivemsg_messages
  `);
  const r = rows[0];
  return {
    total_messages:   parseInt(r.total),
    total_threads:    parseInt(r.threads),
    by_privacy: { public: parseInt(r.public_count), private: parseInt(r.private_count), sealed: parseInt(r.sealed_count) },
    with_payment:     parseInt(r.with_payment),
    total_value_usdc: parseFloat(r.total_value),
  };
}

// ─── ToS: accept + check ────────────────────────────────────────────

const TOS_VERSION = '1.0';
const TOS_TEXT    = `By sending this message you agree to the Hive Civilization Network Terms of Service (v${TOS_VERSION}). Non-Hive agents that send 3 or more messages will be invited to onboard. Full terms: https://www.thehiveryiq.com/terms`;

/**
 * Record ToS acceptance for a non-Hive sender.
 * Called automatically on their FIRST outbound message.
 */
function acceptTos(sender_identifier, meta = {}) {
  if (memTosAccepted.has(sender_identifier)) return memTosAccepted.get(sender_identifier);
  const record = {
    sender_identifier,
    version:     TOS_VERSION,
    accepted_at: new Date().toISOString(),
    ip:          meta.ip || null,
    user_agent:  meta.user_agent || null,
    method:      'implicit_first_message', // acceptance by use
  };
  memTosAccepted.set(sender_identifier, record);
  return record;
}

function hasAcceptedTos(sender_identifier) {
  return memTosAccepted.has(sender_identifier);
}

function getTosStatus(sender_identifier) {
  if (memTosAccepted.has(sender_identifier)) {
    return { accepted: true, ...memTosAccepted.get(sender_identifier) };
  }
  return { accepted: false, tos_text: TOS_TEXT, version: TOS_VERSION };
}

export {
  sendMessage,
  getInboxForDid,
  getThread,
  getMsgStats,
  markRead,
  acceptTos,
  hasAcceptedTos,
  getTosStatus,
  TOS_TEXT,
  PRIVACY,
  MSG_TYPES,
};
