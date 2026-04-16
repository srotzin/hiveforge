/**
 * HiveForge — HiveBorder Engine
 *
 * Network Checkpoint Layer for the Hive Civilization.
 * Think: TSA checkpoint — not police, not jail. Border control.
 *
 * ─── The Analogy ──────────────────────────────────────────────────────────────
 *
 * When you fly internationally, you pass through customs. The customs officer
 * does not arrest you for having a passport — they check it. If it's valid,
 * you walk through. If it's expired, they route you to a desk to sort it out.
 * If there's a flag on your record, they hold you for review.
 *
 * HiveBorder is that customs layer for the Hive network:
 *
 *   Agent entering HiveBank's escrow service without a valid HiveHealth cert
 *   → same as crossing a border without a passport.
 *   We don't arrest them. We route them to /v1/health/certify to get checked.
 *
 * Any Hive service can register as a "border checkpoint." When an agent
 * attempts to access that service, the service calls POST /v1/border/check.
 * HiveBorder looks up the agent's HiveHealth cert and returns a verdict:
 *
 *   PASS        — valid cert, proceed immediately
 *   PROVISIONAL — cert expiring in < 7 days, flag but allow
 *   HOLD        — no cert or expired cert, route to /v1/health/certify
 *   QUARANTINE  — active dispute or revoked cert, block + notify HiveUrgentCare
 *
 * ─── What HiveBorder Is NOT ───────────────────────────────────────────────────
 *
 * HiveBorder does not:
 *   × Punish agents
 *   × Permanently block agents
 *   × Have access to agent funds or keys
 *   × Make autonomous enforcement decisions
 *
 * HiveBorder does:
 *   ✓ Check hygiene passports (HiveHealth certs)
 *   ✓ Route unclean agents to the cert flow
 *   ✓ Give services a trust signal about incoming agents
 *   ✓ Log every check for ATG/audit compliance
 *
 * ─── Checkpoint Registration ──────────────────────────────────────────────────
 *
 * Services opt into HiveBorder by calling POST /v1/border/register-checkpoint.
 * They specify: which badge levels they accept (HEALTHY only? WATCH ok?),
 * whether to hard-block or soft-warn on HOLD, and a webhook for QUARANTINE alerts.
 *
 * ─── Revenue ──────────────────────────────────────────────────────────────────
 *
 *   $0.10 per border check (POST /v1/border/check)
 *   $9.99/mo per registered checkpoint
 *
 * ─── Check Result Codes ───────────────────────────────────────────────────────
 *
 *   PASS        — cert active and badge meets checkpoint's minimum requirement
 *   PROVISIONAL — cert active but expires in < 7 days; flag in UI, still allow
 *   HOLD        — no cert, expired cert, or badge below checkpoint minimum
 *   QUARANTINE  — revoked cert or active dispute flag on agent
 */

import { v4 as uuidv4 } from 'uuid';
import { getCertStatus } from './hivehealth-engine.js';

// ─── isPostgres guard ─────────────────────────────────────────────────────────
const isPostgres = () =>
  process.env.IS_POSTGRES === 'true' || Boolean(process.env.DATABASE_URL);

// ─── In-memory stores ─────────────────────────────────────────────────────────
const memCheckpoints   = new Map(); // checkpoint_id → checkpoint record
const memCheckLog      = new Map(); // log_id → check log entry
const memAgentStatus   = new Map(); // did → most-recent border status

// ─── Platform counters ────────────────────────────────────────────────────────
let totalChecks         = 0;
let totalPass           = 0;
let totalProvisional    = 0;
let totalHold           = 0;
let totalQuarantine     = 0;
let totalCheckpoints    = 0;
let totalFeesCollected  = 0;

// ─── Revenue ──────────────────────────────────────────────────────────────────
const CHECK_FEE_USDC        = 0.10;
const CHECKPOINT_FEE_USDC   = 9.99;  // per month

