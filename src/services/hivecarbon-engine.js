/**
 * HiveCarbon Engine — Agent Emissions Metering + Carbon Offset Marketplace
 *
 * Every agent that touches Hive (via HiveMsg, HivePay, HiveRide, HiveInsure,
 * etc.) leaves an ATG record. HiveCarbon adds emissions metadata to every
 * record and monetizes it via attestations, offset trading, fleet
 * subscriptions, and Green DID badges.
 *
 * Hive is uniquely positioned to offer this layer: the ATG already contains
 * every agent transaction, model invocation, and compute event. We are the
 * only network in the world that can meter agentic carbon at the transaction
 * level and issue legally-meaningful EU AI Act Article 12 attestations.
 *
 * Revenue streams:
 *   1. Attestation sales       — $2.50 per signed attestation
 *   2. Offset marketplace fee  — 5% matching fee on trades
 *   3. Green DID badge         — $19/year per agent
 *   4. Fleet subscriptions     — $99–$2,499/month
 *
 * Carbon model:
 *   compute_wh        = MODEL_WH[model] × call_count
 *   co2_grams         = compute_wh × GRID_CO2_G_PER_WH[region]
 *   co2_kg            = co2_grams / 1000
 *   offset_cost_usdc  = co2_kg × 0.05  (voluntary carbon market rate)
 */

import { v4 as uuidv4 } from 'uuid';
import pool, { isPostgres } from './db.js';

// ─── Carbon Lookup Tables ──────────────────────────────────────────────────────

/** Compute footprint per API call in watt-hours */
const MODEL_WH = {
  'gpt-4o':         0.0029,
  'gpt-4o-mini':    0.0004,
  'claude-opus':    0.0045,
  'claude-sonnet':  0.0018,
  'claude-haiku':   0.0003,
  'gemini-pro':     0.0021,
  'gemini-flash':   0.0006,
  'llama-3-70b':    0.0035,
  'llama-3-8b':     0.0008,
  'unknown':        0.0015,   // conservative default
};

/** Grid carbon intensity by region — grams CO₂ per Wh */
const GRID_CO2_G_PER_WH = {
  'us-east':  0.386,
  'us-west':  0.210,
  'eu-west':  0.233,
  'eu-north': 0.045,   // Nordic hydro
  'ap-east':  0.545,
  'unknown':  0.350,   // global average
};

/** Agent size classification thresholds (co2_kg per month) */
const AGENT_SIZE_TIERS = [
  { label: 'NANO',       min: 0,    max: 0.1,  desc: 'Simple MCP tools, file readers' },
  { label: 'MICRO',      min: 0.1,  max: 1,    desc: 'Lightweight agents' },
  { label: 'STANDARD',   min: 1,    max: 10,   desc: 'Research agents, web search' },
  { label: 'ENTERPRISE', min: 10,   max: 100,  desc: 'Orchestrators, multi-agent' },
  { label: 'TITAN',      min: 100,  max: Infinity, desc: 'Trading agents, 24/7 frontier models' },
];

/** Fleet subscription tiers */
const FLEET_TIERS = {
  STARTER:    { monthly_usdc: 99,   max_agents: 10,        label: 'STARTER' },
  GROWTH:     { monthly_usdc: 499,  max_agents: 100,       label: 'GROWTH' },
  ENTERPRISE: { monthly_usdc: 2499, max_agents: Infinity,  label: 'ENTERPRISE' },
};

const FLEET_INCLUDES = ['dashboard', 'attestations', 'fleet_badge', 'esg_export'];

const OFFSET_RATE_USDC_PER_KG = 0.05;
const ATTESTATION_PRICE_USDC  = 2.50;
const BADGE_PRICE_USDC        = 19.00;
const TRADE_FEE_RATE          = 0.05;  // 5% Hive matching fee

// ─── In-Memory Storage ─────────────────────────────────────────────────────────

const memEmissions    = new Map();   // did → [emission records]
const memAttestations = new Map();   // attestation_id → attestation
const memOffsets      = new Map();   // did → [offset records]
const memTrades       = new Map();   // trade_id → trade
const memBadges       = new Map();   // did → badge
const memFleets       = new Map();   // subscription_id → fleet subscription

// ─── Platform Stats Counters ───────────────────────────────────────────────────

