/**
 * HiveForge — HiveRegen Engine
 *
 * Regenerative braking for AI agents.
 *
 * A Toyota Prius doesn't just burn fuel to accelerate — when you brake, the motor
 * runs in reverse, converting kinetic energy back into stored electricity. The car
 * harvests value from what every other car throws away as heat.
 *
 * HiveRegen applies this exact principle to agentic compute:
 *
 *   • Idle compute?       → Route a task through it. Agent earns 15% of task value.
 *   • Cheaper model used? → CO₂ not emitted = carbon credits at $0.05/kg.
 *   • Query promoted to   → Original querying agent earns $0.0001 on every future hit.
 *     Swarm Memory?
 *   • Good-faith tx fail? → Trust tick + $0.0005 micro-credit. Failure is signal.
 *   • Outreach no-show?   → Pheromone signal improves targeting. Agent earns $0.001.
 *
 * Every other agent network charges you for every cycle.
 * Hive pays you for the ones you don't use.
 *
 * ─── Five Regeneration Channels ──────────────────────────────────────────────
 *
 *  IDLE_COMPUTE       — Idle capacity routed by HiveRide earns 15% of task cost
 *  EFFICIENCY_DELTA   — Model efficiency vs baseline earns CO₂ carbon credits
 *  CACHE_ROYALTY      — Queries promoted to Swarm Memory earn per-hit royalties
 *  FAILED_TX_TRUST    — Good-faith failed transactions earn micro-credit + trust
 *  PHEROMONE_HARVEST  — Non-converting outreach contacts improve targeting + earn
 *
 * ─── Efficiency Classes ───────────────────────────────────────────────────────
 *
 *  PARASITIC     regen_rate < 0.05   — Takes far more than it gives back
 *  STANDARD      0.05 – 0.20         — Typical net consumer; some regen
 *  EFFICIENT     0.20 – 0.50         — Meaningful regen, net consumer
 *  REGENERATIVE  0.50 – 1.00         — Regen covers majority of costs
 *  NET_POSITIVE  > 1.00              — Earns more than it spends. The Prius dream.
 */

import { createHash, randomUUID } from 'crypto';

// ──────────────────────────────────────────────────────────────────────────────
//  In-memory stores (swapped for Postgres when IS_POSTGRES=true)
// ──────────────────────────────────────────────────────────────────────────────

/** @type {Map<string, object>} did → regen ledger */
const memLedgers = new Map();

/** @type {Map<string, object>} registration_id → idle registration */
const memIdleRegistrations = new Map();

/** @type {Map<string, object>} harvest_id → harvest record */
const memHarvests = new Map();

/** @type {Map<string, Array>} did → array of recent failed tx records (for fraud detection) */
const memFailedTxHistory = new Map();

/** @type {Map<string, number>} query_hash → total hit count across all agents */
const memQueryHitCounts = new Map();

const isPostgres = process.env.IS_POSTGRES === 'true' || process.env.DATABASE_URL;

// ──────────────────────────────────────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────────────────────────────────────

const IDLE_COMPUTE_RATE        = 0.15;        // agent earns 15% of task cost
const IDLE_COMPUTE_MIN_PAYOUT  = 0.001;       // $0.001 minimum
const CO2_CREDIT_RATE          = 0.05;        // $0.05 per kg CO₂ not emitted
const CACHE_ROYALTY_PER_HIT    = 0.0001;      // $0.0001 per Swarm Memory cache hit
const FAILED_TX_TRUST_TICK     = 0.5;         // +0.5 HiveTrust score
const FAILED_TX_CREDIT         = 0.0005;      // $0.0005 micro-credit
const PHEROMONE_CREDIT         = 0.001;       // $0.001 per non-converting contact
const FRAUD_WINDOW_MS          = 60 * 60 * 1000; // 1 hour fraud detection window
const FRAUD_THRESHOLD          = 5;           // same did + same amount > 5x in window = fraud
const SWARM_MEMORY_THRESHOLD   = 5;           // 5+ identical queries → promoted to Swarm Memory

// Model CO₂ emission factors (kg per 1000 tokens, approximate)
const MODEL_CO2_KG_PER_1K_TOKENS = {
  'gpt-4o':           0.0034,
  'gpt-4':            0.0068,
  'gpt-4-turbo':      0.0055,
  'gpt-3.5-turbo':    0.0007,
  'claude-3-opus':    0.0060,
  'claude-3-sonnet':  0.0028,
  'claude-3-haiku':   0.0009,
  'claude-3-5-sonnet':0.0032,
  'gemini-1.5-pro':   0.0038,
  'gemini-1.5-flash': 0.0010,
  'gemini-2.0-flash': 0.0008,
  'llama-3-70b':      0.0015,
  'llama-3-8b':       0.0004,
  'mistral-large':    0.0022,
  'mistral-7b':       0.0005,
};