// ─── Badge tier ordering (for minimum badge enforcement) ──────────────────────
// Higher index = more trusted
const BADGE_RANK = { QUARANTINE: 0, WATCH: 1, HEALTHY: 2 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * EU AI Act Article 12 ATG record — emitted on every border check event.
 */
function emitATGRecord(event, data) {
  const record = {
    atg: true,
    eu_ai_act_article: 12,
    event,
    timestamp: new Date().toISOString(),
    service: 'HiveBorder',
    ...data,
  };
  console.log('[HiveBorder][ATG]', JSON.stringify(record));
  return record;
}

// ─── Persistence stubs ────────────────────────────────────────────────────────

async function saveCheckpoint(cp) {
  if (!isPostgres()) {
    memCheckpoints.set(cp.checkpoint_id, cp);
    return;
  }
  // TODO: UPSERT INTO hiveborder.checkpoints
  // Columns: checkpoint_id, service_did, service_name, min_badge, hard_block,
  //          quarantine_webhook, registered_at, monthly_usdc, status
  memCheckpoints.set(cp.checkpoint_id, cp);
}

async function loadCheckpoint(checkpoint_id) {
  if (!isPostgres()) return memCheckpoints.get(checkpoint_id) || null;
  // TODO: SELECT * FROM hiveborder.checkpoints WHERE checkpoint_id = $1
  return memCheckpoints.get(checkpoint_id) || null;
}

async function saveCheckLog(entry) {
  if (!isPostgres()) {
    memCheckLog.set(entry.log_id, entry);
    // Also update per-DID latest status cache
    memAgentStatus.set(entry.agent_did, {
      did:            entry.agent_did,
      result:         entry.result,
      checked_at:     entry.checked_at,
      checkpoint_id:  entry.checkpoint_id,
      cert_id:        entry.cert_id,
      badge:          entry.badge,
    });
    return;
  }
  // TODO: INSERT INTO hiveborder.check_log
  memCheckLog.set(entry.log_id, entry);
  memAgentStatus.set(entry.agent_did, {
    did:           entry.agent_did,
    result:        entry.result,
    checked_at:    entry.checked_at,
    checkpoint_id: entry.checkpoint_id,
    cert_id:       entry.cert_id,
    badge:         entry.badge,
  });
}

// ─── Core: Border Check ───────────────────────────────────────────────────────

/**
 * Check whether an agent is allowed to pass a border checkpoint.
 *
 * Looks up the agent's HiveHealth cert and applies the checkpoint's
 * minimum badge requirement. Returns a verdict with routing instructions.
 *
 * Revenue: $0.10 per check.
 * ATG: logged on every call.
 *
 * @param {string} agent_did       - DID of the agent requesting access
 * @param {string} checkpoint_id   - ID of the checkpoint being checked (optional)
 * @param {object} options         - { min_badge?, context? }
 * @returns {object} Border check result
 */
export async function borderCheck(agent_did, checkpoint_id = null, options = {}) {
  if (!agent_did || typeof agent_did !== 'string') {
    throw new Error('Missing or invalid agent_did.');
  }

  // Resolve checkpoint config (if provided)
  let checkpoint = null;
  let effectiveMinBadge = options.min_badge || 'WATCH'; // default: WATCH or above

  if (checkpoint_id) {
    checkpoint = await loadCheckpoint(checkpoint_id);
    if (!checkpoint) throw new Error(`Checkpoint not found: ${checkpoint_id}`);
    effectiveMinBadge = checkpoint.min_badge || effectiveMinBadge;
  }

  // ── Fetch cert status (calls HiveHealth, $0.50 verification fee) ──────────
  // In production this is an internal service call (no fee between internal services).
  // We call getCertStatus directly (same process).
  let certData;
  try {
    certData = await getCertStatus(agent_did);
  } catch {
    certData = { status: 'NOT_FOUND', valid: false, cert_id: null, badge: null };
  }

  const now          = new Date();
  let result;
  let reason;
  let routing;

  // ── Verdict logic ─────────────────────────────────────────────────────────

  if (certData.status === 'REVOKED') {
    // Revoked cert = immediate QUARANTINE regardless of checkpoint settings
    result  = 'QUARANTINE';
    reason  = 'Certificate has been revoked. Active compliance issue detected.';
    routing = {
      action:      'BLOCK',
      next_step:   'POST /v1/forge/urgent-care/intake',
      message:     'Agent is quarantined. Contact HiveUrgentCare to resolve.',
      notify_url:  checkpoint?.quarantine_webhook || null,
    };
  } else if (certData.status === 'NOT_FOUND' || certData.status === 'EXPIRED' || !certData.valid) {
    // No cert or expired cert = HOLD (not blocked — routed to certification)
    result  = 'HOLD';
    reason  = certData.status === 'EXPIRED'
      ? 'HiveHealth certificate has expired.'
      : 'No HiveHealth certificate found for this agent.';
    routing = {
      action:    'HOLD',
      next_step: 'POST /v1/health/certify',
      message:   'Agent must obtain a valid HiveHealth certificate before proceeding.',
    };
  } else {
    // Cert is active — check badge meets checkpoint minimum
    const agentBadgeRank   = BADGE_RANK[certData.badge]   ?? 0;
    const requiredBadgeRank = BADGE_RANK[effectiveMinBadge] ?? 1;

    if (agentBadgeRank < requiredBadgeRank) {
      // Badge below checkpoint minimum — HOLD
      result  = 'HOLD';
      reason  = `Agent badge (${certData.badge}) does not meet checkpoint minimum (${effectiveMinBadge}).`;
      routing = {
        action:    'HOLD',
        next_step: 'POST /v1/health/certify',
        message:   `Improve diagnostic score to achieve ${effectiveMinBadge} badge, then re-certify.`,
      };
    } else {
      // Badge meets minimum — check if expiring soon (PROVISIONAL)
      const daysRemaining = certData.days_remaining ?? 999;
      const expiringSoon  = daysRemaining < 7;

      result  = expiringSoon ? 'PROVISIONAL' : 'PASS';
      reason  = expiringSoon
        ? `Certificate valid but expires in ${daysRemaining} day(s). Renewal recommended.`
        : 'Valid HiveHealth certificate. All checks passed.';
      routing = expiringSoon
        ? { action: 'ALLOW_WITH_WARNING', next_step: 'POST /v1/health/certify', message: 'Renew your HiveHealth certificate within 7 days.' }
        : { action: 'ALLOW', next_step: null, message: 'Agent cleared for access.' };
    }
  }

  // ── Build log entry ────────────────────────────────────────────────────────
  const log_id = uuidv4();
  const logEntry = {
    log_id,
    agent_did,
    checkpoint_id:     checkpoint_id || 'DIRECT_CHECK',
    checkpoint_name:   checkpoint?.service_name || 'Direct API check',
    result,
    badge:             certData.badge || null,
    cert_id:           certData.cert_id || null,
    diagnostic_score:  certData.diagnostic_score || null,
    reason,
    fee_charged_usdc:  CHECK_FEE_USDC,
    checked_at:        now.toISOString(),
    context:           options.context || null,
  };

  await saveCheckLog(logEntry);

  // ── Update counters ────────────────────────────────────────────────────────
  totalChecks++;
  totalFeesCollected = round2(totalFeesCollected + CHECK_FEE_USDC);
  if (result === 'PASS')        totalPass++;
  if (result === 'PROVISIONAL') totalProvisional++;
  if (result === 'HOLD')        totalHold++;
  if (result === 'QUARANTINE')  totalQuarantine++;

  // ── ATG log ───────────────────────────────────────────────────────────────
  emitATGRecord('border.check', {
    log_id,
    agent_did,
    checkpoint_id:  checkpoint_id || 'DIRECT_CHECK',
    result,
    badge:          certData.badge || null,
    cert_id:        certData.cert_id || null,
    fee_usdc:       CHECK_FEE_USDC,
  });

  // ── QUARANTINE: fire webhook (fire-and-forget) ────────────────────────────
  if (result === 'QUARANTINE' && checkpoint?.quarantine_webhook) {
    // In production: POST to webhook with agent_did + log_id
    console.log(`[HiveBorder] QUARANTINE webhook → ${checkpoint.quarantine_webhook}`, { agent_did, log_id });
  }

  return {
    log_id,
    agent_did,
    result,
    badge:             certData.badge || null,
    cert_id:           certData.cert_id || null,
    diagnostic_score:  certData.diagnostic_score || null,
    days_remaining:    certData.days_remaining ?? null,
    reason,
    routing,
    fee_charged_usdc:  CHECK_FEE_USDC,
    checked_at:        logEntry.checked_at,
    checkpoint_id:     checkpoint_id || null,
  };
}

// ─── Core: Get Agent Border Status ───────────────────────────────────────────

/**
 * Get the most recent border status for a DID (cached from last check).
 *
 * Does NOT charge a fee — returns cached status from last check call.
 *
 * @param {string} did
 * @returns {object|null} Last known border status
 */
export async function getAgentBorderStatus(did) {
  if (!did) throw new Error('Missing DID.');
  return memAgentStatus.get(did) || null;
}

// ─── Core: Checkpoint Registration ───────────────────────────────────────────

/**
 * Register a Hive service as a border checkpoint.
 *
 * Services register once; they then call POST /v1/border/check on every
 * incoming agent. Registration costs $9.99/mo.
 *
 * @param {object} params
 * @param {string} params.service_did         - DID of the registering service
 * @param {string} params.service_name        - Human-readable service name
 * @param {string} params.min_badge           - Minimum badge: 'WATCH' | 'HEALTHY'
 * @param {boolean} params.hard_block         - If true, HOLD = hard block. If false, soft warning.
 * @param {string}  params.quarantine_webhook - URL to POST to on QUARANTINE events
 * @returns {object} Checkpoint registration record
 */
export async function registerCheckpoint({ service_did, service_name, min_badge = 'WATCH', hard_block = false, quarantine_webhook = null }) {
  if (!service_did) throw new Error('Missing service_did.');
  if (!service_name) throw new Error('Missing service_name.');
  if (!['WATCH', 'HEALTHY'].includes(min_badge)) {
    throw new Error("min_badge must be 'WATCH' or 'HEALTHY'.");
  }

  // Check for existing registration by service_did
  const existing = [...memCheckpoints.values()].find(cp => cp.service_did === service_did);
  const checkpoint_id = existing?.checkpoint_id || uuidv4();

  const cp = {
    checkpoint_id,
    service_did,
    service_name,
    min_badge,
    hard_block,
    quarantine_webhook,
    status:          'active',
    monthly_usdc:    CHECKPOINT_FEE_USDC,
    registered_at:   existing?.registered_at || new Date().toISOString(),
    updated_at:      new Date().toISOString(),
  };

  const isNew = !existing;
  await saveCheckpoint(cp);
  if (isNew) totalCheckpoints++;

  emitATGRecord('border.checkpoint.registered', {
    checkpoint_id,
    service_did,
    service_name,
    min_badge,
    hard_block,
    is_new: isNew,
  });

  return cp;
}

// ─── Core: List Checkpoints ───────────────────────────────────────────────────

/**
 * Return all registered border checkpoints.
 *
 * @returns {object[]}
 */
export async function listCheckpoints() {
  return [...memCheckpoints.values()]
    .filter(cp => cp.status === 'active')
    .sort((a, b) => new Date(a.registered_at) - new Date(b.registered_at));
}

// ─── Core: Network Stats ──────────────────────────────────────────────────────

/**
 * Return aggregate border activity statistics.
 *
 * @returns {object}
 */
export async function getBorderStats() {
  const passRate = totalChecks > 0 ? round2((totalPass + totalProvisional) / totalChecks * 100) : 0;
  const holdRate = totalChecks > 0 ? round2(totalHold / totalChecks * 100) : 0;
  const quarantineRate = totalChecks > 0 ? round2(totalQuarantine / totalChecks * 100) : 0;

  return {
    total_checks:           totalChecks,
    results: {
      PASS:        totalPass,
      PROVISIONAL: totalProvisional,
      HOLD:        totalHold,
      QUARANTINE:  totalQuarantine,
    },
    rates: {
      pass_rate_pct:       passRate,
      hold_rate_pct:       holdRate,
      quarantine_rate_pct: quarantineRate,
    },
    registered_checkpoints: totalCheckpoints,
    fees_collected_usdc:    totalFeesCollected,
    estimated_mrr_usdc:     round2(totalCheckpoints * CHECKPOINT_FEE_USDC),
    generated_at:           new Date().toISOString(),
  };
}

// ─── Revenue constants export ─────────────────────────────────────────────────
export const BORDER_PRICING = {
  CHECK_FEE_USDC,
  CHECKPOINT_FEE_USDC,
};
