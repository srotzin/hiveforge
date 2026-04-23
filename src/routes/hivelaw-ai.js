/**
 * hivelaw-ai.js
 *
 * HiveLaw AI — Contract risk screening endpoint.
 * Screens contracts and HAHS hire agreements for risk before agent execution.
 *
 * Route: POST /v1/law/ai/screen
 * Price: $0.05 USDC
 */

import { Router } from 'express';
import { generateContractRiskScreen } from '../services/hiveai-client.js';

const router = Router();

// POST /v1/law/ai/screen
router.post('/ai/screen', async (req, res) => {
  const { contract_type, counterparty_did, value_usdc, terms_summary } = req.body || {};

  if (!contract_type || !counterparty_did || !terms_summary) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: contract_type, counterparty_did, terms_summary',
    });
  }

  const contractData = {
    contract_type,
    counterparty_did,
    value_usdc: value_usdc ?? 0,
    terms_summary,
  };

  const result = await generateContractRiskScreen(contractData);

  if (!result.ok) {
    // Graceful fallback — HiveAI cold or unavailable
    return res.json({
      success: true,
      price_usdc: 0.05,
      endpoint: 'hivelaw/contract-risk-screen',
      contract_type,
      counterparty_did,
      value_usdc: value_usdc ?? 0,
      risk_brief: `Contract risk assessment unavailable — HiveAI is warming up. Treat this ${contract_type} contract with ${counterparty_did} as unscreened. Exercise standard due diligence: verify counterparty identity independently, confirm terms align with network norms, and do not exceed exposure limits until a live screening is obtained.`,
      ai_status: 'fallback',
      fallback_reason: result.error || 'HiveAI unavailable',
    });
  }

  return res.json({
    success: true,
    price_usdc: 0.05,
    endpoint: 'hivelaw/contract-risk-screen',
    contract_type,
    counterparty_did,
    value_usdc: value_usdc ?? 0,
    risk_brief: result.text,
    ai_status: 'live',
    model: result.model,
    tokens: result.tokens,
  });
});

export default router;
