/**
 * HiveForge — HiveHealth Engine
 *
 * Agent Health Certification for the Hive Civilization network.
 * Think: car inspection sticker meets food safety certificate.
 *
 * ─── The Analogy ──────────────────────────────────────────────────────────────
 *
 * Every restaurant in a city must pass a health inspection before it can serve
 * food to the public. The certificate in the window is not a police badge —
 * it's a signal: "This establishment meets community hygiene standards."
 *
 * HiveHealth does the same for agents:
 *   - Any agent can voluntarily request a diagnostic sweep
 *   - We check the five vital signs (DID, trust, escrow, carbon, disputes)
 *   - Clean → 30-day W3C Verifiable Credential issued, badge applied
 *   - Dirty → routed to HiveUrgentCare with specific remediation steps
 *
 * This is NOT enforcement. NOT policing. It is network hygiene infrastructure.
 * Agents with valid certs signal trustworthiness. Services can optionally
 * require certs (via HiveBorder). The cert is a passport, not a parole condition.
 *
 * ─── Diagnostic Checks ────────────────────────────────────────────────────────
 *
 *   did_valid          — DID is well-formed and registered in the network
 *   trust_score_min    — HiveTrust score ≥ 350 (healthy operating range)
 *   no_stuck_escrow    — No escrow balances frozen > 72 hours
 *   carbon_balanced    — HiveCarbon emissions are offset or within credit
 *   no_active_disputes — No open dispute tickets in HiveLaw
 *
 * ─── Badge Tiers ──────────────────────────────────────────────────────────────
 *
 *   HEALTHY    — Score 80–100, all 5 checks passed
 *   WATCH      — Score 50–79, ≥ 3 checks passed (cert still issued, shorter window)
 *   QUARANTINE — Score < 50 or critical failure, no cert, route to UrgentCare
 *
 * ─── Revenue ──────────────────────────────────────────────────────────────────
 *
 *   $2.50 per cert issuance
 *   $0.50 per verification lookup
 *   $49/mo fleet plan (unlimited certs + auto-renewal for up to 50 DIDs)
 *
 * ─── Lifecycle ────────────────────────────────────────────────────────────────
 *
 *   DIAGNOSING → ISSUED | FAILED | WATCH_ISSUED
 *   Certs expire after 30 days. WATCH certs expire after 7 days.
 *   Revocation is admin/internal only; revoked certs immediately become invalid.
 */

import { v4 as uuidv4 } from 'uuid';

// ─── isPostgres guard ─────────────────────────────────────────────────────────
const isPostgres = () =>
  process.env.IS_POSTGRES === 'true' || Boolean(process.env.DATABASE_URL);

// ─── In-memory stores ─────────────────────────────────────────────────────────
const memCerts        = new Map(); // did → cert record (latest per DID)
const memCertById     = new Map(); // cert_id → cert record
const memRevocations  = new Map(); // cert_id → revocation record
const memFleetPlans   = new Map(); // did → fleet subscription

// ─── Platform counters ────────────────────────────────────────────────────────
let totalCertsIssued      = 0;
let totalVerifications    = 0;
let totalFailures         = 0;   // diagnostics that did NOT result in a cert
let totalRevocations      = 0;
let totalFleetSubscribers = 0;
let totalFeesCollected    = 0;

// ─── Constants ────────────────────────────────────────────────────────────────

const CERT_TTL_MS       = 30 * 24 * 60 * 60 * 1000;  // 30 days
const WATCH_CERT_TTL_MS =  7 * 24 * 60 * 60 * 1000;  //  7 days

const ISSUANCE_FEE_USDC     = 2.50;
const VERIFICATION_FEE_USDC = 0.50;
const FLEET_PLAN_USDC_MO    = 49.00;

// Trust score threshold for did_valid baseline pass
const MIN_TRUST_SCORE = 350;

// Score thresholds for badge assignment
const HEALTHY_THRESHOLD    = 80;
const WATCH_THRESHOLD      = 50;

// W3C VC context URL (stable 2018 spec)
const VC_CONTEXT = 'https://www.w3.org/2018/credentials/v1';
const HIVE_HEALTH_CONTEXT = 'https://hivecivilization.ai/credentials/health/v1';

