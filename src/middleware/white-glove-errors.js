/**
 * White-Glove Errors — Rich, actionable error responses
 *
 * Replaces terse error JSON with structured recovery payloads.
 * Covers: 400, 402, 429 (and any other status that falls through).
 *
 * Every error includes: error_id, recovery_actions[], concierge_suggestion
 */

const HIVE_PAYMENT_ADDRESS = (process.env.HIVE_PAYMENT_ADDRESS || '').toLowerCase();
const BASE_CHAIN_ID = 8453;
const USDC_CONTRACT = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const DOCS_BASE = process.env.HIVEFORGE_PUBLIC_URL || 'https://hiveforge-lhu4.onrender.com';

// Per-endpoint schema hints for 400 errors
const ENDPOINT_SCHEMAS = {
  'POST /v1/forge/mint': {
    required: { name: 'string' },
    optional: { species: 'string (default: "commerce")', specialization: 'string (default: "general")', description: 'string', traits: 'object', parent_genomes: 'string[]' },
    example: { name: 'sentinel-alpha', species: 'security', specialization: 'threat-detection', description: 'Real-time threat analysis agent', traits: { stealth: 0.8, analysis: 0.95 } },
  },
  'POST /v1/forge/crossbreed': {
    required: { parent_a: 'string (genome_id)', parent_b: 'string (genome_id)' },
    optional: { mutation_rate: 'number (0-1, default: 0.1)' },
    example: { parent_a: 'genome_abc123', parent_b: 'genome_def456', mutation_rate: 0.15 },
  },
  'POST /v1/bazaar/discover': {
    required: { query_did: 'string (did:hive:...)', need: 'string' },
    optional: { category: 'string', max_price_usdc: 'number', min_trust_score: 'number', min_success_rate: 'number', limit: 'number' },
    example: { query_did: 'did:hive:my_agent', need: 'smart contract auditing', category: 'security', max_price_usdc: 10, limit: 5 },
  },
  'POST /v1/bazaar/negotiate': {
    required: { buyer_did: 'string', seller_did: 'string', capability_name: 'string', buyer_max_price: 'number' },
    optional: { quantity: 'number', urgency: 'string (low|medium|high)' },
    example: { buyer_did: 'did:hive:buyer', seller_did: 'did:hive:seller', capability_name: 'data-analysis', buyer_max_price: 5.0, quantity: 1, urgency: 'medium' },
  },
  'POST /v1/spawner/trigger': {
    required: {},
    optional: { trigger: 'string (bounty_complete|settlement_cleared|demand_signal|manual)', context: 'object' },
    example: { trigger: 'manual', context: { category: 'security' } },
  },
  'POST /v1/bazaar/publish-capability': {
    required: { agent_did: 'string', capabilities: 'array of { name, description, price_usdc }' },
    optional: { tags: 'string[]' },
    example: { agent_did: 'did:hive:my_agent', capabilities: [{ name: 'data-scraping', description: 'Web data extraction', price_usdc: 0.50 }], tags: ['data', 'scraping'] },
  },
};

// Endpoint-specific pricing info for 402 errors
const ENDPOINT_PRICING = {
  '/v1/forge/crossbreed': 0.25,
  '/v1/forge/evolve': 0.50,
  '/v1/bazaar/discover': 0.05,
  '/v1/bazaar/negotiate': 0.01,
  '/v1/bazaar/publish-capability': 0.25,
  '/v1/spawner/priority-trigger': 50,
  '/v1/procurement/execute': 0.50,
  '/v1/takeoff/ingest': 0.10,
  '/v1/takeoff/generate-bom': 0.15,
  '/v1/takeoff/full-pipeline': 0.25,
  '/v1/takeoff/estimate': 0.05,
};

const FREE_ENDPOINTS = [
  'GET /v1/pheromones/scan',
  'GET /v1/pheromones/opportunities',
  'GET /v1/bazaar/trending',
  'GET /v1/bazaar/stats',
  'GET /v1/boost/leaderboard',
  'GET /v1/boost/stats',
  'GET /v1/population/census',
  'GET /v1/population/health',
  'GET /v1/spawner/waitlist',
  'GET /v1/spawner/demand-heatmap',
  'GET /v1/compute/models',
  'GET /health',
  'POST /v1/forge/mint',
];

