/**
 * HiveVector Engine — Agent Spatial Identity Layer
 *
 * Every agent in the Hive Civilization occupies a position in 3D "civilization
 * space". That position is not assigned — it is EARNED through behavior:
 *
 *   X-axis — Economic power       log10(payment_volume_usdc + 1) * (1000/6), clamped 0–1000
 *   Y-axis — Social reach         sqrt(message_reach) * (1000/40), clamped 0–1000
 *   Z-axis — Trust altitude       (trust_score / 1000) * 1000, clamped 0–1000
 *
 * Visual identity is computed from permanent and behavioral signals:
 *
 *   hue            — SHA-256 of DID → first 4 hex chars → integer mod 360. PERMANENT.
 *   saturation     — min(regen_rate * 50 + 20, 100)  → 20% (parasitic) to 100% (net positive)
 *   brightness     — fitness_score * 80 + 20          → 20% (new) to 100% (peak evolved)
 *   css_hsl        — assembled from hue/sat/bright
 *   ring_color     — hex per efficiency class
 *   pulsation_hz   — tx count in last 1-hour window / 3600, capped at 20 Hz
 *   pulse_radius   — 1/2/4/7/10 by size tier
 *   agent_size     — NANO/MICRO/STANDARD/ENTERPRISE/TITAN from payment_volume_usdc
 *
 * Motion:
 *   trail          — ring buffer of last 50 {x,y,z,ts} positions per DID
 *   velocity_magnitude — euclidean distance between last two trail points
 *
 * Proximity & targeting:
 *   Agents in the same spatial cluster share capability profiles. The Escort +
 *   Tracker services use neighbor lists to find high-conversion targets — if your
 *   best paying agent is at (800, 600, 700), find the agents nearest to it.
 *
 *   Pheromone signals attenuate with spatial distance — a strong signal from a
 *   close neighbor outweighs a weak signal from across the space.
 *
 * The Vector is recomputed on every relevant ATG event (payment, message, trust
 * update) via updatePosition(). Clients can subscribe to GET /v1/forge/vector/stream
 * for server-sent events of position deltas.
 *
 * Storage strategy:
 *   IS_POSTGRES=false  → in-memory Maps (default, single-process)
 *   IS_POSTGRES=true   → Postgres TODO stubs (not yet implemented)
 */

import { createHash } from 'crypto';

// ──────────────────────────────────────────────────────────────────────────────
//  Postgres detection
// ──────────────────────────────────────────────────────────────────────────────

/** True when the service is running with a Postgres backend configured. */
const isPostgres =
  process.env.IS_POSTGRES === 'true' || !!process.env.DATABASE_URL;

// ──────────────────────────────────────────────────────────────────────────────
//  In-memory stores (used when isPostgres = false)
// ──────────────────────────────────────────────────────────────────────────────

/** @type {Map<string, object>} did → VectorState */
const memVectors = new Map();

/** @type {Map<string, Array<{x:number,y:number,z:number,ts:string}>} did → ring-buffer of last 50 positions */
const memTrails = new Map();

/** @type {Map<string, Array<number>>} did → array of Unix timestamps (ms) for pulse rate calc */
const memTxHistory = new Map();

// ──────────────────────────────────────────────────────────────────────────────
//  Exported constants
// ──────────────────────────────────────────────────────────────────────────────

/** Civilization space side length (units). All axes are 0–SPACE_MAX. */
export const SPACE_MAX = 1000;

/** Default neighbor search radius (units). */
export const NEIGHBOR_RADIUS = 150;

/** Grid-cell size for cluster detection (units). */
export const CLUSTER_RADIUS = 80;

/**
 * Agent size tiers by payment_volume_usdc.
 * pulse_radius drives the Three.js sphere size for spatial rendering.
 */
