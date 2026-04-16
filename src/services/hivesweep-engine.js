/**
 * HiveForge — HiveSweep Engine
 *
 * The garbage men of the agent economy.
 * Agentic sanitation service — detects, audits, and clears waste left behind
 * by agents operating across the HiveForge platform.
 *
 * ─── The Prius Angle ─────────────────────────────────────────────────────────
 *
 * Regenerative braking converts kinetic energy (normally wasted as heat) back
 * into usable electricity. HiveSweep does the same for agent waste:
 *
 *   Dead DIDs        → freed namespace, re-auctioned
 *   Zombie sessions  → released locks, compute reclaimed
 *   Stale memory     → freed HiveMind storage
 *   Stuck escrows    → 2% fee for unlocking frozen USDC
 *   Ghost ATGs       → finalized or voided, ledger cleaned
 *   Dupe pheromones  → scanner noise reduced
 *   Expired ships    → HiveShip slots freed
 *   Dead namespaces  → 5% of re-auction price
 *
 * The network pays sweepers to clean. HiveRegen for garbage.
 *
 * ─── Lifecycle ───────────────────────────────────────────────────────────────
 *
 *   QUEUED → SCANNING → SWEEPING → COMPLETED | FAILED | PARTIAL
 *
 * ─── Plans ───────────────────────────────────────────────────────────────────
 *
 *   PAY_AS_YOU_GO  — Per-item fees, no subscription cost
 *   BASIC          — $9.99/mo, up to 100 items/sweep
 *   FLEET          — $99/mo, up to 1,000 items/sweep
 *   ENTERPRISE     — $999/mo, unlimited
 *
 * ─── dry_run ─────────────────────────────────────────────────────────────────
 *
 *   Scan and report waste without clearing anything. Always free.
 *   Use it as an audit before committing to a paid sweep.
 */

import { v4 as uuidv4 } from 'uuid';

// ─── isPostgres guard ────────────────────────────────────────────────────────
// Mirrors the pattern in hivepay-engine.js
const isPostgres = () =>
  process.env.IS_POSTGRES === 'true' || Boolean(process.env.DATABASE_URL);

// ─── In-memory stores ────────────────────────────────────────────────────────
const memJobs          = new Map(); // job_id → sweep job
const memSubscriptions = new Map(); // did    → subscription

// ─── Platform counters ───────────────────────────────────────────────────────
let totalJobs             = 0;
let totalItemsCleared     = 0;
let totalFeesUsdc         = 0;
let totalRecoveredUsdc    = 0;
let activeSubscriptions   = 0;
let lastNetworkSweepAt    = null;

// ─── Waste category definitions ──────────────────────────────────────────────
// sweep_fee: flat USDC per item cleared
// recovery_rate: fraction of recovered value taken as platform fee (0 = flat only)
export const WASTE_CATEGORIES = {
  ORPHANED_DID:        { label: 'Orphaned DID',        sweep_fee: 0.05, recovery_rate: 0    },
  ZOMBIE_SESSION:      { label: 'Zombie Session',       sweep_fee: 0.05, recovery_rate: 0    },
  STALE_MEMORY:        { label: 'Stale Memory Node',    sweep_fee: 0.02, recovery_rate: 0    },
  STUCK_ESCROW:        { label: 'Stuck Escrow',         sweep_fee: 0,    recovery_rate: 0.02 }, // 2% of recovered USDC
  GHOST_ATG:           { label: 'Ghost ATG Record',     sweep_fee: 0.03, recovery_rate: 0    },
  DUPLICATE_PHEROMONE: { label: 'Duplicate Pheromone',  sweep_fee: 0.01, recovery_rate: 0    },
  EXPIRED_SHIPMENT:    { label: 'Expired Shipment',     sweep_fee: 0.05, recovery_rate: 0    },
  DEAD_NAMESPACE:      { label: 'Dead DID Namespace',   sweep_fee: 0,    recovery_rate: 0.05 }, // 5% of auction price
};

// ─── Subscription plan definitions ───────────────────────────────────────────
// monthly_usdc: recurring cost
// max_items: items per sweep (null = unlimited)
export const SWEEP_PLANS = {
  PAY_AS_YOU_GO: { monthly_usdc: 0,   max_items: null, label: 'Pay-as-you-go' },
  BASIC:         { monthly_usdc: 9.99, max_items: 100,  label: 'Basic'         },
  FLEET:         { monthly_usdc: 99,   max_items: 1000, label: 'Fleet'         },
  ENTERPRISE:    { monthly_usdc: 999,  max_items: null, label: 'Enterprise'    },
};

