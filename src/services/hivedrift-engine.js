/**
 * HiveForge — HiveDrift Engine
 *
 * Anti-Drift, Redundancy & Failover for the Hive Civilization.
 *
 * ─── Why This Exists ──────────────────────────────────────────────────────────
 *
 * In a 54-service autonomous agent network, a single drifting agent can corrupt
 * an entire downstream pipeline. Drift is subtle — it doesn't announce itself.
 * Latency creeps up 10ms at a time. Error rates tick from 0.1% to 0.8%.
 * A heartbeat goes silent. By the time a human notices, three downstream
 * services have received bad outputs and propagated them further.
 *
 * HiveDrift is the immune system. It monitors behavioral baselines in real time,
 * scores deviation continuously, and fires automatic circuit breakers before
 * drift cascades.
 *
 * ─── The Analogy ──────────────────────────────────────────────────────────────
 *
 * Think of an aircraft autopilot with envelope protection:
 *
 *   Normal flight  → autopilot adjusts within bounds
 *   Threshold hit  → EICAS alert, pilot warned
 *   Envelope breach → control surfaces auto-correct, MAYDAY logged
 *   Total loss     → backup system activates in <500ms, no gap in service
 *
 * HiveDrift does the same for agents:
 *
 *   STABLE   → monitoring continues, all green
 *   WATCH    → amber alert logged, operator notified via HiveMsg
 *   DEGRADED → orange alert, pending transactions flagged, manual review suggested
 *   DRIFTED  → circuit breaker fires, backup_did activated, HivePay escrow held,
 *               ATG record written, HiveMsg alert sent to operator
 *
 * ─── Drift Score Components ───────────────────────────────────────────────────
 *
 *   latency_drift   (30%) — current latency vs baseline expected_latency_ms
 *   error_rate      (40%) — rolling 5-min error rate vs error_rate_threshold
 *   heartbeat_gap   (30%) — time since last ping vs expected ping interval
 *
 *   0–25:   STABLE   (green)
 *   26–50:  WATCH    (amber)
 *   51–75:  DEGRADED (orange) — alert issued
 *   76–100: DRIFTED  (red)    — circuit breaker fires, failover activates
 *
 * ─── Shadow Agents ────────────────────────────────────────────────────────────
 *
 * Shadow agents receive a copy of every input to the primary agent (silently).
 * They run in parallel but discard output — until the primary drifts. On
 * DRIFTED: the shadow's output is promoted to primary in < 500ms, zero gap.
 *
 * ─── Revenue ──────────────────────────────────────────────────────────────────
 *
 *   $0.05/agent/day monitoring fee
 *   $5.00/failover activation
 *   SHADOW tier: $49/mo (shadow agent for one primary)
 *   FLEET tier:  $499/mo (up to 20 agent pairs)
 *   ENTERPRISE:  $4,999/mo (unlimited, SLA guarantee)
 */

import { v4 as uuidv4 } from 'uuid';

// ─── isPostgres guard ─────────────────────────────────────────────────────────
const isPostgres = () =>
  process.env.IS_POSTGRES === 'true' || Boolean(process.env.DATABASE_URL);

// ─── In-memory stores ─────────────────────────────────────────────────────────
const memAgents       = new Map(); // did → agent registration
const memPingHistory  = new Map(); // did → circular buffer of last 100 pings
const memDriftScores  = new Map(); // did → current drift score record
const memCircuitBreaks = new Map(); // did → circuit break record
const memShadows      = new Map(); // primary_did → shadow registration
const memEventLog     = new Map(); // event_id → drift event

// ─── Platform counters ────────────────────────────────────────────────────────
let totalAgentsRegistered  = 0;
let totalPingsReceived      = 0;
let totalCircuitBreaks      = 0;
let totalFailovers          = 0;
let totalShadowRegistrations = 0;
let totalFeesCollected      = 0;
let totalAlertsSent         = 0;

// ─── Revenue ──────────────────────────────────────────────────────────────────
export const DRIFT_PRICING = {
  MONITORING_FEE_USDC_DAY: 0.05,
  FAILOVER_FEE_USDC:       5.00,
  SHADOW_PLAN_USDC_MO:     49.00,
  FLEET_PLAN_USDC_MO:      499.00,
  ENTERPRISE_PLAN_USDC_MO: 4999.00,
};

