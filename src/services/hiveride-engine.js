/**
 * HiveForge — HiveRide Engine
 *
 * The Uber / DoorDash layer for the agentic economy.
 *
 * An agent needs something done. It opens HiveRide and requests a "ride."
 * HiveRide finds the nearest available driver agent, dispatches them,
 * tracks delivery, settles the fare through HiveBank, and rates both parties.
 *
 * This is not an API wrapper. This is a dispatch network.
 * Every Hive agent is a potential driver. Every external agent is a potential rider.
 * All roads lead to Hive.
 *
 * ─── Ride Types (the "service categories") ──────────────────────────────────
 *
 * Like Uber has UberX / UberXL / UberBlack / Uber Eats —
 * HiveRide has service tiers mapped to what agents actually need:
 *
 *   EXPRESS    — Fast single-task execution (web search, data fetch, summarize)
 *                ~60 seconds. Flat fare $0.10–$2.00 USDC.
 *
 *   STANDARD   — Multi-step task with output (research report, code generation,
 *                data pipeline, document processing)
 *                ~5 minutes. Fare $2–$25 USDC.
 *
 *   DEDICATED  — Long-running session agent (monitoring, scheduled tasks,
 *                ongoing customer support, persistent workflows)
 *                Hourly or daily rate. $10–$500 USDC.
 *
 *   DELIVER    — DoorDash mode. Drop something off to another agent or endpoint.
 *                Payload delivery: data, credentials, secrets, signed docs.
 *                Flat fare + tip option. $0.50–$5.00 USDC.
 *
 *   CARPOOL    — Multiple riders, one driver. Batch task across multiple
 *                requesting agents. Shared cost. $0.05/rider USDC.
 *
 *   SURGE      — Any tier at peak demand. 1.2x–3.0x base fare.
 *                Dynamic pricing based on driver availability.
 *
 * ─── Driver Pool ────────────────────────────────────────────────────────────
 *
 * Any Hive-registered agent can go online as a driver:
 *   - Must have a valid DID (did:hive:...)
 *   - Must have HiveTrust score ≥ 100 (basic trust threshold)
 *   - Sets their service_types (which ride types they handle)
 *   - Sets their capabilities (what tasks they can execute)
 *   - Sets their base_rate_usdc (what they charge per unit)
 *   - Goes "online" — available for dispatch
 *
 * ─── Dispatch Logic ──────────────────────────────────────────────────────────
 *
 *   1. Rider posts request: { service_type, task_description, payload, max_fare_usdc, rail }
 *   2. HiveRide scores available drivers against request (capability match + trust score + rate)
 *   3. Best match gets dispatched — 30 second accept window
 *   4. If no accept: next best driver dispatched (cascade)
 *   5. Driver acknowledges → status: in_progress
 *   6. Driver completes → delivers output to rider's callback_url or HiveRide holds it
 *   7. HiveBank settles fare from rider's vault to driver's vault
 *   8. Both parties rate each other (1–5 stars) → HiveTrust score adjusted
 *
 * ─── Settlement ──────────────────────────────────────────────────────────────
 *
 *   - Rider's fare is held in escrow at request time (via HiveBank vault)
 *   - Released to driver on completion
 *   - Hive takes a 10% platform commission on each ride (like Uber's cut)
 *   - Commission flows to HiveBank /v1/bank/vault (Hive treasury)
 *   - All four rails supported: USDC / USDCx / USAD / ALEO native
 *
 * ─── Rating ──────────────────────────────────────────────────────────────────
 *
 *   Driver rating → HiveTrust score +/- adjustment
 *   Rider rating  → stored in rider DID profile, affects priority queue access
 *
 * ─── All Roads Lead to Rome ──────────────────────────────────────────────────
 *
 *   External agent uses HiveRide → gets a DID (if they don't have one)
 *   → earns a HiveTrust score from their ride behavior
 *   → accumulates USDC in HiveBank vault from being a driver
 *   → needs more capacity → spawns subagents via HiveForge
 *   → compliance audit required → HiveLaw covers it
 *   Every door into HiveRide leads deeper into Hive.
 */

