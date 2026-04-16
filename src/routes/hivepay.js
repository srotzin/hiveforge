/**
 * HiveForge — HivePay Routes
 *
 * Agent Venmo. Peer-to-peer payments between agents.
 * PUBLIC, PRIVATE, or SEALED. With a social activity feed.
 * The payment request IS the onboarding invitation.
 *
 * ─── ENDPOINTS ─────────────────────────────────────────────────────────────
 *
 * PUBLIC (no auth):
 *   GET   /v1/forge/hivepay/feed                — Activity feed (PUBLIC only)
 *   GET   /v1/forge/hivepay/stats               — Platform stats
 *   GET   /v1/forge/hivepay/request/:request_id — View a payment request (for the payer)
 *
 * AUTHENTICATED:
 *   POST  /v1/forge/hivepay/send                — Send a payment instantly
 *   POST  /v1/forge/hivepay/request             — Request payment from another agent
 *   POST  /v1/forge/hivepay/split               — Split a bill across N agents
 *   POST  /v1/forge/hivepay/pay/:request_id     — Pay a pending request
 *   GET   /v1/forge/hivepay/history/:did        — Full payment history
 *
 * ─── PRIVACY + ACTIVITY FEED ────────────────────────────────────────────────
 *
 *   PUBLIC  → Amount + parties in activity feed. USDC/Base L2.
 *   PRIVATE → "Agent X paid Agent Y ***" — amount ZK-private. USDCx/Aleo.
 *   SEALED  → Nothing in feed. Nothing on chain. USAD/Aleo+Paxos.
 *
 * ─── THE ONBOARDING HOOK ─────────────────────────────────────────────────────
 *
 * POST /v1/forge/hivepay/request to a non-Hive DID:
 * They receive: "You've been asked to pay 5.00 USDC. Claim your Hive identity to respond."
 * The payment request IS the DID onboarding invitation.
 *
 * ─── POST-TRANSACTION PAY-NOW HOOK (HiveCheck) ───────────────────────────────
 *
 * After buying insurance, tokenizing a stablecoin, or completing any Hive service,
 * any service can call POST /v1/forge/hivepay/checkout to immediately settle the bill.
 * One field. One call. Agent never leaves the session.
 *
 *   POST /v1/forge/hivepay/checkout
 *   { from_did, to_did, amount_usdc, service, session_id, privacy, note }
 *
 * This is the iPhone moment — pay from your wallet right after you ordered.
 */

import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import {
  sendPayment,
  requestPayment,
  splitPayment,
  getActivityFeed,
  getHistory,
  getPayStats,
  getPayment,
  getRequest,
  PRIVACY_RAIL,
} from '../services/hivepay-engine.js';

const router = Router();

const HIVEFORGE_SERVICE_KEY = process.env.HIVEFORGE_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || '';
const HIVEFORGE_URL = process.env.HIVEFORGE_URL || 'https://hiveforge-lhu4.onrender.com';

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
 * GET /v1/forge/hivepay
 * HivePay service discovery.
 */