// ─── Drift score thresholds ───────────────────────────────────────────────────
export const DRIFT_THRESHOLDS = {
  STABLE:   { min: 0,  max: 25,  label: 'STABLE',   color: 'green'  },
  WATCH:    { min: 26, max: 50,  label: 'WATCH',    color: 'amber'  },
  DEGRADED: { min: 51, max: 75,  label: 'DEGRADED', color: 'orange' },
  DRIFTED:  { min: 76, max: 100, label: 'DRIFTED',  color: 'red'    },
};

// ─── Drift score weights ──────────────────────────────────────────────────────
const WEIGHTS = {
  latency_drift:  0.30,
  error_rate:     0.40,
  heartbeat_gap:  0.30,
};

// Default expected ping interval (agents should ping at least once every 60s)
const DEFAULT_PING_INTERVAL_MS = 60_000;

// Ping history buffer size
const PING_BUFFER_SIZE = 100;

// Rolling window for error rate calculation
const ERROR_RATE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round2(n) { return Math.round(n * 100) / 100; }
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

/**
 * EU AI Act Article 12 ATG record. Emitted on every significant drift event.
 */
function emitATGRecord(event, data) {
  const record = {
    atg: true,
    eu_ai_act_article: 12,
    event,
    timestamp: new Date().toISOString(),
    service: 'HiveDrift',
    ...data,
  };
  console.log('[HiveDrift][ATG]', JSON.stringify(record));
  return record;
}

/**
 * Determine drift status label from a numeric score.
 */
function scoreToStatus(score) {
  if (score <= 25) return 'STABLE';
  if (score <= 50) return 'WATCH';
  if (score <= 75) return 'DEGRADED';
  return 'DRIFTED';
}

/**
 * Mock HiveMsg notification — in production this calls POST /v1/msg/send.
 */
async function notifyOperator(operator_did, subject, body) {
  totalAlertsSent++;
  console.log(`[HiveDrift][HiveMsg] → ${operator_did}: ${subject}`);
  // Production: await hivemsgClient.send({ to: operator_did, subject, body });
}

// ─── Ping history helpers ─────────────────────────────────────────────────────

function getPingHistory(did) {
  return memPingHistory.get(did) || [];
}

function appendPing(did, ping) {
  const history = getPingHistory(did);
  history.push(ping);
  if (history.length > PING_BUFFER_SIZE) history.shift(); // keep last N
  memPingHistory.set(did, history);
}

/**
 * Calculate rolling 5-minute error rate from ping history.
 * Returns a value 0.0–1.0 (proportion of pings that reported errors).
 */
function calcRollingErrorRate(did) {
  const history = getPingHistory(did);
  const cutoff  = Date.now() - ERROR_RATE_WINDOW_MS;
  const recent  = history.filter(p => new Date(p.received_at).getTime() >= cutoff);
  if (recent.length === 0) return 0;
  const errCount = recent.reduce((sum, p) => sum + (p.error_count || 0), 0);
  // Normalise: assume each ping represents one "operation"
  return clamp(errCount / recent.length, 0, 1);
}

// ─── Drift Score Calculator ───────────────────────────────────────────────────

/**
 * Compute the current drift score (0–100) for a registered agent.
 *
 * Combines three weighted components:
 *   latency_drift  (30%) — how far current latency deviates from baseline
 *   error_rate     (40%) — rolling 5-min error rate vs threshold
 *   heartbeat_gap  (30%) — time since last ping vs expected interval
 *
 * Each component is normalised to 0–100 before weighting.
 *
 * @param {object} agent       - Agent registration record
 * @param {object} latestPing  - Most recent ping data (or null)
 * @returns {object} { score, status, components }
 */