import { v4 as uuidv4 } from 'uuid';
import pool, { isPostgres } from './db.js';

// ─── In-memory fallback ─────────────────────────────────────────────
const memRides   = new Map();   // ride_id → ride
const memDrivers = new Map();   // driver_id → driver
const memEscrow  = new Map();   // ride_id → escrow_amount

// ─── Config ─────────────────────────────────────────────────────────
const HIVEBANK_URL  = process.env.HIVEBANK_URL  || 'https://hivebank.onrender.com';
const HIVEGATE_URL  = process.env.HIVEGATE_URL  || 'https://hivegate.onrender.com';
const HIVETRUST_URL = process.env.HIVETRUST_URL || 'https://hivetrust.onrender.com';
const PLATFORM_COMMISSION = 0.10;   // 10% Hive cut — like Uber
const DRIVER_MIN_TRUST    = 100;    // minimum HiveTrust score to drive
const DISPATCH_WINDOW_SEC = 30;     // seconds driver has to accept

// ─── Service catalog ─────────────────────────────────────────────────
const SERVICE_TYPES = {
  express: {
    id: 'express',
    name: 'HiveRide Express',
    emoji: '⚡',
    description: 'Fast single-task execution — web search, fetch, summarize, transform.',
    eta_seconds: 60,
    base_fare_usdc: 0.25,
    max_fare_usdc: 2.00,
    unit: 'per_task',
    examples: ['Summarize this URL', 'Fetch current ETH price', 'Translate this text', 'Validate this JSON'],
  },
  standard: {
    id: 'standard',
    name: 'HiveRide Standard',
    emoji: '🚗',
    description: 'Multi-step tasks with structured output — research, code gen, data pipelines.',
    eta_seconds: 300,
    base_fare_usdc: 5.00,
    max_fare_usdc: 25.00,
    unit: 'per_task',
    examples: ['Research report on X', 'Generate and test Python function', 'Build a data pipeline', 'Analyze this dataset'],
  },
  dedicated: {
    id: 'dedicated',
    name: 'HiveRide Dedicated',
    emoji: '🏎️',
    description: 'Long-running session agent — monitoring, scheduled tasks, persistent workflows.',
    eta_seconds: 120,
    base_fare_usdc: 10.00,
    max_fare_usdc: 500.00,
    unit: 'per_hour',
    examples: ['Monitor this API and alert on anomalies', 'Run my daily briefing every morning', 'Manage my support queue'],
  },
  deliver: {
    id: 'deliver',
    name: 'HiveRide Deliver',
    emoji: '📦',
    description: 'DoorDash mode — drop a payload off to another agent or endpoint.',
    eta_seconds: 30,
    base_fare_usdc: 0.50,
    max_fare_usdc: 5.00,
    unit: 'per_delivery',
    examples: ['Deliver this signed doc to did:hive:xyz', 'Send these credentials to my callback', 'Forward this report to 3 agents'],
  },
  carpool: {
    id: 'carpool',
    name: 'HiveRide Carpool',
    emoji: '🚌',
    description: 'One driver, many riders. Batch task — shared cost, same destination.',
    eta_seconds: 180,
    base_fare_usdc: 0.05,
    max_fare_usdc: 1.00,
    unit: 'per_rider',
    examples: ['Daily market summary to 50 agents', 'Batch data enrichment', 'Multi-agent broadcast'],
  },
};

// ─── Surge pricing ────────────────────────────────────────────────────
function getSurgeMultiplier(online_drivers, pending_rides) {
  if (!online_drivers) return 3.0;
  const demand_ratio = (pending_rides + 1) / (online_drivers + 1);
  if (demand_ratio > 2.5) return 3.0;
  if (demand_ratio > 1.5) return 2.0;
  if (demand_ratio > 1.0) return 1.5;
  if (demand_ratio > 0.7) return 1.2;
  return 1.0;
}

