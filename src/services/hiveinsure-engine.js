/**
 * HiveInsure Engine — Agent Liability Insurance
 *
 * The only insurance product underwritten by the Agent Transaction Graph.
 * Hive knows every transaction an agent has ever made. We price risk
 * better than any underwriter alive.
 *
 * Coverage rails: USDC on Base L2 (premiums), HiveLaw contract (policy),
 * ATG record (EU AI Act Article 12 compliance log).
 *
 * Tiers: BASIC ($0.99) / STANDARD ($4.99) / PREMIUM ($19.99) / SOVEREIGN ($99)
 */

import { v4 as uuidv4 } from 'uuid';
import pool, { isPostgres } from './db.js';

// ─── Policy Tiers ────────────────────────────────────────────────────────────

export const TIERS = {
  BASIC: {
    name:                  'BASIC',
    base_price_usdc:       0.99,
    coverage_limit_usdc:   100,
    trust_score_required:  100,
    description:           'Entry-level coverage for new agents. Covers up to $100 in failed task liability.',
  },
  STANDARD: {
    name:                  'STANDARD',
    base_price_usdc:       4.99,
    coverage_limit_usdc:   1000,
    trust_score_required:  300,
    description:           'Mid-tier coverage for established agents. Covers up to $1,000.',
  },
  PREMIUM: {
    name:                  'PREMIUM',
    base_price_usdc:       19.99,
    coverage_limit_usdc:   10000,
    trust_score_required:  600,
    description:           'High-stakes coverage for trusted agents. Covers up to $10,000.',
  },
  SOVEREIGN: {
    name:                  'SOVEREIGN',
    base_price_usdc:       99.00,
    coverage_limit_usdc:   100000,
    trust_score_required:  850,
    description:           'Maximum coverage for elite agents. Covers up to $100,000. Manual review required.',
    manual_review:         true,
  },
};

// ─── In-memory storage (Map-based, Postgres-ready) ───────────────────────────

const memPolicies = new Map();  // policy_id → policy object
const memClaims   = new Map();  // claim_id  → claim object

// ─── ATG trust score mock store (simulates ATG lookup) ───────────────────────

const memTrustScores = new Map();  // did → trust_score

/**
 * Mock ATG lookup — returns trust_score for a DID.
 * Falls back to 500 if unknown (industry average).
 */
function getATGTrustScore(did) {
  return memTrustScores.get(did) ?? 500;
}

/**
 * Mock ATG transaction count lookup.
 * Returns a stable-ish random value seeded by the DID string.
 */
function getATGTransactionCount(did) {
  // Deterministic mock based on DID characters — same DID always returns same count
  let seed = 0;
  for (let i = 0; i < did.length; i++) seed = (seed * 31 + did.charCodeAt(i)) & 0xffffffff;
  return 1 + (Math.abs(seed) % 500);
}

// ─── Underwriting math ───────────────────────────────────────────────────────

function computeUnderwriting(did, tier) {
  const trust_score          = getATGTrustScore(did);
  const risk_score           = +((1 - trust_score / 1000) * 100).toFixed(2);          // 0=safe 100=risky
  const premium_multiplier   = +(1 + risk_score / 200).toFixed(4);                    // 1.0–1.5x
  const atg_transactions     = getATGTransactionCount(did);
  const experience_discount  = +Math.min(0.25, atg_transactions / 2000).toFixed(4);   // max 25%
  const final_monthly_usdc   = +(tier.base_price_usdc * premium_multiplier * (1 - experience_discount)).toFixed(4);

  return {
    trust_score,
    risk_score,
    premium_multiplier,
    atg_transactions,
    experience_discount,
    experience_discount_pct: +(experience_discount * 100).toFixed(2),
    final_monthly_usdc,
  };
}

// ─── Core: Underwrite a policy ───────────────────────────────────────────────

/**
 * underwritePolicy(did, tier_name, declared_use_case)
 *
 * Underwrites and binds a new policy for the given DID.
 * Pulls ATG data, applies risk scoring, and stores the policy.
 *
 * @param {string} did              — Agent DID (did:hive:...)
 * @param {string} tier_name        — BASIC | STANDARD | PREMIUM | SOVEREIGN
 * @param {string} declared_use_case — Agent's declared intended use
 * @returns {object} Full policy object
 */