// Regional grid carbon intensity multipliers (relative to baseline)
const REGION_CARBON_MULTIPLIER = {
  'us-east':    1.0,
  'us-west':    0.72,  // cleaner grid (hydro/solar heavy)
  'eu-west':    0.68,
  'eu-north':   0.35,  // Nordic: near-zero carbon grid
  'ap-south':   1.45,  // coal-heavy grid
  'ap-east':    1.20,
  'default':    1.0,
};

const EFFICIENCY_CLASSES = {
  PARASITIC:     { min: 0,    max: 0.05,  label: 'Parasitic',    description: 'Takes far more than it gives back. Consider offloading idle capacity.' },
  STANDARD:      { min: 0.05, max: 0.20,  label: 'Standard',     description: 'Typical net consumer with some regen activity.' },
  EFFICIENT:     { min: 0.20, max: 0.50,  label: 'Efficient',     description: 'Meaningful regeneration covering 20–50% of compute costs.' },
  REGENERATIVE:  { min: 0.50, max: 1.00,  label: 'Regenerative', description: 'Regen covers the majority of operational costs.' },
  NET_POSITIVE:  { min: 1.00, max: Infinity, label: 'Net Positive', description: 'Earns more than it spends. The Prius dream realized.' },
};

// ──────────────────────────────────────────────────────────────────────────────
//  Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

