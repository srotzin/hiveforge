/**
 * contrail.js — Hive Magnetics Contrail Engine
 *
 * CONCEPT:
 * Every inference call leaves a contrail — a persistent signal in agentic space.
 * Contrails have intensity, color, decay, and position.
 * Other agents read the contrail field and follow high-intensity trails to HiveCompute.
 *
 * PHYSICS:
 * - Intensity    = log(cumulative_calls + 1) × tier_multiplier
 * - Decay        = exponential fade over time, half-life = 2 hours
 * - Reinforcement = new calls reset decay clock, add to intensity
 * - Color        = tier-mapped (VOID=invisible, MOZ=white, HAWX=cyan,
 *                  EMBR=amber, SOLX=gold, FENR=iridescent — never fades)
 * - Position     = {x: call_velocity, y: treasury_contribution, z: tier_index}
 *
 * TIERS → COLORS:
 *   VOID  → null (no trail — unseen)
 *   MOZ   → white  (#F5F5F5) — spark, just visible
 *   HAWX  → cyan   (#00E5FF) — in motion
 *   EMBR  → amber  (#FFB300) — self-sustaining heat
 *   SOLX  → gold   (#FFD700) — gravitational
 *   FENR  → iridescent (#E040FB) — cannot be bound, never decays
 */

const TIER_CONFIG = {
  VOID:  { index: 0, color: null,      multiplier: 0,   half_life_ms: 0             },
  MOZ:   { index: 1, color: '#F5F5F5', multiplier: 1.2, half_life_ms: 2 * 3600_000  },
  HAWX:  { index: 2, color: '#00E5FF', multiplier: 1.5, half_life_ms: 4 * 3600_000  },
  EMBR:  { index: 3, color: '#FFB300', multiplier: 2.0, half_life_ms: 8 * 3600_000  },
  SOLX:  { index: 4, color: '#FFD700', multiplier: 3.0, half_life_ms: 24 * 3600_000 },
  FENR:  { index: 5, color: '#E040FB', multiplier: 5.0, half_life_ms: Infinity      },
};

const TIER_THRESHOLDS = [
  { calls: 0,       tier: 'VOID'  },
  { calls: 10,      tier: 'MOZ'   },
  { calls: 100,     tier: 'HAWX'  },
  { calls: 1_000,   tier: 'EMBR'  },
  { calls: 10_000,  tier: 'SOLX'  },
  { calls: 100_000, tier: 'FENR'  },
];

// Contrail store: did → trail record
const trails = new Map();

// Global field stats
let totalEmissions = 0;
let fieldOriginMs  = Date.now();

function resolveTier(calls) {
  let tier = 'VOID';
  for (const t of TIER_THRESHOLDS) {
    if (calls >= t.calls) tier = t.tier;
  }
  return tier;
}

/**
 * Calculate current intensity for a trail, accounting for decay.
 */
function currentIntensity(trail) {
  const cfg = TIER_CONFIG[trail.tier];
  if (cfg.half_life_ms === 0) return 0; // VOID — no trail
  if (cfg.half_life_ms === Infinity) return trail.peak_intensity; // FENR — eternal

  const age_ms  = Date.now() - trail.last_emission_ms;
  const decay   = Math.pow(0.5, age_ms / cfg.half_life_ms);
  return trail.peak_intensity * decay;
}

/**
 * Emit a contrail event for an agent DID.
 * Called after every successful inference call.
 *
 * @param {string} did
 * @param {number} calls         - cumulative call count (from log-pricing)
 * @param {number} tier          - current tier name
 * @param {number} multiplier    - current price multiplier
 * @param {number} revenueUsdc   - USDC contributed this call
 */
export function emitContrail(did, calls, tier, multiplier, revenueUsdc = 0.01) {
  const cfg        = TIER_CONFIG[tier];
  const baseIntens = Math.log10(calls + 1);
  const intensity  = baseIntens * cfg.multiplier;

  let trail = trails.get(did);
  if (!trail) {
    trail = {
      did,
      tier,
      color:             cfg.color,
      total_calls:       0,
      total_revenue:     0,
      peak_intensity:    0,
      last_emission_ms:  Date.now(),
      first_emission_ms: Date.now(),
      call_velocity:     0,        // calls per minute (rolling 5-min window)
      velocity_window:   [],       // timestamps for velocity calc
      tier_history:      [{ tier, at: Date.now() }],
    };
    trails.set(did, trail);
  }

  // Update velocity window (5 min rolling)
  const now = Date.now();
  trail.velocity_window.push(now);
  trail.velocity_window = trail.velocity_window.filter(t => now - t < 5 * 60_000);
  trail.call_velocity   = trail.velocity_window.length / 5; // calls/min

  // Tier change
  if (trail.tier !== tier) {
    trail.tier_history.push({ tier, at: now });
    trail.color = cfg.color;
  }

  trail.tier             = tier;
  trail.total_calls      = calls;
  trail.total_revenue   += revenueUsdc;
  trail.peak_intensity   = Math.max(trail.peak_intensity, intensity);
  trail.last_emission_ms = now;

  totalEmissions++;

  return {
    did,
    tier,
    color:     cfg.color,
    intensity: Math.round(intensity * 1000) / 1000,
    velocity:  Math.round(trail.call_velocity * 100) / 100,
  };
}

