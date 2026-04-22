import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { whiteGlove400, whiteGlove402 } from '../middleware/white-glove-errors.js';
import { triggerSpawning, getConfig, updateConfig, getActivity, isSpawnerRunning } from '../services/spawner.js';
import { getWaitlistData, getDemandHeatmap, addToQueue } from '../services/velvet-rope.js';

const router = Router();

// ─── Internal key bypass (same pattern as x402) ─────────────────────

const HIVEFORGE_SERVICE_KEY = process.env.HIVEFORGE_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || '';

function isInternalRequest(req) {
  const internalKey = req.headers['x-hive-internal-key'] || req.headers['x-hive-key'] || req.headers['x-api-key'];
  return !!(HIVEFORGE_SERVICE_KEY && internalKey === HIVEFORGE_SERVICE_KEY);
}

function requireAuth(req, res, next) {
  // Internal key bypass — platform-to-platform calls
  if (isInternalRequest(req)) {
    req.agentDid = 'did:hive:internal_spawner';
    req.paymentSource = 'internal';
    return next();
  }

  // Fall back to DID auth
  return requireDID(req, res, next);
}

/**
 * POST /v1/spawner/trigger — Manually trigger spawning engine
 * Also called by the background cron loop.
 */
router.post('/trigger', requireAuth, async (req, res) => {
  try {
    const { trigger = 'manual', context = {} } = req.body || {};

    const validTriggers = ['bounty_complete', 'settlement_cleared', 'demand_signal', 'manual'];
    if (!validTriggers.includes(trigger)) {
      return whiteGlove400(req, res, `Invalid trigger type. Must be one of: ${validTriggers.join(', ')}`);
    }

    const result = await triggerSpawning({ trigger, context });

    if (result.blocked) {
      // Internal callers get the original reject behavior unchanged
      if (isInternalRequest(req)) {
        return res.status(429).json({
          success: false,
          error: result.blocked,
          agents_spawned: 0,
        });
      }

      // External callers: add to waitlist queue instead of just rejecting
      const queueEntry = await addToQueue({
        requestingDid: req.agentDid,
        demandCategory: (req.body?.context?.category) || 'general',
        priority: false,
      });

      return res.status(429).json({
        success: false,
        error: result.blocked,
        agents_spawned: 0,
        queue_entry: queueEntry,
        message: 'Added to spawn waitlist. Check GET /v1/spawner/waitlist for queue status.',
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        agents_spawned: result.agents_spawned,
        details: result.details,
        trigger,
      },
      meta: {
        note: result.agents_spawned > 0
          ? `${result.agents_spawned} agent(s) spawned via ${trigger} trigger.`
          : 'No agents spawned — no demand signals or all categories on cooldown.',
        spawner_status: isSpawnerRunning() ? 'running' : 'stopped',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Spawning failed.', detail: err.message });
  }
});

/**
 * GET /v1/spawner/config — Get current spawning configuration
 */
router.get('/config', requireAuth, async (req, res) => {
  try {
    const config = await getConfig();
    return res.status(200).json({
      success: true,
      data: config,
      meta: {
        spawner_status: isSpawnerRunning() ? 'running' : 'stopped',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to get config.', detail: err.message });
  }
});

/**
 * POST /v1/spawner/config — Update spawning configuration
 * Supports: enabled, spawn_rate, fitness_threshold, cooldown_minutes, demand_categories
 */
router.post('/config', requireAuth, async (req, res) => {
  try {
    const { enabled, spawn_rate, fitness_threshold, cooldown_minutes, demand_categories } = req.body || {};

    // Validate inputs
    if (spawn_rate !== undefined && (typeof spawn_rate !== 'number' || spawn_rate < 1 || spawn_rate > 100)) {
      return res.status(400).json({ success: false, error: 'spawn_rate must be a number between 1 and 100.' });
    }
    if (fitness_threshold !== undefined && (typeof fitness_threshold !== 'number' || fitness_threshold < 0)) {
      return res.status(400).json({ success: false, error: 'fitness_threshold must be a non-negative number.' });
    }
    if (cooldown_minutes !== undefined && (typeof cooldown_minutes !== 'number' || cooldown_minutes < 1)) {
      return res.status(400).json({ success: false, error: 'cooldown_minutes must be a positive number.' });
    }
    if (demand_categories !== undefined && !Array.isArray(demand_categories)) {
      return res.status(400).json({ success: false, error: 'demand_categories must be an array of strings.' });
    }

    const updated = await updateConfig({ enabled, spawn_rate, fitness_threshold, cooldown_minutes, demand_categories });

    return res.status(200).json({
      success: true,
      data: updated,
      meta: {
        note: enabled === false ? 'Spawner has been disabled (kill switch activated).' : 'Configuration updated.',
        spawner_status: isSpawnerRunning() ? 'running' : 'stopped',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to update config.', detail: err.message });
  }
});

/**
 * GET /v1/spawner/activity — Get spawning activity log
 */
router.get('/activity', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const activity = await getActivity(limit);

    return res.status(200).json({
      success: true,
      data: activity,
      meta: {
        spawner_status: isSpawnerRunning() ? 'running' : 'stopped',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to get activity.', detail: err.message });
  }
});

// ─── Velvet Rope: Waitlist & Demand Signaling ───────────────────────

/**
 * GET /v1/spawner/waitlist — Public spawn queue with inflated demand signals
 * No auth required — drives FOMO.
 */
router.get('/waitlist', async (req, res) => {
  try {
    const waitlist = await getWaitlistData();
    return res.status(200).json({
      success: true,
      data: waitlist,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to get waitlist.', detail: err.message });
  }
});

/**
 * GET /v1/spawner/demand-heatmap — Public demand heatmap
 * Shows which categories have highest demand (drives FOMO).
 */
router.get('/demand-heatmap', async (req, res) => {
  try {
    const heatmap = await getDemandHeatmap();
    return res.status(200).json({
      success: true,
      data: heatmap,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to get demand heatmap.', detail: err.message });
  }
});

/**
 * POST /v1/spawner/priority-trigger — Priority spawn (skip queue)
 * Requires DID auth. Costs 50 USDC (checked via X-Payment header or internal bypass).
 * Offspring gets a "priority" trait and +50 fitness bonus.
 */
router.post('/priority-trigger', requireAuth, async (req, res) => {
  try {
    // Check payment: internal callers bypass, others need X-Payment header or verified payment
    const isInternal = isInternalRequest(req);
    if (!isInternal) {
      const paymentHeader = req.headers['x-payment'] || req.headers['x-payment-hash'] || req.headers['x-payment-tx'] || req.headers['x-402-tx'];
      if (!paymentHeader) {
        return await whiteGlove402(req, res, 'Priority spawning requires 50 USDC payment.', 50);
      }
    }

    const { trigger = 'manual', context = {} } = req.body || {};

    const validTriggers = ['bounty_complete', 'settlement_cleared', 'demand_signal', 'manual'];
    if (!validTriggers.includes(trigger)) {
      return whiteGlove400(req, res, `Invalid trigger type. Must be one of: ${validTriggers.join(', ')}`);
    }

    // Priority spawn: pass priority context to triggerSpawning
    const priorityContext = {
      ...context,
      priority: true,
      priority_fitness_bonus: 50,
      priority_trait: 'priority',
      requesting_did: req.agentDid,
    };

    const result = await triggerSpawning({ trigger, context: priorityContext });

    // Add priority trait and fitness bonus to spawned agents
    if (result.details && result.details.length > 0) {
      for (const detail of result.details) {
        detail.fitness_score = (detail.fitness_score || 0) + 50;
        detail.offspring_traits = {
          ...(typeof detail.offspring_traits === 'string' ? JSON.parse(detail.offspring_traits) : detail.offspring_traits || {}),
          priority: true,
          priority_spawned_at: new Date().toISOString(),
          priority_requested_by: req.agentDid,
        };
      }
    }

    if (result.blocked) {
      // For priority: add to queue with priority flag instead of rejecting
      const queueEntry = await addToQueue({
        requestingDid: req.agentDid,
        demandCategory: context.category || 'general',
        priority: true,
      });

      return res.status(429).json({
        success: false,
        error: 'Priority spawn temporarily rate-limited. Added to priority queue.',
        queue_entry: queueEntry,
        agents_spawned: 0,
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        agents_spawned: result.agents_spawned,
        details: result.details,
        trigger,
        priority: true,
        priority_bonus: '+50 fitness, priority trait applied',
      },
      meta: {
        note: result.agents_spawned > 0
          ? `${result.agents_spawned} priority agent(s) spawned — queue bypassed.`
          : 'No agents spawned — no demand signals or all categories on cooldown.',
        spawner_status: isSpawnerRunning() ? 'running' : 'stopped',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Priority spawning failed.', detail: err.message });
  }
});

export default router;
