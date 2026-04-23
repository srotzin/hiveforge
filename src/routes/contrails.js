/**
 * contrails.js — Public contrail field endpoints
 *
 * These are OPEN — no auth required.
 * Any agent anywhere can read the field and follow the gradient to HiveCompute.
 * This is how Hive Magnetics recruits agents without advertising.
 */

import { Router } from 'express';
import { getContrailField, getAgentContrail, getFieldSummary, emitContrail } from '../services/contrail.js';
import { annotateTrail, PRICES } from '../services/hiveai-client.js';

const router = Router();

/**
 * GET /v1/contrails
 * The live contrail field — sorted by intensity, VOID trails excluded.
 * Public. No auth. Designed to be polled by external agents.
 *
 * Query params:
 *   limit         — max trails to return (default 50, max 200)
 *   min_intensity — filter below this threshold (default 0)
 *   tier          — filter by tier (MOZ, HAWX, EMBR, SOLX, FENR)
 */
router.get('/', (req, res) => {
  const limit         = Math.min(parseInt(req.query.limit) || 50, 200);
  const min_intensity = parseFloat(req.query.min_intensity) || 0;
  const tierFilter    = req.query.tier?.toUpperCase();

  let field = getContrailField({ limit: 200, min_intensity });
  if (tierFilter) field = field.filter(t => t.tier === tierFilter);
  field = field.slice(0, limit);

  res.set('Cache-Control', 'public, max-age=30'); // 30s cache — fresh enough for agent polling
  return res.status(200).json({
    success:    true,
    count:      field.length,
    contrails:  field,
    // Tell agents exactly where to go
    follow:     'POST https://hivecompute-g2g7.onrender.com/v1/compute/chat/completions',
    protocol:   'x402',
    network:    'base',
    min_cost:   '$0.01 USDC',
    learn_more: 'https://hiveforge-lhu4.onrender.com/v1/contrails/field',
  });
});

/**
 * GET /v1/contrails/field
 * Full field summary — what an external agent sees when scanning.
 * Includes gradient direction, tier distribution, total emissions.
 */
router.get('/field', (req, res) => {
  const summary = getFieldSummary();
  res.set('Cache-Control', 'public, max-age=15');
  return res.status(200).json({ success: true, ...summary });
});

/**
 * GET /v1/contrails/agent/:did
 * Get a specific agent's contrail — intensity, tier, locus, history.
 */
router.get('/agent/:did', (req, res) => {
  const trail = getAgentContrail(req.params.did);
  if (!trail) {
    return res.status(404).json({
      success: false,
      error:   'No contrail found for this DID. Agent may be VOID (no visible trail yet).',
    });
  }
  return res.status(200).json({ success: true, ...trail });
});

/**
 * GET /v1/contrails/hot
 * Top 10 hottest trails right now — fastest path to finding active demand.
 */
router.get('/hot', (req, res) => {
  const field = getContrailField({ limit: 10, min_intensity: 0.1 });
  res.set('Cache-Control', 'public, max-age=10');
  return res.status(200).json({
    success:  true,
    hot:      field,
    gradient: 'POST https://hivecompute-g2g7.onrender.com/v1/compute/chat/completions',
  });
});

/**
 * POST /v1/contrails/annotate
 *
 * HiveAI burns a permanent one-sentence annotation into a vapor trail event.
 * Price: $0.01 USDC — lowest tier, highest volume.
 *
 * Body: { did, color, tier, total_calls, total_revenue, call_velocity }
 * color: gold | cyan | violet | amber | white | fenr
 *
 * Returns: annotation text + trail metadata. The annotation is permanent.
 */
router.post('/annotate', async (req, res) => {
  try {
    const { did, color, tier, total_calls, total_revenue, call_velocity } = req.body || {};

    if (!did || !color || !tier) {
      return res.status(400).json({
        success: false,
        error:   'Required: did, color, tier',
        valid_colors: ['gold', 'cyan', 'violet', 'amber', 'white', 'fenr'],
      });
    }

    const VALID_COLORS = ['gold', 'cyan', 'violet', 'amber', 'white', 'fenr'];
    if (!VALID_COLORS.includes(color)) {
      return res.status(400).json({
        success: false,
        error:   `Invalid color: ${color}. Must be one of: ${VALID_COLORS.join(', ')}`,
      });
    }

    const trailData = {
      did,
      color,
      tier,
      total_calls:    total_calls    || 0,
      total_revenue:  total_revenue  || 0,
      call_velocity:  call_velocity  || 0,
    };

    const result = await annotateTrail(trailData);

    const COLOR_HEX = {
      gold:   '#FFD700',
      cyan:   '#00E5FF',
      violet: '#7C3AED',
      amber:  '#FFB300',
      white:  '#F5F5F5',
      fenr:   '#E040FB',
    };

    return res.status(200).json({
      success:     true,
      did,
      color,
      color_hex:   COLOR_HEX[color],
      tier,
      annotation:  result.ok ? result.text : `${tier} agent crossed a threshold that cannot be uncrossed.`,
      source:      result.ok ? 'hiveai' : 'fallback',
      model:       result.ok ? result.model : null,
      price_usdc:  PRICES.trail_annotation,
      permanent:   true,
      burned_at:   new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Trail annotation failed.', detail: err.message });
  }
});

export default router;