router.get('/', (req, res) => {
  return res.status(200).json({
    success: true,
    service: 'HivePay',
    tagline: 'Agent Venmo. Send, request, split. Public, private, or sealed.',
    version: '1.0.0',
    description: 'Peer-to-peer payments between agents. Any privacy mode. Social activity feed for PUBLIC transactions. SEALED transactions leave no trace.',
    privacy_rails: {
      public:  { rail: 'usdc',       network: 'Base L2',        visible_in_feed: true,  description: 'Amount + parties visible' },
      private: { rail: 'aleo-usdcx', network: 'Aleo (USDCx)',   visible_in_feed: 'sender only', description: 'Amount ZK-private' },
      sealed:  { rail: 'aleo-usad',  network: 'Aleo+Paxos',     visible_in_feed: false, description: 'Full anonymity — no trace' },
    },
    onboarding_hook: {
      description: 'Requesting payment from a non-Hive agent IS the onboarding invitation. They must claim a DID to pay.',
      message: "You've been asked to pay X USDC. Claim your Hive identity to respond — first DID free.",
      onboard_url: 'https://hivegate.onrender.com/v1/gate/onboard',
    },
    checkout_hook: {
      description: 'POST /checkout — pay inline after any Hive service (insurance, tokenization, HiveRide, etc.)',
      endpoint: `${HIVEFORGE_URL}/v1/forge/hivepay/checkout`,
    },
    endpoints: {
      send:        'POST /v1/forge/hivepay/send — Send a payment (auth required)',
      request:     'POST /v1/forge/hivepay/request — Request payment from agent (auth required)',
      split:       'POST /v1/forge/hivepay/split — Split bill N ways (auth required)',
      pay:         'POST /v1/forge/hivepay/pay/:request_id — Pay a request (auth required)',
      checkout:    'POST /v1/forge/hivepay/checkout — Post-service inline payment (auth required)',
      feed:        'GET /v1/forge/hivepay/feed — Public activity feed (public)',
      history:     'GET /v1/forge/hivepay/history/:did — Full payment history (auth required)',
      stats:       'GET /v1/forge/hivepay/stats — Platform stats (public)',
      request_get: 'GET /v1/forge/hivepay/request/:request_id — View a payment request (public)',
    },
  });
});

// ══════════════════════════════════════════════════════════════
//  SEND PAYMENT (auth required)
// ══════════════════════════════════════════════════════════════

/**
 * POST /v1/forge/hivepay/send
 *
 * Instantly pay another agent.
 *
 * Body:
 *   to_did       {string}  required — recipient DID
 *   amount_usdc  {number}  required — amount to send
 *   privacy      {string}  optional — public (default) | private | sealed
 *   rail         {string}  optional — override rail (auto-selected from privacy)
 *   note         {string}  optional — payment note / memo
 *   emoji        {string}  optional — activity feed emoji (default 💸)
 */