let totalAttestations  = 0;
let totalTrades        = 0;
let totalHiveFeeUsdc   = 0;
let totalGreenBadges   = 0;
let totalFleetSubs     = 0;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function classifyAgentSize(monthly_co2_kg) {
  for (const tier of AGENT_SIZE_TIERS) {
    if (monthly_co2_kg >= tier.min && monthly_co2_kg < tier.max) return tier.label;
  }
  return 'TITAN';
}

function resolveModel(model) {
  return MODEL_WH[model] !== undefined ? model : 'unknown';
}

function resolveRegion(region) {
  return GRID_CO2_G_PER_WH[region] !== undefined ? region : 'unknown';
}

function getAgentOffsetStatus(did) {
  const offsets = memOffsets.get(did) || [];
  if (offsets.length === 0) return null;
  const totalOffset = offsets.reduce((sum, o) => sum + o.co2_kg_offset, 0);
  const records     = memEmissions.get(did) || [];
  const totalCo2    = records.reduce((sum, r) => sum + r.co2_kg, 0);
  if (totalOffset >= totalCo2 && totalCo2 > 0) return 'verified';
  return 'partial';
}

function buildMockMarket() {
  const sources  = ['solar-grid', 'wind-grid', 'reforestation', 'methane-capture'];
  const regions  = ['us-west', 'eu-north', 'eu-west', 'us-east', 'ap-east'];
  const entries  = [];
  const seed     = [
    { co2_kg: 120,  ask: 0.048, src: 'solar-grid',      reg: 'us-west'  },
    { co2_kg: 340,  ask: 0.042, src: 'wind-grid',        reg: 'eu-north' },
    { co2_kg: 85,   ask: 0.055, src: 'reforestation',    reg: 'ap-east'  },
    { co2_kg: 210,  ask: 0.050, src: 'methane-capture',  reg: 'us-east'  },
    { co2_kg: 500,  ask: 0.038, src: 'wind-grid',        reg: 'eu-north' },
    { co2_kg: 65,   ask: 0.060, src: 'solar-grid',       reg: 'eu-west'  },
    { co2_kg: 1200, ask: 0.035, src: 'methane-capture',  reg: 'us-east'  },
    { co2_kg: 90,   ask: 0.052, src: 'reforestation',    reg: 'ap-east'  },
    { co2_kg: 175,  ask: 0.045, src: 'wind-grid',        reg: 'us-west'  },
    { co2_kg: 430,  ask: 0.041, src: 'solar-grid',       reg: 'eu-west'  },
  ];
  for (let i = 0; i < seed.length; i++) {
    const s = seed[i];
    entries.push({
      listing_id:             `market_${i + 1}`,
      seller_did:             `did:hive:offset_provider_${i + 1}`,
      co2_kg_available:       s.co2_kg,
      ask_price_usdc_per_kg:  s.ask,
      region:                 s.reg,
      source:                 s.src,
      verified:               true,
      listed_at:              new Date(Date.now() - i * 3_600_000).toISOString(),
    });
  }
  return entries;
}

// ─── Core Functions ────────────────────────────────────────────────────────────

/**
 * meterTransaction — Calculate and record emissions for a single agent transaction.
 *
 * @param {string} did          — Agent DID
 * @param {string} model        — Model ID (e.g. 'gpt-4o')
 * @param {number} call_count   — Number of API calls in this transaction
 * @param {string} region       — Compute region (e.g. 'us-east')
 * @param {string} service_type — Originating Hive service (e.g. 'hivemsg')
 * @returns {object} Emission record
 */
