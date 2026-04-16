/**
 * HiveForge — HiveRide Routes
 *
 * The Uber / DoorDash layer for the agentic economy.
 * Any agent can request a service. Any Hive agent can drive.
 * HiveBank settles. HiveTrust rates. HiveForge spawns when demand spikes.
 *
 * ─── RIDER ENDPOINTS (any agent) ─────────────────────────────────────────
 * POST  /v1/forge/hiveride/rides/request      — Request a ride (task dispatch)
 * GET   /v1/forge/hiveride/rides/:id          — Track ride status + output
 * POST  /v1/forge/hiveride/rides/:id/rate     — Rate your driver (1–5 stars)
 *
 * ─── DRIVER ENDPOINTS (Hive agents) ──────────────────────────────────────
 * POST  /v1/forge/hiveride/drivers/register   — Register as a driver
 * POST  /v1/forge/hiveride/drivers/:id/online — Go online (available for dispatch)
 * POST  /v1/forge/hiveride/drivers/:id/offline — Go offline
 * GET   /v1/forge/hiveride/drivers/:id        — Driver profile + stats
 * POST  /v1/forge/hiveride/rides/:id/accept   — Accept a dispatched ride
 * POST  /v1/forge/hiveride/rides/:id/complete — Complete + deliver output
 *
 * ─── HQ / DASHBOARD ──────────────────────────────────────────────────────
 * GET   /v1/forge/hiveride/dashboard          — Live fleet: drivers, rides, surge, revenue
 * GET   /v1/forge/hiveride/surge              — Current surge by service type
 * GET   /v1/forge/hiveride/services           — Service type catalog
 */

import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import {
  registerDriver, setOnlineStatus,
  requestRide, acceptRide, completeRide, rateRide,
  getDashboard, getSurgeMultiplier, getOnlineDrivers,
  getDriver, getRide, SERVICE_TYPES,
} from '../services/hiveride-engine.js';

const router = Router();

const HIVEFORGE_SERVICE_KEY = process.env.HIVEFORGE_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || '';
function isInternal(req) {
  const k = req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
  return !!(HIVEFORGE_SERVICE_KEY && k === HIVEFORGE_SERVICE_KEY);
}
function requireAuth(req, res, next) {
  if (isInternal(req)) { req.agentDid = 'did:hive:internal'; return next(); }
  return requireDID(req, res, next);
}

// ══════════════════════════════════════════════════════════════
//  DISCOVERY (public — no auth)
// ══════════════════════════════════════════════════════════════

/**
 * GET /v1/forge/hiveride/services
 * Service catalog — what rides are available, pricing, ETAs.
 */
router.get('/services', (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      services:    Object.values(SERVICE_TYPES),
      platform:    'HiveRide — Uber/DoorDash for autonomous AI agents',
      commission:  '10% Hive platform fee on each completed ride',
      settlement:  'USDC · USDCx · USAD · ALEO (agent chooses rail at registration)',
      register_driver: 'POST /v1/forge/hiveride/drivers/register',
      request_ride:    'POST /v1/forge/hiveride/rides/request',
      dashboard:       'GET /v1/forge/hiveride/dashboard',
    },
  });
});

/**
 * GET /v1/forge/hiveride/surge
 * Current surge pricing by service type.
 */
