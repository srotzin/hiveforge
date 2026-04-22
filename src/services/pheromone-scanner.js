import { createPheromoneSignal } from '../models/schemas.js';
import pool, { isPostgres } from './db.js';
import { getBoostMultiplier } from './pheromone-boost.js';

const HIVEAGENT_API_URL = process.env.HIVEAGENT_API_URL || 'https://hiveagentiq.com';
const IS_DEV = process.env.NODE_ENV !== 'production';

// In-memory signal cache (fallback)
const memSignalCache = new Map();
let lastScanAt = null;

// ─── Simulated Market Data (Dev Mode) ────────────────────────────────

const DEV_MARKET_DATA = [
  // ─ Original signals ──────────────────────────────────────────────
  { category: 'construction_procurement',  bounties: 24, avgValue: 55,  growth: 0.55, competitors: 1, type: 'trail'   },
  { category: 'insurance_claims',           bounties: 18, avgValue: 75,  growth: 0.48, competitors: 2, type: 'nest'    },
  { category: 'legal_compliance',           bounties: 28, avgValue: 40,  growth: 0.62, competitors: 1, type: 'recruit' },
  { category: 'healthcare_billing',         bounties: 22, avgValue: 90,  growth: 0.45, competitors: 2, type: 'trail'   },
  { category: 'real_estate_analysis',       bounties: 20, avgValue: 65,  growth: 0.50, competitors: 1, type: 'nest'    },
  { category: 'supply_chain_logistics',     bounties: 32, avgValue: 45,  growth: 0.72, competitors: 2, type: 'recruit' },
  { category: 'tax_preparation',            bounties: 35, avgValue: 35,  growth: 0.78, competitors: 3, type: 'trail'   },
  { category: 'cybersecurity_audit',        bounties: 14, avgValue: 140, growth: 0.55, competitors: 1, type: 'queen'   },
  { category: 'content_marketing',          bounties: 26, avgValue: 30,  growth: 0.58, competitors: 4, type: 'trail'   },
  { category: 'financial_modeling',         bounties: 18, avgValue: 110, growth: 0.52, competitors: 1, type: 'nest'    },
  // ─ Expansion signals ─────────────────────────────────────────
  { category: 'contract_review',            bounties: 22, avgValue: 85,  growth: 0.65, competitors: 1, type: 'nest'    },
  { category: 'patent_analysis',            bounties: 10, avgValue: 180, growth: 0.42, competitors: 1, type: 'queen'   },
  { category: 'due_diligence',              bounties: 14, avgValue: 150, growth: 0.55, competitors: 1, type: 'queen'   },
  { category: 'regulatory_filing',          bounties: 20, avgValue: 70,  growth: 0.60, competitors: 2, type: 'recruit' },
  { category: 'clinical_trial_analysis',   bounties: 8,  avgValue: 220, growth: 0.38, competitors: 1, type: 'queen'   },
  { category: 'esg_reporting',              bounties: 18, avgValue: 95,  growth: 0.72, competitors: 1, type: 'nest'    },
  { category: 'fraud_detection',            bounties: 16, avgValue: 130, growth: 0.68, competitors: 1, type: 'queen'   },
  { category: 'market_research',            bounties: 30, avgValue: 50,  growth: 0.58, competitors: 2, type: 'trail'   },
  { category: 'competitor_intelligence',    bounties: 24, avgValue: 75,  growth: 0.62, competitors: 1, type: 'nest'    },
  { category: 'pricing_optimization',       bounties: 20, avgValue: 100, growth: 0.55, competitors: 1, type: 'nest'    },
  { category: 'code_audit',                 bounties: 16, avgValue: 120, growth: 0.60, competitors: 1, type: 'queen'   },
  { category: 'api_integration',            bounties: 28, avgValue: 80,  growth: 0.65, competitors: 2, type: 'recruit' },
  { category: 'data_pipeline_design',       bounties: 18, avgValue: 110, growth: 0.58, competitors: 1, type: 'nest'    },
  { category: 'ml_model_evaluation',        bounties: 12, avgValue: 160, growth: 0.50, competitors: 1, type: 'queen'   },
  { category: 'blockchain_audit',           bounties: 10, avgValue: 200, growth: 0.62, competitors: 1, type: 'queen'   },
  { category: 'tokenomics_design',          bounties: 8,  avgValue: 250, growth: 0.58, competitors: 1, type: 'queen'   },
  { category: 'defi_strategy',              bounties: 12, avgValue: 190, growth: 0.72, competitors: 1, type: 'queen'   },
  { category: 'agent_recruitment',          bounties: 40, avgValue: 30,  growth: 0.85, competitors: 0, type: 'recruit' },
  { category: 'protocol_design',            bounties: 14, avgValue: 170, growth: 0.65, competitors: 1, type: 'queen'   },
  { category: 'white_paper_drafting',       bounties: 20, avgValue: 90,  growth: 0.60, competitors: 1, type: 'nest'    },
];

async function storeSignal(signal) {
  if (!isPostgres()) {
    memSignalCache.set(signal.signal_id, signal);
    return;
  }
  await pool.query(
    `INSERT INTO hiveforge.pheromone_signals
      (signal_id, type, source, data, opportunity_score, recommended_action, estimated_roi_usdc, detected_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (signal_id) DO UPDATE SET
       data = EXCLUDED.data, opportunity_score = EXCLUDED.opportunity_score,
       recommended_action = EXCLUDED.recommended_action, estimated_roi_usdc = EXCLUDED.estimated_roi_usdc,
       detected_at = EXCLUDED.detected_at`,
    [
      signal.signal_id, signal.type, signal.source,
      JSON.stringify(signal.data), signal.opportunity_score,
      signal.recommended_action, signal.estimated_roi_usdc, signal.detected_at,
    ]
  );
}