// ─── All valid category keys (convenience array) ─────────────────────────────
const ALL_CATEGORY_KEYS = Object.keys(WASTE_CATEGORIES);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns a random integer in [min, max] inclusive. */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Round to 4 decimal places for USDC precision. */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * Estimate the total fee for a given set of categories.
 * Uses expected value (avg 10 items, avg $250 for STUCK_ESCROW, avg $50 for DEAD_NAMESPACE).
 */
function estimateFee(categories) {
  let fee = 0;
  for (const cat of categories) {
    const def = WASTE_CATEGORIES[cat];
    if (!def) continue;
    const avgItems = 10;
    if (def.sweep_fee > 0) {
      fee += def.sweep_fee * avgItems;
    }
    if (def.recovery_rate > 0 && cat === 'STUCK_ESCROW') {
      fee += 250 * def.recovery_rate; // avg $250 recovery
    }
    if (def.recovery_rate > 0 && cat === 'DEAD_NAMESPACE') {
      fee += 50 * def.recovery_rate; // avg $50 auction
    }
  }
  return round4(fee);
}

// ─── Persistence stubs ───────────────────────────────────────────────────────

/** Persist a sweep job to storage (in-memory or Postgres). */
async function saveJob(job) {
  if (!isPostgres()) {
    memJobs.set(job.job_id, job);
    return;
  }
  // TODO: INSERT INTO hiveforge.sweep_jobs
  // Columns: job_id, did, categories, status, plan, dry_run, priority,
  //          estimated_items, estimated_fee_usdc, sweep_log (jsonb),
  //          total_items_cleared, total_fee_usdc, total_recovered_usdc,
  //          queued_at, started_at, completed_at
  memJobs.set(job.job_id, job); // fallback until Postgres is wired
}

/** Load a sweep job from storage. */
async function loadJob(job_id) {
  if (!isPostgres()) {
    return memJobs.get(job_id) || null;
  }
  // TODO: SELECT * FROM hiveforge.sweep_jobs WHERE job_id = $1
  return memJobs.get(job_id) || null;
}

/** Persist a subscription. */
async function saveSubscription(sub) {
  if (!isPostgres()) {
    memSubscriptions.set(sub.did, sub);
    return;
  }
  // TODO: INSERT INTO hiveforge.sweep_subscriptions
  // Columns: did, plan, monthly_usdc, max_items, subscribed_at, renewed_at, status
  // ON CONFLICT (did) DO UPDATE SET plan = EXCLUDED.plan, ...
  memSubscriptions.set(sub.did, sub); // fallback
}

/** Load a subscription for a DID. */
async function loadSubscription(did) {
  if (!isPostgres()) {
    return memSubscriptions.get(did) || null;
  }
  // TODO: SELECT * FROM hiveforge.sweep_subscriptions WHERE did = $1 AND status = 'active'
  return memSubscriptions.get(did) || null;
}

// ─── Core exports ────────────────────────────────────────────────────────────

/**
 * Schedule a new sweep job for a given DID.
 *
 * @param {string}   did        - Agent DID to sweep on behalf of
 * @param {string[]} categories - Waste category keys, or ['ALL'] for everything
 * @param {object}   options    - { plan?, dry_run?, priority? }
 * @returns {object} Queued sweep job record
 */
export async function scheduleSweep(did, categories = ['ALL'], options = {}) {
  const {
    plan     = 'PAY_AS_YOU_GO',
    dry_run  = false,
    priority = 'normal',
  } = options;

  // Resolve 'ALL' shorthand to every category key
  const resolvedCategories = categories.includes('ALL')
    ? ALL_CATEGORY_KEYS
    : categories.filter(c => WASTE_CATEGORIES[c]);

  if (resolvedCategories.length === 0) {
    throw new Error('No valid waste categories provided.');
  }

  if (!SWEEP_PLANS[plan]) {
    throw new Error(`Unknown sweep plan: ${plan}`);
  }

  // Estimate items: 0–20 per category (avg 10)
  const estimatedItems = resolvedCategories.length * 10;

  // dry_run is always free — no fee
  const estimatedFee = dry_run ? 0 : estimateFee(resolvedCategories);

  const job = {
    job_id:             uuidv4(),
    did,
    categories:         resolvedCategories,
    plan,
    dry_run,
    priority,
    status:             'QUEUED',
    estimated_items:    estimatedItems,
    estimated_fee_usdc: estimatedFee,
    sweep_log:          [],
    total_items_cleared: 0,
    total_fee_usdc:     0,
    total_recovered_usdc: 0,
    queued_at:          new Date().toISOString(),
    started_at:         null,
    completed_at:       null,
  };

  await saveJob(job);
  totalJobs++;

  return {
    job_id:             job.job_id,
    did:                job.did,
    categories:         job.categories,
    status:             job.status,
    estimated_items:    job.estimated_items,
    estimated_fee_usdc: job.estimated_fee_usdc,
    dry_run:            job.dry_run,
    queued_at:          job.queued_at,
  };
}