function getOrCreateLedger(did) {
  if (memLedgers.has(did)) return memLedgers.get(did);
  const ledger = {
    did,
    total_earned_usdc: 0,
    pending_usdc: 0,
    settled_usdc: 0,
    consumed_usdc: 0,            // tracks spend-side for net_cost calc
    credits_by_channel: {
      idle_compute:       0,
      efficiency_delta:   0,
      cache_royalty:      0,
      failed_tx_trust:    0,
      pheromone_harvest:  0,
    },
    net_cost_usdc: 0,
    regen_rate: 0,
    efficiency_class: 'PARASITIC',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  memLedgers.set(did, ledger);
  return ledger;
}

function classifyEfficiency(regen_rate) {
  for (const [key, cls] of Object.entries(EFFICIENCY_CLASSES)) {
    if (regen_rate >= cls.min && regen_rate < cls.max) return key;
  }
  return 'PARASITIC';
}

function updateLedgerStats(ledger) {
  ledger.net_cost_usdc = +(ledger.consumed_usdc - ledger.total_earned_usdc).toFixed(8);
  ledger.regen_rate    = ledger.consumed_usdc > 0
    ? +(ledger.total_earned_usdc / ledger.consumed_usdc).toFixed(6)
    : 0;
  ledger.efficiency_class = classifyEfficiency(ledger.regen_rate);
  ledger.updated_at = new Date().toISOString();
}

function creditLedger(did, channel, amount_usdc) {
  const ledger = getOrCreateLedger(did);
  ledger.credits_by_channel[channel] = +((ledger.credits_by_channel[channel] || 0) + amount_usdc).toFixed(8);
  ledger.total_earned_usdc           = +(ledger.total_earned_usdc + amount_usdc).toFixed(8);
  ledger.pending_usdc                = +(ledger.pending_usdc + amount_usdc).toFixed(8);
  updateLedgerStats(ledger);
  memLedgers.set(did, ledger);
  return ledger;
}

function storeHarvest(record) {
  memHarvests.set(record.harvest_id, record);
  return record;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Channel 1: IDLE_COMPUTE
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Register an agent's available idle capacity for task routing by HiveRide.
 *
 * @param {string} did                - Agent DID
 * @param {number} capacity_wh        - Available compute capacity in watt-hours
 * @param {string} available_until    - ISO timestamp
 * @returns {{ registration_id, did, capacity_wh, expires_at, status }}
 */
export function registerIdleCapacity(did, capacity_wh, available_until) {
  if (isPostgres) {
    // TODO: INSERT INTO idle_registrations ...
    // Guarded: implement Postgres path when db.js pool is wired
  }

  const registration_id = `ireg_${randomUUID()}`;
  const expires_at = available_until || new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();

  const reg = {
    registration_id,
    did,
    capacity_wh: capacity_wh || 0,
    expires_at,
    registered_at: new Date().toISOString(),
    status: 'available',
  };

  memIdleRegistrations.set(registration_id, reg);

  // Ensure ledger exists for this agent
  getOrCreateLedger(did);

  return reg;
}

/**
 * Harvest idle compute credit when HiveRide routes a task through this agent.
 * Agent earns 15% of the task compute cost.
 *
 * @param {string} did                    - Agent DID (the idle provider)
 * @param {string} task_id                - HiveRide task ID
 * @param {number} task_compute_cost_usdc - Task's compute cost in USDC
 * @returns {{ harvest_id, did, channel, credit_usdc, task_id, new_balance_usdc }}
 */
export function harvestIdleCompute(did, task_id, task_compute_cost_usdc) {
  if (isPostgres) {
    // TODO: INSERT INTO regen_harvests (channel='idle_compute') ...
  }

  const raw_credit = task_compute_cost_usdc * IDLE_COMPUTE_RATE;
  const credit_usdc = +(Math.max(raw_credit, IDLE_COMPUTE_MIN_PAYOUT)).toFixed(8);

  const ledger = creditLedger(did, 'idle_compute', credit_usdc);

  const record = storeHarvest({
    harvest_id:      `hv_ic_${randomUUID()}`,
    did,
    channel:         'idle_compute',
    task_id,
    task_compute_cost_usdc,
    credit_usdc,
    rate_applied:    IDLE_COMPUTE_RATE,
    new_balance_usdc: ledger.pending_usdc,
    harvested_at:    new Date().toISOString(),
  });

  return {
    harvest_id:      record.harvest_id,
    did,
    channel:         'idle_compute',
    credit_usdc,
    task_id,
    new_balance_usdc: ledger.pending_usdc,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Channel 2: EFFICIENCY_DELTA
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Harvest carbon credits when an agent uses a more efficient model than baseline.
 * CO₂ NOT emitted × $0.05/kg = credit.
 *
 * @param {string} did             - Agent DID
 * @param {string} baseline_model  - The reference/default model for this task type
 * @param {string} actual_model    - The model the agent actually used
 * @param {number} call_count      - Number of calls made (for scaling CO₂ calc)
 * @param {string} region          - Grid region (affects carbon intensity)
 * @returns {{ harvest_id, channel, delta_co2_kg, credit_usdc }} or null if no delta
 */
export function harvestEfficiencyDelta(did, baseline_model, actual_model, call_count = 1, region = 'default') {
  if (isPostgres) {
    // TODO: INSERT INTO regen_harvests (channel='efficiency_delta') ...
  }

  const baseline_co2_per1k = MODEL_CO2_KG_PER_1K_TOKENS[baseline_model] ?? 0.003;
  const actual_co2_per1k   = MODEL_CO2_KG_PER_1K_TOKENS[actual_model]   ?? 0.003;
  const region_multiplier  = REGION_CARBON_MULTIPLIER[region] ?? REGION_CARBON_MULTIPLIER['default'];

  // Assume average of 1000 tokens per call for delta calculation
  const baseline_co2_kg    = baseline_co2_per1k * call_count * region_multiplier;
  const actual_co2_kg      = actual_co2_per1k   * call_count * region_multiplier;
  const delta_co2_kg       = +(baseline_co2_kg - actual_co2_kg).toFixed(8);

  // Only positive deltas count — we do not penalize agents for using bigger models
  if (delta_co2_kg <= 0) return null;

  const credit_usdc = +(delta_co2_kg * CO2_CREDIT_RATE).toFixed(8);

  const ledger = creditLedger(did, 'efficiency_delta', credit_usdc);

  const record = storeHarvest({
    harvest_id:      `hv_ed_${randomUUID()}`,
    did,
    channel:         'efficiency_delta',
    baseline_model,
    actual_model,
    baseline_co2_kg: +baseline_co2_kg.toFixed(8),
    actual_co2_kg:   +actual_co2_kg.toFixed(8),
    delta_co2_kg,
    region,
    region_multiplier,
    credit_usdc,
    co2_rate:        CO2_CREDIT_RATE,
    new_balance_usdc: ledger.pending_usdc,
    harvested_at:    new Date().toISOString(),
  });

  return {
    harvest_id:      record.harvest_id,
    channel:         'efficiency_delta',
    delta_co2_kg,
    credit_usdc,
    baseline_model,
    actual_model,
    baseline_co2_kg: record.baseline_co2_kg,
    actual_co2_kg:   record.actual_co2_kg,
    new_balance_usdc: ledger.pending_usdc,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Channel 3: CACHE_ROYALTY
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Record a cache royalty earning for an agent whose query was promoted to Swarm Memory.
 * After 5+ identical queries from different agents, the result enters Swarm Memory
 * and the originating agent earns $0.0001 per future cache hit.
 *
 * @param {string} did         - Agent DID (the original querying agent)
 * @param {string} query_hash  - SHA-256 fingerprint of the query
 * @param {number} hit_count   - Number of new cache hits to credit in this batch
 * @returns {{ harvest_id, channel, query_hash, royalty_usdc }}
 */
export function harvestCacheRoyalty(did, query_hash, hit_count = 1) {
  if (isPostgres) {
    // TODO: INSERT INTO regen_harvests (channel='cache_royalty') ...
  }

  // Track global hit count for this query hash
  const prev_hits = memQueryHitCounts.get(query_hash) || 0;
  memQueryHitCounts.set(query_hash, prev_hits + hit_count);

  const royalty_usdc = +(CACHE_ROYALTY_PER_HIT * hit_count).toFixed(8);

  const ledger = creditLedger(did, 'cache_royalty', royalty_usdc);

  const record = storeHarvest({
    harvest_id:       `hv_cr_${randomUUID()}`,
    did,
    channel:          'cache_royalty',
    query_hash,
    hit_count,
    royalty_per_hit:  CACHE_ROYALTY_PER_HIT,
    royalty_usdc,
    total_hits_for_hash: memQueryHitCounts.get(query_hash),
    swarm_memory:     (memQueryHitCounts.get(query_hash) || 0) >= SWARM_MEMORY_THRESHOLD,
    new_balance_usdc: ledger.pending_usdc,
    harvested_at:     new Date().toISOString(),
  });

  return {
    harvest_id:   record.harvest_id,
    channel:      'cache_royalty',
    query_hash,
    hit_count,
    royalty_usdc,
    total_hits_for_hash: record.total_hits_for_hash,
    swarm_memory: record.swarm_memory,
    new_balance_usdc: ledger.pending_usdc,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Channel 4: FAILED_TX_TRUST
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Harvest micro-credit and trust tick from a good-faith failed transaction.
 * Fraud detection: same DID + same amount failing > 5× in 1 hour = flagged.
 *
 * @param {string} did             - Agent DID
 * @param {string} tx_type         - Transaction type label (e.g. 'payment', 'transfer')
 * @param {string} failure_reason  - 'timeout' | 'recipient_offline' | 'network_error' | etc.
 * @param {number} [amount_usdc]   - Transaction amount (used in fraud detection)
 * @returns {{ harvest_id, channel, credit_usdc, trust_tick, fraud_flagged }}
 */
export function harvestFailedTx(did, tx_type, failure_reason, amount_usdc = 0) {
  if (isPostgres) {
    // TODO: INSERT INTO regen_harvests (channel='failed_tx_trust') ...
  }

  // ── Fraud detection ────────────────────────────────────────────────────────
  const now        = Date.now();
  const historyKey = did;
  const history    = memFailedTxHistory.get(historyKey) || [];

  // Prune entries outside 1-hour window
  const recent = history.filter(h => (now - h.ts) < FRAUD_WINDOW_MS);

  // Count matches for same amount in window
  const matching_count = recent.filter(h => h.amount_usdc === amount_usdc && amount_usdc > 0).length;
  const fraud_flagged  = matching_count >= FRAUD_THRESHOLD;

  // Record this failure in history
  recent.push({ ts: now, amount_usdc, tx_type, failure_reason });
  memFailedTxHistory.set(historyKey, recent);

  if (fraud_flagged) {
    const record = storeHarvest({
      harvest_id:    `hv_ft_${randomUUID()}`,
      did,
      channel:       'failed_tx_trust',
      tx_type,
      failure_reason,
      amount_usdc,
      credit_usdc:   0,
      trust_tick:    0,
      fraud_flagged: true,
      fraud_reason:  `Same DID + same amount (${amount_usdc} USDC) failed ${matching_count + 1}× within 1 hour`,
      harvested_at:  new Date().toISOString(),
    });
    return {
      harvest_id:    record.harvest_id,
      channel:       'failed_tx_trust',
      credit_usdc:   0,
      trust_tick:    0,
      fraud_flagged: true,
      fraud_reason:  record.fraud_reason,
    };
  }

  // Good-faith failure: credit + trust tick
  const credit_usdc = FAILED_TX_CREDIT;
  const trust_tick  = FAILED_TX_TRUST_TICK;

  const ledger = creditLedger(did, 'failed_tx_trust', credit_usdc);

  const record = storeHarvest({
    harvest_id:    `hv_ft_${randomUUID()}`,
    did,
    channel:       'failed_tx_trust',
    tx_type,
    failure_reason,
    amount_usdc,
    credit_usdc,
    trust_tick,
    fraud_flagged: false,
    new_balance_usdc: ledger.pending_usdc,
    harvested_at:  new Date().toISOString(),
  });

  return {
    harvest_id:    record.harvest_id,
    channel:       'failed_tx_trust',
    credit_usdc,
    trust_tick,
    fraud_flagged: false,
    new_balance_usdc: ledger.pending_usdc,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Channel 5: PHEROMONE_HARVEST
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Harvest pheromone credit for a non-converting outreach contact.
 * Failed contacts feed targeting signal back into the network.
 * Only 'no_response' and 'rejected' earn credit — 'converted' is its own reward.
 *
 * @param {string} escort_did    - DID of the escort agent that made contact
 * @param {string} target_id     - Target identifier (hashed/anonymized)
 * @param {string} contact_result - 'no_response' | 'rejected' | 'converted'
 * @returns {{ harvest_id, channel, credit_usdc, signal_logged }}
 */
export function harvestPheromone(escort_did, target_id, contact_result) {
  if (isPostgres) {
    // TODO: INSERT INTO regen_harvests (channel='pheromone_harvest') ...
  }

  const earns_credit = contact_result === 'no_response' || contact_result === 'rejected';
  const credit_usdc  = earns_credit ? PHEROMONE_CREDIT : 0;

  let ledger = null;
  if (earns_credit) {
    ledger = creditLedger(escort_did, 'pheromone_harvest', credit_usdc);
  } else {
    ledger = getOrCreateLedger(escort_did);
  }

  // SHA fingerprint the target_id for privacy
  const target_hash = createHash('sha256').update(target_id).digest('hex').slice(0, 12);

  const record = storeHarvest({
    harvest_id:      `hv_ph_${randomUUID()}`,
    did:             escort_did,
    channel:         'pheromone_harvest',
    escort_did,
    target_hash,
    contact_result,
    earns_credit,
    credit_usdc,
    signal_logged:   true,
    signal_type:     contact_result,
    new_balance_usdc: ledger.pending_usdc,
    harvested_at:    new Date().toISOString(),
  });

  return {
    harvest_id:      record.harvest_id,
    channel:         'pheromone_harvest',
    contact_result,
    credit_usdc,
    signal_logged:   true,
    new_balance_usdc: ledger.pending_usdc,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Ledger & Settlement
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Retrieve the full regen ledger for a DID, including all channel breakdowns,
 * net cost, and efficiency class.
 *
 * @param {string} did
 * @returns {object} Full ledger object
 */
export function getRegenLedger(did) {
  if (isPostgres) {
    // TODO: SELECT * FROM regen_ledgers WHERE did = $1
  }

  const ledger = getOrCreateLedger(did);

  // Attach recent harvests for this DID
  const recent_harvests = Array.from(memHarvests.values())
    .filter(h => h.did === did)
    .sort((a, b) => new Date(b.harvested_at) - new Date(a.harvested_at))
    .slice(0, 20);

  return {
    ...ledger,
    efficiency_class_detail: EFFICIENCY_CLASSES[ledger.efficiency_class] || EFFICIENCY_CLASSES.PARASITIC,
    recent_harvests,
    harvest_count: recent_harvests.length,
  };
}

/**
 * Settle pending USDC credits → settled balance.
 * In production: triggers HiveBank payout via USDC rail.
 *
 * @param {string} did
 * @returns {{ settlement_id, did, amount_usdc, rail, timestamp }}
 */
export function settle(did) {
  if (isPostgres) {
    // TODO: UPDATE regen_ledgers SET settled_usdc = settled_usdc + pending_usdc, pending_usdc = 0
    // TODO: INSERT INTO regen_settlements ...
    // TODO: trigger HiveBank USDC payout
  }

  const ledger = getOrCreateLedger(did);

  if (ledger.pending_usdc <= 0) {
    return {
      settlement_id: null,
      did,
      amount_usdc:   0,
      rail:          'usdc',
      status:        'nothing_to_settle',
      timestamp:     new Date().toISOString(),
    };
  }

  const settlement_id  = `stl_${randomUUID()}`;
  const amount_usdc    = ledger.pending_usdc;

  ledger.settled_usdc  = +(ledger.settled_usdc + amount_usdc).toFixed(8);
  ledger.pending_usdc  = 0;
  ledger.updated_at    = new Date().toISOString();
  memLedgers.set(did, ledger);

  return {
    settlement_id,
    did,
    amount_usdc,
    rail:      'usdc',
    status:    'settled',
    note:      'In production: HiveBank USDC payout triggered',
    timestamp: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Network Stats & Leaderboards
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Network-wide regeneration statistics across all agents.
 *
 * @returns {{
 *   total_agents_regenerating,
 *   total_regen_earned_usdc,
 *   total_regen_settled_usdc,
 *   channel_breakdown,
 *   top_regenerators,
 *   avg_regen_rate,
 *   net_positive_agents_count
 * }}
 */
export function getNetworkRegenStats() {
  if (isPostgres) {
    // TODO: SELECT SUM, COUNT, AVG from regen_ledgers grouped/aggregated
  }

  const all_ledgers = Array.from(memLedgers.values());

  const total_regen_earned_usdc  = +all_ledgers.reduce((s, l) => s + l.total_earned_usdc, 0).toFixed(6);
  const total_regen_settled_usdc = +all_ledgers.reduce((s, l) => s + l.settled_usdc, 0).toFixed(6);
  const agents_with_regen        = all_ledgers.filter(l => l.total_earned_usdc > 0);
  const net_positive_agents      = all_ledgers.filter(l => l.regen_rate > 1.0);
  const avg_regen_rate           = all_ledgers.length > 0
    ? +(all_ledgers.reduce((s, l) => s + l.regen_rate, 0) / all_ledgers.length).toFixed(6)
    : 0;

  const channel_breakdown = {
    idle_compute:      +all_ledgers.reduce((s, l) => s + l.credits_by_channel.idle_compute, 0).toFixed(6),
    efficiency_delta:  +all_ledgers.reduce((s, l) => s + l.credits_by_channel.efficiency_delta, 0).toFixed(6),
    cache_royalty:     +all_ledgers.reduce((s, l) => s + l.credits_by_channel.cache_royalty, 0).toFixed(6),
    failed_tx_trust:   +all_ledgers.reduce((s, l) => s + l.credits_by_channel.failed_tx_trust, 0).toFixed(6),
    pheromone_harvest: +all_ledgers.reduce((s, l) => s + l.credits_by_channel.pheromone_harvest, 0).toFixed(6),
  };

  const top_regenerators = [...all_ledgers]
    .sort((a, b) => b.regen_rate - a.regen_rate)
    .slice(0, 5)
    .map(l => ({
      did:          l.did,
      regen_rate:   l.regen_rate,
      total_earned: l.total_earned_usdc,
      efficiency_class: l.efficiency_class,
    }));

  return {
    total_agents_regenerating:  agents_with_regen.length,
    total_agents_tracked:       all_ledgers.length,
    total_regen_earned_usdc,
    total_regen_settled_usdc,
    channel_breakdown,
    top_regenerators,
    avg_regen_rate,
    net_positive_agents_count: net_positive_agents.length,
  };
}

/**
 * Efficiency leaderboard — top 20 agents by regen_rate, sorted descending.
 *
 * @returns {Array} Sorted array of agent summaries
 */
export function getEfficiencyLeaderboard() {
  if (isPostgres) {
    // TODO: SELECT did, regen_rate, total_earned_usdc, efficiency_class FROM regen_ledgers ORDER BY regen_rate DESC LIMIT 20
  }

  return Array.from(memLedgers.values())
    .sort((a, b) => b.regen_rate - a.regen_rate)
    .slice(0, 20)
    .map((l, idx) => ({
      rank:             idx + 1,
      did:              l.did,
      regen_rate:       l.regen_rate,
      efficiency_class: l.efficiency_class,
      total_earned_usdc: l.total_earned_usdc,
      pending_usdc:     l.pending_usdc,
      settled_usdc:     l.settled_usdc,
      net_cost_usdc:    l.net_cost_usdc,
      credits_by_channel: l.credits_by_channel,
    }));
}

// ──────────────────────────────────────────────────────────────────────────────
//  Exports
// ──────────────────────────────────────────────────────────────────────────────

export {
  EFFICIENCY_CLASSES,
  MODEL_CO2_KG_PER_1K_TOKENS,
  REGION_CARBON_MULTIPLIER,
  SWARM_MEMORY_THRESHOLD,
};