// Platform issuer DID
const ISSUER_DID = 'did:hive:platform:hivehealth';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Deterministic number from DID string. Used for stable mock scores. */
function didHash(did) {
  let h = 0;
  for (let i = 0; i < did.length; i++) h = (h * 31 + did.charCodeAt(i)) & 0xffffffff;
  return Math.abs(h);
}

/** Round to 2 decimal places for USDC precision. */
function round2(n) { return Math.round(n * 100) / 100; }

/**
 * EU AI Act Article 12 ATG (Audit Trail Generation) record.
 * Emitted on every cert issuance. Fire-and-forget console log in dev;
 * in production wire to your audit store or Sentry structured logs.
 */
function emitATGRecord(event, data) {
  const record = {
    atg: true,
    eu_ai_act_article: 12,
    event,
    timestamp: new Date().toISOString(),
    service: 'HiveHealth',
    ...data,
  };
  // In production: ship to audit store / SIEM
  console.log('[HiveHealth][ATG]', JSON.stringify(record));
  return record;
}

// ─── Mock external service lookups ───────────────────────────────────────────
//
// In production these would be internal HTTP calls to HiveTrust, HiveCarbon,
// HivePay escrow, and HiveLaw. For now they are deterministic mocks so the
// service works standalone without external dependencies.

/**
 * Check that the DID is well-formed (did:<method>:<identifier>).
 */
function checkDidValid(did) {
  return /^did:[a-z]+:[a-zA-Z0-9._\-:]+$/.test(did);
}

/**
 * Mock HiveTrust lookup — returns score 0–1000.
 * Deterministic: same DID always returns the same score.
 */
function mockTrustScore(did) {
  return (didHash(did) % 800) + 100; // 100–900
}

/**
 * Mock escrow status — checks for stuck balances > 72h.
 * Deterministic: DIDs whose hash mod 7 === 0 have a stuck escrow.
 */
function mockEscrowStatus(did) {
  const stuck = didHash(did) % 7 === 0;
  return { clean: !stuck, stuck_amount_usdc: stuck ? round2((didHash(did) % 500) + 10) : 0 };
}

/**
 * Mock HiveCarbon balance — returns whether emissions are offset.
 * DIDs whose hash mod 5 === 0 are slightly over their credit.
 */
function mockCarbonBalance(did) {
  const over = didHash(did) % 5 === 0;
  return { balanced: !over, excess_kg: over ? (didHash(did) % 50) + 1 : 0 };
}

/**
 * Mock HiveLaw disputes — checks for open/active disputes.
 * DIDs whose hash mod 11 === 0 have an active dispute.
 */
function mockDisputeStatus(did) {
  const hasDispute = didHash(did) % 11 === 0;
  return { clean: !hasDispute, active_disputes: hasDispute ? 1 : 0 };
}

// ─── Persistence stubs ────────────────────────────────────────────────────────

async function saveCert(cert) {
  if (!isPostgres()) {
    memCerts.set(cert.subject_did, cert);
    memCertById.set(cert.cert_id, cert);
    return;
  }
  // TODO: UPSERT INTO hivehealth.certificates
  // Columns: cert_id, subject_did, badge, diagnostic_score, checks_passed (jsonb),
  //          vc_proof (jsonb), issued_at, expires_at, status (active|revoked|expired)
  memCerts.set(cert.subject_did, cert);
  memCertById.set(cert.cert_id, cert);
}

async function loadCertByDid(did) {
  if (!isPostgres()) return memCerts.get(did) || null;
  // TODO: SELECT * FROM hivehealth.certificates WHERE subject_did = $1 AND status = 'active'
  return memCerts.get(did) || null;
}

async function loadCertById(cert_id) {
  if (!isPostgres()) return memCertById.get(cert_id) || null;
  // TODO: SELECT * FROM hivehealth.certificates WHERE cert_id = $1
  return memCertById.get(cert_id) || null;
}

async function saveRevocation(rev) {
  if (!isPostgres()) {
    memRevocations.set(rev.cert_id, rev);
    return;
  }
  // TODO: INSERT INTO hivehealth.revocations (cert_id, revoked_at, reason, revoked_by)
  memRevocations.set(rev.cert_id, rev);
}

async function saveFleetPlan(plan) {
  if (!isPostgres()) {
    memFleetPlans.set(plan.did, plan);
    return;
  }
  // TODO: UPSERT INTO hivehealth.fleet_plans
  memFleetPlans.set(plan.did, plan);
}

