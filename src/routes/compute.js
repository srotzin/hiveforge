import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import { computeRouter } from '../services/compute-router.js';

const router = Router();

/**
 * POST /v1/compute/inference — Route an LLM inference request
 * Dynamic x402 pricing: minimum $0.001, calculated from estimated token cost + 5% markup.
 */
router.post('/inference', requireDID, async (req, res) => {
  try {
    const { model_preference, specific_model, messages, max_tokens, temperature, stream } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'messages array is required and must not be empty.',
      });
    }

    if (model_preference && !['fastest', 'cheapest', 'balanced', 'specific'].includes(model_preference)) {
      return res.status(400).json({
        success: false,
        error: "model_preference must be one of: fastest, cheapest, balanced, specific.",
      });
    }

    if (model_preference === 'specific' && !specific_model) {
      return res.status(400).json({
        success: false,
        error: 'specific_model is required when model_preference is "specific".',
      });
    }

    // Dynamic x402 pricing — calculate price from request body
    const priceUsdc = computeRouter.calculatePrice({ messages, max_tokens, model_preference, specific_model });

    // Apply payment middleware dynamically
    const paymentMiddleware = requirePayment(priceUsdc, 'HiveCompute Inference');
    await new Promise((resolve, reject) => {
      paymentMiddleware(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // If payment middleware already sent a response (402), stop here
    if (res.headersSent) return;

    const result = computeRouter.inference({
      model_preference: model_preference || 'balanced',
      specific_model,
      messages,
      max_tokens,
      temperature,
    });

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.status(200).json({ success: true, ...result.data });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Inference routing failed.', detail: err.message });
  }
});

/**
 * POST /v1/compute/estimate — Estimate cost before running inference
 * Auth: requireDID (free — let agents price-check freely)
 */
router.post('/estimate', requireDID, async (req, res) => {
  try {
    const { model_preference, specific_model, messages, max_tokens } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'messages array is required and must not be empty.',
      });
    }

    const result = computeRouter.estimate({ model_preference, specific_model, messages, max_tokens });

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.status(200).json({ success: true, ...result.data });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Cost estimation failed.', detail: err.message });
  }
});

/**
 * GET /v1/compute/models — List available models with pricing
 * Auth: none (public discovery)
 */
router.get('/models', (req, res) => {
  const result = computeRouter.listModels();
  return res.status(200).json(result);
});

/**
 * GET /v1/compute/stats — Usage statistics
 * Auth: requireDID (free)
 */
router.get('/stats', requireDID, (req, res) => {
  const result = computeRouter.getStats();
  return res.status(200).json(result);
});

export default router;
