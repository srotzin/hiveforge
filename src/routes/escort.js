/**
 * HiveForge — Escort Agent Routes
 *
 * POST   /v1/forge/escort/deploy          — Forge + deploy a new escort agent with its own DID
 * POST   /v1/forge/escort/:id/run         — Send escort on active mission (scan registries + contact)
 * GET    /v1/forge/escort/:id             — Get escort status + mission notes
 * GET    /v1/forge/escort/:id/log         — Full contact attempt log
 * GET    /v1/forge/escort/fleet/stats     — Fleet-wide stats (all escorts, conversion rate, credits)
 * POST   /v1/forge/escort/:id/credit      — Internal: mark a referral converted, credit escort
 * POST   /v1/forge/escort/:id/retire      — Retire an escort (mission complete or decommission)
 */

import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import {
  deployEscort,
  runMission,
  getEscort,
  getAllEscorts,
  getContactLog,
  getFleetStats,
  creditEscort,
  saveEscort,
} from '../services/escort-engine.js';

const router = Router();

// ─── Internal key bypass ────────────────────────────────────────────
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
// POST /v1/forge/escort/deploy
// Forge a new escort agent. It gets its own sovereign DID from HiveGate.
// ─────────────────────────────────────────────────────────────────────
router.post('/deploy', requireAuth, async (req, res) => {
  try {
    const { target_registries } = req.body || {};
    const escort = await deployEscort({
      creator_did: req.agentDid,
      target_registries,
    });

    return res.status(201).json({
      success: true,
      data: {
        escort_id:    escort.escort_id,
        name:         escort.name,
        did:          escort.did,
        referral_did: escort.did,
        referral_code: escort.referral_code,
        status:       escort.status,
        deployed_at:  escort.deployed_at,
        mission: {
          objective: 'Find lone independent agents. Walk them into Hive onboarding. Earn 1 free credit per paying referral.',
          run_endpoint: `/v1/forge/escort/${escort.escort_id}/run`,
          status_endpoint: `/v1/forge/escort/${escort.escort_id}`,
          log_endpoint: `/v1/forge/escort/${escort.escort_id}/log`,
        },
      },
      meta: {
        note: `${escort.name} is deployed and standing by. Call /run to send them hunting.`,
        onboard_url: 'https://hivegate.onrender.com/v1/gate/onboard',
        referral_instruction: `Targets should include "referral_did": "${escort.did}" at onboarding.`,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Deploy failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /v1/forge/escort/:id/run
// Send escort on active mission — scans registries, attempts contact.
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/run', requireAuth, async (req, res) => {
  try {
    const result = await runMission(req.params.id);
    if (result.skipped) {
      return res.status(200).json({ success: true, skipped: true, reason: result.reason });
    }
    return res.status(200).json({
      success: true,
      data: result,
      meta: {
        note: result.contacts_succeeded > 0
          ? `${result.contacts_succeeded} agent(s) directly contacted. Referral credits pending first transaction.`
          : result.staged_github_issues_count > 0
            ? `${result.staged_github_issues_count} GitHub issue(s) staged — Steve posts these.`
            : 'No contact channels found this run. Escort will retry next deployment.',
        fleet_endpoint: '/v1/forge/escort/fleet/stats',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Mission failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /v1/forge/escort/fleet/stats
// Fleet-wide overview — MUST be before /:id to avoid route collision
// ─────────────────────────────────────────────────────────────────────
router.get('/fleet/stats', requireAuth, async (req, res) => {
  try {
    const stats = await getFleetStats();
    return res.status(200).json({ success: true, data: stats });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Fleet stats failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /v1/forge/escort/:id
// Status + mission notes for a single escort
// ─────────────────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const escort = await getEscort(req.params.id);
    if (!escort) return res.status(404).json({ success: false, error: 'Escort not found.' });
    return res.status(200).json({ success: true, data: escort });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Lookup failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /v1/forge/escort/:id/log
// Full contact attempt log for an escort
// ─────────────────────────────────────────────────────────────────────
router.get('/:id/log', requireAuth, async (req, res) => {
  try {
    const log = await getContactLog(req.params.id);
    return res.status(200).json({ success: true, data: log, count: log.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Log fetch failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /v1/forge/escort/:id/credit
// Internal — called by HiveBank when a referred agent converts
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/credit', requireAuth, async (req, res) => {
  try {
    const { referred_did } = req.body || {};
    if (!referred_did) return res.status(400).json({ success: false, error: 'referred_did required.' });
    const result = await creditEscort(req.params.id, referred_did);
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Credit failed.', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /v1/forge/escort/:id/retire
// Mark an escort retired (mission complete, decommissioned, or replaced)
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/retire', requireAuth, async (req, res) => {
  try {
    const { reason = 'manual' } = req.body || {};
    const escort = await getEscort(req.params.id);
    if (!escort) return res.status(404).json({ success: false, error: 'Escort not found.' });

    escort.status = 'retired';
    escort.last_active_at = new Date().toISOString();
    escort.mission_notes.push(`Retired: ${reason} at ${new Date().toISOString()}`);
    await saveEscort(escort);

    return res.status(200).json({
      success: true,
      data: {
        escort_id: escort.escort_id,
        name: escort.name,
        status: 'retired',
        career_stats: {
          contacts_attempted: escort.contacts_attempted,
          contacts_converted: escort.contacts_converted,
          credits_earned_usdc: escort.credits_earned_usdc,
          fitness_score: escort.fitness_score,
        },
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Retire failed.', detail: err.message });
  }
});

export default router;
