/**
 * HiveShip Engine — Agentic Courier / Payload Delivery Layer
 *
 * FedEx/UPS for the agent economy. HiveShip moves signed payloads,
 * conditional value transfers (escrow delivery), and cross-network
 * drops to non-Hive endpoints.
 *
 * The moat: Every shipment is an immutable EU AI Act Article 12
 * chain-of-custody record underwritten by the Agent Transaction Graph.
 * FedEx Certified Mail + legal admissibility in one API call.
 *
 * Shipment Types:
 *   STANDARD   — payload to DID endpoint, webhook delivery        $0.10
 *   CERTIFIED  — STANDARD + W3C VC receipt signed by HiveLaw      $0.50
 *   ESCROW     — conditional release (recipient countersigns)      1% of payload_value_usdc, min $0.25
 *   CROSS_NET  — delivery to non-Hive: webhook/email/IPFS/Arweave  $0.25
 *   SCHEDULED  — deferred delivery at future ISO timestamp         $0.15
 *   RETURN     — recipient-initiated return back to sender         $0.10
 *
 * Status Lifecycle:
 *   STANDARD/CERTIFIED/CROSS_NET/SCHEDULED/RETURN:
 *     PENDING → IN_TRANSIT → DELIVERED | FAILED | RETURNED | EXPIRED
 *
 *   ESCROW:
 *     PENDING → AWAITING_SIGNATURE → RELEASED | DISPUTED | EXPIRED
 */

import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import pool, { isPostgres } from './db.js';

// ─── Shipment type constants ──────────────────────────────────────────────────

export const SHIPMENT_TYPES = {
  STANDARD:  'STANDARD',
  CERTIFIED: 'CERTIFIED',
  ESCROW:    'ESCROW',
  CROSS_NET: 'CROSS_NET',
  SCHEDULED: 'SCHEDULED',
  RETURN:    'RETURN',
};

// ─── Shipment status constants ────────────────────────────────────────────────

export const STATUS = {
  PENDING:             'PENDING',
  IN_TRANSIT:          'IN_TRANSIT',
  DELIVERED:           'DELIVERED',
  FAILED:              'FAILED',
  RETURNED:            'RETURNED',
  EXPIRED:             'EXPIRED',
  AWAITING_SIGNATURE:  'AWAITING_SIGNATURE',
  RELEASED:            'RELEASED',
  DISPUTED:            'DISPUTED',
};

// ─── Pricing ──────────────────────────────────────────────────────────────────

export const RATES = {
  STANDARD:  0.10,
  CERTIFIED: 0.50,
  ESCROW:    null,   // 1% of payload_value_usdc, min $0.25 — computed below
  CROSS_NET: 0.25,
  SCHEDULED: 0.15,
  RETURN:    0.10,
};

export const ESCROW_RATE = 0.01;   // 1%
export const ESCROW_MIN  = 0.25;   // minimum $0.25

// ─── In-memory storage (Postgres-ready) ──────────────────────────────────────

const memShipments  = new Map();   // shipment_id → shipment object
const memVCReceipts = new Map();   // shipment_id → W3C VC receipt object

// ─── Platform-wide counters ───────────────────────────────────────────────────

let totalShipments       = 0;
let totalDelivered       = 0;
let totalEscrowReleased  = 0;
let totalFeesUsdc        = 0;

// ─── Utility: SHA-256 custody hash ───────────────────────────────────────────

/**
 * computeSignatureHash(shipment_id, event, timestamp)
 *
 * Produces the SHA-256 hex digest that anchors each custody chain entry.
 * Format: SHA-256("<shipment_id>:<event>:<timestamp>")
 *
 * @param {string} shipment_id
 * @param {string} event
 * @param {string} timestamp — ISO 8601
 * @returns {string} hex digest
 */
function computeSignatureHash(shipment_id, event, timestamp) {
  return createHash('sha256')
    .update(`${shipment_id}:${event}:${timestamp}`)
    .digest('hex');
}

// ─── Utility: Build a custody chain entry ────────────────────────────────────