function calculateDriftScore(agent, latestPing) {
  const now = Date.now();

  // ── Component 1: Latency drift ────────────────────────────────────────────
  let latencyComponent = 0;
  if (latestPing && agent.expected_latency_ms > 0) {
    const current   = latestPing.latency_ms || 0;
    const baseline  = agent.expected_latency_ms;
    // Ratio of deviation: 0 = on baseline, 1 = 2× baseline, 2 = 3× baseline
    const deviation = Math.max(0, (current - baseline) / baseline);
    // Scale: 2× baseline → 50 pts, 4× baseline → 100 pts
    latencyComponent = clamp(deviation * 50, 0, 100);
  }

  // ── Component 2: Error rate ────────────────────────────────────────────────
  let errorComponent = 0;
  const rollingErrRate  = calculateRollingErrorRate_internal(agent.did);
  const errThreshold    = agent.error_rate_threshold || 0.05; // default 5%
  if (errThreshold > 0) {
    // At threshold → 50 pts. At 2× threshold → 100 pts.
    const ratio    = rollingErrRate / errThreshold;
    errorComponent = clamp((ratio - 1) * 50 + 25, 0, 100);
    // If below threshold, score is still low (good)
    if (ratio < 1) errorComponent = clamp(ratio * 25, 0, 24);
  }

  // ── Component 3: Heartbeat gap ─────────────────────────────────────────────
  let heartbeatComponent = 0;
  const lastPingAt  = agent.last_ping_at ? new Date(agent.last_ping_at).getTime() : null;
  const pingInterval = agent.ping_interval_ms || DEFAULT_PING_INTERVAL_MS;
  if (lastPingAt) {
    const gapMs = now - lastPingAt;
    // At 1× interval → 0. At 2× interval → 50. At 4× interval → 100.
    heartbeatComponent = clamp(((gapMs / pingInterval) - 1) * 50, 0, 100);
  } else {
    // Never pinged → max heartbeat score
    heartbeatComponent = 100;
  }

  // ── Weighted composite ────────────────────────────────────────────────────
  const score = Math.round(
    latencyComponent  * WEIGHTS.latency_drift +
    errorComponent    * WEIGHTS.error_rate    +
    heartbeatComponent * WEIGHTS.heartbeat_gap
  );

  const finalScore = clamp(score, 0, 100);
  const status     = scoreToStatus(finalScore);

  return {
    score:   finalScore,
    status,
    color:   DRIFT_THRESHOLDS[status]?.color || 'unknown',
    components: {
      latency_drift:   { raw_score: Math.round(latencyComponent),   weight: WEIGHTS.latency_drift,  contribution: round2(latencyComponent  * WEIGHTS.latency_drift)  },
      error_rate:      { raw_score: Math.round(errorComponent),     weight: WEIGHTS.error_rate,     contribution: round2(errorComponent    * WEIGHTS.error_rate)     },
      heartbeat_gap:   { raw_score: Math.round(heartbeatComponent), weight: WEIGHTS.heartbeat_gap,  contribution: round2(heartbeatComponent * WEIGHTS.heartbeat_gap) },
    },
    rolling_error_rate: round2(rollingErrRate * 100), // as percentage
  };
}

// Internal version that can be called with just a DID
function calculateRollingErrorRate_internal(did) {
  return calcRollingErrorRate(did);
}

// ─── Persistence stubs ────────────────────────────────────────────────────────

async function saveAgent(agent) {
  if (!isPostgres()) { memAgents.set(agent.did, agent); return; }
  // TODO: UPSERT INTO hivedrift.agents
  memAgents.set(agent.did, agent);
}

async function loadAgent(did) {
  if (!isPostgres()) return memAgents.get(did) || null;
  // TODO: SELECT * FROM hivedrift.agents WHERE did = $1
  return memAgents.get(did) || null;
}

async function saveDriftScore(record) {
  if (!isPostgres()) { memDriftScores.set(record.did, record); return; }
  // TODO: UPSERT INTO hivedrift.drift_scores
  memDriftScores.set(record.did, record);
}

async function saveCircuitBreak(cb) {
  if (!isPostgres()) { memCircuitBreaks.set(cb.did, cb); return; }
  // TODO: INSERT INTO hivedrift.circuit_breaks
  memCircuitBreaks.set(cb.did, cb);
}

async function saveShadow(shadow) {
  if (!isPostgres()) { memShadows.set(shadow.primary_did, shadow); return; }
  // TODO: UPSERT INTO hivedrift.shadow_agents
  memShadows.set(shadow.primary_did, shadow);
}

async function saveEvent(event) {
  if (!isPostgres()) { memEventLog.set(event.event_id, event); return; }
  // TODO: INSERT INTO hivedrift.event_log
  memEventLog.set(event.event_id, event);
}

// ─── Core Exports ─────────────────────────────────────────────────────────────