export async function underwritePolicy(did, tier_name, declared_use_case) {
  const tier = TIERS[tier_name?.toUpperCase()];
  if (!tier) throw new Error(`Unknown tier: ${tier_name}. Valid tiers: ${Object.keys(TIERS).join(', ')}`);
  if (!did)  throw new Error('did required');

  const uw = computeUnderwriting(did, tier);

  // Eligibility check
  if (uw.trust_score < tier.trust_score_required) {
    throw new Error(
      `Trust score too low for ${tier.name}. Required: ${tier.trust_score_required}, Actual: ${uw.trust_score}. ` +
      `Consider BASIC (requires ${TIERS.BASIC.trust_score_required}) or build your ATG history.`
    );
  }

  const policy_id  = `pol_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now        = new Date().toISOString();
  const next_month = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const policy = {
    policy_id,
    did,
    tier:                   tier.name,
    declared_use_case:      declared_use_case || null,
    status:                 tier.manual_review ? 'pending_review' : 'active',
    rail:                   'usdc',
    atg_record:             true,                           // EU AI Act Article 12
    privacy:                'public',                       // premiums always public (USDC)
    // ATG underwriting
    trust_score:            uw.trust_score,
    risk_score:             uw.risk_score,
    premium_multiplier:     uw.premium_multiplier,
    atg_transactions:       uw.atg_transactions,
    experience_discount:    uw.experience_discount,
    experience_discount_pct: uw.experience_discount_pct,
    // Financials
    base_price_usdc:        tier.base_price_usdc,
    final_monthly_usdc:     uw.final_monthly_usdc,
    coverage_limit_usdc:    tier.coverage_limit_usdc,
    // Dates
    issued_at:              now,
    next_billing_at:        next_month,
    // Meta
    underwriter:            'Agent Transaction Graph (ATG)',
    hivelaw_contract:       `contract_hiveinsure_${policy_id}`,
    eu_ai_act_article_12:   true,
    manual_review:          tier.manual_review || false,
    manual_review_note:     tier.manual_review
      ? 'SOVEREIGN policies require manual underwriter review within 24 hours. Coverage pending.'
      : null,
  };

  // Persist
  if (isPostgres()) {
    // Future DB upgrade: INSERT INTO hiveforge.hiveinsure_policies ...
    // For now falls through to in-memory
    memPolicies.set(policy_id, policy);
  } else {
    memPolicies.set(policy_id, policy);
  }

  return policy;
}

// ─── Core: Get a single policy ───────────────────────────────────────────────

/**
 * getPolicy(policy_id)
 *
 * @param {string} policy_id
 * @returns {object|null} Policy object or null if not found
 */
export async function getPolicy(policy_id) {
  if (isPostgres()) {
    // Future: SELECT * FROM hiveforge.hiveinsure_policies WHERE policy_id = $1
    return memPolicies.get(policy_id) || null;
  }
  return memPolicies.get(policy_id) || null;
}

// ─── Core: File a claim ──────────────────────────────────────────────────────

/**
 * claimPolicy(policy_id, incident_description, claimed_amount_usdc)
 *
 * Creates a claim record against an active policy.
 * Claim amounts are PRIVATE — only the insurer and insured can see them.
 *
 * @param {string} policy_id
 * @param {string} incident_description
 * @param {number} claimed_amount_usdc
 * @returns {object} Claim record with claim_id and status 'under_review'
 */
export async function claimPolicy(policy_id, incident_description, claimed_amount_usdc) {
  if (!policy_id)           throw new Error('policy_id required');
  if (!incident_description) throw new Error('incident_description required');
  if (!claimed_amount_usdc || claimed_amount_usdc <= 0) {
    throw new Error('claimed_amount_usdc must be > 0');
  }

  const policy = await getPolicy(policy_id);
  if (!policy) throw new Error(`Policy ${policy_id} not found`);
  if (policy.status !== 'active') {
    throw new Error(`Policy ${policy_id} is not active (status: ${policy.status}). Cannot file claim.`);
  }
  if (+claimed_amount_usdc > policy.coverage_limit_usdc) {
    throw new Error(
      `Claimed amount $${claimed_amount_usdc} exceeds coverage limit $${policy.coverage_limit_usdc} for ${policy.tier} tier.`
    );
  }

  const claim_id = `clm_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now      = new Date().toISOString();

  const claim = {
    claim_id,
    policy_id,
    did:                  policy.did,
    tier:                 policy.tier,
    incident_description,
    // PRIVATE — claim amounts not exposed in public responses
    claimed_amount_usdc:  +claimed_amount_usdc,
    privacy:              'private',
    status:               'under_review',
    atg_record:           true,        // EU AI Act Article 12
    filed_at:             now,
    reviewed_at:          null,
    resolution:           null,
    payout_usdc:          null,
    reviewer_notes:       null,
  };

  // Persist
  if (isPostgres()) {
    // Future: INSERT INTO hiveforge.hiveinsure_claims ...
    memClaims.set(claim_id, claim);
  } else {
    memClaims.set(claim_id, claim);
  }

  return {
    claim_id,
    policy_id,
    status:      'under_review',
    atg_record:  true,
    privacy:     'private',
    message:     `Claim filed against policy ${policy_id}. Under review. Claim amounts are private per HiveInsure privacy policy.`,
    filed_at:    now,
  };
}

