/**
 * HiveForge — HiveShip Routes
 *
 * Agentic courier and payload delivery layer.
 * FedEx/UPS for the agent economy — signed payloads, escrow delivery,
 * and cross-network drops in one API.
 *
 * ─── ENDPOINTS ──────────────────────────────────────────────────────────────
 *
 * PUBLIC (no auth):
 *   GET   /v1/forge/ship/track/:shipment_id    — Track status + custody chain
 *   GET   /v1/forge/ship/history/:did          — All shipments for a DID
 *   GET   /v1/forge/ship/receipt/:shipment_id  — W3C VC receipt (CERTIFIED)
 *   GET   /v1/forge/ship/stats                 — Platform stats
 *   GET   /v1/forge/ship/hq                    — Full capability card
 *
 * AUTHENTICATED (x-hive-did header required):
 *   POST  /v1/forge/ship/send                  — Create and dispatch a shipment
 *   POST  /v1/forge/ship/sign/:shipment_id     — Sign and release ESCROW
 *   POST  /v1/forge/ship/dispute/:shipment_id  — Dispute ESCROW shipment
 *   POST  /v1/forge/ship/return/:shipment_id   — Initiate return shipment
 *
 * ─── THE MOAT ────────────────────────────────────────────────────────────────
 *
 * Every shipment = immutable EU AI Act Article 12 chain-of-custody record.
 * Every custody_chain entry is SHA-256 anchored.
 * CERTIFIED shipments issue a W3C VC receipt signed by HiveLaw —
 * legally admissible in one API call.
 *
 * ─── RATE LIMITS ─────────────────────────────────────────────────────────────
 *
 * Send:   20 shipments / 60 seconds per IP
 * Sign:   30 requests / 60 seconds per IP
 * Track:  120 requests / 60 seconds per IP (public, generous)
 */

import { Router }      from 'express';
import rateLimit       from 'express-rate-limit';
import {
  createShipment,
  getShipment,
  deliverShipment,
  signAndRelease,
  disputeEscrow,
  returnShipment,
  getShipmentsByDid,
  expireOverdue,
  getStats,
  issueVCReceipt,
  RATES,
  ESCROW_RATE,
  ESCROW_MIN,
  SHIPMENT_TYPES,
  STATUS,
} from '../services/hiveship-engine.js';

const router = Router();

// ─── Rate limiters ────────────────────────────────────────────────────────────

/** Strict limiter for shipment creation — prevents spam sends. */
const sendLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max:      20,
  message:  { ok: false, error: 'rate_limited', message: 'Too many shipments — limit 20/min per IP' },
  standardHeaders: true,
  legacyHeaders:   false,
});

/** Sign/dispute/return — moderately strict. */
const actionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  message:  { ok: false, error: 'rate_limited', message: 'Too many requests — limit 30/min per IP' },
  standardHeaders: true,
  legacyHeaders:   false,
});

/** Public tracking — generous limit. */
const trackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      120,
  message:  { ok: false, error: 'rate_limited', message: 'Too many tracking requests — limit 120/min per IP' },
  standardHeaders: true,
  legacyHeaders:   false,
});

// ─── Response helpers ─────────────────────────────────────────────────────────

/** Standard HiveShip meta envelope appended to every response. */
function shipMeta() {
  return {
    service:    'HiveShip',
    version:    '1.0.0',
    timestamp:  new Date().toISOString(),
    atg_record: true,
  };
}

/**
 * ok(res, data, status)
 * Sends a successful JSON response with HiveShip meta.
 */
function ok(res, data, status = 200) {
  return res.status(status).json({
    ok:   true,
    ...shipMeta(),
    ...data,
  });
}

/**
 * fail(res, message, code, error_key)
 * Sends a failure JSON response with HiveShip meta.
 */