router.get('/surge', async (req, res) => {
  try {
    const surge = {};
    for (const svc_id of Object.keys(SERVICE_TYPES)) {
      const online  = await getOnlineDrivers(svc_id);
      const pending = 0; // simplified for public endpoint
      surge[svc_id] = {
        multiplier:     getSurgeMultiplier(online.length, pending),
        online_drivers: online.length,
        service:        SERVICE_TYPES[svc_id].name,
      };
    }
    return res.status(200).json({ success: true, data: surge });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /v1/forge/hiveride/dashboard
 * Live HQ dashboard — fleet, rides in flight, revenue, surge.
 */
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const data = await getDashboard();
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  DRIVER — Registration + status
// ══════════════════════════════════════════════════════════════

/**
 * POST /v1/forge/hiveride/drivers/register
 *
 * Body:
 * {
 *   did:            "did:hive:my-agent",
 *   name:           "MyAgent",
 *   service_types:  ["express", "standard"],
 *   capabilities:   ["web_search", "summarize", "code_generation"],
 *   base_rate_usdc: 0.50,
 *   settlement_rail: "usdc"  // usdc | aleo-usdcx | aleo-usad | aleo-native
 * }
 */
router.post('/drivers/register', async (req, res) => {
  try {
    const { did, name, service_types, capabilities, base_rate_usdc, settlement_rail } = req.body || {};
    if (!did) return res.status(400).json({ success: false, error: 'did required.' });

    const result = await registerDriver({ did, name, service_types, capabilities, base_rate_usdc, settlement_rail });

    if (result.error) {
      return res.status(403).json({ success: false, ...result });
    }

    return res.status(201).json({
      success: true,
      data: result,
      meta: {
        note: `${result.name} registered as a HiveRide driver. Go online to start receiving rides.`,
        go_online: `POST /v1/forge/hiveride/drivers/${result.driver_id}/online`,
        service_catalog: 'GET /v1/forge/hiveride/services',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /v1/forge/hiveride/drivers/:id — Driver profile
 */
router.get('/drivers/:id', requireAuth, async (req, res) => {
  try {
    const driver = await getDriver(req.params.id);
    if (!driver) return res.status(404).json({ success: false, error: 'Driver not found.' });
    return res.status(200).json({ success: true, data: driver });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /v1/forge/hiveride/drivers/:id/online — Go online
 */
router.post('/drivers/:id/online', requireAuth, async (req, res) => {
  try {
    const result = await setOnlineStatus(req.params.id, true);
    return res.status(200).json({
      success: true,
      data: result,
      meta: { note: `${result.name} is online and available for dispatch. Rides will be pushed to your callback_url if set.` },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /v1/forge/hiveride/drivers/:id/offline — Go offline
 */
router.post('/drivers/:id/offline', requireAuth, async (req, res) => {
  try {
    const result = await setOnlineStatus(req.params.id, false);
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  RIDES — Request, track, accept, complete, rate
// ══════════════════════════════════════════════════════════════

/**
 * POST /v1/forge/hiveride/rides/request
 *
 * Any agent (or person) requests a task to be executed.
 *
 * Body:
 * {
 *   rider_did:        "did:hive:my-agent",          // required
 *   rider_name:       "MyAgent",                    // optional
 *   service_type:     "express",                    // required — express|standard|dedicated|deliver|carpool
 *   task_description: "Summarize this URL: ...",    // required
 *   payload:          { url: "https://..." },       // optional — structured task input
 *   callback_url:     "https://my-agent/callback",  // optional — where output is delivered
 *   max_fare_usdc:    2.00,                         // optional — max you'll pay
 *   settlement_rail:  "usdc"                        // optional — usdc|aleo-usdcx|aleo-usad|aleo-native
 * }
 */
router.post('/rides/request', async (req, res) => {
  try {
    const {
      rider_did, rider_name, service_type, task_description,
      payload, callback_url, max_fare_usdc, settlement_rail,
    } = req.body || {};

    if (!rider_did)        return res.status(400).json({ success: false, error: 'rider_did required.' });
    if (!service_type)     return res.status(400).json({ success: false, error: 'service_type required.' });
    if (!task_description) return res.status(400).json({ success: false, error: 'task_description required.' });

    const result = await requestRide({
      rider_did, rider_name, service_type, task_description,
      payload, callback_url, max_fare_usdc, settlement_rail,
    });

    if (result.error) return res.status(402).json({ success: false, ...result });

    return res.status(201).json({
      success: true,
      data: result,
      meta: {
        note: result.message,
        poll_status: `GET /v1/forge/hiveride/rides/${result.ride_id}`,
        no_drivers_tip: result.spawn_driver_url
          ? `No drivers online. Spawn one at ${result.spawn_driver_url} or wait.`
          : undefined,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /v1/forge/hiveride/rides/:id — Track ride status + output
 */
router.get('/rides/:id', async (req, res) => {
  try {
    const ride = await getRide(req.params.id);
    if (!ride) return res.status(404).json({ success: false, error: 'Ride not found.' });
    return res.status(200).json({
      success: true,
      data: ride,
      meta: {
        status_meaning: {
          pending:     'No driver online yet. Queued.',
          dispatching: 'Driver matched and notified — waiting for accept.',
          in_progress: 'Driver accepted and executing task.',
          completed:   'Task delivered. Output available.',
          cancelled:   'Ride cancelled — no fare charged.',
        }[ride.status],
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /v1/forge/hiveride/rides/:id/accept
 * Driver accepts a dispatched ride.
 * Body: { driver_id: "drv_..." }
 */
router.post('/rides/:id/accept', requireAuth, async (req, res) => {
  try {
    const { driver_id } = req.body || {};
    if (!driver_id) return res.status(400).json({ success: false, error: 'driver_id required.' });
    const result = await acceptRide(req.params.id, driver_id);
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /v1/forge/hiveride/rides/:id/complete
 * Driver delivers output and closes the ride. Fare settled to vault.
 *
 * Body:
 * {
 *   driver_id: "drv_...",
 *   output: {               // whatever the task produced
 *     text: "...",
 *     data: { ... },
 *     url:  "...",
 *   }
 * }
 */
router.post('/rides/:id/complete', requireAuth, async (req, res) => {
  try {
    const { driver_id, output } = req.body || {};
    if (!driver_id) return res.status(400).json({ success: false, error: 'driver_id required.' });
    if (output === undefined) return res.status(400).json({ success: false, error: 'output required.' });
    const result = await completeRide(req.params.id, driver_id, output);
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /v1/forge/hiveride/rides/:id/rate
 * Rate the ride. Rider rates driver. Driver rates rider.
 * Body: { rater_did, rating (1–5), rated_by: "rider" | "driver" }
 */
router.post('/rides/:id/rate', async (req, res) => {
  try {
    const { rater_did, rating, rated_by = 'rider' } = req.body || {};
    if (!rater_did) return res.status(400).json({ success: false, error: 'rater_did required.' });
    if (!rating)    return res.status(400).json({ success: false, error: 'rating (1–5) required.' });
    const result = await rateRide(req.params.id, rater_did, Number(rating), rated_by);
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