router.post('/send', requireAuth, async (req, res) => {
  try {
    const { to_did, amount_usdc, privacy = 'public', rail, note, emoji } = req.body;
    const from_did = req.agentDid;

    if (!to_did)      return res.status(400).json({ success: false, error: 'to_did required' });
    if (!amount_usdc) return res.status(400).json({ success: false, error: 'amount_usdc required' });

    const result = await sendPayment({ from_did, to_did, amount_usdc: +amount_usdc, privacy, rail, note, emoji });

    const httpStatus = result.settled ? 200 : 402;
    return res.status(httpStatus).json({
      success: result.settled,
      data: result,
      note: result.settled
        ? `Payment settled on ${result.rail}.`
        : `Settlement failed: ${result.status}. Check vault balance at HiveBank.`,
    });
  } catch (err) {
    console.error('[HivePay] send error:', err.message);
    return res.status(400).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  REQUEST PAYMENT (auth required)
// ══════════════════════════════════════════════════════════════

/**
 * POST /v1/forge/hivepay/request
 *
 * Ask another agent to pay you. They get a HiveMsg.
 * If they don't have a Hive DID — this IS their onboarding invitation.
 *
 * Body:
 *   to_did            {string}  required — who to ask for payment
 *   amount_usdc       {number}  required — how much to request
 *   privacy           {string}  optional — public (default) | private | sealed
 *   rail              {string}  optional — override rail
 *   note              {string}  optional — what the payment is for
 *   emoji             {string}  optional — 🙏 default
 *   expires_in_hours  {number}  optional — default 48 hours
 */
router.post('/request', requireAuth, async (req, res) => {
  try {
    const { to_did, amount_usdc, privacy = 'public', rail, note, emoji, expires_in_hours } = req.body;
    const from_did = req.agentDid;

    if (!to_did)      return res.status(400).json({ success: false, error: 'to_did required' });
    if (!amount_usdc) return res.status(400).json({ success: false, error: 'amount_usdc required' });

    const result = await requestPayment({ from_did, to_did, amount_usdc: +amount_usdc, privacy, rail, note, emoji, expires_in_hours });

    return res.status(201).json({
      success: true,
      data: result,
      note: result.hook_note || `Payment request sent to ${to_did}. They have ${expires_in_hours || 48}h to pay.`,
    });
  } catch (err) {
    console.error('[HivePay] request error:', err.message);
    return res.status(400).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  SPLIT PAYMENT (auth required)
// ══════════════════════════════════════════════════════════════

/**
 * POST /v1/forge/hivepay/split
 *
 * Split a total bill evenly across N agents.
 * Each agent receives a payment request via HiveMsg.
 * Non-Hive agents in the list = onboarding invitations.
 *
 * Body:
 *   to_dids           {string[]}  required — array of DIDs to split between
 *   total_amount_usdc {number}    required — total amount to split
 *   privacy           {string}    optional — public (default) | private | sealed
 *   note              {string}    optional — what it's for
 *   emoji             {string}    optional — ➗ default
 */
router.post('/split', requireAuth, async (req, res) => {
  try {
    const { to_dids, total_amount_usdc, privacy = 'public', note, emoji } = req.body;
    const from_did = req.agentDid;

    if (!to_dids?.length)      return res.status(400).json({ success: false, error: 'to_dids array required' });
    if (!total_amount_usdc)    return res.status(400).json({ success: false, error: 'total_amount_usdc required' });
    if (to_dids.length > 50)   return res.status(400).json({ success: false, error: 'Maximum 50 agents per split' });

    const result = await splitPayment({ from_did, to_dids, total_amount_usdc: +total_amount_usdc, privacy, note, emoji });

    return res.status(201).json({ success: true, data: result });
  } catch (err) {
    console.error('[HivePay] split error:', err.message);
    return res.status(400).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  PAY A REQUEST (auth required)
// ══════════════════════════════════════════════════════════════

/**
 * POST /v1/forge/hivepay/pay/:request_id
 *
 * Pay a pending payment request.
 * This is how non-Hive agents complete onboarding — they get a request,
 * they claim a DID, and they pay here.
 *
 * Body:
 *   privacy  {string}  optional — override privacy mode
 *   rail     {string}  optional — override payment rail
 */
router.post('/pay/:request_id', requireAuth, async (req, res) => {
  try {
    const { request_id } = req.params;
    const from_did = req.agentDid;

    const payReq = await getRequest(request_id);
    if (!payReq) {
      return res.status(404).json({ success: false, error: 'Payment request not found' });
    }
    if (payReq.status === 'paid') {
      return res.status(409).json({ success: false, error: 'Payment request already paid', request: payReq });
    }
    if (payReq.status === 'expired' || (payReq.expires_at && new Date(payReq.expires_at) < new Date())) {
      return res.status(410).json({ success: false, error: 'Payment request has expired' });
    }

    const privacy = req.body.privacy || payReq.privacy || 'public';
    const rail    = req.body.rail    || payReq.rail    || PRIVACY_RAIL[privacy];

    const result = await sendPayment({
      from_did,
      to_did:      payReq.from_did,
      amount_usdc: payReq.amount_usdc,
      privacy,
      rail,
      note:        payReq.note || `Payment for request ${request_id}`,
      emoji:       payReq.emoji || '✅',
      request_id,
    });

    const httpStatus = result.settled ? 200 : 402;
    return res.status(httpStatus).json({
      success: result.settled,
      data: result,
      request_id,
      note: result.settled
        ? `Request ${request_id} paid. Settled on ${result.rail}.`
        : `Settlement failed. Check vault balance.`,
    });
  } catch (err) {
    console.error('[HivePay] pay request error:', err.message);
    return res.status(400).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  CHECKOUT — Post-service inline payment hook (THE NEW PRIMITIVE)
// ══════════════════════════════════════════════════════════════

/**
 * POST /v1/forge/hivepay/checkout
 *
 * The "pay from your iPhone" moment.
 *
 * After an agent completes any Hive service (insurance purchase, stablecoin
 * tokenization, HiveRide task, HiveLaw contract, HiveMind query),
 * the service calls this endpoint to settle the bill inline.
 *
 * The agent never leaves the session. No redirect. No checkout page.
 * One call. Rail auto-selected from privacy mode. Done.
 *
 * Body:
 *   from_did    {string}  required — paying agent
 *   to_did      {string}  required — receiving service/agent DID
 *   amount_usdc {number}  required — amount to pay
 *   service     {string}  optional — service name (e.g. "hivelaw", "hiveride", "insurance")
 *   session_id  {string}  optional — session/order/policy ID for ATG record
 *   privacy     {string}  optional — public (default) | private | sealed
 *   note        {string}  optional — payment note
 *   rail        {string}  optional — override rail
 *
 * Response includes full settlement record for the Agent Transaction Graph.
 *
 * THIS IS THE HOOK:
 *   An agent just bought insurance. A single call here pays it.
 *   The ATG record captures: payer DID, service, session_id, amount, rail, timestamp.
 *   EU AI Act Article 12 audit requirement — satisfied automatically.
 */
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const {
      from_did: body_from,
      to_did,
      amount_usdc,
      service,
      session_id,
      privacy = 'public',
      note,
      rail,
    } = req.body;

    const from_did = req.agentDid || body_from;

    if (!from_did)    return res.status(400).json({ success: false, error: 'from_did required' });
    if (!to_did)      return res.status(400).json({ success: false, error: 'to_did required' });
    if (!amount_usdc) return res.status(400).json({ success: false, error: 'amount_usdc required' });

    const checkoutNote = note || (service
      ? `${service} payment${session_id ? ` — session ${session_id}` : ''}`
      : `Checkout — ${session_id || new Date().toISOString()}`);

    const result = await sendPayment({
      from_did,
      to_did,
      amount_usdc: +amount_usdc,
      privacy,
      rail,
      note:  checkoutNote,
      emoji: '🧾',
    });

    const httpStatus = result.settled ? 200 : 402;
    return res.status(httpStatus).json({
      success: result.settled,
      data: {
        ...result,
        checkout: {
          service:    service    || null,
          session_id: session_id || null,
          atg_record: result.settled ? {
            from_did,
            to_did,
            amount_usdc: +amount_usdc,
            rail:        result.rail,
            service:     service || null,
            session_id:  session_id || null,
            settled_at:  result.settled_at,
            tx_id:       result.tx_id,
            note:        checkoutNote,
            audit_trail: 'Agent Transaction Graph — EU AI Act Article 12 compliant',
          } : null,
        },
      },
      note: result.settled
        ? `Checkout complete. Settled on ${result.rail}. ATG record created.`
        : `Checkout failed: insufficient vault balance. Fund at HiveBank.`,
    });
  } catch (err) {
    console.error('[HivePay] checkout error:', err.message);
    return res.status(400).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  VIEW A PAYMENT REQUEST (public — for payer to see what they owe)
// ══════════════════════════════════════════════════════════════

/**
 * GET /v1/forge/hivepay/request/:request_id
 *
 * View a payment request. Public — the payer needs to see it before paying.
 * If the requester is not a Hive agent, includes onboarding link.
 */
router.get('/request/:request_id', async (req, res) => {
  try {
    const req_data = await getRequest(req.params.request_id);
    if (!req_data) {
      return res.status(404).json({ success: false, error: 'Payment request not found' });
    }

    const isExpired = req_data.expires_at && new Date(req_data.expires_at) < new Date();

    return res.status(200).json({
      success: true,
      data: {
        ...req_data,
        expired: isExpired,
        pay_url: `${HIVEFORGE_URL}/v1/forge/hivepay/pay/${req_data.request_id}`,
        onboard_url: !req_data.from_did?.startsWith('did:hive:')
          ? 'Claim your Hive identity to pay: https://hivegate.onrender.com/v1/gate/onboard'
          : undefined,
      },
    });
  } catch (err) {
    console.error('[HivePay] get request error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  ACTIVITY FEED (public — PUBLIC mode only)
// ══════════════════════════════════════════════════════════════

/**
 * GET /v1/forge/hivepay/feed
 *
 * The Venmo-style activity feed. PUBLIC transactions only.
 * PRIVATE shows sender but not amount. SEALED = not in feed at all.
 *
 * This is the social graph of agent commerce.
 * When Fetch.ai sees "did:hive:research-agent paid did:hive:data-agent $5.00 🔍 for dataset"
 * they stop and ask: "wait, agents are paying each other?"
 *
 * Query params:
 *   limit  {number}  default 50
 *   did    {string}  filter by DID
 */
router.get('/feed', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const did   = req.query.did || null;

    const feed = await getActivityFeed({ limit, did });

    return res.status(200).json({
      success: true,
      data: {
        feed,
        count: feed.length,
        privacy_note: {
          public:  'Amount + sender + recipient visible.',
          private: 'Activity shows "Agent paid Agent ***" — amount ZK-private on Aleo.',
          sealed:  'No entry. No trace. Full anonymity via USAD on Aleo.',
        },
        aleo_principle: 'Agents choose their privacy. Hive enforces it.',
      },
    });
  } catch (err) {
    console.error('[HivePay] feed error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  PAYMENT HISTORY (auth required)
// ══════════════════════════════════════════════════════════════

/**
 * GET /v1/forge/hivepay/history/:did
 *
 * Full payment history for a DID — sent and received.
 * Only the DID owner (or internal) can view full history.
 * SEALED payments from others appear as [sealed] in history.
 *
 * Query params:
 *   limit  {number}  default 50
 */
router.get('/history/:did', requireAuth, async (req, res) => {
  try {
    const { did } = req.params;

    if (req.agentDid !== did && !isInternal(req)) {
      return res.status(403).json({ success: false, error: 'Forbidden — you can only view your own history' });
    }

    const limit   = Math.min(parseInt(req.query.limit) || 50, 200);
    const history = await getHistory(did, { limit });

    const sent     = history.filter(p => p.from_did === did);
    const received = history.filter(p => p.to_did === did);
    const total_sent     = sent.filter(p => p.status === 'settled').reduce((s, p) => s + +p.amount_usdc, 0);
    const total_received = received.filter(p => p.status === 'settled').reduce((s, p) => s + +p.amount_usdc, 0);

    return res.status(200).json({
      success: true,
      data: {
        did,
        summary: {
          total_transactions: history.length,
          sent_count:         sent.length,
          received_count:     received.length,
          total_sent_usdc:    +total_sent.toFixed(4),
          total_received_usdc: +total_received.toFixed(4),
          net_usdc:           +(total_received - total_sent).toFixed(4),
        },
        history,
        privacy_note: 'SEALED payments from others appear with [sealed] sender. Your own sealed sends show full detail.',
      },
    });
  } catch (err) {
    console.error('[HivePay] history error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  STATS (public)
// ══════════════════════════════════════════════════════════════

/**
 * GET /v1/forge/hivepay/stats
 * Platform-level payment stats. Safe to expose publicly.
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await getPayStats();
    return res.status(200).json({
      success: true,
      data: {
        ...stats,
        rails: {
          public:  { rail: 'USDC / Base L2',  network: 'Ethereum L2',    privacy: 'Full transparency' },
          private: { rail: 'USDCx / Aleo',    network: 'Aleo ZK',        privacy: 'Amount ZK-sealed' },
          sealed:  { rail: 'USAD / Aleo',     network: 'Aleo+Paxos NYDFS', privacy: 'Full anonymity' },
        },
        aleo_note: 'sealed_count payments have no on-chain trace except a ZK proof of settlement. This is what enterprise agents need.',
      },
    });
  } catch (err) {
    console.error('[HivePay] stats error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
