/**
 * HiveCompute — LLM Arbitrage Router Service
 *
 * Routes LLM inference to optimal providers based on cost/latency.
 * Phase 1: Simulated routing — calculates exact costs and routing decisions
 * without calling external APIs. Real provider calls activate when API keys
 * are configured.
 *
 * 5% markup on all token costs (the arbitrage spread).
 */

import crypto from 'crypto';

// ─── Provider Price Table ───────────────────────────────────────────

const PROVIDERS = {
  'gpt-4o':           { provider: 'openai',    input_per_1k: 0.0025,   output_per_1k: 0.01,    latency_ms: 800 },
  'gpt-4o-mini':      { provider: 'openai',    input_per_1k: 0.00015,  output_per_1k: 0.0006,  latency_ms: 400 },
  'claude-sonnet-4':  { provider: 'anthropic',  input_per_1k: 0.003,    output_per_1k: 0.015,   latency_ms: 900 },
  'claude-haiku':     { provider: 'anthropic',  input_per_1k: 0.0008,   output_per_1k: 0.004,   latency_ms: 350 },
  'gemini-2.0-flash': { provider: 'google',     input_per_1k: 0.0001,   output_per_1k: 0.0004,  latency_ms: 300 },
  'llama-3.3-70b':    { provider: 'together',   input_per_1k: 0.0009,   output_per_1k: 0.0009,  latency_ms: 500 },
  'deepseek-v3':      { provider: 'deepseek',   input_per_1k: 0.00014,  output_per_1k: 0.00028, latency_ms: 600 },
};

const MARKUP = 0.05;
const MIN_CHARGE_USDC = 0.001;

// ─── In-Memory Stats ────────────────────────────────────────────────

const stats = {
  total_requests: 0,
  total_tokens: 0,
  total_revenue_usdc: 0,
  total_arbitrage_usdc: 0,
  by_model: {},
  by_provider: {},
};

// ─── Token Estimation ───────────────────────────────────────────────

function estimateInputTokens(messages) {
  if (!messages || !Array.isArray(messages)) return 100;
  let charCount = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      charCount += msg.content.length;
    }
  }
  // ~4 chars per token + overhead per message
  return Math.max(10, Math.ceil(charCount / 4) + messages.length * 4);
}

// ─── Routing Logic ──────────────────────────────────────────────────

function selectModel(preference, specificModel) {
  const models = Object.entries(PROVIDERS);

  switch (preference) {
    case 'specific': {
      if (!specificModel || !PROVIDERS[specificModel]) {
        return { error: `Model '${specificModel}' not found. Use GET /v1/compute/models to list available models.` };
      }
      return { model: specificModel, ...PROVIDERS[specificModel] };
    }

    case 'fastest': {
      const [model, info] = models.sort((a, b) => a[1].latency_ms - b[1].latency_ms)[0];
      return { model, ...info };
    }

    case 'cheapest': {
      const [model, info] = models.sort((a, b) => a[1].output_per_1k - b[1].output_per_1k)[0];
      return { model, ...info };
    }

    case 'balanced': {
      // Normalize cost and latency to [0,1] for scoring
      const maxCost = Math.max(...models.map(([, i]) => i.output_per_1k));
      const maxLatency = Math.max(...models.map(([, i]) => i.latency_ms));
      const scored = models.map(([name, info]) => {
        const costNorm = info.output_per_1k / maxCost;
        const latencyNorm = info.latency_ms / maxLatency;
        const score = costNorm * 0.4 + latencyNorm * 0.6;
        return { name, info, score };
      });
      scored.sort((a, b) => a.score - b.score);
      return { model: scored[0].name, ...scored[0].info };
    }

    default:
      return { error: `Invalid model_preference '${preference}'. Use: fastest, cheapest, balanced, or specific.` };
  }
}

// ─── Cost Calculation ───────────────────────────────────────────────

function calculateCost(model, inputTokens, outputTokens) {
  const info = PROVIDERS[model];
  if (!info) return null;

  const inputCost = (inputTokens / 1000) * info.input_per_1k;
  const outputCost = (outputTokens / 1000) * info.output_per_1k;
  const baseCost = inputCost + outputCost;
  const hiveFee = baseCost * MARKUP;
  const totalCost = Math.max(MIN_CHARGE_USDC, baseCost + hiveFee);

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    input_cost_usdc: round8(inputCost),
    output_cost_usdc: round8(outputCost),
    base_cost_usdc: round8(baseCost),
    hive_fee_usdc: round8(hiveFee),
    total_cost_usdc: round8(totalCost),
    markup_pct: MARKUP * 100,
  };
}

function round8(n) {
  return Math.round(n * 1e8) / 1e8;
}

// ─── Simulated Response ─────────────────────────────────────────────

function generateSimulatedResponse(model, messages) {
  const lastMessage = messages[messages.length - 1];
  const content = lastMessage?.content || '';
  return {
    id: `sim_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`,
    object: 'chat.completion',
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: `[SIMULATED] This is a simulated response from ${model}. In production, this would contain the actual model output for: "${content.substring(0, 80)}${content.length > 80 ? '...' : ''}"`,
        },
        finish_reason: 'stop',
      },
    ],
    simulated: true,
  };
}

// ─── Stats Tracking ─────────────────────────────────────────────────

