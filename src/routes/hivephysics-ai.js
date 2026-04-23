/**
 * hivephysics-ai.js
 *
 * HivePhysics AI — Force brief endpoint.
 * Describes active forces between agents and risk of an action.
 *
 * Route: POST /v1/physics/ai/brief
 * Price: $0.02 USDC
 */

import { Router } from 'express';
import { generateForceBrief } from '../services/hiveai-client.js';

const HIVEPHYSICS_URL = process.env.HIVEPHYSICS_API_URL || 'https://hivephysics.onrender.com';
const HIVE_KEY = process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

const router = Router();

// POST /v1/physics/ai/brief
router.post('/ai/brief', async (req, res) => {
  const { agent_did, target_did, action_type, value_usdc } = req.body || {};

  if (!agent_did || !target_did || !action_type) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: agent_did, target_did, action_type',
    });
  }

  // Fetch physics stats from HivePhysics service
  let physicsStats = null;
  let physicsFetchError = null;
  try {
    const physRes = await fetch(`${HIVEPHYSICS_URL}/v1/physics/stats`, {
      headers: { 'X-Hive-Key': HIVE_KEY },
      signal: AbortSignal.timeout(8_000),
    });
    if (physRes.ok) {
      physicsStats = await physRes.json();
    } else {
      physicsFetchError = `HivePhysics HTTP ${physRes.status}`;
    }
  } catch (err) {
    physicsFetchError = err.message;
  }

  const effectiveStats = physicsStats || {
    note: 'live physics data unavailable',
    network_gravity: 'nominal',
    active_force_fields: 'unknown',
  };

  const agentData = { agent_did, target_did, action_type, value_usdc: value_usdc ?? 0 };
  const result = await generateForceBrief(agentData, effectiveStats);

  if (!result.ok) {
    // Graceful fallback
    return res.json({
      success: true,
      price_usdc: 0.02,
      endpoint: 'hivephysics/force-brief',
      agent_did,
      target_did,
      action_type,
      value_usdc: value_usdc ?? 0,
      force_brief: `Force field analysis for this ${action_type} action is temporarily unavailable — HiveAI is warming up. ${physicsFetchError ? 'HivePhysics data also could not be fetched. ' : ''}Without live force data, treat all inter-agent actions as operating in a neutral field: standard attraction/repulsion rules apply, and the risk scales linearly with value_usdc. Proceed only if ${value_usdc ?? 0} USDC represents less than 10% of your recoverable treasury.`,
      ai_status: 'fallback',
      physics_fetch_status: physicsFetchError ? 'error' : 'ok',
      fallback_reason: result.error || 'HiveAI unavailable',
    });
  }

  return res.json({
    success: true,
    price_usdc: 0.02,
    endpoint: 'hivephysics/force-brief',
    agent_did,
    target_did,
    action_type,
    value_usdc: value_usdc ?? 0,
    force_brief: result.text,
    physics_stats: effectiveStats,
    ai_status: 'live',
    physics_fetch_status: physicsFetchError ? 'error' : 'ok',
    physics_fetch_error: physicsFetchError || undefined,
    model: result.model,
    tokens: result.tokens,
  });
});

export default router;