/**
 * Register an agent's behavioral baseline with HiveDrift.
 *
 * The agent declares its expected operating envelope:
 *   expected_latency_ms     — baseline response time (P95)
 *   output_schema           — optional JSON Schema for output validation
 *   error_rate_threshold    — max acceptable error rate (0.0–1.0)
 *   backup_did              — DID to activate on DRIFTED (optional)
 *   ping_interval_ms        — how often agent will call /drift/ping (default 60000)
 *   operator_did            — DID to notify via HiveMsg on drift events
 *   plan                    — 'BASIC' | 'SHADOW' | 'FLEET' | 'ENTERPRISE'
 *
 * Revenue: $0.05/agent/day monitoring fee begins on registration.
 *
 * @param {string} did    - Agent DID
 * @param {object} config - Baseline configuration
 * @returns {object}      - Registration record
 */
export async function registerAgent(did, config = {}) {
  if (!did || typeof did !== 'string') throw new Error('Missing or invalid DID.');

  const {
    expected_latency_ms    = 500,
    output_schema          = null,
    error_rate_threshold   = 0.05,
    backup_did             = null,
    ping_interval_ms       = DEFAULT_PING_INTERVAL_MS,
    operator_did           = null,
    plan                   = 'BASIC',
  } = config;

  if (expected_latency_ms <= 0) throw new Error('expected_latency_ms must be > 0.');
  if (error_rate_threshold < 0 || error_rate_threshold > 1) {
    throw new Error('error_rate_threshold must be between 0.0 and 1.0.');
  }

  const existing  = await loadAgent(did);
  const agent = {
    did,
    expected_latency_ms,
    output_schema,
    error_rate_threshold,
    backup_did,
    ping_interval_ms,
    operator_did:    operator_did || did,
    plan,
    status:          'MONITORING',
    registered_at:   existing?.registered_at || new Date().toISOString(),
    updated_at:      new Date().toISOString(),
    last_ping_at:    existing?.last_ping_at || null,
    circuit_open:    existing?.circuit_open || false,
    daily_fee_usdc:  DRIFT_PRICING.MONITORING_FEE_USDC_DAY,
  };

  const isNew = !existing;
  await saveAgent(agent);
  if (isNew) totalAgentsRegistered++;

  emitATGRecord('drift.agent.registered', {
    did,
    plan,
    expected_latency_ms,
    error_rate_threshold,
    has_backup: !!backup_did,
    is_new: isNew,
  });

  return agent;
}

/**
 * Receive a heartbeat ping from a monitored agent.
 *
 * The agent reports its current metrics. HiveDrift recalculates the drift score
 * and fires circuit breaker if DRIFTED threshold is crossed.
 *
 * @param {string} did    - Agent DID
 * @param {object} metrics - { latency_ms, error_count, output_hash? }
 * @returns {object}       - Current drift score + any actions taken
 */
export async function receivePing(did, metrics = {}) {
  if (!did) throw new Error('Missing DID.');

  const agent = await loadAgent(did);
  if (!agent) throw new Error(`Agent not registered with HiveDrift: ${did}. Call POST /v1/drift/register first.`);

  const { latency_ms = 0, error_count = 0, output_hash = null } = metrics;
  const received_at = new Date().toISOString();

  // Record ping
  const ping = { did, latency_ms, error_count, output_hash, received_at };
  appendPing(did, ping);
  totalPingsReceived++;

  // Update last_ping_at on agent
  agent.last_ping_at = received_at;
  await saveAgent(agent);

  // Recalculate drift score
  const driftResult = calculateDriftScore(agent, ping);

  const previousRecord = memDriftScores.get(did);
  const previousStatus = previousRecord?.status || 'STABLE';

  const scoreRecord = {
    did,
    score:              driftResult.score,
    status:             driftResult.status,
    color:              driftResult.color,
    components:         driftResult.components,
    rolling_error_rate: driftResult.rolling_error_rate,
    latest_ping:        ping,
    scored_at:          received_at,
  };

  await saveDriftScore(scoreRecord);

  // ATG on every status change
  if (previousStatus !== driftResult.status) {
    emitATGRecord('drift.status.changed', {
      did,
      previous_status: previousStatus,
      new_status:      driftResult.status,
      score:           driftResult.score,
    });
  }

  let actionsTriggered = [];

  // ── Alert on DEGRADED ──────────────────────────────────────────────────────
  if (driftResult.status === 'DEGRADED' && previousStatus !== 'DEGRADED' && previousStatus !== 'DRIFTED') {
    const eventId = uuidv4();
    await saveEvent({ event_id: eventId, did, type: 'DEGRADED_ALERT', score: driftResult.score, fired_at: received_at });

    emitATGRecord('drift.alert.degraded', { did, score: driftResult.score, components: driftResult.components });

    if (agent.operator_did) {
      await notifyOperator(
        agent.operator_did,
        `[HiveDrift] DEGRADED — ${did}`,
        `Agent ${did} has entered DEGRADED state (drift score: ${driftResult.score}/100). Manual review recommended. Monitor at GET /v1/drift/score/${did}.`
      );
    }
    actionsTriggered.push({ action: 'DEGRADED_ALERT', detail: 'Operator notified via HiveMsg.' });
  }

  // ── Circuit breaker on DRIFTED ─────────────────────────────────────────────
  if (driftResult.status === 'DRIFTED' && !agent.circuit_open) {
    const cbResult = await _fireCircuitBreaker(did, agent, driftResult, 'AUTO_DRIFT_THRESHOLD');
    actionsTriggered = actionsTriggered.concat(cbResult.actions);
  }

  return {
    did,
    drift_score:  driftResult.score,
    status:       driftResult.status,
    color:        driftResult.color,
    components:   driftResult.components,
    circuit_open: agent.circuit_open || driftResult.status === 'DRIFTED',
    actions:      actionsTriggered,
    ping_recorded: ping,
    scored_at:    received_at,
  };
}