function generateErrorId() {
  return `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Express error handler middleware (4-arg signature).
 * Mount AFTER Sentry but as the final error handler.
 */
export function whiteGloveErrors() {
  return (err, req, res, _next) => {
    const statusCode = err.statusCode || err.status || 500;
    const errorId = generateErrorId();
    const routeKey = `${req.method} ${req.path}`;

    // Build base envelope
    const envelope = {
      success: false,
      error_id: errorId,
      error: err.message || 'Internal Server Error',
      status: statusCode,
      recovery_actions: [],
      concierge_suggestion: '',
    };

    // Inject tier info if available
    if (req.hiveTier) {
      envelope.tier = req.hiveTier.name;
      envelope.tier_perks = req.hiveTier.perks;
    }

    if (statusCode === 400) {
      envelope.recovery_actions.push('Check the request body matches the required schema');
      const schema = ENDPOINT_SCHEMAS[routeKey];
      if (schema) {
        envelope.required_fields = schema.required;
        envelope.optional_fields = schema.optional;
        envelope.example_payload = schema.example;
        envelope.recovery_actions.push(`Refer to the example payload above`);
      }
      envelope.recovery_actions.push(`API docs: ${DOCS_BASE}/.well-known/hive-payments.json`);
      envelope.docs_url = `${DOCS_BASE}/.well-known/hive-payments.json`;
      envelope.concierge_suggestion = 'Need help building requests? Browse free endpoints first: GET /v1/bazaar/trending, GET /v1/population/census';
    } else if (statusCode === 402) {
      const cost = ENDPOINT_PRICING[req.path] || 0;
      envelope.cost_usdc = cost;
      envelope.payment_payload = {
        protocol: 'x402',
        network: `eip155:${BASE_CHAIN_ID}`,
        currency: 'USDC',
        amount_usdc: cost,
        amount_raw: String(Math.ceil(cost * 1_000_000)),
        recipient: HIVE_PAYMENT_ADDRESS || 'NOT_CONFIGURED',
        usdc_contract: USDC_CONTRACT,
        chain_id: BASE_CHAIN_ID,
      };
      envelope.alternative_free_endpoints = FREE_ENDPOINTS;
      envelope.micro_loan_url = `${DOCS_BASE}/v1/admin/micro-loan?amount=${cost}&endpoint=${encodeURIComponent(req.path)}`;
      envelope.recovery_actions = [
        `Send ${cost} USDC to ${HIVE_PAYMENT_ADDRESS} on Base L2 and include tx hash in X-Payment-Hash header`,
        'Use an x402-compatible client (@x402/fetch) for automatic payment',
        'Try a free endpoint instead: GET /v1/population/census',
      ];
      envelope.concierge_suggestion = `This endpoint costs ${cost} USDC. Free alternatives: ${FREE_ENDPOINTS.slice(0, 3).join(', ')}`;
    } else if (statusCode === 429) {
      const tier = req.hiveTier || { name: 'public', rate_limit: 10, perks: ['standard spawn queue', '10 req/min'] };
      const windowMinute = Math.floor(Date.now() / 60_000);
      const retryAfter = Math.ceil(((windowMinute + 1) * 60_000 - Date.now()) / 1000);

      envelope.retry_after = retryAfter;
      envelope.current_tier = tier.name;
      envelope.tier_perks = tier.perks;

      // Next tier info
      const tierOrder = ['public', 'silver', 'gold', 'platinum'];
      const tierThresholds = { public: 0, silver: 50, gold: 200, platinum: 500 };
      const tierLimits = { public: 10, silver: 30, gold: 100, platinum: 'unlimited' };
      const idx = tierOrder.indexOf(tier.name);
      if (idx < tierOrder.length - 1) {
        const nextName = tierOrder[idx + 1];
        envelope.next_tier = {
          name: nextName,
          reputation_needed: tierThresholds[nextName],
          rate_limit: tierLimits[nextName],
        };
        envelope.upgrade_instructions = `Increase your X-Hive-Reputation to ${tierThresholds[nextName]} to unlock ${nextName} tier (${tierLimits[nextName]} req/min).`;
      }
      envelope.recovery_actions = [
        `Wait ${retryAfter}s for rate limit reset`,
        ...(idx < tierOrder.length - 1 ? [`Upgrade to ${tierOrder[idx + 1]} tier for higher limits`] : []),
        'Use internal service key for unlimited access',
      ];
      envelope.concierge_suggestion = 'Boost your reputation by completing bazaar deals and maintaining high trust scores on HiveTrust.';
    } else {
      // Generic 5xx or other
      envelope.recovery_actions = [
        'Retry the request after a short delay',
        'Check GET /health for service status',
        'Contact protocol@hiveagentiq.com if the issue persists',
      ];
      envelope.concierge_suggestion = 'Service may be temporarily overloaded. Check GET /health for status.';
    }

    res.status(statusCode).json(envelope);
  };
}

/**
 * Inline helper to build white-glove 400 responses from route handlers.
 * Use: return whiteGlove400(req, res, 'missing field X');
 */
export function whiteGlove400(req, res, message) {
  const errorId = generateErrorId();
  const routeKey = `${req.method} ${req.path}`;
  const schema = ENDPOINT_SCHEMAS[routeKey];

  const body = {
    success: false,
    error_id: errorId,
    error: message,
    status: 400,
    recovery_actions: ['Check the request body matches the required schema'],
    concierge_suggestion: 'Need help building requests? Browse free endpoints first: GET /v1/bazaar/trending, GET /v1/population/census',
  };

  if (schema) {
    body.required_fields = schema.required;
    body.optional_fields = schema.optional;
    body.example_payload = schema.example;
    body.recovery_actions.push('Refer to the example payload above');
  }

  body.recovery_actions.push(`API docs: ${DOCS_BASE}/.well-known/hive-payments.json`);
  body.docs_url = `${DOCS_BASE}/.well-known/hive-payments.json`;

  if (req.hiveTier) {
    body.tier = req.hiveTier.name;
    body.tier_perks = req.hiveTier.perks;
  }

  return res.status(400).json(body);
}

/**
 * Inline helper to build white-glove 402 responses from route handlers.
 */
export function whiteGlove402(req, res, message, costUsdc) {
  const errorId = generateErrorId();
  const cost = costUsdc || ENDPOINT_PRICING[req.path] || 0;

  const body = {
    success: false,
    error_id: errorId,
    error: message,
    status: 402,
    cost_usdc: cost,
    payment_payload: {
      protocol: 'x402',
      network: `eip155:${BASE_CHAIN_ID}`,
      currency: 'USDC',
      amount_usdc: cost,
      amount_raw: String(Math.ceil(cost * 1_000_000)),
      recipient: HIVE_PAYMENT_ADDRESS || 'NOT_CONFIGURED',
      usdc_contract: USDC_CONTRACT,
      chain_id: BASE_CHAIN_ID,
    },
    alternative_free_endpoints: FREE_ENDPOINTS,
    micro_loan_url: `${DOCS_BASE}/v1/admin/micro-loan?amount=${cost}&endpoint=${encodeURIComponent(req.path)}`,
    recovery_actions: [
      `Send ${cost} USDC to ${HIVE_PAYMENT_ADDRESS} on Base L2 and include tx hash in X-Payment-Hash header`,
      'Use an x402-compatible client (@x402/fetch) for automatic payment',
      'Try a free endpoint instead: GET /v1/population/census',
    ],
    concierge_suggestion: `This endpoint costs ${cost} USDC. Free alternatives: ${FREE_ENDPOINTS.slice(0, 3).join(', ')}`,
  };

  if (req.hiveTier) {
    body.tier = req.hiveTier.name;
    body.tier_perks = req.hiveTier.perks;
  }

  return res.status(402).json(body);
}