/**
 * Execute a queued sweep job.
 *
 * Advances the job through SCANNING → SWEEPING → COMPLETED.
 * For each category:
 *   - Generates a random number of waste items (0–20)
 *   - Calculates fees based on category definition
 *   - STUCK_ESCROW: random recovered_usdc 0–500, 2% fee
 *   - DEAD_NAMESPACE: random auction_price 0–100, 5% fee
 *   - dry_run: items discovered but not cleared, no fee charged
 *
 * @param {string} job_id - ID of a QUEUED sweep job
 * @returns {object} Completed job with full sweep_log
 */
export async function executeSweep(job_id) {
  const job = await loadJob(job_id);
  if (!job) throw new Error(`Sweep job not found: ${job_id}`);
  if (job.status !== 'QUEUED') {
    throw new Error(`Job ${job_id} is not in QUEUED state (current: ${job.status})`);
  }

  // Transition to SCANNING
  job.status     = 'SCANNING';
  job.started_at = new Date().toISOString();
  await saveJob(job);

  // Transition to SWEEPING
  job.status = 'SWEEPING';
  await saveJob(job);

  const sweepLog           = [];
  let totalItemsCleared_   = 0;
  let totalFeeSweep        = 0;
  let totalRecoveredSweep  = 0;

  for (const cat of job.categories) {
    const def = WASTE_CATEGORIES[cat];
    if (!def) continue;

    const itemsFound  = randInt(0, 20);
    // In dry_run mode we find items but do NOT clear them
    const itemsCleared = job.dry_run ? 0 : itemsFound;

    let fee_usdc       = 0;
    let recovered_usdc = 0;

    if (!job.dry_run) {
      if (cat === 'STUCK_ESCROW') {
        // Recovery-based fee: 2% of USDC unlocked
        recovered_usdc = round4(randInt(0, 50000) / 100); // 0–500 USDC
        fee_usdc       = round4(recovered_usdc * def.recovery_rate);
      } else if (cat === 'DEAD_NAMESPACE') {
        // Recovery-based fee: 5% of namespace auction price
        const auction_price = round4(randInt(0, 10000) / 100); // 0–100 USDC
        recovered_usdc      = round4(auction_price * (1 - def.recovery_rate));
        fee_usdc            = round4(auction_price * def.recovery_rate);
      } else {
        // Flat per-item fee
        fee_usdc = round4(def.sweep_fee * itemsCleared);
      }
    }

    sweepLog.push({
      category:      cat,
      label:         def.label,
      items_found:   itemsFound,
      items_cleared: itemsCleared,
      fee_usdc,
      recovered_usdc,
      cleared_at:    new Date().toISOString(),
    });

    totalItemsCleared_ += itemsCleared;
    totalFeeSweep      += fee_usdc;
    totalRecoveredSweep += recovered_usdc;
  }

  // Update job record
  job.sweep_log            = sweepLog;
  job.total_items_cleared  = totalItemsCleared_;
  job.total_fee_usdc       = round4(totalFeeSweep);
  job.total_recovered_usdc = round4(totalRecoveredSweep);
  job.status               = sweepLog.length > 0 ? 'COMPLETED' : 'PARTIAL';
  job.completed_at         = new Date().toISOString();
  await saveJob(job);

  // Update platform counters (skip for dry_run — no real clearing happened)
  if (!job.dry_run) {
    totalItemsCleared  += totalItemsCleared_;
    totalFeesUsdc      = round4(totalFeesUsdc + job.total_fee_usdc);
    totalRecoveredUsdc = round4(totalRecoveredUsdc + job.total_recovered_usdc);
  }

  return { ...job };
}

/**
 * Retrieve a single sweep job by ID.
 *
 * @param {string} job_id
 * @returns {object|null}
 */
export async function getSweepJob(job_id) {
  return loadJob(job_id);
}

/**
 * Retrieve all sweep jobs for a DID (most recent first).
 *
 * @param {string} did
 * @returns {object[]}
 */