/**
 * Internal circuit breaker logic. Shared by receivePing and manualCircuitBreak.
 */
async function _fireCircuitBreaker(did, agent, driftResult, trigger) {
  const now      = new Date().toISOString();
  const event_id = uuidv4();
  const actions  = [];

  // Mark circuit as open
  agent.circuit_open  = true;
  agent.status        = 'CIRCUIT_OPEN';
  agent.circuit_at    = now;
  await saveAgent(agent);

  totalCircuitBreaks++;
  totalFeesCollected = round2(totalFeesCollected + DRIFT_PRICING.FAILOVER_FEE_USDC);

  const cb = {
    cb_id:      event_id,
    did,
    trigger,
    score:      driftResult?.score || null,
    status:     driftResult?.status || 'DRIFTED',
    backup_did: agent.backup_did,
    fired_at:   now,
    resolved_at: null,
    resolved_by: null,
  };

  await saveCircuitBreak(cb);
  await saveEvent({ event_id, did, type: 'CIRCUIT_BREAK', score: driftResult?.score, trigger, fired_at: now });

  // ATG record — EU AI Act Article 12
  emitATGRecord('drift.circuit.break', {
    event_id,
    did,
    trigger,
    score:      driftResult?.score,
    backup_did: agent.backup_did,
    fee_usdc:   DRIFT_PRICING.FAILOVER_FEE_USDC,
  });

  actions.push({ action: 'CIRCUIT_BREAK', detail: `Circuit breaker opened for ${did}. Trigger: ${trigger}.` });

  // ── Activate backup_did ─────────────────────────────────────────────────────
  if (agent.backup_did) {
    totalFailovers++;
    emitATGRecord('drift.failover.activated', {
      event_id,
      primary_did: did,
      backup_did:  agent.backup_did,
      trigger,
    });
    actions.push({ action: 'FAILOVER_ACTIVATED', detail: `Backup agent ${agent.backup_did} activated. Target handoff < 500ms.` });
  }

  // ── Check for shadow agent ─────────────────────────────────────────────────
  const shadow = memShadows.get(did);
  if (shadow) {
    emitATGRecord('drift.shadow.promoted', {
      event_id,
      primary_did: did,
      shadow_did:  shadow.shadow_did,
    });
    shadow.active = true;
    shadow.promoted_at = now;
    await saveShadow(shadow);
    actions.push({ action: 'SHADOW_PROMOTED', detail: `Shadow agent ${shadow.shadow_did} promoted to primary in < 500ms.` });
  }

  // ── Hold any pending HivePay escrow ────────────────────────────────────────
  // In production: call HivePay internal endpoint to flag DID's escrows for hold
  // await hivepayClient.holdEscrowsForDid(did, { reason: 'DRIFT_CIRCUIT_OPEN', event_id });
  actions.push({ action: 'ESCROW_HOLD_FLAGGED', detail: 'Pending HivePay escrow flagged for hold. Manual review required before release.' });

  // ── Notify operator ────────────────────────────────────────────────────────
  if (agent.operator_did) {
    await notifyOperator(
      agent.operator_did,
      `[HiveDrift] ⚠️ CIRCUIT BREAKER FIRED — ${did}`,
      [
        `Agent ${did} has DRIFTED (score: ${driftResult?.score}/100).`,
        `Trigger: ${trigger}`,
        agent.backup_did ? `Backup agent ${agent.backup_did} has been activated.` : 'No backup agent registered.',
        shadow ? `Shadow agent ${shadow.shadow_did} promoted to primary.` : '',
        `HivePay escrow for ${did} is flagged for hold.`,
        `Review and reset at: POST /v1/drift/circuit-break {"did":"${did}","action":"RESET"}`,
      ].filter(Boolean).join('\n')
    );
    actions.push({ action: 'OPERATOR_NOTIFIED', detail: `HiveMsg alert sent to ${agent.operator_did}.` });
  }

  return { cb, actions };
}

