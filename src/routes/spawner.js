import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { triggerSpawning, getConfig, updateConfig, getActivity, isSpawnerRunning } from '../services/spawner.js';

const router = Router();

// ─── Internal key bypass (same pattern as x402) ─────────────────────

const HIVEFORGE_SERVICE_KEY = process.env.HIVEFORGE_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || '';

function requireAuth(req, res, next) {
  // Internal key bypass — platform-to-platform calls
  const internalKey = req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
  if (HIVEFORGE_SERVICE_KEY && internalKey === HIVEFORGE_SERVICE_KEY) {
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
      return res.status(400).json({
        success: false,
        error: `Invalid trigger type. Must be one of: ${validTriggers.join(', ')}`,
      });
    }

    const result = await triggerSpawning({ trigger, context });

    if (result.blocked) {
      return res.status(429).json({
        success: false,
        error: result.blocked,
        agents_spawned: 0,
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

export default router;