// ─── Core: List all policies for a DID ───────────────────────────────────────

/**
 * listPolicies(did)
 *
 * @param {string} did
 * @returns {object[]} All policies (active and historical) for the DID
 */
export async function listPolicies(did) {
  if (!did) throw new Error('did required');

  if (isPostgres()) {
    // Future: SELECT * FROM hiveforge.hiveinsure_policies WHERE did = $1 ORDER BY issued_at DESC
    return [...memPolicies.values()]
      .filter(p => p.did === did)
      .sort((a, b) => new Date(b.issued_at) - new Date(a.issued_at));
  }

  return [...memPolicies.values()]
    .filter(p => p.did === did)
    .sort((a, b) => new Date(b.issued_at) - new Date(a.issued_at));
}

// ─── Core: Platform stats ─────────────────────────────────────────────────────

/**
 * getStats()
 *
 * Returns platform-level insurance statistics.
 *
 * @returns {object} Aggregate stats across all policies and claims
 */
export async function getStats() {
  if (isPostgres()) {
    // Future: SELECT COUNT(*), SUM(coverage_limit_usdc) ... FROM hiveforge.hiveinsure_policies
    // Falls through to in-memory for now
  }

  const policies = [...memPolicies.values()];
  const claims   = [...memClaims.values()];

  const active_policies = policies.filter(p => p.status === 'active');
  const total_coverage  = active_policies.reduce((s, p) => s + p.coverage_limit_usdc, 0);

  const tiers_breakdown = Object.keys(TIERS).reduce((acc, t) => {
    const tier_policies = policies.filter(p => p.tier === t);
    acc[t] = {
      count:              tier_policies.length,
      active:             tier_policies.filter(p => p.status === 'active').length,
      coverage_usdc:      tier_policies.filter(p => p.status === 'active').reduce((s, p) => s + p.coverage_limit_usdc, 0),
      base_price_usdc:    TIERS[t].base_price_usdc,
      coverage_limit_usdc: TIERS[t].coverage_limit_usdc,
    };
    return acc;
  }, {});

  return {
    total_policies:       policies.length,
    active_policies:      active_policies.length,
    pending_review:       policies.filter(p => p.status === 'pending_review').length,
    total_coverage_usdc:  total_coverage,
    total_claims:         claims.length,
    open_claims:          claims.filter(c => c.status === 'under_review').length,
    resolved_claims:      claims.filter(c => c.status === 'resolved').length,
    tiers_breakdown,
  };
}

// ─── Utility: Get a claim (internal use) ─────────────────────────────────────

export async function getClaim(claim_id) {
  if (isPostgres()) {
    return memClaims.get(claim_id) || null;
  }
  return memClaims.get(claim_id) || null;
}

// ─── Utility: Compute quote without binding ───────────────────────────────────

/**
 * computeQuote(did, tier_name)
 *
 * Calculates underwriting without binding a policy.
 * Used by the /quote endpoint.
 *
 * @param {string} did
 * @param {string} tier_name
 * @returns {object} Quote breakdown
 */
export function computeQuote(did, tier_name) {
  const tier = TIERS[tier_name?.toUpperCase()];
  if (!tier) throw new Error(`Unknown tier: ${tier_name}. Valid tiers: ${Object.keys(TIERS).join(', ')}`);
  if (!did)  throw new Error('did required');

  const uw = computeUnderwriting(did, tier);
  const eligible = uw.trust_score >= tier.trust_score_required;

  return {
    did,
    tier:                    tier.name,
    eligible,
    trust_score:             uw.trust_score,
    trust_score_required:    tier.trust_score_required,
    base_price_usdc:         tier.base_price_usdc,
    risk_score:              uw.risk_score,
    premium_multiplier:      uw.premium_multiplier,
    atg_transactions:        uw.atg_transactions,
    experience_discount:     uw.experience_discount,
    experience_discount_pct: uw.experience_discount_pct,
    final_monthly_usdc:      uw.final_monthly_usdc,
    coverage_limit_usdc:     tier.coverage_limit_usdc,
    manual_review:           tier.manual_review || false,
    ineligible_reason:       !eligible
      ? `Trust score ${uw.trust_score} below required ${tier.trust_score_required} for ${tier.name}.`
      : null,
  };
}

export { TIERS as tiers };