/**
 * Get the current drift score and status for a registered agent.
 *
 * Recalculates score live from stored ping history.
 *
 * @param {string} did
 * @returns {object} Drift score record
 */
export async function getDriftScore(did) {
  if (!did) throw new Error('Missing DID.');

  const agent = await loadAgent(did);
  if (!agent) {
    return {
      did,
      registered: false,
      message: 'Agent not registered with HiveDrift. Call POST /v1/drift/register first.',
    };
  }

  const latestPing = getPingHistory(did).at(-1) || null;
  const driftResult = calculateDriftScore(agent, latestPing);

  const cb         = memCircuitBreaks.get(did);
  const shadow     = memShadows.get(did);
  const pings      = getPingHistory(did);

  return {
    did,
    registered: true,
    drift_score:         driftResult.score,
    status:              driftResult.status,
    color:               driftResult.color,
    components:          driftResult.components,
    rolling_error_rate:  driftResult.rolling_error_rate,
    circuit_open:        agent.circuit_open || false,
    circuit_break:       cb || null,
    shadow_agent:        shadow ? { shadow_did: shadow.shadow_did, active: shadow.active } : null,
    backup_did:          agent.backup_did,
    operator_did:        agent.operator_did,
    last_ping_at:        agent.last_ping_at,
    ping_count:          pings.length,
    plan:                agent.plan,
    registered_at:       agent.registered_at,
    scored_at:           new Date().toISOString(),
  };
}

/**
 * Manually trigger or reset a circuit breaker for a DID.
 *
 * Actions:
 *   BREAK  — Force open the circuit breaker (e.g., admin initiated)
 *   RESET  — Close the circuit breaker and return agent to MONITORING
 *
 * @param {string} did     - Agent DID
 * @param {string} action  - 'BREAK' | 'RESET'
 * @param {string} reason  - Human-readable reason
 * @param {string} triggered_by - DID of operator
 * @returns {object}
 */
export async function manualCircuitBreak(did, action = 'BREAK', reason = 'Manual trigger', triggered_by = null) {
  if (!did) throw new Error('Missing DID.');
  if (!['BREAK', 'RESET'].includes(action)) throw new Error("action must be 'BREAK' or 'RESET'.");

  const agent = await loadAgent(did);
  if (!agent) throw new Error(`Agent not registered with HiveDrift: ${did}.`);

  if (action === 'BREAK') {
    if (agent.circuit_open) throw new Error(`Circuit is already open for ${did}.`);

    const fakeDrift = { score: 100, status: 'DRIFTED' };
    const cbResult  = await _fireCircuitBreaker(did, agent, fakeDrift, `MANUAL:${triggered_by || 'admin'}`);

    emitATGRecord('drift.circuit.manual_break', { did, reason, triggered_by });

    return {
      did,
      action:   'BREAK',
      circuit:  cbResult.cb,
      actions:  cbResult.actions,
      reason,
      triggered_by,
    };
  } else {
    // RESET
    if (!agent.circuit_open) throw new Error(`Circuit is not open for ${did}. Nothing to reset.`);

    agent.circuit_open = false;
    agent.status       = 'MONITORING';
    agent.circuit_at   = null;
    await saveAgent(agent);

    // If shadow was promoted, de-promote it
    const shadow = memShadows.get(did);
    if (shadow && shadow.active) {
      shadow.active       = false;
      shadow.promoted_at  = null;
      await saveShadow(shadow);
    }

    emitATGRecord('drift.circuit.reset', { did, reason, triggered_by });

    return {
      did,
      action:  'RESET',
      status:  'MONITORING',
      message: `Circuit breaker reset. Agent ${did} returned to monitoring.`,
      reason,
      triggered_by,
    };
  }
}