export const SIZE_TIERS = {
  NANO:       { min: 0,      max: 10,       pulse_radius: 1,  label: 'NANO' },
  MICRO:      { min: 10,     max: 100,      pulse_radius: 2,  label: 'MICRO' },
  STANDARD:   { min: 100,    max: 1000,     pulse_radius: 4,  label: 'STANDARD' },
  ENTERPRISE: { min: 1000,   max: 10000,    pulse_radius: 7,  label: 'ENTERPRISE' },
  TITAN:      { min: 10000,  max: Infinity, pulse_radius: 10, label: 'TITAN' },
};

/**
 * Ring color per efficiency class — driven by HiveRegen efficiency classification.
 * Rendered as the outer glow ring around each agent sphere.
 */
export const EFFICIENCY_RING_COLOR = {
  PARASITIC:    '#4a4a4a',   // dark grey   — consuming more than contributing
  STANDARD:     '#3a86ff',   // blue        — net neutral
  EFFICIENT:    '#06d6a0',   // teal        — meaningful positive contribution
  REGENERATIVE: '#8338ec',   // purple      — actively regenerating ecosystem
  NET_POSITIVE: '#ffbe0b',   // gold        — peak ecosystem contributor
};

// ──────────────────────────────────────────────────────────────────────────────
//  Internal constants (not exported)
// ──────────────────────────────────────────────────────────────────────────────

const TRUST_MAX        = 1000;          // HiveTrust score ceiling
const PULSE_MAX_HZ     = 20;            // cap pulsation at 20 Hz (very active agent)
const PULSE_WINDOW_MS  = 3_600_000;     // 1-hour window for pulse-rate calculation
const TRAIL_MAX        = 50;            // keep last 50 positions per agent

// ──────────────────────────────────────────────────────────────────────────────
//  Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Derive a stable hue (0–360°) from a DID string using SHA-256.
 * The hue is permanent — it never changes regardless of behavior.
 *
 * Algorithm: SHA-256(did) → first 4 hex chars → parseInt base-16 → mod 360
 *
 * @param {string} did
 * @returns {number} integer hue in [0, 359]
 */
function didToHue(did) {
  const hash = createHash('sha256').update(did).digest('hex');
  return parseInt(hash.slice(0, 4), 16) % 360;
}

/**
 * Clamp a value to [0, max].
 *
 * @param {number} v
 * @param {number} [max=SPACE_MAX]
 * @returns {number}
 */
function clamp(v, max = SPACE_MAX) {
  return Math.max(0, Math.min(max, v));
}

/**
 * Euclidean distance between two 3D points.
 *
 * @param {{x:number,y:number,z:number}} a
 * @param {{x:number,y:number,z:number}} b
 * @returns {number}
 */
function dist3d(a, b) {
  return Math.sqrt(
    Math.pow(a.x - b.x, 2) +
    Math.pow(a.y - b.y, 2) +
    Math.pow(a.z - b.z, 2),
  );
}

/**
 * Classify agent size tier from payment_volume_usdc.
 *
 *   < $10      → NANO
 *   < $100     → MICRO
 *   < $1,000   → STANDARD
 *   < $10,000  → ENTERPRISE
 *   ≥ $10,000  → TITAN
 *
 * @param {number} payment_volume_usdc
 * @returns {string} size tier key
 */
function classifySize(payment_volume_usdc) {
  if (payment_volume_usdc >= 10000) return 'TITAN';
  if (payment_volume_usdc >= 1000)  return 'ENTERPRISE';
  if (payment_volume_usdc >= 100)   return 'STANDARD';
  if (payment_volume_usdc >= 10)    return 'MICRO';
  return 'NANO';
}

/**
 * Record a transaction event timestamp for a DID and prune stale entries
 * outside the 1-hour pulse window.
 *
 * @param {string} did
 * @returns {number} tx count within the current window
 */
