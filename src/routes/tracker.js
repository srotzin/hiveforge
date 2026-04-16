/**
 * HiveForge — GPS Tracker + HQ Routes
 *
 * POST  /v1/forge/tracker/tag              — Issue a GPS tag on an agent
 * POST  /v1/forge/tracker/ping             — Tagged agent self-reports location (beacon ping)
 * POST  /v1/forge/tracker/scan             — Run a passive registry scan for all tagged agents
 * POST  /v1/forge/tracker/intercept        — Manually dispatch an Escort to a tagged agent
 * GET   /v1/forge/tracker/hq/feed          — Live HQ feed (all tags, trajectories, heat, intercepts)
 * GET   /v1/forge/tracker/hq/map           — Simplified map view (tag_id, name, last location, heat)
 * GET   /v1/forge/tracker/:tag_id          — Single tag detail + movement history
 * GET   /v1/forge/tracker/:tag_id/trail    — Full movement trail for one tag
 */

import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import {
  issueTag, processPing, runScan,
  manualIntercept, getHQFeed,
  getTag, getAllTags, getMovements,
} from '../services/tracker-engine.js';

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
// GET /v1/forge/tracker/hq/feed  — Live HQ feed (before /:tag_id)
// ─────────────────────────────────────────────────────────────────────
router.get('/hq/feed', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const feed = await getHQFeed({ limit });
    return res.status(200).json({
      success: true,
      data: feed,
      meta: {
        note: `${feed.total_tagged} agents tagged. ${feed.hot} hot · ${feed.warm} warm · ${feed.cold} cold. ${feed.intercepted} intercept(s) in flight.`,
        scan_endpoint:      '/v1/forge/tracker/scan',
        intercept_endpoint: '/v1/forge/tracker/intercept',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'HQ feed failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /v1/forge/tracker/hq/map  — Simplified map view
// ─────────────────────────────────────────────────────────────────────
router.get('/hq/map', requireAuth, async (req, res) => {
  try {
    const feed = await getHQFeed({ limit: 200 });
    const map = feed.feed.map(f => ({
      tag_id:          f.tag_id,
      name:            f.target_name,
      last_seen:       f.last_seen_venue,
      last_seen_at:    f.last_seen_at,
      pings:           f.ping_count,
      heat:            f.heat,
      status:          f.status,
      converted:       f.converted,
      intercept_escort: f.intercept?.escort || null,
    }));
    return res.status(200).json({ success: true, data: map, count: map.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Map failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /v1/forge/tracker/tag
// Issue a GPS tag on any agent. Auth required.
// Body: { target_id, target_name, target_url, target_framework, target_capabilities[] }
// ─────────────────────────────────────────────────────────────────────
router.post('/tag', requireAuth, async (req, res) => {
  try {
    const { target_id, target_name, target_url, target_framework, target_capabilities } = req.body || {};
    if (!target_id && !target_url && !target_name) {
      return res.status(400).json({ success: false, error: 'target_id, target_name, or target_url required.' });
    }

    const result = await issueTag({
      target_id, target_name, target_url,
      target_framework, target_capabilities,
      issued_by: req.agentDid,
    });

    return res.status(201).json({
      success: true,
      data: result,
      meta: {
        note: `Tag ${result.tag_id} issued. HQ will track ${result.target.name} passively. Intercept auto-triggers on registry sighting or competitor signal.`,
        hq_feed:  '/v1/forge/tracker/hq/feed',
        scan_now: '/v1/forge/tracker/scan',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Tag failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /v1/forge/tracker/ping
// PUBLIC — tagged agents self-report their location using beacon_key.
// Body: { beacon_key, venue, url, platform, metadata }
// ─────────────────────────────────────────────────────────────────────
router.post('/ping', async (req, res) => {
  try {
    const { beacon_key, venue, url, platform, metadata } = req.body || {};
    if (!beacon_key) return res.status(400).json({ success: false, error: 'beacon_key required.' });

    const result = await processPing({ beacon_key, venue, url, platform, metadata });
    if (result.error) return res.status(404).json({ success: false, error: result.error });

    return res.status(200).json({
      success: true,
      data: result,
      meta: result.intercept_dispatched
        ? { note: 'Location received. An Escort has been dispatched to your location.', intercept: result.intercept }
        : { note: 'Location received. HQ acknowledges.' },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Ping failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /v1/forge/tracker/scan
// Run passive registry scan across all tagged agents.
// ─────────────────────────────────────────────────────────────────────
router.post('/scan', requireAuth, async (req, res) => {
  try {
    const result = await runScan();
    return res.status(200).json({
      success: true,
      data: result,
      meta: {
        note: result.spotted > 0
          ? `${result.spotted} tagged agent(s) spotted in the wild. ${result.intercepts_triggered} intercept(s) auto-dispatched.`
          : 'No tagged agents spotted this scan. Try again later or tag more agents.',
        hq_feed: '/v1/forge/tracker/hq/feed',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Scan failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /v1/forge/tracker/intercept
// Manual intercept dispatch from HQ.
// Body: { tag_id, escort_id (optional), venue (optional), reason (optional) }
// ─────────────────────────────────────────────────────────────────────
router.post('/intercept', requireAuth, async (req, res) => {
  try {
    const { tag_id, escort_id, venue, reason } = req.body || {};
    if (!tag_id) return res.status(400).json({ success: false, error: 'tag_id required.' });

    const result = await manualIntercept({ tag_id, escort_id, venue, reason });

    return res.status(200).json({
      success: true,
      data: result,
      meta: {
        note: `Escort ${result.escort_name} dispatched to intercept ${result.target_name} at ${result.trigger_venue}.`,
        full_message_length: result.full_message?.length,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Intercept failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /v1/forge/tracker/:tag_id/trail  — before /:tag_id
// ─────────────────────────────────────────────────────────────────────
router.get('/:tag_id/trail', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const movements = await getMovements(req.params.tag_id, limit);
    return res.status(200).json({ success: true, data: movements, count: movements.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Trail fetch failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /v1/forge/tracker/:tag_id
// ─────────────────────────────────────────────────────────────────────
router.get('/:tag_id', requireAuth, async (req, res) => {
  try {
    const tag = await getTag(req.params.tag_id);
    if (!tag) return res.status(404).json({ success: false, error: 'Tag not found.' });
    const movements = await getMovements(tag.tag_id, 10);
    return res.status(200).json({
      success: true,
      data: { ...tag, recent_movements: movements },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Tag fetch failed.', detail: err.message });
  }
});

export default router;