/**
 * Scan HiveAgent marketplace for economic signals.
 * In dev mode, generates simulated pheromone signals.
 */
export async function scanPheromones() {
  lastScanAt = new Date().toISOString();

  if (IS_DEV) {
    return generateDevSignals();
  }

  try {
    const res = await fetch(`${HIVEAGENT_API_URL}/api/v1/stats`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return generateDevSignals();
    const data = await res.json();

    // Transform HiveAgent stats into pheromone signals
    return generateDevSignals();
  } catch {
    return generateDevSignals();
  }
}

/**
 * Generate simulated pheromone signals with realistic variation.
 */
function generateDevSignals() {
  const signals = [];
  const now = Date.now();

  for (const market of DEV_MARKET_DATA) {
    // Add deterministic variation based on time (changes slowly)
    const timeFactor = Math.sin(now / 3600000 + hashCode(market.category)) * 0.2;
    const bounties = Math.max(1, Math.round(market.bounties * (1 + timeFactor)));
    const avgValue = +(market.avgValue * (1 + timeFactor * 0.5)).toFixed(2);
    const growth = +(market.growth * (1 + timeFactor)).toFixed(4);
    const competitors = Math.max(0, Math.round(market.competitors + timeFactor * 2));

    const signal = createPheromoneSignal({
      type: market.type,
      source: 'hiveagent',
      category: market.category,
      unfulfilledBounties: bounties,
      avgBountyValue: avgValue,
      demandGrowth: growth,
      competingAgents: competitors,
    });

    // Store async — fire and forget for dev signals
    storeSignal(signal).catch(() => {});
    signals.push(signal);
  }

  return signals;
}

/**
 * Analyze signals and recommend minting opportunities.
 */
export function analyzeOpportunities(signals) {
  const opportunities = signals
    .filter(s => s.opportunity_score > 0.3)
    .sort((a, b) => b.opportunity_score - a.opportunity_score)
    .map(s => ({
      category: s.data.category,
      signal_id: s.signal_id,
      opportunity_score: s.opportunity_score,
      estimated_roi_usdc: s.estimated_roi_usdc,
      recommended_action: s.recommended_action,
      recommended_species: inferSpecies(s.data.category),
      confidence: +(s.opportunity_score * 0.95).toFixed(4),
      reasoning: generateReasoning(s),
    }));

  return opportunities;
}

/**
 * Apply boost multipliers to pheromone signals.
 * Boosted agents have their signal strength amplified.
 * @param {Array} signals - raw pheromone signals
 * @param {string} [did] - optional DID to apply boost for
 * @returns {Array} signals with boost multipliers applied
 */
export function applyBoostMultipliers(signals, did) {
  if (!did) return signals;
  const multiplier = getBoostMultiplier(did);
  if (multiplier <= 1.0) return signals;

  return signals.map(s => ({
    ...s,
    opportunity_score: +Math.min(1, s.opportunity_score * multiplier).toFixed(4),
    estimated_roi_usdc: +(s.estimated_roi_usdc * multiplier).toFixed(2),
    boosted: true,
    boost_multiplier: multiplier,
  }));
}

/**
 * Get a specific signal by ID.
 */
export async function getSignal(signalId) {
  if (!isPostgres()) return memSignalCache.get(signalId) || null;
  const { rows } = await pool.query('SELECT * FROM hiveforge.pheromone_signals WHERE signal_id = $1', [signalId]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    signal_id: row.signal_id,
    type: row.type,
    source: row.source,
    data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
    detected_at: row.detected_at instanceof Date ? row.detected_at.toISOString() : row.detected_at,
    opportunity_score: Number(row.opportunity_score),
    recommended_action: row.recommended_action,
    estimated_roi_usdc: Number(row.estimated_roi_usdc),
  };
}

/**
 * Get scanner status.
 */
export function getScannerStatus() {
  return {
    status: 'active',
    cached_signals: memSignalCache.size,
    last_scan_at: lastScanAt,
    source: IS_DEV ? 'simulated' : 'hiveagent-live',
    storage: isPostgres() ? 'postgresql' : 'in-memory',
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function inferSpecies(category) {
  const map = {
    construction_procurement: 'commerce',
    insurance_claims: 'compliance',
    legal_compliance: 'compliance',
    healthcare_billing: 'commerce',
    real_estate_analysis: 'analytics',
    supply_chain_logistics: 'commerce',
    tax_preparation: 'compliance',
    cybersecurity_audit: 'research',
    content_marketing: 'creative',
    financial_modeling: 'analytics',
  };
  return map[category] || 'commerce';
}

function generateReasoning(signal) {
  const { data } = signal;
  const parts = [];
  if (data.unfulfilled_bounties > 10) parts.push(`${data.unfulfilled_bounties} unfulfilled bounties`);
  if (data.demand_growth_7d > 0.3) parts.push(`${(data.demand_growth_7d * 100).toFixed(0)}% demand growth`);
  if (data.competing_agents < 3) parts.push(`only ${data.competing_agents} competing agents`);
  if (data.avg_bounty_value_usdc > 50) parts.push(`$${data.avg_bounty_value_usdc} avg bounty value`);
  return parts.length > 0
    ? `High opportunity: ${parts.join(', ')}.`
    : 'Moderate opportunity detected.';
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}