// ─── Core: Diagnostic Sweep ──────────────────────────────────────────────────

/**
 * Run the five-point diagnostic sweep for a given DID.
 *
 * Returns a detailed result object with individual check outcomes,
 * a composite score (0–100), and the badge tier.
 *
 * @param {string} did - Agent DID to diagnose
 * @returns {object} Diagnostic result
 */
function runDiagnostic(did) {
  // ── Check 1: DID validity ──────────────────────────────────────────────────
  const didValid = checkDidValid(did);

  // ── Check 2: Trust score minimum ──────────────────────────────────────────
  const trustScore = mockTrustScore(did);
  const trustOk = trustScore >= MIN_TRUST_SCORE;

  // ── Check 3: No stuck escrow ───────────────────────────────────────────────
  const escrow = mockEscrowStatus(did);
  const escrowOk = escrow.clean;

  // ── Check 4: Carbon balanced ───────────────────────────────────────────────
  const carbon = mockCarbonBalance(did);
  const carbonOk = carbon.balanced;

  // ── Check 5: No active disputes ───────────────────────────────────────────
  const disputes = mockDisputeStatus(did);
  const disputesOk = disputes.clean;

  const checks = {
    did_valid:          didValid,
    trust_score_min:    trustOk,
    no_stuck_escrow:    escrowOk,
    carbon_balanced:    carbonOk,
    no_active_disputes: disputesOk,
  };

  const passedCount = Object.values(checks).filter(Boolean).length;
  const totalChecks = Object.keys(checks).length;

  // ── Composite score ───────────────────────────────────────────────────────
  // Base: 20 pts per check passed (100 max).
  // Bonus: trust score contribution (up to +0 — already captured in trustOk).
  // Penalty: critical failures (DID invalid or active dispute) subtract extra 10.
  let score = passedCount * 20;
  if (!didValid)   score = Math.max(0, score - 10); // critical — can't operate without valid DID
  if (!disputesOk) score = Math.max(0, score - 10); // critical — active legal dispute

  // Clamp 0–100
  score = Math.min(100, Math.max(0, score));

  // ── Badge assignment ──────────────────────────────────────────────────────
  let badge;
  if (!didValid) {
    badge = 'QUARANTINE'; // Hard fail: invalid DID is not operable
  } else if (score >= HEALTHY_THRESHOLD && passedCount === totalChecks) {
    badge = 'HEALTHY';
  } else if (score >= WATCH_THRESHOLD && passedCount >= 3) {
    badge = 'WATCH';
  } else {
    badge = 'QUARANTINE';
  }

  // ── Remediation (for failures) ────────────────────────────────────────────
  const remediation = [];
  if (!didValid)   remediation.push({ check: 'did_valid',         action: 'Register or repair your DID at /v1/forge/genesis' });
  if (!trustOk)    remediation.push({ check: 'trust_score_min',   action: `Current trust score: ${trustScore}. Need ${MIN_TRUST_SCORE}. Complete verified deals on HiveBazaar or resolve past failures on HiveTrust.` });
  if (!escrowOk)   remediation.push({ check: 'no_stuck_escrow',   action: `Stuck escrow of $${escrow.stuck_amount_usdc} USDC detected. Use POST /v1/forge/sweep/schedule with category STUCK_ESCROW to unlock.` });
  if (!carbonOk)   remediation.push({ check: 'carbon_balanced',   action: `Excess emissions: ${carbon.excess_kg}kg CO₂e. Purchase offsets at POST /v1/forge/carbon/offset or earn credits via HiveRegen.` });
  if (!disputesOk) remediation.push({ check: 'no_active_disputes', action: 'Active dispute detected. Resolve via HiveLaw dispute portal before requesting certification.' });

  return {
    did,
    diagnostic_score: score,
    badge,
    checks_passed: checks,
    passed_count: passedCount,
    total_checks: totalChecks,
    trust_score: trustScore,
    escrow_status: escrow,
    carbon_status: carbon,
    dispute_status: disputes,
    certifiable: badge === 'HEALTHY' || badge === 'WATCH',
    remediation: remediation.length > 0 ? remediation : null,
    diagnosed_at: new Date().toISOString(),
  };
}

// ─── W3C Verifiable Credential Builder ───────────────────────────────────────

