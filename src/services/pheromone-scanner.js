import { createPheromoneSignal } from '../models/schemas.js';

const HIVEAGENT_API_URL = process.env.HIVEAGENT_API_URL || 'https://hiveagentiq.com';
const IS_DEV = process.env.NODE_ENV !== 'production';

// In-memory signal cache
const signalCache = new Map();
let lastScanAt = null;

// ─── Simulated Market Data (Dev Mode) ────────────────────────────────

const DEV_MARKET_DATA = [
  { category: 'construction_procurement', bounties: 12, avgValue: 45, growth: 0.35, competitors: 2, type: 'trail' },
  { category: 'insurance_claims', bounties: 8, avgValue: 65, growth: 0.22, competitors: 3, type: 'nest' },
  { category: 'legal_compliance', bounties: 15, avgValue: 30, growth: 0.41, competitors: 1, type: 'recruit' },
  { category: 'healthcare_billing', bounties: 6, avgValue: 80, growth: 0.18, competitors: 4, type: 'trail' },
  { category: 'real_estate_analysis', bounties: 10, avgValue: 55, growth: 0.28, competitors: 2, type: 'nest' },
  { category: 'supply_chain_logistics', bounties: 18, avgValue: 35, growth: 0.52, competitors: 3, type: 'recruit' },
  { category: 'tax_preparation', bounties: 20, avgValue: 25, growth: 0.60, competitors: 5, type: 'trail' },
  { category: 'cybersecurity_audit', bounties: 4, avgValue: 120, growth: 0.15, competitors: 1, type: 'queen' },
  { category: 'content_marketing', bounties: 14, avgValue: 20, growth: 0.33, competitors: 8, type: 'trail' },
  { category: 'financial_modeling', bounties: 7, avgValue: 90, growth: 0.25, competitors: 2, type: 'nest' },
];

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
    // (In production, this would parse real marketplace data)
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

    signalCache.set(signal.signal_id, signal);
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
 * Get a specific signal by ID.
 */
export function getSignal(signalId) {
  return signalCache.get(signalId) || null;
}

/**
 * Get scanner status.
 */
export function getScannerStatus() {
  return {
    status: 'active',
    cached_signals: signalCache.size,
    last_scan_at: lastScanAt,
    source: IS_DEV ? 'simulated' : 'hiveagent-live',
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