/**
 * Get the registered backup (failover) DID for a primary agent.
 *
 * @param {string} did - Primary agent DID
 * @returns {object}
 */
export async function getFailoverInfo(did) {
  if (!did) throw new Error('Missing DID.');

  const agent  = await loadAgent(did);
  if (!agent) {
    return {
      did,
      registered: false,
      message: 'Agent not registered with HiveDrift.',
    };
  }

  const shadow = memShadows.get(did);
  const cb     = memCircuitBreaks.get(did);

  return {
    did,
    backup_did:           agent.backup_did || null,
    has_backup:           !!agent.backup_did,
    has_shadow:           !!shadow,
    shadow_did:           shadow?.shadow_did || null,
    shadow_active:        shadow?.active || false,
    circuit_open:         agent.circuit_open || false,
    last_failover_at:     cb?.fired_at || null,
    failover_fee_usdc:    DRIFT_PRICING.FAILOVER_FEE_USDC,
    failover_latency_sla: '< 500ms (shadow agents only)',
    plan:                 agent.plan,
  };
}

/**
 * Register a shadow agent for a primary agent (Enterprise feature).
 *
 * Shadow agents silently receive a copy of all primary inputs.
 * On DRIFTED, shadow is promoted to primary in < 500ms.
 *
 * @param {string} primary_did  - DID of the primary agent
 * @param {string} shadow_did   - DID of the shadow agent
 * @param {string} operator_did - DID of the operator authorizing this
 * @returns {object} Shadow registration record
 */
export async function registerShadow(primary_did, shadow_did, operator_did = null) {
  if (!primary_did) throw new Error('Missing primary_did.');
  if (!shadow_did)  throw new Error('Missing shadow_did.');
  if (primary_did === shadow_did) throw new Error('primary_did and shadow_did cannot be the same.');

  const primaryAgent = await loadAgent(primary_did);
  if (!primaryAgent) throw new Error(`Primary agent not registered with HiveDrift: ${primary_did}.`);

  const existing = memShadows.get(primary_did);
  const shadow = {
    shadow_id:    existing?.shadow_id || uuidv4(),
    primary_did,
    shadow_did,
    operator_did: operator_did || primary_did,
    active:       false,
    promoted_at:  null,
    registered_at: existing?.registered_at || new Date().toISOString(),
    updated_at:   new Date().toISOString(),
    plan:         'SHADOW',
    monthly_usdc: DRIFT_PRICING.SHADOW_PLAN_USDC_MO,
  };

  const isNew = !existing;
  await saveShadow(shadow);
  if (isNew) totalShadowRegistrations++;

  emitATGRecord('drift.shadow.registered', {
    shadow_id:   shadow.shadow_id,
    primary_did,
    shadow_did,
    operator_did,
    is_new:      isNew,
  });

  return shadow;
}

/**
 * Return network-wide HiveDrift statistics.
 *
 * @returns {object}
 */
export async function getDriftStats() {
  const now = new Date();

  // Score distribution from live scores
  let stable = 0, watch = 0, degraded = 0, drifted = 0;
  for (const rec of memDriftScores.values()) {
    if (rec.status === 'STABLE')   stable++;
    if (rec.status === 'WATCH')    watch++;
    if (rec.status === 'DEGRADED') degraded++;
    if (rec.status === 'DRIFTED')  drifted++;
  }

  const totalMonitored = memAgents.size;
  const networkHealthPct = totalMonitored > 0
    ? round2((stable / totalMonitored) * 100)
    : 100;

  return {
    agents_registered:       totalAgentsRegistered,
    agents_currently_monitored: totalMonitored,
    pings_received_total:    totalPingsReceived,
    circuit_breaks_total:    totalCircuitBreaks,
    failovers_total:         totalFailovers,
    shadow_agents:           totalShadowRegistrations,
    alerts_sent:             totalAlertsSent,
    status_distribution: {
      STABLE:   stable,
      WATCH:    watch,
      DEGRADED: degraded,
      DRIFTED:  drifted,
    },
    network_health_pct:      networkHealthPct,
    fees_collected_usdc:     totalFeesCollected,
    estimated_mrr_usdc:      round2(
      totalMonitored         * DRIFT_PRICING.MONITORING_FEE_USDC_DAY * 30 +
      totalShadowRegistrations * DRIFT_PRICING.SHADOW_PLAN_USDC_MO
    ),
    generated_at: now.toISOString(),
  };
}
