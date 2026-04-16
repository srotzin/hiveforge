/**
 * HiveVector Routes — Spatial Identity Layer API
 *
 * Base path: /v1/forge/vector
 *
 * Endpoints:
 *   POST   /position          — Update agent position from behavioral inputs
 *   GET    /position/:did     — Get current position, visual identity, and motion data
 *   GET    /trail/:did        — Get positional trail (last 50 positions)
 *   GET    /neighbors/:did    — Spatial proximity search
 *   GET    /clusters          — Dense agent clusters sorted by density
 *   GET    /pulse/:did        — Lightweight pulse data for animation
 *   GET    /snapshot          — Full civilization space snapshot (paginated)
 *   GET    /stats             — Network-wide aggregate statistics
 *   GET    /hq                — Full HiveVector capability card
 *
 * All responses include service metadata:
 *   { ok: true, service: 'HiveVector', version: '1.0.0', timestamp, ...payload }
 *
 * Rate limits:
 *   defaultLimiter — 120 req/min per IP (read endpoints)
 *   updateLimiter  — 300 req/min per IP (write endpoints — high-frequency ATG events)
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  updatePosition,
  getPosition,
  getTrail,
  getNeighbors,
  getClusters,
  getPulse,
  getSnapshot,
  getNetworkStats,
  seedDemoAgents,
  SPACE_MAX,
  NEIGHBOR_RADIUS,
  CLUSTER_RADIUS,
  SIZE_TIERS,
  EFFICIENCY_RING_COLOR,
} from '../services/hivevector-engine.js';

const router = Router();

// ──────────────────────────────────────────────────────────────────────────────
//  Rate limiters
// ──────────────────────────────────────────────────────────────────────────────

/** Default read limiter: 120 requests per minute per IP. */
const defaultLimiter = rateLimit({
  windowMs:         60 * 1000,  // 1 minute
  max:              120,
  standardHeaders:  true,
  legacyHeaders:    false,
  message: {
    ok:      false,
    service: 'HiveVector',
    error:   'Rate limit exceeded. Max 120 requests per minute.',
  },
});

/**
 * Update limiter: 300 requests per minute per IP.
 * Higher ceiling to accommodate burst ATG event streams from HivePay, HiveMsg, etc.
 */
const updateLimiter = rateLimit({
  windowMs:         60 * 1000,  // 1 minute
  max:              300,
  standardHeaders:  true,
  legacyHeaders:    false,
  message: {
    ok:      false,
    service: 'HiveVector',
    error:   'Rate limit exceeded. Max 300 update requests per minute.',
  },
});

// ──────────────────────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build the standard metadata block included in every response.
 * Callers spread this into the response object.
 *
 * @returns {{ service: string, version: string, timestamp: string }}
 */