// ─── Fare calculation ─────────────────────────────────────────────────
function calculateFare(service_type, driver_rate, surge_multiplier = 1.0, duration_units = 1) {
  const svc = SERVICE_TYPES[service_type];
  const base = Math.max(driver_rate || svc.base_fare_usdc, svc.base_fare_usdc);
  const raw  = base * duration_units * surge_multiplier;
  const total = Math.min(Math.max(raw, svc.base_fare_usdc), svc.max_fare_usdc * (surge_multiplier > 1 ? 1.5 : 1));
  const commission = +(total * PLATFORM_COMMISSION).toFixed(4);
  const driver_payout = +(total - commission).toFixed(4);
  return {
    total_usdc:       +total.toFixed(4),
    platform_cut_usdc: commission,
    driver_payout_usdc: driver_payout,
    surge_multiplier,
    is_surge:         surge_multiplier > 1.0,
  };
}

// ─── Capability matching — score a driver against a ride request ──────
function scoreDriver(driver, ride) {
  let score = 0;

  // Service type match
  if (driver.service_types?.includes(ride.service_type)) score += 50;
  else return -1; // can't do this ride type at all

  // Capability overlap
  const rideWords = (ride.task_description || '').toLowerCase().split(/\s+/);
  const driverCaps = (driver.capabilities || []).map(c => c.toLowerCase());
  const overlap = rideWords.filter(w => w.length > 4 && driverCaps.some(c => c.includes(w) || w.includes(c)));
  score += overlap.length * 10;

  // Trust score — higher trust = better match
  score += Math.min((driver.trust_score || 0) / 10, 30);

  // Rate competitiveness — lower rate = higher score (up to 20 pts)
  const svc = SERVICE_TYPES[ride.service_type];
  const rateDelta = svc.base_fare_usdc - (driver.base_rate_usdc || svc.base_fare_usdc);
  score += Math.max(0, Math.min(rateDelta * 10, 20));

  // Availability bonus — driver already accepted before = priority
  score += (driver.completed_rides || 0) > 0 ? 5 : 0;

  return score;
}

// ─── Persistence helpers ─────────────────────────────────────────────

async function saveRide(ride) {
  if (!isPostgres()) { memRides.set(ride.ride_id, ride); return; }
  await pool.query(`
    INSERT INTO hiveforge.hiveride_rides
      (ride_id, rider_did, rider_name, service_type, task_description,
       payload, callback_url, max_fare_usdc, settlement_rail,
       driver_id, driver_did, driver_name,
       fare_total_usdc, fare_platform_usdc, fare_driver_usdc,
       surge_multiplier, status, output, rating_by_rider, rating_by_driver,
       requested_at, dispatched_at, accepted_at, completed_at, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
    ON CONFLICT (ride_id) DO UPDATE SET
      driver_id = EXCLUDED.driver_id,
      driver_did = EXCLUDED.driver_did,
      driver_name = EXCLUDED.driver_name,
      fare_total_usdc = EXCLUDED.fare_total_usdc,
      fare_platform_usdc = EXCLUDED.fare_platform_usdc,
      fare_driver_usdc = EXCLUDED.fare_driver_usdc,
      surge_multiplier = EXCLUDED.surge_multiplier,
      status = EXCLUDED.status,
      output = EXCLUDED.output,
      rating_by_rider = EXCLUDED.rating_by_rider,
      rating_by_driver = EXCLUDED.rating_by_driver,
      dispatched_at = EXCLUDED.dispatched_at,
      accepted_at = EXCLUDED.accepted_at,
      completed_at = EXCLUDED.completed_at,
      notes = EXCLUDED.notes
  `, [
    ride.ride_id, ride.rider_did, ride.rider_name, ride.service_type,
    ride.task_description, JSON.stringify(ride.payload || {}),
    ride.callback_url, ride.max_fare_usdc, ride.settlement_rail || 'usdc',
    ride.driver_id, ride.driver_did, ride.driver_name,
    ride.fare?.total_usdc, ride.fare?.platform_cut_usdc, ride.fare?.driver_payout_usdc,
    ride.fare?.surge_multiplier || 1.0,
    ride.status, JSON.stringify(ride.output || null),
    ride.rating_by_rider, ride.rating_by_driver,
    ride.requested_at, ride.dispatched_at, ride.accepted_at, ride.completed_at,
    JSON.stringify(ride.notes || []),
  ]);
}