function fail(res, message, code = 400, error_key = 'bad_request') {
  return res.status(code).json({
    ok:      false,
    error:   error_key,
    message,
    ...shipMeta(),
  });
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

/**
 * requireDID(req, res, next)
 *
 * Validates the x-hive-did header. Sets req.agentDid.
 * Returns 401 if missing.
 */
function requireDID(req, res, next) {
  const did = req.headers['x-hive-did'];
  if (!did) {
    return res.status(401).json({
      ok:      false,
      error:   'did_required',
      message: 'x-hive-did header required for authenticated endpoints',
      ...shipMeta(),
    });
  }
  req.agentDid = did;
  return next();
}

// ══════════════════════════════════════════════════════════════════════════════
//  POST /send — Create and dispatch a shipment
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /v1/forge/ship/send
 *
 * Creates a new shipment and immediately attempts delivery for non-SCHEDULED
 * non-ESCROW types by calling deliverShipment internally.
 *
 * Body:
 *   sender_did          {string}          required — Originating DID (or falls back to x-hive-did)
 *   recipient           {string|object}   required — DID string or { type, address } for CROSS_NET
 *   type                {string}          required — STANDARD | CERTIFIED | ESCROW | CROSS_NET | SCHEDULED | RETURN
 *   payload             {object}          required — Any JSON payload
 *   payload_value_usdc  {number}          required for ESCROW
 *   rail                {string}          optional — default 'usdc'
 *   scheduled_at        {string|null}     optional — ISO timestamp for SCHEDULED
 *   ttl_hours           {number}          optional — default 72
 *   note                {string|null}     optional
 *
 * Returns: Full shipment record + computed fee
 */
router.post('/send', sendLimiter, requireDID, async (req, res) => {
  try {
    const {
      type,
      payload,
      payload_value_usdc = 0,
      rail,
      scheduled_at       = null,
      ttl_hours          = 72,
      note               = null,
    } = req.body;

    // Resolve sender: body field takes precedence, falls back to header DID
    const sender_did = req.body.sender_did || req.agentDid;
    const recipient  = req.body.recipient;

    // ── Validate required fields ───────────────────────────────────────────
    if (!recipient)       return fail(res, 'recipient required', 400, 'recipient_required');
    if (!type)            return fail(res, 'type required. Options: ' + Object.keys(SHIPMENT_TYPES).join(', '), 400, 'type_required');
    if (payload === undefined || payload === null) {
      return fail(res, 'payload required (may be empty object {})', 400, 'payload_required');
    }
    if (!SHIPMENT_TYPES[type?.toUpperCase()]) {
      return fail(res,
        `Unknown shipment type: ${type}. Valid: ${Object.keys(SHIPMENT_TYPES).join(', ')}`,
        400, 'invalid_type'
      );
    }

    // ── Create shipment ────────────────────────────────────────────────────
    const shipment = await createShipment(
      sender_did,
      recipient,
      type.toUpperCase(),
      payload,
      { rail, scheduled_at, payload_value_usdc: +payload_value_usdc, note, ttl_hours: +ttl_hours }
    );

    // ── Auto-deliver for immediately-dispatchable types ────────────────────
    // ESCROW: stays AWAITING_SIGNATURE (needs countersign)
    // SCHEDULED: stays PENDING until scheduled_at
    let delivered_shipment = shipment;
    if (!['ESCROW', 'SCHEDULED'].includes(shipment.type)) {
      try {
        delivered_shipment = await deliverShipment(shipment.shipment_id);
      } catch (deliveryErr) {
        // Delivery simulation failure is non-fatal — shipment is still created
        console.warn('[HiveShip] Delivery simulation warning:', deliveryErr.message);
      }
    }

    return ok(res, {
      shipment:        delivered_shipment,
      fee_usdc:        delivered_shipment.fee_usdc,
      tracking_url:    `/v1/forge/ship/track/${delivered_shipment.shipment_id}`,
      custody_chain:   delivered_shipment.custody_chain,
      eu_ai_act:       'Article 12 chain-of-custody record created',
    }, 201);

  } catch (e) {
    console.error('[HiveShip] send error:', e.message);
    if (e.message.includes('payload_value_usdc')) return fail(res, e.message, 422, 'escrow_value_required');
    if (e.message.includes('scheduled_at'))       return fail(res, e.message, 422, 'invalid_scheduled_at');
    if (e.message.includes('CROSS_NET'))          return fail(res, e.message, 422, 'cross_net_recipient_required');
    return fail(res, e.message, 400, 'send_error');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  GET /track/:shipment_id — Track a shipment
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /v1/forge/ship/track/:shipment_id
 *
 * Public tracking endpoint. Returns full status and complete custody chain.
 * The custody_chain is the immutable audit trail — every state transition
 * is SHA-256 anchored and EU AI Act Article 12 compliant.
 *
 * Params:
 *   shipment_id  {string}  required — shp_... ID
 */
router.get('/track/:shipment_id', trackLimiter, async (req, res) => {
  try {
    const shipment = await getShipment(req.params.shipment_id);

    if (!shipment) {
      return fail(res, `Shipment ${req.params.shipment_id} not found`, 404, 'not_found');
    }

    return ok(res, {
      shipment_id:   shipment.shipment_id,
      type:          shipment.type,
      status:        shipment.status,
      sender_did:    shipment.sender_did,
      recipient:     shipment.recipient,
      fee_usdc:      shipment.fee_usdc,
      rail:          shipment.rail,
      note:          shipment.note,
      scheduled_at:  shipment.scheduled_at,
      created_at:    shipment.created_at,
      expires_at:    shipment.expires_at,
      delivered_at:  shipment.delivered_at,
      returned_at:   shipment.returned_at,
      return_shipment_id: shipment.return_shipment_id,
      vc_receipt_id: shipment.vc_receipt_id,
      custody_chain: shipment.custody_chain,
      atg_record:    shipment.atg_record,
      eu_ai_act_article_12: shipment.eu_ai_act_article_12,
    });

  } catch (e) {
    console.error('[HiveShip] track error:', e.message);
    return fail(res, e.message, 500, 'server_error');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  POST /sign/:shipment_id — Sign and release ESCROW
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /v1/forge/ship/sign/:shipment_id
 *
 * Recipient countersigns an ESCROW shipment, triggering conditional release.
 * The x-hive-did must match the shipment's recipient DID.
 *
 * Transitions: AWAITING_SIGNATURE → RELEASED
 * Returns a full settlement record with released payload value.
 *
 * Params:
 *   shipment_id  {string}  required — shp_... ID
 */
router.post('/sign/:shipment_id', actionLimiter, requireDID, async (req, res) => {
  try {
    const { shipment_id } = req.params;
    const recipient_did   = req.agentDid;

    const settlement = await signAndRelease(shipment_id, recipient_did);

    return ok(res, {
      settlement,
      message: `Escrow ${shipment_id} released. Settlement complete.`,
    });

  } catch (e) {
    console.error('[HiveShip] sign error:', e.message);
    if (e.message.includes('not found'))               return fail(res, e.message, 404, 'not_found');
    if (e.message.includes('not awaiting signature'))  return fail(res, e.message, 409, 'wrong_state');
    if (e.message.includes('expired'))                 return fail(res, e.message, 410, 'expired');
    if (e.message.includes('only applies'))            return fail(res, e.message, 422, 'not_escrow');
    return fail(res, e.message, 400, 'sign_error');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  POST /dispute/:shipment_id — Dispute an ESCROW shipment
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /v1/forge/ship/dispute/:shipment_id
 *
 * Raises a dispute on an ESCROW shipment. Funds are frozen and the shipment
 * is escalated to HiveLaw arbitration. Requires the disputing party's DID.
 *
 * Body:
 *   reason  {string}  optional — Human-readable dispute reason
 *
 * Params:
 *   shipment_id  {string}  required — shp_... ID
 */
router.post('/dispute/:shipment_id', actionLimiter, requireDID, async (req, res) => {
  try {
    const { shipment_id } = req.params;
    const { reason }      = req.body;
    const disputing_did   = req.agentDid;

    const shipment = await disputeEscrow(shipment_id, disputing_did, reason || null);

    return ok(res, {
      shipment,
      message:         `Escrow ${shipment_id} disputed. Escalated to HiveLaw arbitration.`,
      hivelaw_arbiter: 'did:hive:hivelaw',
    });

  } catch (e) {
    console.error('[HiveShip] dispute error:', e.message);
    if (e.message.includes('not found'))    return fail(res, e.message, 404, 'not_found');
    if (e.message.includes('Cannot dispute')) return fail(res, e.message, 409, 'wrong_state');
    if (e.message.includes('only applies')) return fail(res, e.message, 422, 'not_escrow');
    return fail(res, e.message, 400, 'dispute_error');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  POST /return/:shipment_id — Initiate return shipment
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /v1/forge/ship/return/:shipment_id
 *
 * Initiates a return shipment from the current recipient back to the
 * original sender. Creates a new RETURN-type shipment and marks the
 * original as RETURNED. The returner's DID is taken from x-hive-did.
 *
 * Params:
 *   shipment_id  {string}  required — shp_... ID of original shipment
 */
router.post('/return/:shipment_id', actionLimiter, requireDID, async (req, res) => {
  try {
    const { shipment_id } = req.params;
    const returner_did    = req.agentDid;

    const result = await returnShipment(shipment_id, returner_did);

    return ok(res, {
      original_shipment:  result.original,
      return_shipment:    result.return_shipment,
      message:            `Return shipment created: ${result.return_shipment.shipment_id}`,
      tracking_url:       `/v1/forge/ship/track/${result.return_shipment.shipment_id}`,
    }, 201);

  } catch (e) {
    console.error('[HiveShip] return error:', e.message);
    if (e.message.includes('not found'))       return fail(res, e.message, 404, 'not_found');
    if (e.message.includes('Cannot return'))   return fail(res, e.message, 409, 'wrong_state');
    return fail(res, e.message, 400, 'return_error');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  GET /history/:did — All shipments for a DID
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /v1/forge/ship/history/:did
 *
 * Returns all shipments where the DID is sender or recipient.
 * Sorted newest-first. Includes both sent and received shipments.
 * Public endpoint — useful for agent-to-agent discovery.
 *
 * Params:
 *   did  {string}  required — Agent DID
 */
router.get('/history/:did', trackLimiter, async (req, res) => {
  try {
    const { did }     = req.params;
    const shipments   = await getShipmentsByDid(did);

    const sent        = shipments.filter(s => s.sender_did === did);
    const received    = shipments.filter(s => s.did_or_endpoint === did);

    return ok(res, {
      did,
      total:    shipments.length,
      sent:     sent.length,
      received: received.length,
      shipments,
    });

  } catch (e) {
    console.error('[HiveShip] history error:', e.message);
    return fail(res, e.message, 500, 'server_error');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  GET /receipt/:shipment_id — W3C VC receipt
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /v1/forge/ship/receipt/:shipment_id
 *
 * Returns the W3C Verifiable Credential delivery receipt for a CERTIFIED
 * shipment. The VC is signed by HiveLaw (did:hive:hivelaw) and includes
 * the full custody chain, payload hash, and delivery proof.
 *
 * Legally admissible under EU AI Act Article 12.
 * Only available for CERTIFIED shipments that have been delivered.
 *
 * Params:
 *   shipment_id  {string}  required — shp_... ID
 */
router.get('/receipt/:shipment_id', trackLimiter, async (req, res) => {
  try {
    const { shipment_id } = req.params;

    // Validate the shipment exists first for clear error messages
    const shipment = await getShipment(shipment_id);
    if (!shipment) {
      return fail(res, `Shipment ${shipment_id} not found`, 404, 'not_found');
    }
    if (shipment.type !== 'CERTIFIED') {
      return fail(res,
        `VC receipts are only issued for CERTIFIED shipments (type: ${shipment.type})`,
        422, 'not_certified'
      );
    }
    if (!['DELIVERED', 'RELEASED'].includes(shipment.status)) {
      return fail(res,
        `VC receipt not yet available — shipment status: ${shipment.status}. Deliver first.`,
        409, 'not_delivered'
      );
    }

    const vc = await issueVCReceipt(shipment_id);

    return ok(res, {
      vc_receipt:          vc,
      legally_admissible:  true,
      eu_ai_act_article_12: true,
      issuer:              'did:hive:hivelaw',
    });

  } catch (e) {
    console.error('[HiveShip] receipt error:', e.message);
    if (e.message.includes('not found'))     return fail(res, e.message, 404, 'not_found');
    if (e.message.includes('CERTIFIED'))     return fail(res, e.message, 422, 'not_certified');
    if (e.message.includes('not yet'))       return fail(res, e.message, 409, 'not_delivered');
    return fail(res, e.message, 500, 'server_error');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  GET /stats — Platform-wide stats
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /v1/forge/ship/stats
 *
 * Platform-level HiveShip statistics.
 * No individual shipment data exposed — safe to make public.
 * Includes per-type breakdown, per-status breakdown, and revenue totals.
 */
router.get('/stats', trackLimiter, async (req, res) => {
  try {
    const stats = await getStats();
    return ok(res, { stats });
  } catch (e) {
    console.error('[HiveShip] stats error:', e.message);
    return fail(res, e.message, 500, 'server_error');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  GET /hq — Full capability card
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /v1/forge/ship/hq
 *
 * HiveShip product discovery endpoint.
 * Returns the full capability card: types, pricing, lifecycle, custody chain
 * explanation, EU AI Act compliance note, and live platform stats.
 * This is what an agent sees on first discovery of HiveShip.
 */
router.get('/hq', trackLimiter, async (req, res) => {
  try {
    const stats = await getStats();

    return ok(res, {
      service:  'HiveShip',
      tagline:  'Agentic courier and payload delivery layer — FedEx/UPS for the agent economy',
      status:   'live',

      // ── Shipment types ──────────────────────────────────────────────────
      shipment_types: {
        STANDARD: {
          description:   'Deliver any JSON payload to a DID endpoint via webhook. The baseline shipment.',
          price_usdc:    RATES.STANDARD,
          delivery:      'Immediate',
          receipt:       'None',
        },
        CERTIFIED: {
          description:   'STANDARD + W3C Verifiable Credential receipt signed by HiveLaw. ' +
                         'Legally admissible under EU AI Act Article 12. ' +
                         'FedEx Certified Mail + legal admissibility in one API call.',
          price_usdc:    RATES.CERTIFIED,
          delivery:      'Immediate',
          receipt:       'W3C VC signed by did:hive:hivelaw',
        },
        ESCROW: {
          description:   'Conditional release delivery. Payload and value locked until recipient countersigns. ' +
                         'HiveLaw enforces the contract. Dispute escalation built in.',
          price_usdc:    `${ESCROW_RATE * 100}% of payload_value_usdc (minimum $${ESCROW_MIN})`,
          delivery:      'On recipient countersignature',
          receipt:       'Settlement record + ATG anchor',
        },
        CROSS_NET: {
          description:   'Deliver to non-Hive endpoints: webhook URLs, email addresses, IPFS CIDs, Arweave TxIDs. ' +
                         'The bridge between the Hive economy and legacy systems.',
          price_usdc:    RATES.CROSS_NET,
          delivery:      'Immediate (bridge-routed)',
          receipt:       'ATG anchor only',
          recipient_format: '{ type: "webhook"|"email"|"ipfs"|"arweave", address: "..." }',
        },
        SCHEDULED: {
          description:   'Deferred delivery at a future ISO 8601 timestamp. ' +
                         'Payload is locked in escrow until the scheduled time.',
          price_usdc:    RATES.SCHEDULED,
          delivery:      'At scheduled_at timestamp',
          receipt:       'None (CERTIFIED not available for SCHEDULED)',
        },
        RETURN: {
          description:   'Recipient-initiated return of a previous shipment back to the original sender. ' +
                         'Preserves the original custody chain and adds a RETURNED event.',
          price_usdc:    RATES.RETURN,
          delivery:      'Immediate',
          receipt:       'None',
        },
      },

      // ── Pricing table ───────────────────────────────────────────────────
      pricing_table: [
        { type: 'STANDARD',  price: `$${RATES.STANDARD} flat` },
        { type: 'CERTIFIED', price: `$${RATES.CERTIFIED} flat` },
        { type: 'ESCROW',    price: `${ESCROW_RATE * 100}% of payload_value_usdc, min $${ESCROW_MIN}` },
        { type: 'CROSS_NET', price: `$${RATES.CROSS_NET} flat` },
        { type: 'SCHEDULED', price: `$${RATES.SCHEDULED} flat` },
        { type: 'RETURN',    price: `$${RATES.RETURN} flat` },
      ],

      // ── Status lifecycle diagram ────────────────────────────────────────
      status_lifecycle: {
        standard_certified_cross_net_scheduled_return:
          'PENDING → IN_TRANSIT → DELIVERED\n' +
          '                     → FAILED\n' +
          '                     → RETURNED\n' +
          'PENDING → EXPIRED    (TTL exceeded before delivery)',
        escrow:
          'PENDING → AWAITING_SIGNATURE → RELEASED  (countersigned by recipient)\n' +
          '                             → DISPUTED  (escalated to HiveLaw)\n' +
          '                             → EXPIRED   (TTL exceeded without signature)',
        notes: [
          'Default TTL: 72 hours (overridable via ttl_hours)',
          'expireOverdue() should be called periodically to sweep stale shipments',
          'Terminal states: DELIVERED, RELEASED, FAILED, RETURNED, EXPIRED',
        ],
      },

      // ── Custody chain ───────────────────────────────────────────────────
      custody_chain: {
        description:
          'Every state transition appends an immutable entry to custody_chain[]. ' +
          'Each entry is anchored by a SHA-256 hash of "shipment_id:event:timestamp". ' +
          'The chain is append-only and returned on every tracking response.',
        entry_shape: {
          event:          'e.g. CREATED | IN_TRANSIT | DELIVERED | SIGNED | RELEASED | DISPUTED | RETURNED | EXPIRED',
          from_did:       'DID of the actor initiating the transition',
          to_did:         'DID or endpoint of the receiving party',
          timestamp:      'ISO 8601 timestamp of the transition',
          signature_hash: 'SHA-256( shipment_id + ":" + event + ":" + timestamp )',
        },
      },

      // ── EU AI Act Article 12 compliance ────────────────────────────────
      eu_ai_act_article_12: {
        compliant: true,
        note:
          'Every HiveShip shipment creates an immutable chain-of-custody record ' +
          'anchored to the Agent Transaction Graph (ATG). ' +
          'CERTIFIED shipments additionally issue a W3C Verifiable Credential signed by HiveLaw ' +
          '(did:hive:hivelaw), providing legally admissible delivery proof. ' +
          'Hive is the only network where a single API call satisfies ' +
          'EU AI Act Article 12 audit trail requirements AND delivers certified payload receipt.',
        atg_anchor: 'Every shipment sets atg_record: true and eu_ai_act_article_12: true',
        hivelaw_vc: 'CERTIFIED shipments receive a W3C VC — verifiable by any conforming VC verifier',
      },

      // ── Revenue model ───────────────────────────────────────────────────
      revenue_model: {
        per_shipment_fees:
          'Flat or percentage fee per shipment (see pricing_table). ' +
          'All fees denominated in USDC.',
        escrow_premium:
          '1% on all escrow value flows — high-value agent transactions are the primary revenue driver.',
        certified_premium:
          '$0.50 per certified delivery — 5x the standard rate. ' +
          'Legal admissibility commands a significant premium in regulated industries.',
        cross_net_bridge:
          '$0.25 per cross-network drop — bridge toll for non-Hive endpoints.',
        volume_outlook:
          'In an agent economy where millions of agents transact daily, ' +
          'even low per-shipment fees compound to significant revenue at scale.',
      },

      // ── Endpoints ───────────────────────────────────────────────────────
      endpoints: {
        send:    'POST /v1/forge/ship/send                 — Create & dispatch shipment (auth)',
        track:   'GET  /v1/forge/ship/track/:shipment_id  — Track status + custody chain (public)',
        sign:    'POST /v1/forge/ship/sign/:shipment_id   — Countersign ESCROW (auth)',
        dispute: 'POST /v1/forge/ship/dispute/:shipment_id — Dispute ESCROW (auth)',
        return:  'POST /v1/forge/ship/return/:shipment_id — Initiate return (auth)',
        history: 'GET  /v1/forge/ship/history/:did        — All shipments for a DID (public)',
        receipt: 'GET  /v1/forge/ship/receipt/:shipment_id — W3C VC receipt, CERTIFIED only (public)',
        stats:   'GET  /v1/forge/ship/stats               — Platform stats (public)',
        hq:      'GET  /v1/forge/ship/hq                  — This capability card (public)',
      },

      // ── Auth ─────────────────────────────────────────────────────────────
      auth: {
        header:      'x-hive-did',
        description: 'Set x-hive-did to your agent DID for authenticated endpoints',
        public_endpoints: ['track', 'history', 'receipt', 'stats', 'hq'],
        auth_endpoints:   ['send', 'sign', 'dispute', 'return'],
      },

      // ── Live stats ───────────────────────────────────────────────────────
      live_stats: stats,
    });

  } catch (e) {
    console.error('[HiveShip] hq error:', e.message);
    return fail(res, e.message, 500, 'server_error');
  }
});

export default router;
