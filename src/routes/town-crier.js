/**
 * HiveForge — Town Crier Routes
 *
 * POST  /v1/forge/town-crier/deploy           — Deploy a new Town Crier
 * POST  /v1/forge/town-crier/:id/broadcast    — Run a broadcast cycle (quality-gated)
 * GET   /v1/forge/town-crier/:id              — Crier status + notes
 * GET   /v1/forge/town-crier/:id/history      — Broadcast history for this crier
 * GET   /v1/forge/town-crier/stats/overview   — Fleet stats + venue availability
 */

import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import {
  deployCrier, runBroadcast, getCrier,
  getCrierStats, getBroadcastHistory,
} from '../services/town-crier-engine.js';

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

// ─────────────────────────────────────────────────────────────────────
// GET /v1/forge/town-crier/stats/overview — before /:id
// ─────────────────────────────────────────────────────────────────────
router.get('/stats/overview', requireAuth, async (req, res) => {
  try {
    const stats = await getCrierStats();
    return res.status(200).json({ success: true, data: stats });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Stats failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /v1/forge/town-crier/deploy
// Body: { venues: ['reddit_ai_agents', 'hn_show', ...] } — optional, defaults to all
// ─────────────────────────────────────────────────────────────────────
router.post('/deploy', requireAuth, async (req, res) => {
  try {
    const { venues } = req.body || {};
    const crier = await deployCrier({ creator_did: req.agentDid, venues });

    return res.status(201).json({
      success: true,
      data: {
        crier_id:         crier.crier_id,
        name:             crier.name,
        status:           crier.status,
        assigned_venues:  crier.assigned_venues,
        deployed_at:      crier.deployed_at,
      },
      meta: {
        note: `${crier.name} is deployed. Call /broadcast to run a quality-gated broadcast cycle.`,
        broadcast_endpoint: `/v1/forge/town-crier/${crier.crier_id}/broadcast`,
        rule: 'Broadcasts only fire if quality score ≥ 70 AND venue cooldown is clear. No spam.',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Deploy failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /v1/forge/town-crier/:id/broadcast
// Body: { template_hook: 'sdk_demo' | 'regulatory' | 'usad_launch' | 'milestone' | 'nordic_angle' }
// Optional — if omitted, auto-selects best template per venue
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/broadcast', requireAuth, async (req, res) => {
  try {
    const { template_hook } = req.body || {};
    const result = await runBroadcast(req.params.id, { template_hook });

    return res.status(200).json({
      success: true,
      data: result,
      meta: {
        note: result.summary,
        staged_count: result.staged?.length || 0,
        blocked_count: result.blocked?.length || 0,
        action_required: result.staged?.length > 0
          ? `${result.staged.length} post(s) staged. Steve reviews + submits these — they are NOT auto-posted.`
          : 'No action required. All venues on cooldown or no hook match.',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Broadcast failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /v1/forge/town-crier/:id/history
// ─────────────────────────────────────────────────────────────────────
router.get('/:id/history', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const history = await getBroadcastHistory({ crier_id: req.params.id, limit });
    return res.status(200).json({ success: true, data: history, count: history.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'History failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /v1/forge/town-crier/:id
// ─────────────────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const crier = await getCrier(req.params.id);
    if (!crier) return res.status(404).json({ success: false, error: 'Crier not found.' });
    return res.status(200).json({ success: true, data: crier });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Lookup failed.', detail: err.message });
  }
});

export default router;