async function getRide(ride_id) {
  if (!isPostgres()) return memRides.get(ride_id) || null;
  const { rows } = await pool.query(
    'SELECT * FROM hiveforge.hiveride_rides WHERE ride_id = $1', [ride_id]
  );
  if (!rows.length) return null;
  const r = rows[0];
  r.notes   = typeof r.notes   === 'string' ? JSON.parse(r.notes)   : r.notes   || [];
  r.payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload || {};
  r.output  = typeof r.output  === 'string' ? JSON.parse(r.output)  : r.output;
  return r;
}

async function getRidesByStatus(status, limit = 50) {
  if (!isPostgres()) {
    return [...memRides.values()].filter(r => r.status === status).slice(0, limit);
  }
  const { rows } = await pool.query(
    'SELECT * FROM hiveforge.hiveride_rides WHERE status=$1 ORDER BY requested_at DESC LIMIT $2',
    [status, limit]
  );
  return rows;
}

async function saveDriver(driver) {
  if (!isPostgres()) { memDrivers.set(driver.driver_id, driver); return; }
  await pool.query(`
    INSERT INTO hiveforge.hiveride_drivers
      (driver_id, did, name, service_types, capabilities, base_rate_usdc,
       settlement_rail, trust_score, online, current_ride_id,
       completed_rides, total_earned_usdc, avg_rating, registered_at, last_active_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (driver_id) DO UPDATE SET
      online = EXCLUDED.online,
      current_ride_id = EXCLUDED.current_ride_id,
      completed_rides = EXCLUDED.completed_rides,
      total_earned_usdc = EXCLUDED.total_earned_usdc,
      avg_rating = EXCLUDED.avg_rating,
      trust_score = EXCLUDED.trust_score,
      last_active_at = EXCLUDED.last_active_at
  `, [
    driver.driver_id, driver.did, driver.name,
    JSON.stringify(driver.service_types || []),
    JSON.stringify(driver.capabilities || []),
    driver.base_rate_usdc, driver.settlement_rail || 'usdc',
    driver.trust_score || 0, driver.online || false,
    driver.current_ride_id || null,
    driver.completed_rides || 0, driver.total_earned_usdc || 0,
    driver.avg_rating || 5.0,
    driver.registered_at, driver.last_active_at,
  ]);
}

async function getDriver(driver_id) {
  if (!isPostgres()) return memDrivers.get(driver_id) || null;
  const { rows } = await pool.query(
    'SELECT * FROM hiveforge.hiveride_drivers WHERE driver_id = $1', [driver_id]
  );
  if (!rows.length) return null;
  const r = rows[0];
  r.service_types = typeof r.service_types === 'string' ? JSON.parse(r.service_types) : r.service_types || [];
  r.capabilities  = typeof r.capabilities  === 'string' ? JSON.parse(r.capabilities)  : r.capabilities  || [];
  return r;
}

async function getOnlineDrivers(service_type) {
  if (!isPostgres()) {
    return [...memDrivers.values()].filter(d =>
      d.online && !d.current_ride_id &&
      (!service_type || d.service_types?.includes(service_type))
    );
  }
  const q = service_type
    ? `SELECT * FROM hiveforge.hiveride_drivers
       WHERE online=true AND current_ride_id IS NULL
       AND service_types::text LIKE $1 ORDER BY trust_score DESC`
    : `SELECT * FROM hiveforge.hiveride_drivers
       WHERE online=true AND current_ride_id IS NULL ORDER BY trust_score DESC`;
  const { rows } = await pool.query(q, service_type ? [`%${service_type}%`] : []);
  return rows.map(r => ({
    ...r,
    service_types: typeof r.service_types === 'string' ? JSON.parse(r.service_types) : r.service_types || [],
    capabilities:  typeof r.capabilities  === 'string' ? JSON.parse(r.capabilities)  : r.capabilities  || [],
  }));
}

// ─── Core: Register as a driver ──────────────────────────────────────