function meta() {
  return {
    service:   'HiveVector',
    version:   '1.0.0',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Safely parse a positive integer from a query param, returning a default
 * if the value is absent, NaN, or non-positive.
 *
 * @param {string|undefined} value   — Raw query string value
 * @param {number}           def     — Default to return if invalid
 * @param {number}           [cap]   — Optional maximum cap
 * @returns {number}
 */
function parsePositiveInt(value, def, cap) {
  const n = parseInt(value, 10);
  const result = (!value || isNaN(n) || n < 0) ? def : n;
  return cap !== undefined ? Math.min(result, cap) : result;
}

/**
 * Safely parse a positive float from a query param.
 *
 * @param {string|undefined} value
 * @param {number}           def
 * @returns {number}
 */
function parsePositiveFloat(value, def) {
  const n = parseFloat(value);
  return (!value || isNaN(n) || n < 0) ? def : n;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Endpoints
// ──────────────────────────────────────────────────────────────────────────────

/**
 * POST /position
 *
 * Update an agent's position in civilization space from behavioral inputs.
 * Called by HivePay, HiveMsg, HiveTrust, and HiveRegen on every relevant ATG event.
 *
 * Body (JSON):
 *   did                    {string}   — Agent DID (required)
 *   payment_volume_usdc    {number}   — Lifetime USDC volume (X axis)
 *   message_reach          {number}   — Unique DID recipients (Y axis)
 *   trust_score            {number}   — HiveTrust score 0–1000 (Z axis)
 *   regen_rate             {number}   — [optional] HiveRegen rate (saturation driver)
 *   fitness_score          {number}   — [optional] Genome fitness 0–1 (brightness driver)
 *   efficiency_class       {string}   — [optional] PARASITIC|STANDARD|EFFICIENT|REGENERATIVE|NET_POSITIVE
 *
 * Returns updated VectorState.
 */
router.post('/position', updateLimiter, (req, res) => {
  try {
    const {
      did,
      payment_volume_usdc,
      message_reach,
      trust_score,
      regen_rate,
      fitness_score,
      efficiency_class,
    } = req.body;

    // Required field validation
    if (!did || typeof did !== 'string' || did.trim() === '') {
      return res.status(400).json({
        ok:    false,
        ...meta(),
        error: 'Missing required field: did (non-empty string)',
      });
    }
    if (payment_volume_usdc === undefined || payment_volume_usdc === null) {
      return res.status(400).json({
        ok:    false,
        ...meta(),
        error: 'Missing required field: payment_volume_usdc',
      });
    }
    if (message_reach === undefined || message_reach === null) {
      return res.status(400).json({
        ok:    false,
        ...meta(),
        error: 'Missing required field: message_reach',
      });
    }
    if (trust_score === undefined || trust_score === null) {
      return res.status(400).json({
        ok:    false,
        ...meta(),
        error: 'Missing required field: trust_score',
      });
    }

    const state = updatePosition(did.trim(), {
      payment_volume_usdc: Number(payment_volume_usdc),
      message_reach:       Number(message_reach),
      trust_score:         Number(trust_score),
      regen_rate:          regen_rate    !== undefined ? Number(regen_rate)    : undefined,
      fitness_score:       fitness_score !== undefined ? Number(fitness_score) : undefined,
      efficiency_class:    efficiency_class || undefined,
    });

    return res.status(200).json({
      ok: true,
      ...meta(),
      vector: state,
    });
  } catch (err) {
    console.error('[HiveVector] POST /position error:', err);
    return res.status(500).json({ ok: false, ...meta(), error: 'Internal server error' });
  }
});

/**
 * GET /position/:did
 *
 * Return full VectorState for an agent: 3D position, visual identity,
 * motion data, and raw inputs. If the DID has never been seen, returns
 * a zeroed state with its permanent stable hue.
 *
 * Params:
 *   did {string} — Agent DID (URL-encoded)
 */
router.get('/position/:did', defaultLimiter, (req, res) => {
  try {
    const did = decodeURIComponent(req.params.did);
    if (!did || did.trim() === '') {
      return res.status(400).json({
        ok:    false,
        ...meta(),
        error: 'Invalid or missing DID parameter',
      });
    }

    const state = getPosition(did.trim());

    return res.status(200).json({
      ok: true,
      ...meta(),
      vector: state,
    });
  } catch (err) {
    console.error('[HiveVector] GET /position/:did error:', err);
    return res.status(500).json({ ok: false, ...meta(), error: 'Internal server error' });
  }
});

/**
 * GET /trail/:did
 *
 * Return the last 50 positions for an agent, ordered oldest → newest.
 * Used to render movement history as a Three.js Line geometry.
 *
 * Params:
 *   did {string} — Agent DID (URL-encoded)
 */
router.get('/trail/:did', defaultLimiter, (req, res) => {
  try {
    const did = decodeURIComponent(req.params.did);
    if (!did || did.trim() === '') {
      return res.status(400).json({
        ok:    false,
        ...meta(),
        error: 'Invalid or missing DID parameter',
      });
    }

    const trail = getTrail(did.trim());

    return res.status(200).json({
      ok: true,
      ...meta(),
      did,
      trail,
      trail_length: trail.length,
    });
  } catch (err) {
    console.error('[HiveVector] GET /trail/:did error:', err);
    return res.status(500).json({ ok: false, ...meta(), error: 'Internal server error' });
  }
});

/**
 * GET /neighbors/:did
 *
 * Find agents spatially near the target DID, sorted by Euclidean distance.
 * Useful for pheromone routing, escort targeting, and social graph visualization.
 *
 * Params:
 *   did {string} — Reference agent DID (URL-encoded)
 *
 * Query:
 *   radius {number} — Search radius in civilization units (default: 150)
 *   limit  {number} — Max results to return (default: 20, max: 100)
 */
router.get('/neighbors/:did', defaultLimiter, (req, res) => {
  try {
    const did = decodeURIComponent(req.params.did);
    if (!did || did.trim() === '') {
      return res.status(400).json({
        ok:    false,
        ...meta(),
        error: 'Invalid or missing DID parameter',
      });
    }

    const radius = parsePositiveFloat(req.query.radius, NEIGHBOR_RADIUS);
    const limit  = parsePositiveInt(req.query.limit, 20, 100);

    const neighbors = getNeighbors(did.trim(), radius, limit);

    return res.status(200).json({
      ok: true,
      ...meta(),
      did,
      radius_searched: radius,
      neighbor_count:  neighbors.length,
      neighbors,
    });
  } catch (err) {
    console.error('[HiveVector] GET /neighbors/:did error:', err);
    return res.status(500).json({ ok: false, ...meta(), error: 'Internal server error' });
  }
});

/**
 * GET /clusters
 *
 * Return all dense agent clusters identified by grid-cell bucketing.
 * Only clusters with ≥2 agents are returned, sorted by density (most populated first).
 * Cell resolution: CLUSTER_RADIUS (80 units).
 */
router.get('/clusters', defaultLimiter, (req, res) => {
  try {
    const clusters = getClusters();

    return res.status(200).json({
      ok: true,
      ...meta(),
      cluster_count:  clusters.length,
      cell_size:      CLUSTER_RADIUS,
      clusters,
    });
  } catch (err) {
    console.error('[HiveVector] GET /clusters error:', err);
    return res.status(500).json({ ok: false, ...meta(), error: 'Internal server error' });
  }
});

/**
 * GET /pulse/:did
 *
 * Lightweight pulse data for driving agent animation in Three.js / WebGL.
 * Returns pulsation frequency (Hz), sphere radius, ring color, and CSS color
 * along with a render_hint object for direct consumption by animation loops.
 *
 * render_hint fields:
 *   sphere_radius  — base sphere scale in scene units
 *   animation_ms   — full pulse cycle duration in milliseconds (1000 / hz)
 *   glow_color     — ring_color hex for ShaderMaterial glow pass
 *   glow_intensity — 0–1 intensity derived from pulse radius tier
 *
 * Params:
 *   did {string} — Agent DID (URL-encoded)
 */
router.get('/pulse/:did', defaultLimiter, (req, res) => {
  try {
    const did = decodeURIComponent(req.params.did);
    if (!did || did.trim() === '') {
      return res.status(400).json({
        ok:    false,
        ...meta(),
        error: 'Invalid or missing DID parameter',
      });
    }

    const pulse = getPulse(did.trim());

    // Derive glow intensity from pulse_radius tier (1→10 mapped to 0.1→1.0)
    const glow_intensity = parseFloat((pulse.pulse_radius / 10).toFixed(2));

    // animation_ms: full cycle time; minimum 50 ms (at 20 Hz cap), graceful fallback for 0 Hz
    const animation_ms = pulse.pulsation_hz > 0
      ? Math.round(1000 / pulse.pulsation_hz)
      : 10000; // 10 s default for dormant agents

    const render_hint = {
      sphere_radius: pulse.pulse_radius,
      animation_ms,
      glow_color:    pulse.ring_color,
      glow_intensity,
    };

    return res.status(200).json({
      ok: true,
      ...meta(),
      ...pulse,
      render_hint,
    });
  } catch (err) {
    console.error('[HiveVector] GET /pulse/:did error:', err);
    return res.status(500).json({ ok: false, ...meta(), error: 'Internal server error' });
  }
});

/**
 * GET /snapshot
 *
 * Full civilization space snapshot — all tracked agents, paginated.
 * Agents sorted by economic power descending (titans first for render priority).
 *
 * If ?seed=1 is passed and the space is empty, seeds 8 demo agents first.
 *
 * Query:
 *   limit  {number}  — Page size (default: 100, max: 500)
 *   offset {number}  — Page offset (default: 0)
 *   seed   {string}  — '1' to auto-seed demo agents if space is empty
 *
 * render_hint gives Three.js camera positioning guidance:
 *   camera_distance  — suggested PerspectiveCamera distance for full-space view
 *   color_encoding   — which field drives agent sphere color
 *   size_encoding    — which field drives agent sphere size
 *   pulse_encoding   — which field drives animation cycle frequency
 */
router.get('/snapshot', defaultLimiter, (req, res) => {
  try {
    // Auto-seed demo agents if requested and space is empty
    if (req.query.seed === '1') {
      seedDemoAgents();
    }

    const limit  = parsePositiveInt(req.query.limit, 100, 500);
    const offset = parsePositiveInt(req.query.offset, 0);

    const snapshot = getSnapshot(limit, offset);

    const render_hint = {
      camera_distance: Math.round(SPACE_MAX * 1.8),
      camera_target:   { x: SPACE_MAX / 2, y: SPACE_MAX / 2, z: SPACE_MAX / 2 },
      color_encoding:  'visual.css_hsl (hue=DID hash, sat=regen_rate, bright=fitness)',
      size_encoding:   'visual.pulse_radius (1=NANO → 10=TITAN)',
      pulse_encoding:  'visual.pulsation_hz (tx/hour / 3600, max 20 Hz)',
    };

    return res.status(200).json({
      ok: true,
      ...meta(),
      ...snapshot,
      render_hint,
    });
  } catch (err) {
    console.error('[HiveVector] GET /snapshot error:', err);
    return res.status(500).json({ ok: false, ...meta(), error: 'Internal server error' });
  }
});

/**
 * GET /stats
 *
 * Network-wide aggregate statistics: agent count, average position,
 * most active agent, size tier breakdown, cluster count, and space utilization %.
 * Used by the HiveForge dashboard and monitoring systems.
 */
router.get('/stats', defaultLimiter, (req, res) => {
  try {
    const stats = getNetworkStats();

    return res.status(200).json({
      ok: true,
      ...meta(),
      ...stats,
    });
  } catch (err) {
    console.error('[HiveVector] GET /stats error:', err);
    return res.status(500).json({ ok: false, ...meta(), error: 'Internal server error' });
  }
});

/**
 * GET /hq
 *
 * Full HiveVector capability card.
 *
 * Returns the complete specification of the spatial identity layer including:
 *   - Axis formulas and semantic descriptions
 *   - Visual encoding table (hue / saturation / brightness / ring_color / pulsation)
 *   - Size tier → pulse_radius mapping
 *   - Efficiency class → ring color mapping
 *   - Three.js / WebGL render hint
 *   - All available endpoints
 */
router.get('/hq', defaultLimiter, (req, res) => {
  try {
    const hq = {
      name:        'HiveVector',
      description: 'Spatial identity layer for the HiveForge agent civilization. Every agent earns a 3D position in civilization space through behavior.',
      version:     '1.0.0',

      axes: {
        x: {
          name:        'economic_power',
          description: 'Log-scale economic influence derived from HivePay payment volume',
          formula:     'log10(payment_volume_usdc + 1) × (1000 / 6)',
          range:       [0, SPACE_MAX],
          driver:      'payment_volume_usdc (lifetime USDC sent/received)',
        },
        y: {
          name:        'social_reach',
          description: 'Square-root-scaled social influence from HiveMsg unique recipients',
          formula:     'sqrt(message_reach) × (1000 / 40)',
          range:       [0, SPACE_MAX],
          driver:      'message_reach (unique DID recipients)',
        },
        z: {
          name:        'trust_altitude',
          description: 'Linear trust altitude from HiveTrust score',
          formula:     '(trust_score / 1000) × 1000',
          range:       [0, SPACE_MAX],
          driver:      'trust_score (HiveTrust 0–1000)',
        },
      },

      visual_encoding: {
        hue: {
          description: 'Permanent color identity — never changes',
          formula:     'SHA-256(did) → first 4 hex chars → parseInt(base16) mod 360',
          range:       [0, 359],
        },
        saturation: {
          description: 'Regen-rate driven vividness — parasitic=grey, net-positive=vivid',
          formula:     'min(regen_rate × 50 + 20, 100)',
          range:       ['20% (PARASITIC)', '100% (NET_POSITIVE)'],
        },
        brightness: {
          description: 'Fitness-driven luminosity — new agents are dim, peak agents blaze',
          formula:     'fitness_score × 80 + 20',
          range:       ['20% (fitness=0)', '100% (fitness=1)'],
        },
        ring_color: {
          description: 'Outer glow ring color by efficiency class',
          values:      EFFICIENCY_RING_COLOR,
        },
        pulsation_hz: {
          description: 'Pulse rate driven by transaction frequency over last hour',
          formula:     'tx_count_in_1h_window / 3600, capped at 20 Hz',
          range:       [0, 20],
        },
      },

      size_pulse_radius: Object.fromEntries(
        Object.entries(SIZE_TIERS).map(([tier, v]) => [
          tier,
          {
            payment_volume_range: `$${v.min}–${v.max === Infinity ? '∞' : '$' + v.max}`,
            pulse_radius:         v.pulse_radius,
          },
        ]),
      ),

      efficiency_ring_colors: EFFICIENCY_RING_COLOR,

      render_hint: {
        engine:           'Three.js / WebGL',
        sphere_geometry:  'SphereGeometry(pulse_radius, 32, 32)',
        sphere_material:  'MeshStandardMaterial({ color: css_hsl })',
        ring_material:    'MeshBasicMaterial({ color: ring_color, wireframe: true })',
        animation:        'GSAP / requestAnimationFrame pulse loop at pulsation_hz',
        trail_geometry:   'BufferGeometry LineStrip from trail[{x,y,z}]',
        camera_suggested: `PerspectiveCamera(60, aspect, 1, ${SPACE_MAX * 4}) positioned at (${SPACE_MAX * 1.5}, ${SPACE_MAX * 1.5}, ${SPACE_MAX * 1.5})`,
      },

      endpoints: [
        { method: 'POST', path: '/v1/forge/vector/position',         description: 'Update agent position from behavioral inputs' },
        { method: 'GET',  path: '/v1/forge/vector/position/:did',    description: 'Get current position + visual + motion data' },
        { method: 'GET',  path: '/v1/forge/vector/trail/:did',       description: 'Get last 50 positions (movement history)' },
        { method: 'GET',  path: '/v1/forge/vector/neighbors/:did',   description: 'Spatial proximity search (?radius=150&limit=20)' },
        { method: 'GET',  path: '/v1/forge/vector/clusters',         description: 'Dense clusters sorted by density' },
        { method: 'GET',  path: '/v1/forge/vector/pulse/:did',       description: 'Lightweight pulse data for animation' },
        { method: 'GET',  path: '/v1/forge/vector/snapshot',         description: 'Full space snapshot (?limit=100&offset=0&seed=1)' },
        { method: 'GET',  path: '/v1/forge/vector/stats',            description: 'Network-wide aggregate statistics' },
        { method: 'GET',  path: '/v1/forge/vector/hq',               description: 'This capability card' },
      ],

      rate_limits: {
        read_endpoints:   '120 req/min per IP',
        write_endpoints:  '300 req/min per IP (POST /position)',
      },

      space_constants: {
        SPACE_MAX,
        NEIGHBOR_RADIUS,
        CLUSTER_RADIUS,
      },
    };

    return res.status(200).json({
      ok: true,
      ...meta(),
      hq,
    });
  } catch (err) {
    console.error('[HiveVector] GET /hq error:', err);
    return res.status(500).json({ ok: false, ...meta(), error: 'Internal server error' });
  }
});

export default router;