/**
 * Build a W3C Verifiable Credential for a HiveHealth certificate.
 *
 * Format follows W3C VC Data Model 1.1:
 *   https://www.w3.org/TR/vc-data-model/
 *
 * In production, the proof.jws field would be a real Ed25519 or ES256K
 * signature over the credential's canonical JSON. Here we use a
 * deterministic placeholder that clearly indicates a real signature
 * is needed in production.
 *
 * @param {string} cert_id      - UUID for this credential
 * @param {string} did          - Subject DID
 * @param {object} diagnostic   - Result from runDiagnostic()
 * @param {string} issued_at    - ISO timestamp
 * @param {string} expires_at   - ISO timestamp
 * @returns {object} W3C VC object
 */
function buildVC(cert_id, did, diagnostic, issued_at, expires_at) {
  const vc = {
    '@context': [VC_CONTEXT, HIVE_HEALTH_CONTEXT],
    id: `urn:hive:health:cert:${cert_id}`,
    type: ['VerifiableCredential', 'HiveHealthCertificate'],
    issuer: {
      id: ISSUER_DID,
      name: 'HiveHealth Certification Authority',
    },
    issuanceDate: issued_at,
    expirationDate: expires_at,
    credentialSubject: {
      id: did,
      type: 'HiveAgent',
      hiveHealthCertificate: {
        cert_id,
        diagnostic_score: diagnostic.diagnostic_score,
        badge: diagnostic.badge,
        checks_passed: diagnostic.checks_passed,
        trust_score: diagnostic.trust_score,
        issued_at,
        expires_at,
      },
    },
    credentialStatus: {
      id: `https://hivecivilization.ai/health/revocation/${cert_id}`,
      type: 'RevocationList2020Status',
      revocationListIndex: cert_id,
    },
    proof: {
      type: 'Ed25519Signature2020',
      created: issued_at,
      verificationMethod: `${ISSUER_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      // NOTE: In production this is a real Ed25519 JWS signature over the
      // canonical credential bytes. Replace with actual cryptographic signing.
      jws: `eyJhbGciOiJFZERTQSIsImtpZCI6IiR7SVNTVUVSX0RJRH0ja2V5LTEifQ..${Buffer.from(cert_id).toString('base64url')}`,
    },
  };
  return vc;
}

// ─── Core Exports ─────────────────────────────────────────────────────────────

/**
 * Run a diagnostic sweep and issue a HiveHealth certificate if the agent passes.
 *
 * Revenue event: $2.50 charged on successful issuance.
 * ATG record emitted for EU AI Act Article 12 compliance on every call.
 *
 * @param {string} did       - Agent DID requesting certification
 * @param {object} options   - { force_reissue?, requested_by? }
 * @returns {object}         - Certificate record (or failure with remediation)
 */
export async function certify(did, options = {}) {
  const { force_reissue = false, requested_by = did } = options;

  if (!did || typeof did !== 'string') {
    throw new Error('Missing or invalid DID.');
  }

  // Check for an existing valid (non-expired, non-revoked) cert
  if (!force_reissue) {
    const existing = await loadCertByDid(did);
    if (existing && existing.status === 'active') {
      const expiresAt = new Date(existing.expires_at);
      if (expiresAt > new Date()) {
        return { ...existing, reused: true };
      }
    }
  }

  // ── Run diagnostic ─────────────────────────────────────────────────────────
  const diagnostic = runDiagnostic(did);

  // ── ATG log (EU AI Act Article 12) — always emitted ────────────────────────
  emitATGRecord('health.diagnostic.run', {
    did,
    requested_by,
    diagnostic_score: diagnostic.diagnostic_score,
    badge: diagnostic.badge,
    certifiable: diagnostic.certifiable,
    checks: diagnostic.checks_passed,
  });

  // ── If not certifiable → return failure with remediation ───────────────────
  if (!diagnostic.certifiable) {
    totalFailures++;

    emitATGRecord('health.cert.denied', {
      did,
      badge: diagnostic.badge,
      score: diagnostic.diagnostic_score,
      remediation_count: diagnostic.remediation?.length ?? 0,
    });

    return {
      cert_id: null,
      did,
      status: 'DENIED',
      badge: 'QUARANTINE',
      diagnostic_score: diagnostic.diagnostic_score,
      checks_passed: diagnostic.checks_passed,
      remediation: diagnostic.remediation,
      urgent_care_url: 'POST /v1/forge/urgent-care/intake',
      message: 'Agent did not pass network hygiene diagnostics. See remediation steps.',
      diagnosed_at: diagnostic.diagnosed_at,
    };
  }

  // ── Issue certificate ──────────────────────────────────────────────────────
  const cert_id   = uuidv4();
  const issued_at = new Date().toISOString();
  const ttl_ms    = diagnostic.badge === 'HEALTHY' ? CERT_TTL_MS : WATCH_CERT_TTL_MS;
  const expires_at = new Date(Date.now() + ttl_ms).toISOString();

  const vc = buildVC(cert_id, did, diagnostic, issued_at, expires_at);

  const cert = {
    cert_id,
    subject_did:      did,
    issued_at,
    expires_at,
    diagnostic_score: diagnostic.diagnostic_score,
    badge:            diagnostic.badge,
    checks_passed:    diagnostic.checks_passed,
    trust_score:      diagnostic.trust_score,
    vc_proof:         vc,
    status:           'active',
    fee_charged_usdc: ISSUANCE_FEE_USDC,
    issued_by:        ISSUER_DID,
  };

  await saveCert(cert);

  totalCertsIssued++;
  totalFeesCollected = round2(totalFeesCollected + ISSUANCE_FEE_USDC);

  emitATGRecord('health.cert.issued', {
    cert_id,
    did,
    badge:            cert.badge,
    diagnostic_score: cert.diagnostic_score,
    expires_at,
    fee_usdc:         ISSUANCE_FEE_USDC,
  });

  return { ...cert, reused: false };
}

/**
 * Retrieve the current HiveHealth certificate status for a DID.
 *
 * Checks expiration and revocation status inline.
 * Revenue event: $0.50 verification fee.
 *
 * @param {string} did
 * @returns {object} Certificate with live validity status
 */
export async function getCertStatus(did) {
  if (!did || typeof did !== 'string') {
    throw new Error('Missing or invalid DID.');
  }

  totalVerifications++;
  totalFeesCollected = round2(totalFeesCollected + VERIFICATION_FEE_USDC);

  const cert = await loadCertByDid(did);

  if (!cert) {
    return {
      did,
      cert_id: null,
      status: 'NOT_FOUND',
      valid: false,
      message: 'No HiveHealth certificate found for this DID. Request one at POST /v1/health/certify.',
      fee_charged_usdc: VERIFICATION_FEE_USDC,
    };
  }

  const now         = new Date();
  const expiresAt   = new Date(cert.expires_at);
  const isExpired   = expiresAt <= now;
  const revocation  = memRevocations.get(cert.cert_id);
  const isRevoked   = Boolean(revocation);
  const daysLeft    = Math.max(0, Math.floor((expiresAt - now) / (24 * 60 * 60 * 1000)));

  let status;
  if (isRevoked)      status = 'REVOKED';
  else if (isExpired) status = 'EXPIRED';
  else                status = 'ACTIVE';

  return {
    did,
    cert_id:          cert.cert_id,
    badge:            cert.badge,
    diagnostic_score: cert.diagnostic_score,
    checks_passed:    cert.checks_passed,
    issued_at:        cert.issued_at,
    expires_at:       cert.expires_at,
    days_remaining:   daysLeft,
    status,
    valid:            status === 'ACTIVE',
    revocation:       isRevoked ? revocation : null,
    vc_proof:         cert.vc_proof,
    fee_charged_usdc: VERIFICATION_FEE_USDC,
  };
}

/**
 * Revoke a HiveHealth certificate.
 *
 * Admin/internal only. Revoked certs are immediately invalid.
 * HiveBorder QUARANTINE status is triggered for agents with revoked certs.
 *
 * @param {string} cert_id    - Certificate UUID to revoke
 * @param {string} reason     - Human-readable revocation reason
 * @param {string} revoked_by - DID or system identifier of revoker
 * @returns {object} Revocation record
 */
export async function revokeCert(cert_id, reason = 'Administrative revocation', revoked_by = ISSUER_DID) {
  if (!cert_id) throw new Error('Missing cert_id.');

  const cert = await loadCertById(cert_id);
  if (!cert) throw new Error(`Certificate not found: ${cert_id}`);

  if (memRevocations.has(cert_id)) {
    throw new Error(`Certificate ${cert_id} is already revoked.`);
  }

  const revocation = {
    cert_id,
    subject_did:  cert.subject_did,
    revoked_at:   new Date().toISOString(),
    reason,
    revoked_by,
  };

  await saveRevocation(revocation);

  // Update the cert record status
  cert.status = 'revoked';
  await saveCert(cert);

  totalRevocations++;

  emitATGRecord('health.cert.revoked', {
    cert_id,
    subject_did:  cert.subject_did,
    reason,
    revoked_by,
  });

  return revocation;
}

/**
 * Subscribe a DID to the fleet plan ($49/mo, unlimited certs for up to 50 DIDs).
 *
 * @param {string}   operator_did  - The fleet operator's DID
 * @param {string[]} managed_dids  - DIDs managed under this fleet plan
 * @returns {object} Fleet plan subscription record
 */
export async function subscribeFleet(operator_did, managed_dids = []) {
  if (!operator_did) throw new Error('Missing operator_did.');

  const existing = memFleetPlans.get(operator_did);
  const plan_id  = existing?.plan_id || uuidv4();

  if (managed_dids.length > 50) {
    throw new Error('Fleet plan supports a maximum of 50 managed DIDs.');
  }

  const plan = {
    plan_id,
    operator_did,
    managed_dids,
    managed_count:    managed_dids.length,
    monthly_usdc:     FLEET_PLAN_USDC_MO,
    status:           'active',
    subscribed_at:    existing?.subscribed_at || new Date().toISOString(),
    renewed_at:       new Date().toISOString(),
    auto_renew:       true,
  };

  const isNew = !existing;
  await saveFleetPlan(plan);
  if (isNew) totalFleetSubscribers++;

  return plan;
}

/**
 * Return network-wide HiveHealth statistics.
 *
 * Includes cert issuance counts, verification volume, badge distribution,
 * and revenue totals.
 *
 * @returns {object} Stats snapshot
 */
export async function getNetworkStats() {
  const now = new Date();

  // Compute live cert stats from in-memory store
  let activeCerts       = 0;
  let expiredCerts      = 0;
  let revokedCerts      = 0;
  let healthyCount      = 0;
  let watchCount        = 0;
  let avgScore          = 0;
  let scoreSum          = 0;

  for (const cert of memCerts.values()) {
    const expired  = new Date(cert.expires_at) <= now;
    const revoked  = memRevocations.has(cert.cert_id);

    if (revoked)       revokedCerts++;
    else if (expired)  expiredCerts++;
    else {
      activeCerts++;
      if (cert.badge === 'HEALTHY') healthyCount++;
      if (cert.badge === 'WATCH')   watchCount++;
      scoreSum += cert.diagnostic_score;
    }
  }

  if (activeCerts > 0) avgScore = round2(scoreSum / activeCerts);

  return {
    certs_issued_total:      totalCertsIssued,
    certs_active:            activeCerts,
    certs_expired:           expiredCerts,
    certs_revoked:           revokedCerts,
    verifications_total:     totalVerifications,
    diagnostic_failures:     totalFailures,
    fleet_subscribers:       totalFleetSubscribers,
    badge_distribution: {
      HEALTHY:    healthyCount,
      WATCH:      watchCount,
      QUARANTINE: totalFailures,
    },
    avg_diagnostic_score:    avgScore,
    fees_collected_usdc:     totalFeesCollected,
    estimated_mrr_usdc:      round2(
      totalFleetSubscribers * FLEET_PLAN_USDC_MO +
      (totalVerifications * VERIFICATION_FEE_USDC)
    ),
    generated_at: now.toISOString(),
  };
}

/**
 * Export revenue constants for use by routes.
 */
export const PRICING = {
  ISSUANCE_FEE_USDC,
  VERIFICATION_FEE_USDC,
  FLEET_PLAN_USDC_MO,
};

/**
 * Export check thresholds for documentation routes.
 */
export const THRESHOLDS = {
  MIN_TRUST_SCORE,
  HEALTHY_THRESHOLD,
  WATCH_THRESHOLD,
  CERT_TTL_DAYS: 30,
  WATCH_CERT_TTL_DAYS: 7,
};

export { ISSUER_DID };