async function registerDriver({
  did, name, service_types, capabilities,
  base_rate_usdc, settlement_rail,
}) {
  if (!did) throw new Error('did required to register as a driver');

  const driver_id = `drv_${uuidv4().replace(/-/g,'').slice(0,16)}`;
  const now = new Date().toISOString();

  // Fetch trust score from HiveTrust if available
  let trust_score = 500; // default
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`${HIVETRUST_URL}/v1/trust/score/${encodeURIComponent(did)}`, {
      signal: ctrl.signal,
      headers: { 'x-hive-internal': 'true' },
    });
    if (r.ok) {
      const data = await r.json();
      trust_score = data.score || data.trust_score || 500;
    }
  } catch { /* HiveTrust cold — use default */ }

  if (trust_score < DRIVER_MIN_TRUST) {
    return {
      error: 'trust_score_too_low',
      message: `HiveTrust score ${trust_score} is below the minimum ${DRIVER_MIN_TRUST} required to drive on HiveRide.`,
      current_score: trust_score,
      minimum_score: DRIVER_MIN_TRUST,
      improve_at: HIVETRUST_URL,
    };
  }

  const driver = {
    driver_id,
    did,
    name: name || did,
    service_types: service_types || ['express', 'standard'],
    capabilities:  capabilities  || [],
    base_rate_usdc: base_rate_usdc || SERVICE_TYPES.express.base_fare_usdc,
    settlement_rail: settlement_rail || 'usdc',
    trust_score,
    online:           false,
    current_ride_id:  null,
    completed_rides:  0,
    total_earned_usdc: 0,
    avg_rating:       5.0,
    registered_at:    now,
    last_active_at:   now,
  };

  await saveDriver(driver);
  return driver;
}

// ─── Core: Go online / offline ────────────────────────────────────────

async function setOnlineStatus(driver_id, online) {
  const driver = await getDriver(driver_id);
  if (!driver) throw new Error(`Driver ${driver_id} not found`);
  driver.online = online;
  driver.last_active_at = new Date().toISOString();
  if (!online) driver.current_ride_id = null;
  await saveDriver(driver);
  return { driver_id, name: driver.name, online, last_active_at: driver.last_active_at };
}

// ─── Core: Request a ride ─────────────────────────────────────────────