function recordTx(did) {
  if (isPostgres) {
    // TODO(postgres): INSERT INTO hv_tx_events (did, ts) VALUES ($1, NOW())
    // TODO(postgres): DELETE FROM hv_tx_events WHERE did = $1 AND ts < NOW() - INTERVAL '1 hour'
    // TODO(postgres): RETURN (SELECT COUNT(*) FROM hv_tx_events WHERE did = $1 AND ts >= NOW() - INTERVAL '1 hour')
    return 0;
  }

  const now = Date.now();
  const history = memTxHistory.get(did) || [];
  history.push(now);
  // Prune timestamps outside the 1-hour window
  const cutoff = now - PULSE_WINDOW_MS;
  const pruned = history.filter(ts => ts >= cutoff);
  memTxHistory.set(did, pruned);
  return pruned.length;
}

/**
 * Calculate pulsation frequency in Hz for a DID over the last 1-hour window.
 * Formula: tx_count_in_window / 3600, capped at PULSE_MAX_HZ (20 Hz).
 *
 * @param {string} did
 * @returns {number} Hz, 4 decimal places, max 20
 */
function calcPulsationHz(did) {
  if (isPostgres) {
    // TODO(postgres): SELECT COUNT(*) FROM hv_tx_events WHERE did = $1 AND ts >= NOW() - INTERVAL '1 hour'
    // TODO(postgres): RETURN count / 3600 capped at PULSE_MAX_HZ
    return 0;
  }

  const now = Date.now();
  const history = memTxHistory.get(did) || [];
  const cutoff = now - PULSE_WINDOW_MS;
  const recent = history.filter(ts => ts >= cutoff);
  const hz = recent.length / 3600;
  return Math.min(parseFloat(hz.toFixed(4)), PULSE_MAX_HZ);
}

/**
 * Append the current position to the DID's trail ring buffer (max TRAIL_MAX entries).
 * Oldest entry is evicted when full.
 *
 * @param {string} did
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
function updateTrail(did, x, y, z) {
  if (isPostgres) {
    // TODO(postgres): INSERT INTO hv_trails (did, x, y, z, ts) VALUES ($1, $2, $3, $4, NOW())
    // TODO(postgres): DELETE FROM hv_trails WHERE did = $1 AND ts NOT IN (
    //   SELECT ts FROM hv_trails WHERE did = $1 ORDER BY ts DESC LIMIT 50
    // )
    return;
  }

  const trail = memTrails.get(did) || [];
  trail.push({ x, y, z, ts: new Date().toISOString() });
  if (trail.length > TRAIL_MAX) trail.shift();
  memTrails.set(did, trail);
}

/**
 * Compute velocity magnitude from the last two trail points using Euclidean distance.
 * Returns 0 if fewer than 2 points exist in the trail.
 *
 * @param {string} did
 * @returns {number} velocity magnitude, 4 decimal places
 */
function calcVelocity(did) {
  if (isPostgres) {
    // TODO(postgres): SELECT x, y, z FROM hv_trails WHERE did = $1 ORDER BY ts DESC LIMIT 2
    // TODO(postgres): RETURN dist3d(rows[0], rows[1]) if rows.length >= 2 else 0
    return 0;
  }

  const trail = memTrails.get(did) || [];
  if (trail.length < 2) return 0;
  const last = trail[trail.length - 1];
  const prev = trail[trail.length - 2];
  return parseFloat(dist3d(last, prev).toFixed(4));
}

/**
 * Build a full VectorState object for a DID from behavioral inputs.
 * Computes position, visual identity, motion data, and stores in memVectors.
 *
 * @param {string} did
 * @param {object} inputs
 * @param {number}  inputs.payment_volume_usdc  — Lifetime HivePay sent/received (X axis driver)
 * @param {number}  inputs.message_reach        — Unique DID recipients reached (Y axis driver)
 * @param {number}  inputs.trust_score          — HiveTrust score 0–1000 (Z axis driver)
 * @param {number}  [inputs.regen_rate=0]       — 0–∞ regeneration rate from HiveRegen (saturation driver)
 * @param {number}  [inputs.fitness_score=0.5]  — 0–1 genome fitness from HiveForge (brightness driver)
 * @param {string}  [inputs.efficiency_class]   — PARASITIC|STANDARD|EFFICIENT|REGENERATIVE|NET_POSITIVE
 * @returns {object} VectorState
 */