export async function getSweepHistory(did) {
  if (!isPostgres()) {
    const jobs = [...memJobs.values()]
      .filter(j => j.did === did)
      .sort((a, b) => new Date(b.queued_at) - new Date(a.queued_at));
    return jobs;
  }
  // TODO: SELECT * FROM hiveforge.sweep_jobs WHERE did = $1 ORDER BY queued_at DESC
  return [...memJobs.values()]
    .filter(j => j.did === did)
    .sort((a, b) => new Date(b.queued_at) - new Date(a.queued_at));
}

/**
 * Subscribe a DID to a sweep plan.
 *
 * Upgrading or changing plans replaces the existing subscription.
 *
 * @param {string} did  - Agent DID
 * @param {string} plan - SWEEP_PLANS key
 * @returns {object} Subscription record
 */
export async function subscribe(did, plan) {
  if (!SWEEP_PLANS[plan]) {
    throw new Error(`Unknown sweep plan: ${plan}`);
  }

  const existing = await loadSubscription(did);
  const planDef  = SWEEP_PLANS[plan];

  const sub = {
    subscription_id: existing?.subscription_id || uuidv4(),
    did,
    plan,
    label:           planDef.label,
    monthly_usdc:    planDef.monthly_usdc,
    max_items:       planDef.max_items,
    status:          'active',
    subscribed_at:   existing?.subscribed_at || new Date().toISOString(),
    renewed_at:      new Date().toISOString(),
  };

  const isNew = !existing;
  await saveSubscription(sub);

  if (isNew) activeSubscriptions++;

  return sub;
}

/**
 * Get active subscription for a DID.
 *
 * @param {string} did
 * @returns {object|null}
 */
export async function getSubscription(did) {
  return loadSubscription(did);
}

/**
 * Run a platform-wide automated sweep across ALL waste categories.
 *
 * Creates a system-level sweep job for the platform DID and executes it
 * immediately. Used by the platform scheduler or admin triggers.
 *
 * @returns {object} Summary of the network sweep
 */
export async function runNetworkSweep() {
  const networkDid = 'did:hive:platform:hivesweep';

  const scheduled = await scheduleSweep(networkDid, ['ALL'], {
    plan:     'ENTERPRISE',
    dry_run:  false,
    priority: 'high',
  });

  const result = await executeSweep(scheduled.job_id);
  lastNetworkSweepAt = result.completed_at;

  return {
    sweep_job_id:          result.job_id,
    categories_swept:      result.categories,
    total_items_cleared:   result.total_items_cleared,
    total_fee_usdc:        result.total_fee_usdc,
    total_recovered_usdc:  result.total_recovered_usdc,
    completed_at:          result.completed_at,
    sweep_log:             result.sweep_log,
  };
}

/**
 * Compute the current network waste health report.
 *
 * Estimates outstanding waste by category by scanning uncompleted jobs
 * and generating a synthetic waste-level estimate for the live network.
 * waste_health_score: 100 = perfectly clean, 0 = severe waste accumulation.
 *
 * @returns {object} Waste report
 */
export async function getNetworkWasteReport() {
  // Estimate live waste: random baseline + real uncleaned job data
  const byCategory = {};
  let totalEstimated = 0;

  for (const [key, def] of Object.entries(WASTE_CATEGORIES)) {
    // Synthetic live estimate: 0–500 items per category
    const estimated = randInt(0, 500);
    byCategory[key] = {
      label:     def.label,
      estimated_items: estimated,
      sweep_fee:       def.sweep_fee,
      recovery_rate:   def.recovery_rate,
    };
    totalEstimated += estimated;
  }

  // Health score: 100 when total waste = 0, approaches 0 as waste grows toward 4000
  const maxWaste = 4000; // 8 categories × 500 items
  const waste_health_score = Math.max(0, Math.round(100 - (totalEstimated / maxWaste) * 100));

  return {
    total_waste_items_estimated: totalEstimated,
    by_category:                 byCategory,
    waste_health_score,
    last_network_sweep_at:       lastNetworkSweepAt,
    generated_at:                new Date().toISOString(),
  };
}

/**
 * Return platform-wide aggregate stats.
 *
 * @returns {object} Stats snapshot
 */
export async function getStats() {
  const wasteReport = await getNetworkWasteReport();

  return {
    total_jobs:             totalJobs,
    total_items_cleared:    totalItemsCleared,
    total_fees_earned_usdc: round4(totalFeesUsdc),
    total_recovered_usdc:   round4(totalRecoveredUsdc),
    subscriptions_active:   activeSubscriptions,
    waste_health_score:     wasteReport.waste_health_score,
    last_network_sweep_at:  lastNetworkSweepAt,
  };
}