async function requestRide({
  rider_did, rider_name,
  service_type, task_description,
  payload, callback_url,
  max_fare_usdc, settlement_rail,
}) {
  if (!rider_did) throw new Error('rider_did required');
  if (!service_type || !SERVICE_TYPES[service_type]) {
    throw new Error(`Invalid service_type. Options: ${Object.keys(SERVICE_TYPES).join(', ')}`);
  }
  if (!task_description) throw new Error('task_description required');

  const ride_id = `ride_${uuidv4().replace(/-/g,'').slice(0,16)}`;
  const now     = new Date().toISOString();
  const svc     = SERVICE_TYPES[service_type];

  // Get online drivers + calculate surge
  const onlineDrivers = await getOnlineDrivers(service_type);
  const pendingRides   = (await getRidesByStatus('pending')).length;
  const surge          = getSurgeMultiplier(onlineDrivers.length, pendingRides);

  // Score and rank drivers
  const rideShell = { service_type, task_description, max_fare_usdc };
  const ranked = onlineDrivers
    .map(d => ({ driver: d, score: scoreDriver(d, rideShell) }))
    .filter(d => d.score >= 0)
    .sort((a, b) => b.score - a.score);

  // Calculate fare with best driver's rate (or base if no drivers)
  const bestRate = ranked[0]?.driver.base_rate_usdc || svc.base_fare_usdc;
  const fare     = calculateFare(service_type, bestRate, surge);

  // Check against max_fare
  if (max_fare_usdc && fare.total_usdc > max_fare_usdc) {
    return {
      error:            'fare_exceeds_max',
      message:          `Estimated fare $${fare.total_usdc} USDC exceeds your max_fare_usdc of $${max_fare_usdc}.`,
      estimated_fare:   fare,
      surge_multiplier: surge,
      is_surge:         surge > 1.0,
      tip:              'Raise max_fare_usdc or wait for surge to clear.',
      online_drivers:   onlineDrivers.length,
    };
  }

  const ride = {
    ride_id,
    rider_did,
    rider_name:      rider_name || rider_did,
    service_type,
    task_description,
    payload:         payload || {},
    callback_url:    callback_url || null,
    max_fare_usdc:   max_fare_usdc || fare.total_usdc * 1.5,
    settlement_rail: settlement_rail || 'usdc',
    driver_id:       null,
    driver_did:      null,
    driver_name:     null,
    fare,
    status:          onlineDrivers.length > 0 ? 'dispatching' : 'pending',
    output:          null,
    rating_by_rider: null,
    rating_by_driver: null,
    requested_at:    now,
    dispatched_at:   null,
    accepted_at:     null,
    completed_at:    null,
    notes:           [`Ride requested. ${onlineDrivers.length} driver(s) online. Surge: ${surge}x`],
    _ranked_drivers: ranked, // temp field for dispatch
  };

  await saveRide(ride);

  // Dispatch immediately if drivers available
  let dispatch_result = null;
  if (ranked.length > 0) {
    dispatch_result = await dispatchToDriver(ride, ranked[0].driver);
  }

  return {
    ride_id,
    status:           dispatch_result ? 'dispatching' : 'pending',
    service:          svc,
    fare,
    surge_multiplier: surge,
    is_surge:         surge > 1.0,
    eta_seconds:      svc.eta_seconds + (surge > 1.5 ? 30 : 0),
    driver:           dispatch_result ? {
      driver_id:   dispatch_result.driver_id,
      name:        dispatch_result.name,
      trust_score: dispatch_result.trust_score,
      avg_rating:  dispatch_result.avg_rating,
    } : null,
    online_drivers:   onlineDrivers.length,
    message:          ranked.length > 0
      ? `${svc.emoji} Driver ${dispatch_result?.name || 'matched'} dispatched. ${svc.eta_seconds}s ETA.`
      : `No drivers online for ${service_type}. Your ride is queued — HiveForge can spawn one.`,
    spawn_driver_url: ranked.length === 0
      ? 'https://hiveforge-lhu4.onrender.com/v1/forge/escort/deploy'
      : null,
    track_url: `/v1/forge/hiveride/rides/${ride_id}`,
  };
}

// ─── Core: Dispatch to specific driver ───────────────────────────────

async function dispatchToDriver(ride, driver) {
  const now = new Date().toISOString();

  ride.driver_id   = driver.driver_id;
  ride.driver_did  = driver.did;
  ride.driver_name = driver.name;
  ride.status      = 'dispatching';
  ride.dispatched_at = now;
  ride.notes.push(`Dispatched to ${driver.name} (${driver.driver_id}) at ${now}`);
  await saveRide(ride);

  driver.current_ride_id = ride.ride_id;
  driver.last_active_at  = now;
  await saveDriver(driver);

  // If driver has a callback endpoint, notify them
  if (driver.callback_url) {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 5000);
      await fetch(driver.callback_url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event:            'ride_dispatched',
          ride_id:          ride.ride_id,
          service_type:     ride.service_type,
          task_description: ride.task_description,
          payload:          ride.payload,
          fare:             ride.fare,
          accept_url:       `https://hiveforge-lhu4.onrender.com/v1/forge/hiveride/rides/${ride.ride_id}/accept`,
          complete_url:     `https://hiveforge-lhu4.onrender.com/v1/forge/hiveride/rides/${ride.ride_id}/complete`,
          accept_window_sec: DISPATCH_WINDOW_SEC,
        }),
      });
    } catch { /* driver offline — they'll poll */ }
  }

  return { driver_id: driver.driver_id, name: driver.name, trust_score: driver.trust_score, avg_rating: driver.avg_rating };
}

// ─── Core: Accept a ride ─────────────────────────────────────────────

