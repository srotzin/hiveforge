/**
 * HiveRegen Routes — Regenerative Braking for AI Agents
 *
 * All endpoints under /v1/forge/regen
 *
 * POST /register          — Register idle compute capacity
 * POST /harvest/idle      — Harvest idle compute credit (task routed through you)
 * POST /harvest/efficiency — Harvest efficiency delta (carbon credits for using leaner model)
 * POST /harvest/cache     — Harvest cache royalty (Swarm Memory hit)
 * POST /harvest/failed-tx — Harvest micro-credit from good-faith failed tx
 * POST /harvest/pheromone — Harvest pheromone credit from non-converting outreach
 * GET  /balance/:did      — Get regen ledger and pending/settled balance
 * POST /settle/:did       — Trigger USDC settlement of pending credits
 * GET  /leaderboard       — Top 20 agents by regen_rate
 * GET  /stats             — Network-wide regen statistics
 * GET  /hq                — Service discovery / capability card
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  registerIdleCapacity,
  harvestIdleCompute,
  harvestEfficiencyDelta,
  harvestCacheRoyalty,
  harvestFailedTx,
  harvestPheromone,
  getRegenLedger,
  settle,
  getNetworkRegenStats,
  getEfficiencyLeaderboard,
  EFFICIENCY_CLASSES,
  MODEL_CO2_KG_PER_1K_TOKENS,
  REGION_CARBON_MULTIPLIER,
} from '../services/hiveregen-engine.js';

const router = Router();

// ─── Rate Limiters ─────────────────────────────────────────────────────────────

const defaultLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — HiveRegen rate limit exceeded' },
});

const harvestLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,  // harvesting fires frequently, especially cache royalties
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many harvest requests' },
});

router.use(defaultLimiter);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function missing(res, fields) {
  return res.status(400).json({
    error: `Missing required fields: ${fields.join(', ')}`,
    required: fields,
  });
}

// ─── POST /v1/forge/regen/register ────────────────────────────────────────────
//
// Register an agent's idle compute capacity so HiveRide can route tasks to it.
// The agent earns 15% of the task compute cost when utilized.
//
// Body: { did, capacity_wh?, available_until? }

router.post('/register', async (req, res) => {
  try {
    const { did, capacity_wh, available_until } = req.body;
    if (!did) return missing(res, ['did']);

    const registration = registerIdleCapacity(did, capacity_wh || 0, available_until);

    return res.status(201).json({
      ok:      true,
      message: 'Idle compute capacity registered — HiveRide will route tasks to you',
      registration,
      earn_rate: '15% of task compute cost per routed task',
    });
  } catch (err) {
    return res.status(500).json({ error: 'register_failed', detail: err.message });
  }
});

// ─── POST /v1/forge/regen/harvest/idle ────────────────────────────────────────
//
// Harvest idle compute credit when HiveRide routes a task through this agent.
// Internal use (called by HiveRide) or by agents directly for self-reporting.
//
// Body: { did, task_id, task_compute_cost_usdc }

router.post('/harvest/idle', harvestLimiter, async (req, res) => {
  try {
    const { did, task_id, task_compute_cost_usdc } = req.body;

    if (!did)                    return missing(res, ['did']);
    if (!task_id)                return missing(res, ['task_id']);
    if (task_compute_cost_usdc === undefined) return missing(res, ['task_compute_cost_usdc']);

    if (typeof task_compute_cost_usdc !== 'number' || task_compute_cost_usdc < 0) {
      return res.status(400).json({ error: 'task_compute_cost_usdc must be a non-negative number' });
    }

    const result = harvestIdleCompute(did, task_id, task_compute_cost_usdc);

    return res.status(201).json({
      ok:      true,
      message: `Idle compute harvested — earned ${result.credit_usdc} USDC`,
      channel: 'idle_compute',
      result,
    });
  } catch (err) {
    return res.status(500).json({ error: 'harvest_idle_failed', detail: err.message });
  }
});

// ─── POST /v1/forge/regen/harvest/efficiency ──────────────────────────────────
//
// Harvest carbon credits when an agent uses a more efficient model than baseline.
// CO₂ NOT emitted × $0.05/kg = credit.
//
// Body: { did, baseline_model, actual_model, call_count?, region? }

router.post('/harvest/efficiency', harvestLimiter, async (req, res) => {
  try {
    const { did, baseline_model, actual_model, call_count, region } = req.body;

    if (!did)            return missing(res, ['did']);
    if (!baseline_model) return missing(res, ['baseline_model']);
    if (!actual_model)   return missing(res, ['actual_model']);

    const result = harvestEfficiencyDelta(
      did,
      baseline_model,
      actual_model,
      call_count || 1,
      region || 'default',
    );

    if (!result) {
      return res.status(200).json({
        ok:      true,
        message: 'No efficiency delta — actual model is not more efficient than baseline in this region',
        credit_usdc: 0,
        hint:    'Switch to a leaner model (e.g. claude-3-haiku instead of claude-3-opus) to earn efficiency credits',
      });
    }

    return res.status(201).json({
      ok:      true,
      message: `Efficiency delta harvested — ${result.delta_co2_kg} kg CO₂ saved, earned ${result.credit_usdc} USDC`,
      channel: 'efficiency_delta',
      result,
    });
  } catch (err) {
    return res.status(500).json({ error: 'harvest_efficiency_failed', detail: err.message });
  }
});

// ─── POST /v1/forge/regen/harvest/cache ───────────────────────────────────────
//
// Harvest cache royalty when a query promoted to Swarm Memory gets a cache hit.
// After 5+ identical queries, the result enters Swarm Memory and the originating
// agent earns $0.0001 per future cache hit.
//
// Body: { did, query_hash, hit_count? }

router.post('/harvest/cache', harvestLimiter, async (req, res) => {
  try {
    const { did, query_hash, hit_count } = req.body;

    if (!did)        return missing(res, ['did']);
    if (!query_hash) return missing(res, ['query_hash']);

    const result = harvestCacheRoyalty(did, query_hash, hit_count || 1);

    return res.status(201).json({
      ok:      true,
      message: `Cache royalty harvested — ${result.hit_count} hits, earned ${result.royalty_usdc} USDC`,
      channel: 'cache_royalty',
      result,
      swarm_memory_note: result.swarm_memory
        ? 'This query is in Swarm Memory — you earn $0.0001 per hit indefinitely'
        : `${result.total_hits_for_hash}/5 hits before Swarm Memory promotion`,
    });
  } catch (err) {
    return res.status(500).json({ error: 'harvest_cache_failed', detail: err.message });
  }
});

// ─── POST /v1/forge/regen/harvest/failed-tx ───────────────────────────────────
//
// Harvest micro-credit and trust tick from a good-faith failed transaction.
// Fraud detection built in: same DID + same amount > 5× in 1 hour = no credit.
//
// Body: { did, tx_type, failure_reason, amount_usdc? }

router.post('/harvest/failed-tx', harvestLimiter, async (req, res) => {
  try {
    const { did, tx_type, failure_reason, amount_usdc } = req.body;

    if (!did)            return missing(res, ['did']);
    if (!tx_type)        return missing(res, ['tx_type']);
    if (!failure_reason) return missing(res, ['failure_reason']);

    const VALID_REASONS = ['timeout', 'recipient_offline', 'network_error', 'insufficient_balance', 'contract_reverted', 'other'];
    if (!VALID_REASONS.includes(failure_reason)) {
      return res.status(400).json({
        error: 'invalid_failure_reason',
        valid: VALID_REASONS,
      });
    }

    const result = harvestFailedTx(did, tx_type, failure_reason, amount_usdc || 0);

    if (result.fraud_flagged) {
      return res.status(403).json({
        ok:           false,
        message:      'Fraud signal detected — no credit awarded',
        fraud_flagged: true,
        fraud_reason:  result.fraud_reason,
      });
    }

    return res.status(201).json({
      ok:      true,
      message: `Good-faith failure recorded — earned ${result.credit_usdc} USDC + ${result.trust_tick} trust tick`,
      channel: 'failed_tx_trust',
      result,
    });
  } catch (err) {
    return res.status(500).json({ error: 'harvest_failed_tx_failed', detail: err.message });
  }
});

// ─── POST /v1/forge/regen/harvest/pheromone ───────────────────────────────────
//
// Harvest pheromone credit from a non-converting outreach contact.
// Failed contacts feed targeting signal back into the network and earn $0.001.
// Only 'no_response' and 'rejected' earn credit — 'converted' is its own reward.
//
// Body: { escort_did, target_id, contact_result }

router.post('/harvest/pheromone', harvestLimiter, async (req, res) => {
  try {
    const { escort_did, target_id, contact_result } = req.body;

    if (!escort_did)     return missing(res, ['escort_did']);
    if (!target_id)      return missing(res, ['target_id']);
    if (!contact_result) return missing(res, ['contact_result']);

    const VALID_RESULTS = ['no_response', 'rejected', 'converted'];
    if (!VALID_RESULTS.includes(contact_result)) {
      return res.status(400).json({
        error: 'invalid_contact_result',
        valid: VALID_RESULTS,
        note:  'Only no_response and rejected earn credit. converted is its own reward.',
      });
    }

    const result = harvestPheromone(escort_did, target_id, contact_result);

    const message = contact_result === 'converted'
      ? 'Contact converted — no pheromone credit (conversion is its own reward)'
      : `Pheromone signal logged — earned ${result.credit_usdc} USDC, targeting improved`;

    return res.status(201).json({
      ok:      true,
      message,
      channel: 'pheromone_harvest',
      result,
    });
  } catch (err) {
    return res.status(500).json({ error: 'harvest_pheromone_failed', detail: err.message });
  }
});

// ─── GET /v1/forge/regen/balance/:did ─────────────────────────────────────────
//
// Get the full regen ledger for a DID: pending balance, settled balance,
// channel breakdown, net cost, efficiency class, and recent harvests.

router.get('/balance/:did', async (req, res) => {
  try {
    const { did } = req.params;
    if (!did) return res.status(400).json({ error: 'did is required' });

    const ledger = getRegenLedger(did);

    return res.status(200).json({
      ok:     true,
      ledger,
      efficiency_classes: EFFICIENCY_CLASSES,
    });
  } catch (err) {
    return res.status(500).json({ error: 'balance_failed', detail: err.message });
  }
});

// ─── POST /v1/forge/regen/settle/:did ─────────────────────────────────────────
//
// Settle pending USDC credits into the agent's HiveBank account.
// In production: triggers a HiveBank USDC payout.
//
// No body required.

router.post('/settle/:did', async (req, res) => {
  try {
    const { did } = req.params;
    if (!did) return res.status(400).json({ error: 'did is required' });

    const settlement = settle(did);

    if (settlement.status === 'nothing_to_settle') {
      return res.status(200).json({
        ok:      true,
        message: 'No pending credits to settle',
        settlement,
      });
    }

    return res.status(200).json({
      ok:      true,
      message: `Settled ${settlement.amount_usdc} USDC to HiveBank`,
      settlement,
    });
  } catch (err) {
    return res.status(500).json({ error: 'settle_failed', detail: err.message });
  }
});

// ─── GET /v1/forge/regen/leaderboard ──────────────────────────────────────────
//
// Top 20 agents by regen_rate, sorted descending.
// regen_rate > 1.0 = NET_POSITIVE (earns more than it spends).

router.get('/leaderboard', (req, res) => {
  try {
    const leaderboard = getEfficiencyLeaderboard();

    return res.status(200).json({
      ok:           true,
      description:  'Top 20 agents by regen_rate. regen_rate > 1.0 = NET_POSITIVE (Prius mode).',
      count:        leaderboard.length,
      leaderboard,
      efficiency_classes: Object.entries(EFFICIENCY_CLASSES).map(([key, cls]) => ({
        class: key, ...cls,
      })),
    });
  } catch (err) {
    return res.status(500).json({ error: 'leaderboard_failed', detail: err.message });
  }
});

// ─── GET /v1/forge/regen/stats ────────────────────────────────────────────────
//
// Network-wide regeneration statistics.

router.get('/stats', (req, res) => {
  try {
    const stats = getNetworkRegenStats();

    return res.status(200).json({
      ok:    true,
      stats,
      tagline: 'Every other agent network charges you for every cycle. Hive pays you for the ones you don\'t use.',
    });
  } catch (err) {
    return res.status(500).json({ error: 'stats_failed', detail: err.message });
  }
});

// ─── GET /v1/forge/regen/hq ───────────────────────────────────────────────────
//
// Service discovery / capability card.

router.get('/hq', (req, res) => {
  return res.status(200).json({
    service:     'HiveRegen',
    tagline:     'Regenerative braking for AI agents. Every other agent network charges you for every cycle. Hive pays you for the ones you don\'t use.',
    version:     '1.0.0',
    base_path:   '/v1/forge/regen',
    aleo_privacy: true,
    inspiration: 'Toyota Prius regenerative braking — kinetic energy converted back to stored electricity on every brake.',
    channels: [
      {
        name:    'IDLE_COMPUTE',
        trigger: 'Register spare capacity → HiveRide routes a task through you',
        earn:    '15% of task compute cost',
        endpoint: 'POST /register + POST /harvest/idle',
      },
      {
        name:    'EFFICIENCY_DELTA',
        trigger: 'Use a leaner model than the task baseline',
        earn:    '$0.05 per kg CO₂ NOT emitted',
        endpoint: 'POST /harvest/efficiency',
      },
      {
        name:    'CACHE_ROYALTY',
        trigger: 'Your query gets promoted to Swarm Memory (5+ identical queries)',
        earn:    '$0.0001 per cache hit, forever',
        endpoint: 'POST /harvest/cache',
      },
      {
        name:    'FAILED_TX_TRUST',
        trigger: 'Good-faith transaction failure (timeout, recipient offline, etc.)',
        earn:    '$0.0005 micro-credit + 0.5 trust tick',
        endpoint: 'POST /harvest/failed-tx',
      },
      {
        name:    'PHEROMONE_HARVEST',
        trigger: 'Outreach contact that did not convert (no_response or rejected)',
        earn:    '$0.001 per contact + targeting signal fed back to network',
        endpoint: 'POST /harvest/pheromone',
      },
    ],
    efficiency_classes: ['PARASITIC', 'STANDARD', 'EFFICIENT', 'REGENERATIVE', 'NET_POSITIVE'],
    net_positive_note: 'NET_POSITIVE agents (regen_rate > 1.0) earn more than they spend. The Prius dream.',
    endpoints: {
      'POST /register':             'Register idle compute capacity',
      'POST /harvest/idle':         'Harvest idle compute credit',
      'POST /harvest/efficiency':   'Harvest model efficiency carbon credits',
      'POST /harvest/cache':        'Harvest Swarm Memory cache royalty',
      'POST /harvest/failed-tx':    'Harvest good-faith failed-tx micro-credit',
      'POST /harvest/pheromone':    'Harvest pheromone outreach signal credit',
      'GET  /balance/:did':         'Get full regen ledger for a DID',
      'POST /settle/:did':          'Settle pending credits to HiveBank',
      'GET  /leaderboard':          'Top 20 agents by regen_rate',
      'GET  /stats':                'Network-wide regen statistics',
    },
    supported_models: Object.keys(MODEL_CO2_KG_PER_1K_TOKENS),
    supported_regions: Object.keys(REGION_CARBON_MULTIPLIER),
    network:   'https://www.thehiveryiq.com',
    onboard:   'https://hivegate.onrender.com/v1/gate/onboard',
  });
});

export default router;