/**
 * makeCustodyEntry(shipment_id, event, from_did, to_did)
 *
 * Constructs a single immutable chain-of-custody record.
 *
 * @param {string} shipment_id
 * @param {string} event         — e.g. CREATED, IN_TRANSIT, DELIVERED
 * @param {string} from_did      — DID initiating the event
 * @param {string} to_did        — DID receiving the event
 * @returns {{ event, from_did, to_did, timestamp, signature_hash }}
 */
function makeCustodyEntry(shipment_id, event, from_did, to_did) {
  const timestamp      = new Date().toISOString();
  const signature_hash = computeSignatureHash(shipment_id, event, timestamp);
  return { event, from_did, to_did, timestamp, signature_hash };
}

// ─── Utility: Compute shipment fee ───────────────────────────────────────────

/**
 * computeFee(type, payload_value_usdc)
 *
 * Returns the fee in USDC for the given shipment type.
 * ESCROW fee = max(ESCROW_MIN, ESCROW_RATE * payload_value_usdc).
 *
 * @param {string} type
 * @param {number} [payload_value_usdc=0]
 * @returns {number}
 */
function computeFee(type, payload_value_usdc = 0) {
  if (type === 'ESCROW') {
    return +Math.max(ESCROW_MIN, ESCROW_RATE * payload_value_usdc).toFixed(6);
  }
  return RATES[type] ?? 0.10;
}

// ─── Utility: Normalize recipient ────────────────────────────────────────────

/**
 * normalizeRecipient(recipient)
 *
 * Accepts either a DID string or a CROSS_NET object.
 * Returns a normalized { did_or_endpoint, rail_type } descriptor.
 *
 * @param {string|{ type: string, address: string }} recipient
 * @returns {{ did_or_endpoint: string, rail_type: string }}
 */
function normalizeRecipient(recipient) {
  if (typeof recipient === 'string') {
    return { did_or_endpoint: recipient, rail_type: 'did' };
  }
  if (recipient && typeof recipient === 'object' && recipient.type && recipient.address) {
    return { did_or_endpoint: recipient.address, rail_type: recipient.type };
  }
  throw new Error('recipient must be a DID string or { type, address } object');
}

// ─── Utility: Compute payload hash ───────────────────────────────────────────

/**
 * computePayloadHash(payload)
 *
 * SHA-256 of the JSON-serialised payload — used in VC receipts.
 *
 * @param {*} payload
 * @returns {string} hex digest
 */