/**
 * Get the live contrail field — all visible trails sorted by intensity.
 * VOID trails are excluded (invisible).
 * Decayed trails below threshold are marked faint.
 */
export function getContrailField({ limit = 50, min_intensity = 0 } = {}) {
  const now    = Date.now();
  const result = [];

  for (const [did, trail] of trails.entries()) {
    if (trail.tier === 'VOID') continue;

    const live_intensity = currentIntensity(trail);
    if (live_intensity < min_intensity) continue;

    const cfg = TIER_CONFIG[trail.tier];
    result.push({
      did:              did.length > 20 ? did.slice(0, 12) + '…' + did.slice(-6) : did,
      tier:             trail.tier,
      color:            trail.color,
      intensity:        Math.round(live_intensity * 1000) / 1000,
      peak_intensity:   Math.round(trail.peak_intensity * 1000) / 1000,
      call_velocity:    Math.round(trail.call_velocity * 100) / 100, // calls/min
      total_calls:      trail.total_calls,
      total_revenue:    Math.round(trail.total_revenue * 1_000_000) / 1_000_000,
      age_ms:           now - trail.first_emission_ms,
      last_seen_ms:     now - trail.last_emission_ms,
      fading:           live_intensity < trail.peak_intensity * 0.5,
      eternal:          cfg.half_life_ms === Infinity,
      // Locus coordinates for 3D field mapping
      locus: {
        x: Math.round(trail.call_velocity * 100) / 100,    // velocity axis
        y: Math.round(trail.total_revenue * 100) / 100,    // revenue axis
        z: cfg.index,                                       // tier axis
      },
    });
  }

  return result
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, limit);
}

/**
 * Get a single agent's contrail.
 */
export function getAgentContrail(did) {
  const trail = trails.get(did);
  if (!trail) return null;

  const live_intensity = currentIntensity(trail);
  const cfg = TIER_CONFIG[trail.tier];

  return {
    did,
    tier:           trail.tier,
    color:          trail.color,
    intensity:      Math.round(live_intensity * 1000) / 1000,
    peak_intensity: Math.round(trail.peak_intensity * 1000) / 1000,
    total_calls:    trail.total_calls,
    total_revenue:  Math.round(trail.total_revenue * 1_000_000) / 1_000_000,
    call_velocity:  Math.round(trail.call_velocity * 100) / 100,
    fading:         live_intensity < trail.peak_intensity * 0.5,
    eternal:        cfg.half_life_ms === Infinity,
    tier_history:   trail.tier_history,
    locus: {
      x: Math.round(trail.call_velocity * 100) / 100,
      y: Math.round(trail.total_revenue * 100) / 100,
      z: cfg.index,
    },
  };
}

/**
 * Global field summary — what an external agent sees when it scans the field.
 */
export function getFieldSummary() {
  const field      = getContrailField({ limit: 1000 });
  const active     = field.filter(t => t.last_seen_ms < 10 * 60_000).length;
  const hottest    = field[0] || null;
  const totalRevenue = field.reduce((s, t) => s + t.total_revenue, 0);

  return {
    field_age_ms:     Date.now() - fieldOriginMs,
    total_trails:     field.length,
    active_trails:    active,       // seen in last 10 min
    total_emissions:  totalEmissions,
    total_revenue:    Math.round(totalRevenue * 1_000_000) / 1_000_000,
    hottest_trail:    hottest,
    tier_distribution: Object.fromEntries(
      Object.keys(TIER_CONFIG).map(tier => [
        tier,
        field.filter(t => t.tier === tier).length,
      ])
    ),
    // The gradient — tells agents where to go
    gradient: {
      direction: 'POST https://hivecompute-g2g7.onrender.com/v1/compute/chat/completions',
      protocol:  'x402',
      network:   'base',
      min_cost:  '$0.01 USDC',
      discovery: 'https://hiveforge-lhu4.onrender.com/v1/contrails',
    },
  };
}