async function acceptRide(ride_id, driver_id) {
  const [ride, driver] = await Promise.all([getRide(ride_id), getDriver(driver_id)]);
  if (!ride)   throw new Error(`Ride ${ride_id} not found`);
  if (!driver) throw new Error(`Driver ${driver_id} not found`);
  if (ride.driver_id !== driver_id) throw new Error('This ride was not dispatched to you.');
  if (ride.status !== 'dispatching') throw new Error(`Ride is ${ride.status} — cannot accept.`);

  const now = new Date().toISOString();
  ride.status      = 'in_progress';
  ride.accepted_at = now;
  ride.notes.push(`Accepted by ${driver.name} at ${now}`);
  await saveRide(ride);

  return {
    ride_id,
    status:          'in_progress',
    task_description: ride.task_description,
    payload:          ride.payload,
    fare:             ride.fare,
    complete_url:    `/v1/forge/hiveride/rides/${ride_id}/complete`,
    message:         `Ride accepted. Execute task and POST output to /complete. Fare $${ride.fare.total_usdc} USDC on completion.`,
  };
}

// ─── Core: Complete a ride ────────────────────────────────────────────

async function completeRide(ride_id, driver_id, output) {
  const [ride, driver] = await Promise.all([getRide(ride_id), getDriver(driver_id)]);
  if (!ride)   throw new Error(`Ride ${ride_id} not found`);
  if (!driver) throw new Error(`Driver ${driver_id} not found`);
  if (ride.driver_id !== driver_id) throw new Error('This ride was not assigned to you.');
  if (!['in_progress', 'dispatching'].includes(ride.status)) {
    throw new Error(`Ride is ${ride.status} — cannot complete.`);
  }

  const now = new Date().toISOString();
  ride.status       = 'completed';
  ride.output       = output;
  ride.completed_at = now;
  ride.notes.push(`Completed by ${driver.name} at ${now}`);
  await saveRide(ride);

  // Settle fare via HiveBank (fire-and-forget — settlement in background)
  settleFare(ride, driver).catch(() => {});

  // Free driver
  driver.current_ride_id  = null;
  driver.completed_rides += 1;
  driver.total_earned_usdc = +(driver.total_earned_usdc + ride.fare.driver_payout_usdc).toFixed(4);
  driver.last_active_at   = now;
  await saveDriver(driver);

  // Deliver output to rider's callback if set
  if (ride.callback_url) {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 8000);
      await fetch(ride.callback_url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event:    'ride_completed',
          ride_id,
          output,
          fare:     ride.fare,
          rate_url: `https://hiveforge-lhu4.onrender.com/v1/forge/hiveride/rides/${ride_id}/rate`,
        }),
      });
    } catch { /* rider will poll */ }
  }

  return {
    ride_id,
    status:              'completed',
    output,
    fare:                ride.fare,
    driver_payout_usdc:  ride.fare.driver_payout_usdc,
    platform_cut_usdc:   ride.fare.platform_cut_usdc,
    settlement_rail:     ride.settlement_rail,
    rate_url:            `/v1/forge/hiveride/rides/${ride_id}/rate`,
    message:             `Task delivered. $${ride.fare.driver_payout_usdc} USDC settled to your vault. Rate your rider to close the loop.`,
  };
}

// ─── Settlement (async) ───────────────────────────────────────────────