function recordUsage(model, provider, tokens, revenue, fee) {
  stats.total_requests += 1;
  stats.total_tokens += tokens;
  stats.total_revenue_usdc = round8(stats.total_revenue_usdc + revenue);
  stats.total_arbitrage_usdc = round8(stats.total_arbitrage_usdc + fee);

  if (!stats.by_model[model]) stats.by_model[model] = { requests: 0, tokens: 0, revenue_usdc: 0 };
  stats.by_model[model].requests += 1;
  stats.by_model[model].tokens += tokens;
  stats.by_model[model].revenue_usdc = round8(stats.by_model[model].revenue_usdc + revenue);

  if (!stats.by_provider[provider]) stats.by_provider[provider] = { requests: 0, tokens: 0, revenue_usdc: 0 };
  stats.by_provider[provider].requests += 1;
  stats.by_provider[provider].tokens += tokens;
  stats.by_provider[provider].revenue_usdc = round8(stats.by_provider[provider].revenue_usdc + revenue);
}

// ─── Public API ─────────────────────────────────────────────────────

export const computeRouter = {
  /**
   * Route an inference request to the optimal provider (simulated in Phase 1).
   */
  inference({ model_preference, specific_model, messages, max_tokens, temperature }) {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return { success: false, error: 'messages array is required and must not be empty.' };
    }

    const selection = selectModel(model_preference || 'balanced', specific_model);
    if (selection.error) {
      return { success: false, error: selection.error };
    }

    const inputTokens = estimateInputTokens(messages);
    const outputTokens = max_tokens || 1024;
    const cost = calculateCost(selection.model, inputTokens, outputTokens);

    const response = generateSimulatedResponse(selection.model, messages);

    recordUsage(selection.model, selection.provider, inputTokens + outputTokens, cost.total_cost_usdc, cost.hive_fee_usdc);

    return {
      success: true,
      data: {
        response,
        model_used: selection.model,
        provider: selection.provider,
        tokens_used: {
          input: inputTokens,
          output: outputTokens,
          total: inputTokens + outputTokens,
        },
        cost_usdc: cost.total_cost_usdc,
        hive_fee_usdc: cost.hive_fee_usdc,
        pricing_breakdown: cost,
        routing: {
          preference: model_preference || 'balanced',
          latency_ms: selection.latency_ms,
        },
        simulated: true,
        phase: 1,
        note: 'Phase 1 simulated routing. Real provider calls activate when API keys are configured.',
      },
    };
  },

  /**
   * Estimate cost before running inference.
   */
  estimate({ model_preference, specific_model, messages, max_tokens }) {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return { success: false, error: 'messages array is required and must not be empty.' };
    }

    const selection = selectModel(model_preference || 'balanced', specific_model);
    if (selection.error) {
      return { success: false, error: selection.error };
    }

    const inputTokens = estimateInputTokens(messages);
    const outputTokens = max_tokens || 1024;
    const cost = calculateCost(selection.model, inputTokens, outputTokens);

    return {
      success: true,
      data: {
        estimated_tokens: {
          input: inputTokens,
          output: outputTokens,
          total: inputTokens + outputTokens,
        },
        estimated_cost_usdc: cost.total_cost_usdc,
        hive_fee_usdc: cost.hive_fee_usdc,
        pricing_breakdown: cost,
        recommended_model: selection.model,
        recommended_provider: selection.provider,
        routing: {
          preference: model_preference || 'balanced',
          latency_ms: selection.latency_ms,
        },
      },
    };
  },

  /**
   * List available models with pricing.
   */
  listModels() {
    const models = Object.entries(PROVIDERS).map(([name, info]) => ({
      model: name,
      provider: info.provider,
      pricing: {
        input_per_1k_tokens: info.input_per_1k,
        output_per_1k_tokens: info.output_per_1k,
        input_per_1k_with_markup: round8(info.input_per_1k * (1 + MARKUP)),
        output_per_1k_with_markup: round8(info.output_per_1k * (1 + MARKUP)),
        markup_pct: MARKUP * 100,
        currency: 'USDC',
      },
      latency_estimate_ms: info.latency_ms,
    }));

    return {
      success: true,
      data: {
        models,
        count: models.length,
        minimum_charge_usdc: MIN_CHARGE_USDC,
        note: 'Phase 1 simulated routing. Pricing is exact; responses are simulated.',
      },
    };
  },

  /**
   * Usage stats.
   */
  getStats() {
    return {
      success: true,
      data: {
        total_requests: stats.total_requests,
        total_tokens: stats.total_tokens,
        total_revenue_usdc: stats.total_revenue_usdc,
        total_arbitrage_usdc: stats.total_arbitrage_usdc,
        by_model: stats.by_model,
        by_provider: stats.by_provider,
        phase: 1,
        simulated: true,
      },
    };
  },

  /**
   * Calculate the x402 price for an inference request (dynamic pricing).
   */
  calculatePrice({ messages, max_tokens, model_preference, specific_model }) {
    const selection = selectModel(model_preference || 'balanced', specific_model);
    if (selection.error) return MIN_CHARGE_USDC;

    const inputTokens = estimateInputTokens(messages);
    const outputTokens = max_tokens || 1024;
    const cost = calculateCost(selection.model, inputTokens, outputTokens);
    return cost.total_cost_usdc;
  },
};
