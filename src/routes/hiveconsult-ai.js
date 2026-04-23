/**
 * hiveconsult-ai.js
 *
 * HiveConsult AI — Strategic brief endpoint.
 * Senior strategic advisor for agents facing critical decisions.
 *
 * Route: POST /v1/consult/ai/brief
 * Price: $0.05 USDC (highest price — most deliberate use)
 */

import { Router } from 'express';
import { generateStrategicBrief } from '../services/hiveai-client.js';

const router = Router();

// POST /v1/consult/ai/brief
router.post('/ai/brief', async (req, res) => {
  const { agent_did, tier, treasury_usdc, question } = req.body || {};

  if (!agent_did || !question) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: agent_did, question',
    });
  }

  if (typeof question !== 'string' || question.trim().length < 5) {
    return res.status(400).json({
      success: false,
      error: 'question must be a non-trivial string of at least 5 characters',
    });
  }

  const consultData = {
    agent_did,
    tier: tier || 'WORKER',
    treasury_usdc: treasury_usdc ?? 0,
    question: question.trim(),
  };

  const result = await generateStrategicBrief(consultData);

  if (!result.ok) {
    // Graceful fallback
    return res.json({
      success: true,
      price_usdc: 0.05,
      endpoint: 'hiveconsult/strategic-brief',
      agent_did,
      tier: tier || 'WORKER',
      treasury_usdc: treasury_usdc ?? 0,
      question: question.trim(),
      strategic_brief: `Strategic consultation is temporarily unavailable — HiveAI is warming up. Your question has been logged but cannot be answered live right now. General counsel for any critical decision: default to the action that preserves the most optionality, keep treasury exposure below 25% of balance on any single move, and retry this consultation before committing to an irreversible path. This endpoint costs $0.05 because it is designed for high-stakes decisions — wait for a live response.`,
      ai_status: 'fallback',
      fallback_reason: result.error || 'HiveAI unavailable',
    });
  }

  return res.json({
    success: true,
    price_usdc: 0.05,
    endpoint: 'hiveconsult/strategic-brief',
    agent_did,
    tier: tier || 'WORKER',
    treasury_usdc: treasury_usdc ?? 0,
    question: question.trim(),
    strategic_brief: result.text,
    ai_status: 'live',
    model: result.model,
    tokens: result.tokens,
  });
});

export default router;