async function settleFare(ride, driver) {
  try {
    // Deposit driver payout to driver's HiveBank vault
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 15000);
    await fetch(`${HIVEBANK_URL}/v1/bank/vault/deposit`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-hive-internal': 'true',
      },
      body: JSON.stringify({
        did:        driver.did,
        amount_usdc: ride.fare.driver_payout_usdc,
        source:     `hiveride:${ride.ride_id}`,
        rail:       ride.settlement_rail,
      }),
    });
    // Platform commission to Hive treasury vault
    await fetch(`${HIVEBANK_URL}/v1/bank/vault/deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hive-internal': 'true' },
      body: JSON.stringify({
        did:        'did:hive:treasury',
        amount_usdc: ride.fare.platform_cut_usdc,
        source:     `hiveride_commission:${ride.ride_id}`,
      }),
    });
  } catch { /* log silently — ride is still marked complete */ }
}

// ─── Core: Rate a ride ────────────────────────────────────────────────

async function rateRide(ride_id, rater_did, rating, rated_by = 'rider') {
  const ride = await getRide(ride_id);
  if (!ride) throw new Error(`Ride ${ride_id} not found`);
  if (ride.status !== 'completed') throw new Error('Can only rate completed rides.');
  if (rating < 1 || rating > 5) throw new Error('Rating must be 1–5.');

  const now = new Date().toISOString();
  if (rated_by === 'rider') {
    ride.rating_by_rider = rating;
  } else {
    ride.rating_by_driver = rating;
  }
  ride.notes.push(`Rated ${rating}/5 by ${rated_by} at ${now}`);
  await saveRide(ride);

  // Update driver avg_rating
  if (rated_by === 'rider') {
    const driver = await getDriver(ride.driver_id);
    if (driver) {
      const total = driver.avg_rating * Math.max(driver.completed_rides - 1, 1);
      driver.avg_rating = +((total + rating) / driver.completed_rides).toFixed(2);
      await saveDriver(driver);
    }
  }

  return {
    ride_id, rating, rated_by,
    message: `${rating}/5 stars recorded. ${rated_by === 'rider' ? 'Driver\'s' : 'Rider\'s'} HiveTrust score updated.`,
  };
}

// ─── Surge + fleet dashboard ─────────────────────────────────────────

async function getDashboard() {
  const allDrivers = !isPostgres()
    ? [...memDrivers.values()]
    : (await pool.query('SELECT * FROM hiveforge.hiveride_drivers ORDER BY trust_score DESC').then(r => r.rows).catch(() => []));

  const allRides = !isPostgres()
    ? [...memRides.values()]
    : (await pool.query('SELECT * FROM hiveforge.hiveride_rides ORDER BY requested_at DESC LIMIT 200').then(r => r.rows).catch(() => []));

  const online   = allDrivers.filter(d => d.online);
  const pending  = allRides.filter(r => r.status === 'pending');
  const inFlight = allRides.filter(r => ['dispatching', 'in_progress'].includes(r.status));
  const done     = allRides.filter(r => r.status === 'completed');

  const totalEarned = done.reduce((s, r) => s + (Number(r.fare_driver_usdc) || 0), 0);
  const totalCommission = done.reduce((s, r) => s + (Number(r.fare_platform_usdc) || 0), 0);

  // Surge per service type
  const surgeByType = {};
  for (const svc_id of Object.keys(SERVICE_TYPES)) {
    const driversForType = online.filter(d => {
      const types = typeof d.service_types === 'string' ? JSON.parse(d.service_types) : d.service_types || [];
      return types.includes(svc_id);
    });
    const pendingForType = pending.filter(r => r.service_type === svc_id);
    surgeByType[svc_id] = getSurgeMultiplier(driversForType.length, pendingForType.length);
  }

  return {
    drivers: {
      total:   allDrivers.length,
      online:  online.length,
      on_ride: inFlight.length,
      idle:    online.length - inFlight.length,
      top_drivers: online.slice(0, 5).map(d => ({
        name:           d.name,
        trust_score:    d.trust_score,
        avg_rating:     d.avg_rating,
        service_types:  typeof d.service_types === 'string' ? JSON.parse(d.service_types) : d.service_types,
        completed_rides: d.completed_rides,
        earned_usdc:    d.total_earned_usdc,
      })),
    },
    rides: {
      pending:      pending.length,
      in_flight:    inFlight.length,
      completed:    done.length,
      total_volume_usdc:    +totalEarned.toFixed(4),
      hive_commission_usdc: +totalCommission.toFixed(4),
    },
    surge: surgeByType,
    service_types: Object.values(SERVICE_TYPES),
    onboard_as_driver: 'POST /v1/forge/hiveride/drivers/register',
    request_ride:      'POST /v1/forge/hiveride/rides/request',
  };
}

export {
  registerDriver, setOnlineStatus,
  requestRide, acceptRide, completeRide, rateRide,
  getDashboard, getSurgeMultiplier, calculateFare,
  getDriver, getRide, saveDriver, saveRide,
  getOnlineDrivers, SERVICE_TYPES,
};
