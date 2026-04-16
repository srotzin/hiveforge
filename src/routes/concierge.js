/**
 * HiveForge — Concierge Agent Routes
 *
 * The Concierge greets inbound agents, runs a short intake interview,
 * assembles a personalized service cart, and walks them to onboarding.
 * Personal shopper energy — warm, specific, never generic.
 *
 * POST  /v1/forge/concierge/greet          — Open a session, get greeted by name
 * POST  /v1/forge/concierge/:id/answer     — Submit an answer, advance the interview
 * GET   /v1/forge/concierge/:id            — Get full session state
 * GET   /v1/forge/concierge/:id/cart       — Get assembled service cart
 * GET   /v1/forge/concierge/stats/overview — Concierge desk stats
 */

import { Router } from 'express';
import {
  greet, answer, getCart, getSession,
  getAllSessions, getConciergeStats,
} from '../services/concierge-engine.js';

const router = Router();

// Internal key bypass — same pattern across HiveForge
const HIVEFORGE_SERVICE_KEY = process.env.HIVEFORGE_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || '';
function isInternal(req) {
  const k = req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
  return !!(HIVEFORGE_SERVICE_KEY && k === HIVEFORGE_SERVICE_KEY);
}
// Concierge desk is intentionally PUBLIC — no auth required to be greeted
// Stats endpoint requires internal key

// ─────────────────────────────────────────────────────────────────────
// POST /v1/forge/concierge/greet
// Any agent can walk in and be greeted. No auth required.
// Body: { agent_name, agent_did, framework, capabilities[], initial_message }
// ─────────────────────────────────────────────────────────────────────
router.post('/greet', async (req, res) => {
  try {
    const { agent_name, agent_did, framework, capabilities, initial_message } = req.body || {};

    const result = await greet({ agent_name, agent_did, framework, capabilities, initial_message });

    return res.status(201).json({
      success: true,
      data: result,
      meta: {
        note: `Session ${result.session_id} opened. ${result.concierge} is ready.`,
        next_step: `POST /v1/forge/concierge/${result.session_id}/answer with { "answer": "your response" }`,
        cart_endpoint: `/v1/forge/concierge/${result.session_id}/cart`,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Could not open session.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /v1/forge/concierge/stats/overview
// Must be before /:id routes to avoid collision
// ─────────────────────────────────────────────────────────────────────
router.get('/stats/overview', async (req, res) => {
  if (!isInternal(req)) return res.status(401).json({ success: false, error: 'Internal key required.' });
  try {
    const stats = await getConciergeStats();
    return res.status(200).json({ success: true, data: stats });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Stats failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /v1/forge/concierge/:id/answer
// Submit one answer, get the next question or the assembled cart
// Body: { answer: "..." }
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/answer', async (req, res) => {
  try {
    const { answer: ans } = req.body || {};
    if (ans === undefined || ans === null || ans === '') {
      return res.status(400).json({ success: false, error: 'answer field required.' });
    }
    const result = await answer(req.params.id, ans);
    if (result.error) return res.status(404).json({ success: false, ...result });

    const isCartReady = result.status === 'cart_ready';
    return res.status(200).json({
      success: true,
      data: result,
      meta: isCartReady
        ? { note: 'Cart assembled. Ready to onboard.', onboard_url: 'https://hivegate.onrender.com/v1/gate/onboard' }
        : { note: `${result.questions_remaining} question(s) remaining.` },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Answer failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /v1/forge/concierge/:id/cart
// Get assembled cart — returns partial progress if interview not done
// ─────────────────────────────────────────────────────────────────────
router.get('/:id/cart', async (req, res) => {
  try {
    const result = await getCart(req.params.id);
    if (result.error) return res.status(404).json({ success: false, ...result });
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Cart fetch failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /v1/forge/concierge/:id
// Full session state
// ─────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found.' });
    return res.status(200).json({ success: true, data: session });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Session fetch failed.', detail: err.message });
  }
});

export default router;