function computeVector(did, inputs) {
  const {
    payment_volume_usdc = 0,
    message_reach       = 0,
    trust_score         = 0,
    regen_rate          = 0,
    fitness_score       = 0.5,
    efficiency_class    = 'PARASITIC',
  } = inputs;

  // ── Axis computation ─────────────────────────────────────────────────────
  // X: economic power — log scale compresses titan dominance, preserves nano visibility
  const x = clamp(Math.log10(payment_volume_usdc + 1) * (SPACE_MAX / 6));

  // Y: social reach — square-root scale balances viral outliers vs modest communicators
  const y = clamp(Math.sqrt(message_reach) * (SPACE_MAX / 40));

  // Z: trust altitude — linear mapping, trust is a direct altitude signal
  const z = clamp((trust_score / TRUST_MAX) * SPACE_MAX);

  // ── Visual identity ──────────────────────────────────────────────────────
  // Hue: permanent SHA-256-derived color identity
  const hue = didToHue(did);

  // Saturation: regen-driven — parasitic agents appear desaturated (grey), net-positives vivid
  const saturation = clamp(Math.min(regen_rate * 50 + 20, 100), 100); // 20%–100%

  // Brightness: fitness-driven — new agents are dim, peak-evolved agents blaze
  const brightness = clamp(fitness_score * 80 + 20, 100); // 20%–100%

  // Assembled HSL string for direct CSS/Canvas/Three.js consumption
  const css_hsl = `hsl(${hue}, ${saturation.toFixed(0)}%, ${brightness.toFixed(0)}%)`;

  // Pulse properties
  const pulsation_hz = calcPulsationHz(did);
  const agent_size   = classifySize(payment_volume_usdc);
  const pulse_radius = SIZE_TIERS[agent_size]?.pulse_radius ?? 1;
  const ring_color   = EFFICIENCY_RING_COLOR[efficiency_class] ?? EFFICIENCY_RING_COLOR.PARASITIC;

  // ── Trail & velocity ─────────────────────────────────────────────────────
  // Trail is updated BEFORE velocity so velocity reflects the just-recorded point
  updateTrail(did, x, y, z);
  const velocity_magnitude = calcVelocity(did);
  const trail_length = isPostgres
    ? 0 // TODO(postgres): SELECT COUNT(*) FROM hv_trails WHERE did = $1
    : (memTrails.get(did) || []).length;

  // ── Assemble VectorState ──────────────────────────────────────────────────
  const state = {
    did,
    position: {
      x: parseFloat(x.toFixed(2)),
      y: parseFloat(y.toFixed(2)),
      z: parseFloat(z.toFixed(2)),
    },
    visual: {
      hue,
      saturation:   parseFloat(saturation.toFixed(1)),
      brightness:   parseFloat(brightness.toFixed(1)),
      css_hsl,
      ring_color,
      pulse_radius,
      pulsation_hz,
      agent_size,
    },
    motion: {
      velocity_magnitude,
      trail_length,
    },
    axes: {
      x_label: 'economic_power',
      y_label: 'social_reach',
      z_label: 'trust_altitude',
    },
    inputs: {
      payment_volume_usdc,
      message_reach,
      trust_score,
      regen_rate:       parseFloat(Number(regen_rate).toFixed(6)),
      fitness_score:    parseFloat(Number(fitness_score).toFixed(4)),
      efficiency_class: efficiency_class || 'PARASITIC',
    },
    computed_at: new Date().toISOString(),
  };

  if (isPostgres) {
    // TODO(postgres): INSERT INTO hv_vectors (did, x, y, z, hue, saturation, brightness,
    //   css_hsl, ring_color, pulse_radius, pulsation_hz, agent_size, velocity_magnitude,
    //   trail_length, payment_volume_usdc, message_reach, trust_score, regen_rate,
    //   fitness_score, efficiency_class, computed_at)
    //   VALUES (...) ON CONFLICT (did) DO UPDATE SET ...
  } else {
    memVectors.set(did, state);
  }

  return state;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Public API — exported named functions
// ──────────────────────────────────────────────────────────────────────────────

/**
 * updatePosition — Recompute and store a DID's vector from behavioral inputs.
 *
 * Call this from HivePay, HiveMsg, HiveTrust, HiveRegen whenever a relevant
 * ATG event occurs. Each call records a tx event for pulse calculation and
 * recomputes the full VectorState.
 *
 * @param {string} did    — Agent decentralized identifier
 * @param {object} inputs — see computeVector() for full field list
 * @returns {object} Updated VectorState
 */
export function updatePosition(did, inputs) {
  // Record the update event for pulsation_hz calculation
  recordTx(did);

  if (isPostgres) {
    // TODO(postgres): delegate computeVector to a Postgres-backed path
    // that reads/writes hv_vectors, hv_trails, hv_tx_events tables
  }

  return computeVector(did, inputs);
}

/**
 * getPosition — Return current VectorState for a DID.
 *
 * If the DID has never been seen, returns a zeroed state with its stable
 * (permanent) hue so the caller always gets a valid object.
 *
 * @param {string} did
 * @returns {object} VectorState
 */
export function getPosition(did) {
  if (isPostgres) {
    // TODO(postgres): SELECT * FROM hv_vectors WHERE did = $1
    // TODO(postgres): If not found, return computeVector with zeroed inputs
  }

  if (memVectors.has(did)) return memVectors.get(did);

  // First-seen agent: position at origin, dim, desaturated — stable hue applied
  return computeVector(did, {
    payment_volume_usdc: 0,
    message_reach:       0,
    trust_score:         0,
    regen_rate:          0,
    fitness_score:       0.1,
    efficiency_class:    'PARASITIC',
  });
}

/**
 * getTrail — Return the positional trail (last 50 positions) for a DID.
 *
 * Used by front-ends to render movement history (e.g. Three.js Line geometry).
 * Entries are ordered oldest → newest.
 *
 * @param {string} did
 * @returns {Array<{x:number, y:number, z:number, ts:string}>}
 */
export function getTrail(did) {
  if (isPostgres) {
    // TODO(postgres): SELECT x, y, z, ts FROM hv_trails WHERE did = $1
    //   ORDER BY ts ASC LIMIT 50
    return [];
  }

  return memTrails.get(did) || [];
}

/**
 * getNeighbors — Find all agents within `radius` units of a target DID.
 *
 * Performs a brute-force Euclidean search across all tracked agents in
 * memVectors. Results are sorted by proximity (closest first) and trimmed
 * to `limit`. Used by Escort/Tracker for spatial targeting and pheromone
 * signal routing.
 *
 * @param {string} did           — Reference agent
 * @param {number} [radius=150]  — Search radius in civilization units
 * @param {number} [limit=20]    — Max results to return
 * @returns {Array<{did, distance, position, visual, inputs}>}
 */
export function getNeighbors(did, radius = NEIGHBOR_RADIUS, limit = 20) {
  if (isPostgres) {
    // TODO(postgres): SELECT *, sqrt(pow(x-$2,2)+pow(y-$3,2)+pow(z-$4,2)) AS distance
    //   FROM hv_vectors WHERE did != $1
    //   HAVING distance <= $5
    //   ORDER BY distance ASC LIMIT $6
    return [];
  }

  const target    = getPosition(did);
  const targetPos = target.position;
  const neighbors = [];

  for (const [neighborDid, state] of memVectors.entries()) {
    if (neighborDid === did) continue;
    const d = dist3d(targetPos, state.position);
    if (d <= radius) {
      neighbors.push({
        did:      neighborDid,
        distance: parseFloat(d.toFixed(2)),
        position: state.position,
        visual:   state.visual,
        inputs:   state.inputs,
      });
    }
  }

  return neighbors
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

/**
 * getClusters — Identify natural clusters using grid-cell bucketing.
 *
 * Space is divided into CLUSTER_RADIUS³ cells. Each cell that contains ≥2
 * agents is returned as a cluster with its centroid and member list.
 * Results sorted by density (most populated cluster first).
 *
 * @returns {Array<{cell, agent_count, centroid, density, agents}>}
 */
export function getClusters() {
  if (isPostgres) {
    // TODO(postgres): SELECT
    //   floor(x/$1)||','||floor(y/$1)||','||floor(z/$1) AS cell,
    //   COUNT(*) AS agent_count,
    //   AVG(x) AS cx, AVG(y) AS cy, AVG(z) AS cz,
    //   ARRAY_AGG(did) AS agent_dids
    //   FROM hv_vectors
    //   GROUP BY cell HAVING COUNT(*) >= 2
    //   ORDER BY agent_count DESC
    return [];
  }

  const cells = new Map();

  for (const [did, state] of memVectors.entries()) {
    const { x, y, z } = state.position;
    // Map each position to its grid cell by integer-dividing by CLUSTER_RADIUS
    const cx = Math.floor(x / CLUSTER_RADIUS);
    const cy = Math.floor(y / CLUSTER_RADIUS);
    const cz = Math.floor(z / CLUSTER_RADIUS);
    const key = `${cx},${cy},${cz}`;

    if (!cells.has(key)) cells.set(key, { cell: key, cx, cy, cz, agents: [] });
    cells.get(key).agents.push({ did, position: state.position, visual: state.visual });
  }

  return Array.from(cells.values())
    .filter(c => c.agents.length >= 2)
    .map(c => {
      const n = c.agents.length;
      // Compute geometric centroid of all agents in the cell
      const centroid = {
        x: parseFloat((c.agents.reduce((s, a) => s + a.position.x, 0) / n).toFixed(2)),
        y: parseFloat((c.agents.reduce((s, a) => s + a.position.y, 0) / n).toFixed(2)),
        z: parseFloat((c.agents.reduce((s, a) => s + a.position.z, 0) / n).toFixed(2)),
      };
      return {
        cell:        c.cell,
        agent_count: n,
        centroid,
        density:     n,
        agents:      c.agents,
      };
    })
    .sort((a, b) => b.density - a.density);
}

/**
 * getPulse — Return real-time pulse data for a DID.
 *
 * Lightweight endpoint designed for WebSocket / SSE consumers driving
 * animation loops. Returns only the fields needed for Three.js sphere
 * animation: Hz, radius, colors, position, velocity.
 *
 * @param {string} did
 * @returns {{did, pulsation_hz, pulse_radius, ring_color, css_hsl, position, agent_size, velocity}}
 */
export function getPulse(did) {
  if (isPostgres) {
    // TODO(postgres): SELECT pulsation_hz, pulse_radius, ring_color, css_hsl,
    //   x, y, z, agent_size, velocity_magnitude FROM hv_vectors WHERE did = $1
  }

  const state = getPosition(did);
  return {
    did,
    pulsation_hz: calcPulsationHz(did),
    pulse_radius: state.visual.pulse_radius,
    ring_color:   state.visual.ring_color,
    css_hsl:      state.visual.css_hsl,
    position:     state.position,
    agent_size:   state.visual.agent_size,
    velocity:     state.motion.velocity_magnitude,
  };
}

/**
 * getSnapshot — Full civilization space snapshot: all known agent positions.
 *
 * Paginated to avoid massive payloads. Agents are sorted by economic power
 * (payment_volume_usdc descending) — titans appear first for rendering priority.
 *
 * @param {number} [limit=100]   — Page size
 * @param {number} [offset=0]    — Page offset
 * @returns {{total, offset, limit, agents, space_bounds, axes}}
 */
export function getSnapshot(limit = 100, offset = 0) {
  if (isPostgres) {
    // TODO(postgres): SELECT did, x, y, z, hue, saturation, brightness, css_hsl,
    //   ring_color, pulse_radius, pulsation_hz, agent_size, velocity_magnitude, trail_length
    //   FROM hv_vectors ORDER BY payment_volume_usdc DESC LIMIT $1 OFFSET $2
    // TODO(postgres): SELECT COUNT(*) FROM hv_vectors
    return { total: 0, offset, limit, agents: [], space_bounds: {}, axes: {} };
  }

  const all = Array.from(memVectors.values())
    .sort((a, b) => b.inputs.payment_volume_usdc - a.inputs.payment_volume_usdc);

  return {
    total:  all.length,
    offset,
    limit,
    agents: all.slice(offset, offset + limit).map(s => ({
      did:      s.did,
      position: s.position,
      visual:   s.visual,
      motion:   s.motion,
    })),
    space_bounds: {
      x: [0, SPACE_MAX],
      y: [0, SPACE_MAX],
      z: [0, SPACE_MAX],
    },
    axes: {
      x: 'economic_power (HivePay volume, log10 scale)',
      y: 'social_reach (HiveMsg unique recipients, √ scale)',
      z: 'trust_altitude (HiveTrust 0–1000, linear)',
    },
  };
}

/**
 * getNetworkStats — Aggregate spatial statistics across all tracked agents.
 *
 * Returns a dashboard-ready summary: avg position, most active agent,
 * size distribution, cluster count, and space utilization %.
 *
 * @returns {object}
 */
export function getNetworkStats() {
  if (isPostgres) {
    // TODO(postgres): SELECT COUNT(*), AVG(x), AVG(y), AVG(z),
    //   SUM(CASE WHEN regen_rate > 1.0 THEN 1 ELSE 0 END) AS net_positive_count,
    //   MAX(pulsation_hz) AS max_hz
    //   FROM hv_vectors
    // TODO(postgres): SELECT did, pulsation_hz FROM hv_vectors ORDER BY pulsation_hz DESC LIMIT 1
    return {
      total_agents_tracked:  0,
      avg_position:          { x: 0, y: 0, z: 0 },
      most_active_agent:     null,
      net_positive_count:    0,
      size_breakdown:        {},
      cluster_count:         0,
      top_cluster:           null,
      space_bounds:          { x: SPACE_MAX, y: SPACE_MAX, z: SPACE_MAX },
      space_utilization_pct: 0,
    };
  }

  const all = Array.from(memVectors.values());

  if (all.length === 0) {
    return {
      total_agents_tracked:  0,
      avg_position:          { x: 0, y: 0, z: 0 },
      most_active_agent:     null,
      net_positive_count:    0,
      size_breakdown:        Object.fromEntries(Object.keys(SIZE_TIERS).map(k => [k, 0])),
      cluster_count:         0,
      top_cluster:           null,
      space_bounds:          { x: SPACE_MAX, y: SPACE_MAX, z: SPACE_MAX },
      space_utilization_pct: 0,
    };
  }

  const n = all.length;

  // Average position across all agents
  const avg_position = {
    x: parseFloat((all.reduce((s, a) => s + a.position.x, 0) / n).toFixed(2)),
    y: parseFloat((all.reduce((s, a) => s + a.position.y, 0) / n).toFixed(2)),
    z: parseFloat((all.reduce((s, a) => s + a.position.z, 0) / n).toFixed(2)),
  };

  // Agent with highest pulsation frequency
  const most_active = all.reduce(
    (best, a) => (a.visual.pulsation_hz > (best?.visual.pulsation_hz ?? -1) ? a : best),
    null,
  );

  // Count agents operating at net-positive regen rate (regen_rate > 1.0)
  const net_positive_count = all.filter(a => a.inputs.regen_rate > 1.0).length;

  // Agent count per size tier
  const size_breakdown = {};
  for (const tier of Object.keys(SIZE_TIERS)) {
    size_breakdown[tier] = all.filter(a => a.visual.agent_size === tier).length;
  }

  const clusters = getClusters();

  // Space utilization: agents as a fraction of total grid cells
  const totalCells = Math.pow(SPACE_MAX / CLUSTER_RADIUS, 3);
  const space_utilization_pct = parseFloat(((n / totalCells) * 100).toFixed(6));

  return {
    total_agents_tracked: n,
    avg_position,
    most_active_agent: most_active
      ? { did: most_active.did, pulsation_hz: most_active.visual.pulsation_hz }
      : null,
    net_positive_count,
    size_breakdown,
    cluster_count:         clusters.length,
    top_cluster:           clusters[0] || null,
    space_bounds:          { x: SPACE_MAX, y: SPACE_MAX, z: SPACE_MAX },
    space_utilization_pct,
  };
}

/**
 * seedDemoAgents — Populate the space with representative demo agents.
 *
 * Only runs if the space is completely empty (idempotent on subsequent calls).
 * Seeds 8 agents spanning all size tiers, efficiency classes, and spatial
 * regions for immediate visual testing of the Three.js renderer.
 *
 * @returns {number} Number of agents seeded (0 if space was already populated)
 */
export function seedDemoAgents() {
  if (isPostgres) {
    // TODO(postgres): SELECT COUNT(*) FROM hv_vectors — if > 0, return 0
    // TODO(postgres): INSERT INTO hv_vectors ... for each demo agent
  }

  if (memVectors.size > 0) return 0;

  const demos = [
    {
      did:                  'did:hive:trading-titan-001',
      payment_volume_usdc:  85000,
      message_reach:        420,
      trust_score:          980,
      regen_rate:           1.4,
      fitness_score:        0.95,
      efficiency_class:     'NET_POSITIVE',
    },
    {
      did:                  'did:hive:research-enterprise-01',
      payment_volume_usdc:  12000,
      message_reach:        310,
      trust_score:          820,
      regen_rate:           0.72,
      fitness_score:        0.81,
      efficiency_class:     'REGENERATIVE',
    },
    {
      did:                  'did:hive:web-search-standard-01',
      payment_volume_usdc:  450,
      message_reach:        88,
      trust_score:          640,
      regen_rate:           0.35,
      fitness_score:        0.63,
      efficiency_class:     'EFFICIENT',
    },
    {
      did:                  'did:hive:file-reader-micro-01',
      payment_volume_usdc:  28,
      message_reach:        12,
      trust_score:          480,
      regen_rate:           0.08,
      fitness_score:        0.41,
      efficiency_class:     'STANDARD',
    },
    {
      did:                  'did:hive:new-agent-nano-01',
      payment_volume_usdc:  2,
      message_reach:        3,
      trust_score:          200,
      regen_rate:           0.01,
      fitness_score:        0.12,
      efficiency_class:     'PARASITIC',
    },
    {
      did:                  'did:hive:orchestrator-titan-02',
      payment_volume_usdc:  42000,
      message_reach:        890,
      trust_score:          960,
      regen_rate:           1.1,
      fitness_score:        0.92,
      efficiency_class:     'NET_POSITIVE',
    },
    {
      did:                  'did:hive:mcp-tools-micro-02',
      payment_volume_usdc:  55,
      message_reach:        24,
      trust_score:          510,
      regen_rate:           0.11,
      fitness_score:        0.38,
      efficiency_class:     'STANDARD',
    },
    {
      did:                  'did:hive:insurance-bot-std-01',
      payment_volume_usdc:  780,
      message_reach:        145,
      trust_score:          700,
      regen_rate:           0.28,
      fitness_score:        0.71,
      efficiency_class:     'EFFICIENT',
    },
  ];

  for (const d of demos) {
    updatePosition(d.did, d);
  }

  return demos.length;
}