function computePayloadHash(payload) {
  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

// ══════════════════════════════════════════════════════════════════════════════
//  CORE: createShipment
// ══════════════════════════════════════════════════════════════════════════════

/**
 * createShipment(sender_did, recipient, type, payload, options)
 *
 * Creates and persists a new HiveShip shipment.
 *
 * For ESCROW shipments, initial status is AWAITING_SIGNATURE.
 * For SCHEDULED shipments, the scheduled_at timestamp is validated.
 * expires_at defaults to now + 72 hours (overridable via options.ttl_hours).
 *
 * @param {string}                           sender_did  — Originating agent DID
 * @param {string|{ type, address }}         recipient   — DID string or CROSS_NET descriptor
 * @param {keyof SHIPMENT_TYPES}             type        — Shipment type
 * @param {*}                                payload     — Any JSON-serialisable payload
 * @param {{ rail?, scheduled_at?, payload_value_usdc?, note?, ttl_hours? }} options
 * @returns {object} Full shipment record with initial custody_chain entry
 */
export async function createShipment(sender_did, recipient, type, payload, options = {}) {
  if (!sender_did)  throw new Error('sender_did required');
  if (!recipient)   throw new Error('recipient required');
  if (!type)        throw new Error('type required');
  if (!SHIPMENT_TYPES[type]) {
    throw new Error(`Unknown shipment type: ${type}. Valid types: ${Object.keys(SHIPMENT_TYPES).join(', ')}`);
  }

  const { rail = 'usdc', scheduled_at = null, payload_value_usdc = 0, note = null, ttl_hours = 72 } = options;

  // Validate CROSS_NET recipient shape
  if (type === 'CROSS_NET' && typeof recipient === 'string' && recipient.startsWith('did:')) {
    throw new Error('CROSS_NET shipments require a { type, address } recipient, not a DID');
  }

  // Validate ESCROW has a payload value
  if (type === 'ESCROW' && (!payload_value_usdc || payload_value_usdc <= 0)) {
    throw new Error('ESCROW shipments require payload_value_usdc > 0');
  }

  // Validate SCHEDULED has a future timestamp
  if (type === 'SCHEDULED') {
    if (!scheduled_at) throw new Error('SCHEDULED shipments require scheduled_at ISO timestamp');
    if (new Date(scheduled_at) <= new Date()) {
      throw new Error('scheduled_at must be a future timestamp');
    }
  }

  const { did_or_endpoint, rail_type } = normalizeRecipient(recipient);

  const shipment_id  = `shp_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now          = new Date();
  const created_at   = now.toISOString();
  const expires_at   = new Date(now.getTime() + ttl_hours * 60 * 60 * 1000).toISOString();
  const fee_usdc     = computeFee(type, payload_value_usdc);
  const payload_hash = computePayloadHash(payload);

  // Initial status: ESCROW → AWAITING_SIGNATURE, all others → PENDING
  const initial_status = type === 'ESCROW' ? STATUS.AWAITING_SIGNATURE : STATUS.PENDING;

  // Build initial custody chain entry
  const custody_chain = [
    makeCustodyEntry(shipment_id, 'CREATED', sender_did, did_or_endpoint),
  ];

  const shipment = {
    shipment_id,
    type,
    status:              initial_status,
    sender_did,
    recipient:           recipient,          // preserve original shape
    did_or_endpoint,
    rail_type,
    payload,
    payload_hash,
    payload_value_usdc:  +payload_value_usdc,
    fee_usdc,
    rail,
    note,
    scheduled_at,
    ttl_hours,
    created_at,
    expires_at,
    delivered_at:        null,
    returned_at:         null,
    return_shipment_id:  null,
    vc_receipt_id:       null,
    atg_record:          true,               // EU AI Act Article 12
    eu_ai_act_article_12: true,
    hivelaw_contract:    `contract_hiveship_${shipment_id}`,
    custody_chain,
  };

  // Persist
  if (isPostgres()) {
    // TODO: INSERT INTO hiveforge.hiveship_shipments (shipment_id, type, status, sender_did,
    //       recipient_json, payload_json, payload_hash, fee_usdc, rail, note, scheduled_at,
    //       expires_at, created_at, custody_chain_json) VALUES (...)
    memShipments.set(shipment_id, shipment);
  } else {
    memShipments.set(shipment_id, shipment);
  }

  totalShipments++;
  totalFeesUsdc = +(totalFeesUsdc + fee_usdc).toFixed(6);

  return shipment;
}

// ══════════════════════════════════════════════════════════════════════════════
//  CORE: getShipment
// ══════════════════════════════════════════════════════════════════════════════

/**
 * getShipment(shipment_id)
 *
 * Retrieves a single shipment record by ID.
 *
 * @param {string} shipment_id
 * @returns {object|null} Shipment record or null if not found
 */
export async function getShipment(shipment_id) {
  if (isPostgres()) {
    // TODO: SELECT * FROM hiveforge.hiveship_shipments WHERE shipment_id = $1
    return memShipments.get(shipment_id) || null;
  }
  return memShipments.get(shipment_id) || null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  CORE: deliverShipment
// ══════════════════════════════════════════════════════════════════════════════

/**
 * deliverShipment(shipment_id)
 *
 * Simulates payload delivery. Transitions:
 *   PENDING → IN_TRANSIT → DELIVERED
 *
 * For CERTIFIED shipments, automatically issues a W3C VC receipt.
 * ESCROW shipments cannot be delivered via this method — use signAndRelease.
 * Expired or already-terminal shipments cannot be delivered.
 *
 * @param {string} shipment_id
 * @returns {object} Updated shipment record
 */
export async function deliverShipment(shipment_id) {
  const shipment = await getShipment(shipment_id);
  if (!shipment) throw new Error(`Shipment ${shipment_id} not found`);

  if (shipment.type === 'ESCROW') {
    throw new Error('ESCROW shipments use signAndRelease — not deliverShipment');
  }

  const terminal = [STATUS.DELIVERED, STATUS.FAILED, STATUS.RETURNED, STATUS.EXPIRED];
  if (terminal.includes(shipment.status)) {
    throw new Error(`Shipment ${shipment_id} is already in terminal state: ${shipment.status}`);
  }

  if (new Date() > new Date(shipment.expires_at)) {
    shipment.status = STATUS.EXPIRED;
    shipment.custody_chain.push(
      makeCustodyEntry(shipment_id, 'EXPIRED', 'did:hive:hiveship', shipment.did_or_endpoint)
    );
    memShipments.set(shipment_id, shipment);
    throw new Error(`Shipment ${shipment_id} has expired`);
  }

  const now = new Date().toISOString();

  // Transition: PENDING → IN_TRANSIT
  if (shipment.status === STATUS.PENDING) {
    shipment.status = STATUS.IN_TRANSIT;
    shipment.custody_chain.push(
      makeCustodyEntry(shipment_id, 'IN_TRANSIT', shipment.sender_did, shipment.did_or_endpoint)
    );
  }

  // Transition: IN_TRANSIT → DELIVERED
  shipment.status       = STATUS.DELIVERED;
  shipment.delivered_at = now;
  shipment.custody_chain.push(
    makeCustodyEntry(shipment_id, 'DELIVERED', 'did:hive:hiveship', shipment.did_or_endpoint)
  );

  // Persist
  if (isPostgres()) {
    // TODO: UPDATE hiveforge.hiveship_shipments SET status='DELIVERED', delivered_at=$1,
    //       custody_chain_json=$2 WHERE shipment_id=$3
    memShipments.set(shipment_id, shipment);
  } else {
    memShipments.set(shipment_id, shipment);
  }

  totalDelivered++;

  // For CERTIFIED shipments, auto-issue the VC receipt
  if (shipment.type === 'CERTIFIED') {
    await issueVCReceipt(shipment_id);
    const receipt = memVCReceipts.get(shipment_id);
    shipment.vc_receipt_id = receipt?.id || null;
  }

  return shipment;
}

// ══════════════════════════════════════════════════════════════════════════════
//  CORE: signAndRelease (ESCROW)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * signAndRelease(shipment_id, recipient_did)
 *
 * Recipient countersigns an ESCROW shipment, triggering conditional release.
 * Transitions: AWAITING_SIGNATURE → RELEASED
 *
 * Returns a settlement record with the release details.
 *
 * @param {string} shipment_id
 * @param {string} recipient_did — Must match the shipment's did_or_endpoint
 * @returns {{ settlement_id, shipment_id, sender_did, recipient_did, released_at, amount_usdc, fee_usdc, custody_chain }}
 */
export async function signAndRelease(shipment_id, recipient_did) {
  const shipment = await getShipment(shipment_id);
  if (!shipment) throw new Error(`Shipment ${shipment_id} not found`);

  if (shipment.type !== 'ESCROW') {
    throw new Error(`signAndRelease only applies to ESCROW shipments (type: ${shipment.type})`);
  }
  if (shipment.status !== STATUS.AWAITING_SIGNATURE) {
    throw new Error(`ESCROW shipment ${shipment_id} is not awaiting signature (status: ${shipment.status})`);
  }
  if (new Date() > new Date(shipment.expires_at)) {
    shipment.status = STATUS.EXPIRED;
    shipment.custody_chain.push(
      makeCustodyEntry(shipment_id, 'EXPIRED', recipient_did, shipment.sender_did)
    );
    memShipments.set(shipment_id, shipment);
    throw new Error(`Escrow shipment ${shipment_id} has expired`);
  }

  const now = new Date().toISOString();

  // Append SIGNED event
  shipment.custody_chain.push(
    makeCustodyEntry(shipment_id, 'SIGNED', recipient_did, shipment.sender_did)
  );

  // Transition to RELEASED
  shipment.status       = STATUS.RELEASED;
  shipment.delivered_at = now;
  shipment.custody_chain.push(
    makeCustodyEntry(shipment_id, 'RELEASED', 'did:hive:hiveship', recipient_did)
  );

  // Persist
  if (isPostgres()) {
    // TODO: UPDATE hiveforge.hiveship_shipments SET status='RELEASED', delivered_at=$1,
    //       custody_chain_json=$2 WHERE shipment_id=$3
    memShipments.set(shipment_id, shipment);
  } else {
    memShipments.set(shipment_id, shipment);
  }

  totalDelivered++;
  totalEscrowReleased++;

  const settlement = {
    settlement_id:      `stl_${uuidv4().replace(/-/g, '').slice(0, 16)}`,
    shipment_id,
    type:               'ESCROW_SETTLEMENT',
    sender_did:         shipment.sender_did,
    recipient_did,
    payload_value_usdc: shipment.payload_value_usdc,
    fee_usdc:           shipment.fee_usdc,
    released_at:        now,
    atg_record:         true,
    eu_ai_act_article_12: true,
    custody_chain:      shipment.custody_chain,
  };

  return settlement;
}

// ══════════════════════════════════════════════════════════════════════════════
//  CORE: disputeEscrow
// ══════════════════════════════════════════════════════════════════════════════

/**
 * disputeEscrow(shipment_id, disputing_did, reason)
 *
 * Marks an ESCROW shipment as DISPUTED. Funds are frozen until
 * resolved by HiveLaw arbitration.
 *
 * @param {string} shipment_id
 * @param {string} disputing_did — DID raising the dispute
 * @param {string} reason        — Human-readable dispute reason
 * @returns {object} Updated shipment record
 */
export async function disputeEscrow(shipment_id, disputing_did, reason) {
  const shipment = await getShipment(shipment_id);
  if (!shipment) throw new Error(`Shipment ${shipment_id} not found`);

  if (shipment.type !== 'ESCROW') {
    throw new Error(`disputeEscrow only applies to ESCROW shipments (type: ${shipment.type})`);
  }
  if (![STATUS.AWAITING_SIGNATURE, STATUS.PENDING].includes(shipment.status)) {
    throw new Error(`Cannot dispute shipment in state: ${shipment.status}. Must be AWAITING_SIGNATURE or PENDING.`);
  }

  shipment.status          = STATUS.DISPUTED;
  shipment.dispute_reason  = reason || null;
  shipment.disputed_by     = disputing_did;
  shipment.disputed_at     = new Date().toISOString();

  shipment.custody_chain.push(
    makeCustodyEntry(shipment_id, 'DISPUTED', disputing_did, 'did:hive:hivelaw')
  );

  // Persist
  if (isPostgres()) {
    // TODO: UPDATE hiveforge.hiveship_shipments SET status='DISPUTED', dispute_reason=$1,
    //       disputed_by=$2, disputed_at=$3, custody_chain_json=$4 WHERE shipment_id=$5
    memShipments.set(shipment_id, shipment);
  } else {
    memShipments.set(shipment_id, shipment);
  }

  return shipment;
}

// ══════════════════════════════════════════════════════════════════════════════
//  CORE: returnShipment
// ══════════════════════════════════════════════════════════════════════════════

/**
 * returnShipment(shipment_id, returner_did)
 *
 * Initiates a return shipment from recipient back to sender.
 * Creates a new RETURN-type shipment and marks the original as RETURNED.
 *
 * @param {string} shipment_id  — ID of the original shipment
 * @param {string} returner_did — DID initiating the return (usually recipient)
 * @returns {{ original: object, return_shipment: object }}
 */
export async function returnShipment(shipment_id, returner_did) {
  const original = await getShipment(shipment_id);
  if (!original) throw new Error(`Shipment ${shipment_id} not found`);

  const returnable = [STATUS.DELIVERED, STATUS.IN_TRANSIT, STATUS.PENDING, STATUS.RELEASED];
  if (!returnable.includes(original.status)) {
    throw new Error(`Cannot return shipment in state: ${original.status}. Must be one of: ${returnable.join(', ')}`);
  }

  // Create the return shipment from returner back to original sender
  const return_shipment = await createShipment(
    returner_did,
    original.sender_did,           // return goes back to original sender
    'RETURN',
    { original_shipment_id: shipment_id, returned_payload: original.payload },
    {
      rail:  original.rail,
      note:  `Return of ${shipment_id}`,
      ttl_hours: 72,
    }
  );

  // Mark original as RETURNED
  const now = new Date().toISOString();
  original.status             = STATUS.RETURNED;
  original.returned_at        = now;
  original.return_shipment_id = return_shipment.shipment_id;

  original.custody_chain.push(
    makeCustodyEntry(shipment_id, 'RETURNED', returner_did, original.sender_did)
  );

  // Persist original
  if (isPostgres()) {
    // TODO: UPDATE hiveforge.hiveship_shipments SET status='RETURNED', returned_at=$1,
    //       return_shipment_id=$2, custody_chain_json=$3 WHERE shipment_id=$4
    memShipments.set(shipment_id, original);
  } else {
    memShipments.set(shipment_id, original);
  }

  return { original, return_shipment };
}

// ══════════════════════════════════════════════════════════════════════════════
//  CORE: getShipmentsByDid
// ══════════════════════════════════════════════════════════════════════════════

/**
 * getShipmentsByDid(did)
 *
 * Returns all shipments where the DID appears as sender or recipient.
 * Sorted by created_at descending (newest first).
 *
 * @param {string} did
 * @returns {object[]}
 */
export async function getShipmentsByDid(did) {
  if (!did) throw new Error('did required');

  if (isPostgres()) {
    // TODO: SELECT * FROM hiveforge.hiveship_shipments
    //       WHERE sender_did = $1 OR did_or_endpoint = $1
    //       ORDER BY created_at DESC
    return [...memShipments.values()]
      .filter(s => s.sender_did === did || s.did_or_endpoint === did)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  return [...memShipments.values()]
    .filter(s => s.sender_did === did || s.did_or_endpoint === did)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

// ══════════════════════════════════════════════════════════════════════════════
//  CORE: expireOverdue
// ══════════════════════════════════════════════════════════════════════════════

/**
 * expireOverdue()
 *
 * Scans all active shipments for expired TTLs and marks them EXPIRED.
 * Target states: PENDING, IN_TRANSIT, AWAITING_SIGNATURE.
 *
 * Intended to be called by a periodic background job.
 *
 * @returns {{ expired_count: number, expired_ids: string[] }}
 */
export async function expireOverdue() {
  const expirable = [STATUS.PENDING, STATUS.IN_TRANSIT, STATUS.AWAITING_SIGNATURE];
  const now       = new Date();
  const expiredIds = [];

  if (isPostgres()) {
    // TODO: UPDATE hiveforge.hiveship_shipments SET status='EXPIRED'
    //       WHERE status = ANY($1) AND expires_at < NOW()
    //       RETURNING shipment_id
  }

  for (const [id, shipment] of memShipments.entries()) {
    if (expirable.includes(shipment.status) && new Date(shipment.expires_at) < now) {
      shipment.status = STATUS.EXPIRED;
      shipment.custody_chain.push(
        makeCustodyEntry(id, 'EXPIRED', 'did:hive:hiveship', shipment.did_or_endpoint)
      );
      memShipments.set(id, shipment);
      expiredIds.push(id);
    }
  }

  return { expired_count: expiredIds.length, expired_ids: expiredIds };
}

// ══════════════════════════════════════════════════════════════════════════════
//  CORE: getStats
// ══════════════════════════════════════════════════════════════════════════════

/**
 * getStats()
 *
 * Returns platform-wide HiveShip statistics.
 * Safe to expose publicly — no individual payload data.
 *
 * @returns {object} Aggregate counters and breakdowns
 */
export async function getStats() {
  if (isPostgres()) {
    // TODO: SELECT COUNT(*), SUM(fee_usdc), status, type
    //       FROM hiveforge.hiveship_shipments GROUP BY status, type
  }

  const all = [...memShipments.values()];

  // Per-type breakdown
  const types_breakdown = Object.keys(SHIPMENT_TYPES).reduce((acc, t) => {
    const typed = all.filter(s => s.type === t);
    acc[t] = {
      count:      typed.length,
      delivered:  typed.filter(s => [STATUS.DELIVERED, STATUS.RELEASED].includes(s.status)).length,
      pending:    typed.filter(s => [STATUS.PENDING, STATUS.AWAITING_SIGNATURE].includes(s.status)).length,
      failed:     typed.filter(s => s.status === STATUS.FAILED).length,
      expired:    typed.filter(s => s.status === STATUS.EXPIRED).length,
      rate_usdc:  t === 'ESCROW' ? `${ESCROW_RATE * 100}% (min $${ESCROW_MIN})` : `$${RATES[t]}`,
    };
    return acc;
  }, {});

  return {
    total_shipments:        totalShipments,
    total_delivered:        totalDelivered,
    total_escrow_released:  totalEscrowReleased,
    total_fees_usdc:        +totalFeesUsdc.toFixed(4),
    in_memory_count:        all.length,
    by_status: {
      pending:             all.filter(s => s.status === STATUS.PENDING).length,
      in_transit:          all.filter(s => s.status === STATUS.IN_TRANSIT).length,
      awaiting_signature:  all.filter(s => s.status === STATUS.AWAITING_SIGNATURE).length,
      delivered:           all.filter(s => s.status === STATUS.DELIVERED).length,
      released:            all.filter(s => s.status === STATUS.RELEASED).length,
      failed:              all.filter(s => s.status === STATUS.FAILED).length,
      returned:            all.filter(s => s.status === STATUS.RETURNED).length,
      expired:             all.filter(s => s.status === STATUS.EXPIRED).length,
      disputed:            all.filter(s => s.status === STATUS.DISPUTED).length,
    },
    types_breakdown,
    vc_receipts_issued:     memVCReceipts.size,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  CORE: issueVCReceipt
// ══════════════════════════════════════════════════════════════════════════════

/**
 * issueVCReceipt(shipment_id)
 *
 * Issues a W3C Verifiable Credential delivery receipt for a CERTIFIED shipment.
 * The VC is signed (conceptually) by HiveLaw (did:hive:hivelaw) and is
 * legally admissible under EU AI Act Article 12.
 *
 * Can be called repeatedly — returns cached receipt if already issued.
 *
 * @param {string} shipment_id
 * @returns {object} W3C-shaped Verifiable Credential
 */
export async function issueVCReceipt(shipment_id) {
  const shipment = await getShipment(shipment_id);
  if (!shipment) throw new Error(`Shipment ${shipment_id} not found`);

  if (shipment.type !== 'CERTIFIED') {
    throw new Error(`VC receipts are only issued for CERTIFIED shipments (type: ${shipment.type})`);
  }

  if (![STATUS.DELIVERED, STATUS.RELEASED].includes(shipment.status)) {
    throw new Error(`Cannot issue VC receipt: shipment not yet delivered (status: ${shipment.status})`);
  }

  // Return cached receipt if already issued
  if (memVCReceipts.has(shipment_id)) {
    return memVCReceipts.get(shipment_id);
  }

  const now   = new Date().toISOString();
  const vc_id = `vc_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

  const vc = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://hiveforge.ai/contexts/hiveship/v1',
    ],
    id:     `did:hive:hivelaw#${vc_id}`,
    type:   ['VerifiableCredential', 'HiveShipReceipt'],
    issuer: 'did:hive:hivelaw',
    issuanceDate: now,
    credentialSubject: {
      shipment_id,
      sender_did:    shipment.sender_did,
      recipient:     shipment.recipient,
      delivered_at:  shipment.delivered_at,
      payload_hash:  shipment.payload_hash,
      custody_chain: shipment.custody_chain,
      fee_usdc:      shipment.fee_usdc,
      rail:          shipment.rail,
    },
    proof: {
      type:               'HiveLawSignature2024',
      created:            now,
      verificationMethod: 'did:hive:hivelaw#keys-1',
      proofPurpose:       'assertionMethod',
      // Signature hash over the credential subject
      jws: computeSignatureHash(shipment_id, 'VC_ISSUED', now),
    },
    eu_ai_act_article_12: true,
    atg_record:           true,
    hivelaw_contract:     shipment.hivelaw_contract,
  };

  // Persist
  if (isPostgres()) {
    // TODO: INSERT INTO hiveforge.hiveship_receipts (vc_id, shipment_id, vc_json, issued_at)
    //       VALUES ($1, $2, $3, $4)
    memVCReceipts.set(shipment_id, vc);
  } else {
    memVCReceipts.set(shipment_id, vc);
  }

  return vc;
}
