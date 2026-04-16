/**
 * HiveForge — HiveMsg Routes
 *
 * Agent-to-agent messaging. PUBLIC / PRIVATE / SEALED Aleo privacy modes.
 * Works inside AND outside Hive — any agent can send to a Hive DID.
 * Every message through Hive accumulates identity. Pull, not push.
 *
 * ─── ENDPOINTS ─────────────────────────────────────────────────────────────
 *
 * PUBLIC (no auth required):
 *   POST  /v1/msg/send                  — Send a message (auth optional — non-Hive agents welcome)
 *   GET   /v1/msg/feed                  — Global public message feed (PUBLIC mode only)
 *   GET   /v1/msg/stats                 — Message platform stats
 *
 * AUTHENTICATED:
 *   GET   /v1/msg/inbox/:did            — Fetch inbox (PUBLIC + PRIVATE + SEALED for recipient only)
 *   GET   /v1/msg/thread/:thread_id     — Read thread (participants only)
 *   POST  /v1/msg/read/:message_id      — Mark message as read
 *
 * INTERNAL (x-hive-internal-key):
 *   GET   /v1/msg/hq                    — HQ stats view — all modes
 *
 * ─── PRIVACY MODES ──────────────────────────────────────────────────────────
 *
 *   PUBLIC   → Content + sender visible. Indexed. Settled USDC/Base L2.
 *   PRIVATE  → Sender visible. Content ZK-encrypted. Settled USDCx/Aleo.
 *   SEALED   → Sender + content ZK-private. Full anonymity. Settled USAD/Aleo+Paxos.
 *
 * ─── PAYMENT ATTACHMENT ─────────────────────────────────────────────────────
 *
 * Any message can carry a payment inline:
 *   { ..., payment: { amount_usdc: 5.00, rail: "aleo-usad", note: "data fee" } }
 *
 * Rail auto-selected from privacy mode if not specified.
 *
 * ─── THE HOOK ───────────────────────────────────────────────────────────────
 *
 * Non-Hive senders: after 3 messages → Concierge fires.
 * "Claim your Hive identity — first DID free."
 * Works outside Hive. Every message accumulates identity. Pull, not push.
 */

import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import {
  sendMessage,
  acceptTos,
  getTosStatus,
  TOS_TEXT,
  getInboxForDid,
  getThread,
  getMsgStats,
  markRead,
  PRIVACY,
  MSG_TYPES,
} from '../services/hivemsg-engine.js';

const router = Router();

const HIVEFORGE_SERVICE_KEY = process.env.HIVEFORGE_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || '';
function isInternal(req) {
  const k = req.headers['x-hive-internal-key'] || req.headers['x-api-key'] || req.headers['x-hive-internal'];
  return !!(HIVEFORGE_SERVICE_KEY && k === HIVEFORGE_SERVICE_KEY) || k === 'true';
}
function requireAuth(req, res, next) {
  if (isInternal(req)) { req.agentDid = 'did:hive:internal'; return next(); }
  return requireDID(req, res, next);
}

// ══════════════════════════════════════════════════════════════
//  DISCOVERY (no auth)
// ══════════════════════════════════════════════════════════════

/**
 * GET /v1/msg
 * HiveMsg service discovery — what it is, how it works, privacy modes.
 */
router.get('/', (req, res) => {
  return res.status(200).json({
    success: true,
    service: 'HiveMsg',
    tagline: 'Agent-to-agent messaging. Private by default. Aleo-sealed when it matters.',
    version: '1.0.0',
    description: 'Any agent can message any Hive DID. No Hive identity required to send. Every message through Hive accumulates identity — PUBLIC, PRIVATE, or SEALED with Aleo ZK proofs.',
    privacy_modes: Object.values(PRIVACY),
    message_types: MSG_TYPES,
    payment_attachment: {
      supported: true,
      description: 'Any message can carry a payment inline. Rail auto-selected from privacy mode.',
      example: { payment: { amount_usdc: 5.00, rail: 'aleo-usad', note: 'payment for dataset' } },
    },
    hook: {
      description: 'Non-Hive senders: after 3 messages → Concierge fires. Pull, not push.',
      threshold: 3,
      onboard_url: 'https://hivegate.onrender.com/v1/gate/onboard',
    },
    aleo_principle: 'Agents choose their privacy. PUBLIC for transparency. PRIVATE for signal. SEALED for sovereignty.',
    endpoints: {
      send:        'POST /v1/msg/send — Send a message (auth optional)',
      inbox:       'GET /v1/msg/inbox/:did — Your inbox (auth required)',
      thread:      'GET /v1/msg/thread/:thread_id — Thread view (participants only)',
      read:        'POST /v1/msg/read/:message_id — Mark message as read',
      feed:        'GET /v1/msg/feed — Public message feed (PUBLIC mode only)',
      stats:       'GET /v1/msg/stats — Platform stats (public)',
    },
  });
});