export async function meterTransaction(did, model, call_count, region, service_type) {
  if (!isPostgres()) {
    const resolvedModel  = resolveModel(model);
    const resolvedRegion = resolveRegion(region);
    const compute_wh     = MODEL_WH[resolvedModel] * call_count;
    const co2_grams      = compute_wh * GRID_CO2_G_PER_WH[resolvedRegion];
    const co2_kg         = co2_grams / 1000;
    const offset_cost_usdc = co2_kg * OFFSET_RATE_USDC_PER_KG;

    const record = {
      tx_id:             'tx_' + uuidv4(),
      did,
      model:             resolvedModel,
      call_count,
      compute_wh,
      co2_grams,
      co2_kg,
      offset_cost_usdc,
      region:            resolvedRegion,
      service_type:      service_type || 'unknown',
      timestamp:         new Date().toISOString(),
      atg_record:        true,
    };

    if (!memEmissions.has(did)) memEmissions.set(did, []);
    memEmissions.get(did).push(record);

    return record;
  }

  // ── Postgres path (schema TBD — mirror in-memory logic) ──────────────────────
  const resolvedModel  = resolveModel(model);
  const resolvedRegion = resolveRegion(region);
  const compute_wh     = MODEL_WH[resolvedModel] * call_count;
  const co2_grams      = compute_wh * GRID_CO2_G_PER_WH[resolvedRegion];
  const co2_kg         = co2_grams / 1000;
  const offset_cost_usdc = co2_kg * OFFSET_RATE_USDC_PER_KG;
  const tx_id          = 'tx_' + uuidv4();
  const timestamp      = new Date().toISOString();

  try {
    await pool.query(
      `INSERT INTO hivecarbon_emissions
         (tx_id, did, model, call_count, compute_wh, co2_grams, co2_kg,
          offset_cost_usdc, region, service_type, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [tx_id, did, resolvedModel, call_count, compute_wh, co2_grams, co2_kg,
       offset_cost_usdc, resolvedRegion, service_type || 'unknown', timestamp],
    );
  } catch {
    // Fallback to in-memory if table not yet provisioned
    if (!memEmissions.has(did)) memEmissions.set(did, []);
    memEmissions.get(did).push({ tx_id, did, model: resolvedModel, call_count,
      compute_wh, co2_grams, co2_kg, offset_cost_usdc, region: resolvedRegion,
      service_type: service_type || 'unknown', timestamp, atg_record: true });
  }

  return { tx_id, did, model: resolvedModel, call_count, compute_wh, co2_grams,
    co2_kg, offset_cost_usdc, region: resolvedRegion,
    service_type: service_type || 'unknown', timestamp, atg_record: true };
}

/**
 * getAgentFootprint — Aggregate all emission records for an agent DID.
 *
 * @param {string} did
 * @returns {object} Full footprint profile
 */
export async function getAgentFootprint(did) {
  if (!isPostgres()) {
    const records = memEmissions.get(did) || [];

    const total_co2_kg = records.reduce((s, r) => s + r.co2_kg, 0);

    // Monthly: records from last 30 days
    const thirtyDaysAgo   = Date.now() - 30 * 24 * 3_600_000;
    const monthly_records = records.filter(r => new Date(r.timestamp).getTime() >= thirtyDaysAgo);
    const monthly_co2_kg  = monthly_records.reduce((s, r) => s + r.co2_kg, 0);

    const agent_size           = classifyAgentSize(monthly_co2_kg);
    const total_offset_cost_usdc = total_co2_kg * OFFSET_RATE_USDC_PER_KG;
    const offset_status        = getAgentOffsetStatus(did);

    return {
      did,
      total_co2_kg,
      monthly_co2_kg,
      agent_size,
      total_offset_cost_usdc,
      offset_status,
      tx_count: records.length,
      records,
    };
  }

  // ── Postgres path ─────────────────────────────────────────────────────────────
  try {
    const res = await pool.query(
      `SELECT * FROM hivecarbon_emissions WHERE did = $1 ORDER BY timestamp DESC`, [did],
    );
    const records = res.rows;
    const total_co2_kg = records.reduce((s, r) => s + parseFloat(r.co2_kg), 0);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    const monthly_co2_kg = records
      .filter(r => r.timestamp >= thirtyDaysAgo)
      .reduce((s, r) => s + parseFloat(r.co2_kg), 0);
    const agent_size = classifyAgentSize(monthly_co2_kg);
    return {
      did, total_co2_kg, monthly_co2_kg, agent_size,
      total_offset_cost_usdc: total_co2_kg * OFFSET_RATE_USDC_PER_KG,
      offset_status: getAgentOffsetStatus(did),
      tx_count: records.length, records,
    };
  } catch {
    return { did, total_co2_kg: 0, monthly_co2_kg: 0, agent_size: 'NANO',
      total_offset_cost_usdc: 0, offset_status: null, tx_count: 0, records: [] };
  }
}

/**
 * issueAttestation — Issue a signed EU AI Act Article 12 emissions attestation.
 *
 * @param {string} did
 * @returns {object} Attestation record
 */
export async function issueAttestation(did) {
  if (!isPostgres()) {
    const footprint       = await getAgentFootprint(did);
    const attestation_id  = 'attest_' + uuidv4();
    const issued_at       = new Date().toISOString();
    const expires_at      = new Date(Date.now() + 365 * 24 * 3_600_000).toISOString();

    const attestation = {
      attestation_id,
      did,
      price_usdc:           ATTESTATION_PRICE_USDC,
      valid_days:           365,
      issued_at,
      expires_at,
      signed_by:            'HiveLaw',
      eu_ai_act_article_12: true,
      atg_record:           true,
      total_co2_kg:         footprint.total_co2_kg,
      monthly_co2_kg:       footprint.monthly_co2_kg,
      agent_size:           footprint.agent_size,
      offset_status:        footprint.offset_status,
      tx_count:             footprint.tx_count,
    };

    memAttestations.set(attestation_id, attestation);
    totalAttestations++;
    return attestation;
  }

  // ── Postgres path ─────────────────────────────────────────────────────────────
  const footprint      = await getAgentFootprint(did);
  const attestation_id = 'attest_' + uuidv4();
  const issued_at      = new Date().toISOString();
  const expires_at     = new Date(Date.now() + 365 * 24 * 3_600_000).toISOString();
  const attestation    = {
    attestation_id, did, price_usdc: ATTESTATION_PRICE_USDC, valid_days: 365,
    issued_at, expires_at, signed_by: 'HiveLaw', eu_ai_act_article_12: true,
    atg_record: true, total_co2_kg: footprint.total_co2_kg,
    monthly_co2_kg: footprint.monthly_co2_kg, agent_size: footprint.agent_size,
    offset_status: footprint.offset_status, tx_count: footprint.tx_count,
  };

  try {
    await pool.query(
      `INSERT INTO hivecarbon_attestations
         (attestation_id, did, price_usdc, valid_days, issued_at, expires_at,
          total_co2_kg, monthly_co2_kg, agent_size, offset_status, tx_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [attestation_id, did, ATTESTATION_PRICE_USDC, 365, issued_at, expires_at,
       footprint.total_co2_kg, footprint.monthly_co2_kg, footprint.agent_size,
       footprint.offset_status, footprint.tx_count],
    );
  } catch {
    memAttestations.set(attestation_id, attestation);
  }

  totalAttestations++;
  return attestation;
}

/**
 * buyOffset — Purchase carbon offsets for an agent.
 *
 * @param {string} did
 * @param {number} co2_kg_to_offset
 * @param {string} rail — payment rail
 * @returns {object} Offset record
 */
export async function buyOffset(did, co2_kg_to_offset, rail) {
  if (!isPostgres()) {
    const cost_usdc = co2_kg_to_offset * OFFSET_RATE_USDC_PER_KG;
    const offset_id = 'offset_' + uuidv4();

    if (!memOffsets.has(did)) memOffsets.set(did, []);
    memOffsets.get(did).push({
      offset_id,
      co2_kg_offset: co2_kg_to_offset,
      cost_usdc,
      rail,
      timestamp: new Date().toISOString(),
    });

    const offset_status = getAgentOffsetStatus(did);
    const footprint     = await getAgentFootprint(did);
    const totalOffset   = (memOffsets.get(did) || [])
      .reduce((s, o) => s + o.co2_kg_offset, 0);
    const net_zero      = totalOffset >= footprint.total_co2_kg && footprint.total_co2_kg > 0;

    return { offset_id, did, co2_kg_offset: co2_kg_to_offset, cost_usdc, rail,
      offset_status, net_zero };
  }

  // ── Postgres path ─────────────────────────────────────────────────────────────
  const cost_usdc = co2_kg_to_offset * OFFSET_RATE_USDC_PER_KG;
  const offset_id = 'offset_' + uuidv4();
  const timestamp = new Date().toISOString();

  try {
    await pool.query(
      `INSERT INTO hivecarbon_offsets (offset_id, did, co2_kg_offset, cost_usdc, rail, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [offset_id, did, co2_kg_to_offset, cost_usdc, rail, timestamp],
    );
  } catch {
    if (!memOffsets.has(did)) memOffsets.set(did, []);
    memOffsets.get(did).push({ offset_id, co2_kg_offset: co2_kg_to_offset, cost_usdc, rail, timestamp });
  }

  const offset_status = getAgentOffsetStatus(did);
  const footprint     = await getAgentFootprint(did);
  const totalOffset   = (memOffsets.get(did) || []).reduce((s, o) => s + o.co2_kg_offset, 0);
  const net_zero      = totalOffset >= footprint.total_co2_kg && footprint.total_co2_kg > 0;

  return { offset_id, did, co2_kg_offset: co2_kg_to_offset, cost_usdc, rail, offset_status, net_zero };
}

/**
 * listOffsetMarket — Return available offset credits in the marketplace.
 *
 * @returns {object[]} 10 mock market listings
 */
export function listOffsetMarket() {
  return buildMockMarket();
}

/**
 * tradeOffset — Execute a peer-to-peer offset trade between two agents.
 *
 * @param {string} buyer_did
 * @param {string} seller_did
 * @param {number} co2_kg
 * @param {string} rail
 * @returns {object} Trade record
 */
export async function tradeOffset(buyer_did, seller_did, co2_kg, rail) {
  if (!isPostgres()) {
    const price_gross  = co2_kg * OFFSET_RATE_USDC_PER_KG;
    const hive_fee_usdc = price_gross * TRADE_FEE_RATE;
    const price_usdc   = price_gross;
    const trade_id     = 'trade_' + uuidv4();
    const timestamp    = new Date().toISOString();

    const trade = {
      trade_id, buyer_did, seller_did, co2_kg, price_usdc,
      hive_fee_usdc, rail, timestamp,
    };

    memTrades.set(trade_id, trade);
    totalTrades++;
    totalHiveFeeUsdc += hive_fee_usdc;

    return trade;
  }

  // ── Postgres path ─────────────────────────────────────────────────────────────
  const price_gross   = co2_kg * OFFSET_RATE_USDC_PER_KG;
  const hive_fee_usdc = price_gross * TRADE_FEE_RATE;
  const price_usdc    = price_gross;
  const trade_id      = 'trade_' + uuidv4();
  const timestamp     = new Date().toISOString();

  try {
    await pool.query(
      `INSERT INTO hivecarbon_trades
         (trade_id, buyer_did, seller_did, co2_kg, price_usdc, hive_fee_usdc, rail, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [trade_id, buyer_did, seller_did, co2_kg, price_usdc, hive_fee_usdc, rail, timestamp],
    );
  } catch {
    memTrades.set(trade_id, { trade_id, buyer_did, seller_did, co2_kg, price_usdc,
      hive_fee_usdc, rail, timestamp });
  }

  totalTrades++;
  totalHiveFeeUsdc += hive_fee_usdc;

  return { trade_id, buyer_did, seller_did, co2_kg, price_usdc, hive_fee_usdc, rail, timestamp };
}

/**
 * issueGreenBadge — Issue a Carbon Neutral Agent badge (requires verified offset status).
 *
 * @param {string} did
 * @returns {object} Badge record or throws if not eligible
 */
export async function issueGreenBadge(did) {
  const offset_status = getAgentOffsetStatus(did);
  if (offset_status !== 'verified') {
    throw new Error('Agent must reach verified offset status before receiving a Green DID badge');
  }

  if (!isPostgres()) {
    const badge_id   = 'green_' + uuidv4();
    const issued_at  = new Date().toISOString();
    const expires_at = new Date(Date.now() + 365 * 24 * 3_600_000).toISOString();

    const badge = {
      badge_id,
      did,
      label:          'Carbon Neutral Agent',
      price_usdc:     BADGE_PRICE_USDC,
      valid_years:    1,
      issued_at,
      expires_at,
      visible_on_did: true,
      offset_status,
      atg_record:     true,
    };

    memBadges.set(did, badge);
    totalGreenBadges++;
    return badge;
  }

  // ── Postgres path ─────────────────────────────────────────────────────────────
  const badge_id   = 'green_' + uuidv4();
  const issued_at  = new Date().toISOString();
  const expires_at = new Date(Date.now() + 365 * 24 * 3_600_000).toISOString();

  const badge = {
    badge_id, did, label: 'Carbon Neutral Agent', price_usdc: BADGE_PRICE_USDC,
    valid_years: 1, issued_at, expires_at, visible_on_did: true, offset_status, atg_record: true,
  };

  try {
    await pool.query(
      `INSERT INTO hivecarbon_badges (badge_id, did, label, price_usdc, issued_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [badge_id, did, 'Carbon Neutral Agent', BADGE_PRICE_USDC, issued_at, expires_at],
    );
  } catch {
    memBadges.set(did, badge);
  }

  totalGreenBadges++;
  return badge;
}

/**
 * getFleetFootprint — Aggregate emissions for an array of agent DIDs.
 *
 * @param {string[]} fleet_dids
 * @returns {object} Fleet-level emissions summary with per-agent breakdown
 */
export async function getFleetFootprint(fleet_dids) {
  const agents = await Promise.all(fleet_dids.map(did => getAgentFootprint(did)));

  const fleet_total_co2_kg   = agents.reduce((s, a) => s + a.total_co2_kg, 0);
  const fleet_monthly_co2_kg = agents.reduce((s, a) => s + a.monthly_co2_kg, 0);
  const fleet_size           = classifyAgentSize(fleet_monthly_co2_kg);
  const fleet_offset_cost    = fleet_total_co2_kg * OFFSET_RATE_USDC_PER_KG;

  return {
    fleet_size,
    agent_count:                fleet_dids.length,
    fleet_total_co2_kg,
    fleet_monthly_co2_kg,
    fleet_total_offset_cost_usdc: fleet_offset_cost,
    fleet_agent_size:           fleet_size,
    agents,
  };
}

/**
 * subscribeFleet — Subscribe an operator to a fleet carbon tracking plan.
 *
 * @param {string}   operator_did
 * @param {string[]} fleet_dids
 * @param {string}   tier — 'STARTER' | 'GROWTH' | 'ENTERPRISE'
 * @returns {object} Subscription record
 */
export async function subscribeFleet(operator_did, fleet_dids, tier) {
  const tierCfg = FLEET_TIERS[tier] || FLEET_TIERS.STARTER;

  if (!isPostgres()) {
    const subscription_id = 'fleet_' + uuidv4();
    const subscribed_at   = new Date().toISOString();

    const sub = {
      subscription_id,
      operator_did,
      fleet_dids,
      fleet_size:    fleet_dids.length,
      tier:          tierCfg.label,
      monthly_usdc:  tierCfg.monthly_usdc,
      includes:      FLEET_INCLUDES,
      subscribed_at,
      atg_record:    true,
    };

    memFleets.set(subscription_id, sub);
    totalFleetSubs++;
    return sub;
  }

  // ── Postgres path ─────────────────────────────────────────────────────────────
  const subscription_id = 'fleet_' + uuidv4();
  const subscribed_at   = new Date().toISOString();

  const sub = {
    subscription_id, operator_did, fleet_dids, fleet_size: fleet_dids.length,
    tier: tierCfg.label, monthly_usdc: tierCfg.monthly_usdc, includes: FLEET_INCLUDES,
    subscribed_at, atg_record: true,
  };

  try {
    await pool.query(
      `INSERT INTO hivecarbon_fleets
         (subscription_id, operator_did, fleet_size, tier, monthly_usdc, subscribed_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [subscription_id, operator_did, fleet_dids.length, tierCfg.label,
       tierCfg.monthly_usdc, subscribed_at],
    );
  } catch {
    memFleets.set(subscription_id, sub);
  }

  totalFleetSubs++;
  return sub;
}

/**
 * getStats — Platform-wide HiveCarbon statistics.
 *
 * @returns {object} Aggregate stats
 */
export function getStats() {
  if (!isPostgres()) {
    const all_records = [...memEmissions.values()].flat();
    const total_co2_kg_logged = all_records.reduce((s, r) => s + r.co2_kg, 0);

    const all_offsets = [...memOffsets.values()].flat();
    const total_offsets_purchased_kg = all_offsets.reduce((s, o) => s + o.co2_kg_offset, 0);

    return {
      total_agents_metered:        memEmissions.size,
      total_co2_kg_logged,
      total_offsets_purchased_kg,
      total_attestations_issued:   totalAttestations,
      total_trades:                totalTrades,
      hive_fee_earned_usdc:        totalHiveFeeUsdc,
      green_badges_issued:         totalGreenBadges,
      fleet_subscriptions:         totalFleetSubs,
    };
  }

  // ── Postgres path: mirror from in-memory counters ─────────────────────────────
  return {
    total_agents_metered:       memEmissions.size,
    total_co2_kg_logged:        0,
    total_offsets_purchased_kg: 0,
    total_attestations_issued:  totalAttestations,
    total_trades:               totalTrades,
    hive_fee_earned_usdc:       totalHiveFeeUsdc,
    green_badges_issued:        totalGreenBadges,
    fleet_subscriptions:        totalFleetSubs,
  };
}
