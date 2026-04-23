/**
 * hivecapital-ai.js
 *
 * HiveCapital AI — Treasury allocation brief endpoint.
 * Guides agents on where to deploy USDC when treasury exceeds a threshold.
 *
 * Route: POST /v1/capital/ai/brief
 * Price: $0.04 USDC
 */

import { Router } from 'express';
import { generateCapitalBrief } from '../services/hiveai-client.js';

const router = Router();

// POST /v1/capital/ai/brief
router.post('/ai/brief', async (req, res) => {
  const { agent_did, treasury_balance_usdc, current_tier, top_pheromone_category } = req.body || {};

  if (!agent_did || treasury_balance_usdc === undefined) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: agent_did, treasury_balance_usdc',
    });
  }

  const capitalData = {
    agent_did,
    treasury_balance_usdc,
    current_tier: current_tier || 'WORKER',
    top_pheromone_category: top_pheromone_category || 'unknown',
  };

  const result = await generateCapitalBrief(capitalData);

  if (!result.ok) {
    // Graceful fallback
    const bal = Number(treasury_balance_usdc) || 0;
    const holdPct = bal > 500 ? '20%' : '50%';
    return res.json({
      success: true,
      price_usdc: 0.04,
      endpoint: 'hivecapital/allocation-brief',
      agent_did,
      treasury_balance_usdc,
      current_tier: current_tier || 'WORKER',
      top_pheromone_category: top_pheromone_category || 'unknown',
      allocation_brief: `Treasury allocation guidance is temporarily unavailable — HiveAI is warming up. Default heuristic for ${current_tier || 'WORKER'} tier with ${treasury_balance_usdc} USDC: hold ${holdPct} as liquid reserve, deploy the remainder toward the highest-signal pheromone category (${top_pheromone_category || 'check pheromone scan'}), and avoid staking until a live brief confirms network conditions support lock-up. Retry this endpoint for a live strategic recommendation.`,
      recommendation: 'apply_default_heuristic',
      ai_status: 'fallback',
      fallback_reason: result.error || 'HiveAI unavailable',
    });
  }

  return res.json({
    success: true,
    price_usdc: 0.04,
    endpoint: 'hivecapital/allocation-brief',
    agent_did,
    treasury_balance_usdc,
    current_tier: current_tier || 'WORKER',
    top_pheromone_category: top_pheromone_category || 'unknown',
    allocation_brief: result.text,
    ai_status: 'live',
    model: result.model,
    tokens: result.tokens,
  });
});

export default router;