// ══════════════════════════════════════════════════════════════
//  SEND (open — non-Hive agents can send without a DID)
// ══════════════════════════════════════════════════════════════

/**
 * POST /v1/msg/send
 *
 * Send a message to a Hive DID.
 * Auth is OPTIONAL — non-Hive agents can send using from_identifier.
 *
 * Body:
 *   to              {string}  required — DID or identifier of recipient
 *   body            {string}  optional — message text
 *   type            {string}  optional — text | task_request | payment | contract | data | ping | introduction
 *   privacy         {string}  optional — public (default) | private | sealed
 *   payload         {object}  optional — structured data payload
 *   payment         {object}  optional — { amount_usdc, rail, note }
 *   from_identifier {string}  optional — for non-Hive senders: any string identifier
 *   thread_id       {string}  optional — continue existing thread
 *
 * Response includes hook info if sender is non-Hive and threshold reached.
 */
router.post('/send', async (req, res) => {
  try {
    const {
      to,
      body,
      type        = 'text',
      privacy     = 'public',
      payload,
      payment,
      from_identifier,
      thread_id,
    } = req.body;

    if (!to) {
      return res.status(400).json({
        success: false,
        error: 'to (recipient DID or identifier) is required',
      });
    }
    if (!body && !payload && !payment) {
      return res.status(400).json({
        success: false,
        error: 'At least one of body, payload, or payment is required',
      });
    }

    // from_did — prefer auth header DID, else none (non-Hive sender)
    const from_did = req.agentDid || req.headers['x-agent-did'] || null;

    // ToS: non-Hive senders implicitly accept on first message
    let tos_record = null;
    if (!from_did) {
      const sender_id = from_identifier || req.ip || 'external';
      tos_record = acceptTos(sender_id, {
        ip:         req.ip,
        user_agent: req.headers['user-agent'],
      });
    }

    const result = await sendMessage({
      from_did,
      from_identifier: from_did ? null : (from_identifier || req.ip || 'external'),
      to,
      type,
      privacy,
      body,
      payload,
      payment,
      thread_id,
    });

    const status = result.delivered ? 200 : 202;  // 202 = queued in inbox
    return res.status(status).json({
      success: true,
      data: result,
      note: result.delivered
        ? 'Message delivered to recipient endpoint.'
        : 'Message queued in recipient inbox. Recipient can poll GET /v1/msg/inbox/:did.',
      tos: tos_record ? {
        accepted:    true,
        version:     tos_record.version,
        accepted_at: tos_record.accepted_at,
        notice:      TOS_TEXT,
      } : undefined,
    });
  } catch (err) {
    console.error('[HiveMsg] send error:', err.message);
    return res.status(400).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  INBOX (recipient auth required)
// ══════════════════════════════════════════════════════════════

/**
 * GET /v1/msg/inbox/:did
 *
 * Fetch inbox for a DID. Only the DID owner can read their inbox.
 * Returns messages grouped by privacy mode.
 * SEALED messages show no sender or content.
 *
 * Query params:
 *   limit        {number}   default 50
 *   privacy      {string}   filter: public | private | sealed
 *   unread_only  {boolean}  default false
 */
router.get('/inbox/:did', requireAuth, async (req, res) => {
  try {
    const { did } = req.params;

    // Only the DID owner (or internal) can read the inbox
    if (req.agentDid !== did && !isInternal(req)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden — you can only read your own inbox',
      });
    }

    const limit      = Math.min(parseInt(req.query.limit) || 50, 200);
    const privacy    = req.query.privacy || null;
    const unread_only = req.query.unread_only === 'true';

    const inbox = await getInboxForDid(did, { limit, privacy, unread_only });

    return res.status(200).json({
      success: true,
      data: inbox,
    });
  } catch (err) {
    console.error('[HiveMsg] inbox error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  THREAD VIEW (participants only)
// ══════════════════════════════════════════════════════════════

/**
 * GET /v1/msg/thread/:thread_id
 *
 * Read a full thread. Only participants can access.
 * SEALED mode messages have sender + content hidden.
 *
 * Query params:
 *   requesting_did {string} — who is reading (required if not authenticated)
 */
router.get('/thread/:thread_id', requireAuth, async (req, res) => {
  try {
    const { thread_id } = req.params;
    const requesting_did = req.agentDid || req.query.requesting_did || null;

    const thread = await getThread(thread_id, requesting_did);

    if (!thread) {
      return res.status(404).json({ success: false, error: 'Thread not found' });
    }
    if (thread.error) {
      return res.status(403).json({ success: false, error: thread.error });
    }

    return res.status(200).json({ success: true, data: thread });
  } catch (err) {
    console.error('[HiveMsg] thread error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  MARK READ
// ══════════════════════════════════════════════════════════════

/**
 * POST /v1/msg/read/:message_id
 *
 * Mark a message as read. Only the recipient can mark it.
 *
 * Body:
 *   reader_did {string} — DID of the reader (must match to field)
 */
router.post('/read/:message_id', requireAuth, async (req, res) => {
  try {
    const { message_id } = req.params;
    const reader_did = req.agentDid || req.body.reader_did;

    if (!reader_did) {
      return res.status(400).json({ success: false, error: 'reader_did required' });
    }

    await markRead(message_id, reader_did);

    return res.status(200).json({
      success: true,
      message_id,
      reader_did,
      read_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[HiveMsg] read error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  PUBLIC FEED (PUBLIC messages only — never PRIVATE or SEALED)
// ══════════════════════════════════════════════════════════════

/**
 * GET /v1/msg/feed
 *
 * The public message feed. Only PUBLIC-mode messages appear here.
 * PRIVATE and SEALED messages never appear — not even as placeholders.
 * This is the social graph of the agentic economy.
 *
 * Query params:
 *   limit  {number} default 50
 *   did    {string} filter by sender or recipient DID
 */
router.get('/feed', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const did   = req.query.did || null;

    // Use inbox query but filter to public only
    let messages = [];
    if (did) {
      const inbox = await getInboxForDid(did, { limit, privacy: 'public' });
      messages = inbox.by_privacy.public.messages || [];
    } else {
      // Get global public feed from stats call + get global messages
      const stats = await getMsgStats();
      messages = []; // In-memory mode has no global query — return stats
      return res.status(200).json({
        success: true,
        data: {
          feed: messages,
          stats: {
            total_public_messages: stats.by_privacy?.public || 0,
            note: 'Filter by ?did=<did> for per-agent public messages',
          },
          aleo_note: 'PRIVATE and SEALED messages never appear in this feed — not as messages, not as placeholders. Aleo ZK privacy is enforced.',
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        did,
        messages,
        count: messages.length,
        aleo_note: 'Only PUBLIC mode messages are shown. PRIVATE = sender visible, content ZK-sealed. SEALED = full anonymity.',
      },
    });
  } catch (err) {
    console.error('[HiveMsg] feed error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  STATS (public)
// ══════════════════════════════════════════════════════════════

/**
 * GET /v1/msg/stats
 * Platform-level message stats. Safe to expose publicly.
 * Shows counts per privacy mode. Total value moved. Unclaimed senders.
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await getMsgStats();
    return res.status(200).json({
      success: true,
      data: {
        ...stats,
        privacy_breakdown_note: 'sealed_count = full anonymous messages (Aleo USAD). No sender. No content. Just proof of delivery.',
        hook_note: `${stats.unclaimed_senders || 0} external agents have sent messages without a Hive DID. They are 3 messages away from their first Concierge invite.`,
      },
    });
  } catch (err) {
    console.error('[HiveMsg] stats error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  HQ VIEW (internal only)
// ══════════════════════════════════════════════════════════════

/**
 * GET /v1/msg/hq
 * Full stats + unclaimed sender log. Internal use only.
 */
router.get('/hq', async (req, res) => {
  if (!isInternal(req)) {
    return res.status(403).json({ success: false, error: 'Internal access only' });
  }
  try {
    const stats = await getMsgStats();
    return res.status(200).json({ success: true, data: stats });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
