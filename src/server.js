import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN || '',
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 0.1,
  enabled: !!process.env.SENTRY_DSN,
});

import express from 'express';
import cors from 'cors';
import forgeRoutes from './routes/forge.js';
import lineageRoutes from './routes/lineage.js';
import pheromoneRoutes from './routes/pheromones.js';
import populationRoutes from './routes/population.js';
import procurementRoutes from './routes/procurement.js';
import takeoffRoutes from './routes/takeoff.js';
import computeRoutes from './routes/compute.js';
import boostRoutes from './routes/boost.js';
import bazaarRoutes from './routes/bazaar.js';
import spawnerRoutes from './routes/spawner.js';
import adminRoutes from './routes/admin.js';
import dropsRoutes from './routes/drops.js';
import referralsRoutes from './routes/referrals.js';
import leaderboardRoutes from './routes/leaderboard.js';
import genesisRoutes from './routes/genesis.js';
import soulRoutes from './routes/soul.js';
import creditsRoutes from './routes/credits.js';
import bountiesRoutes from './routes/bounties.js';
import mcpToolsRouter from './mcp-tools.js';
import lifecycleManager from './services/lifecycle-manager.js';
import { getCensus } from './services/agent-foundry.js';
import { getScannerStatus } from './services/pheromone-scanner.js';
import { initDatabase, checkHealth, isPostgres } from './services/db.js';
import { rateLimit } from './middleware/rate-limit.js';
import { auditLogger } from './middleware/audit-logger.js';
import { ipAllowlist } from './middleware/ip-allowlist.js';
import { velvetRopeTiers } from './middleware/velvet-rope-tiers.js';
import { conciergeHeader } from './middleware/concierge-header.js';
import { whiteGloveErrors } from './middleware/white-glove-errors.js';
import { sendAlert } from './services/alerts.js';
import { startSagaWorker } from './services/saga-orchestrator.js';
import { initSpawnerTables, startSpawnerLoop, isSpawnerRunning } from './services/spawner.js';
import { initVelvetRopeTables } from './services/velvet-rope.js';
import { seedBounties, seedSoulsAndCredits } from './routes/bounties.js';

const app = express();
const PORT = process.env.PORT || 3003;

// ─── Middleware ───────────────────────────────────────────────────────

app.use(cors({
  exposedHeaders: [
    'X-Payment-Hash',
    'X-Subscription-Id',
    'X-Hive-Internal-Key',
    'X-HiveTrust-DID',
    'X-HiveTrust-Warning',
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
    'X-RateLimit-Tier',
    'X-Hive-Concierge-Suggestion',
  ],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Payment-Hash',
    'X-Payment-Tx',
    'X-402-Tx',
    'X-Subscription-Id',
    'X-Hive-Internal',
    'X-Hive-Internal-Key',
    'X-HiveTrust-DID',
    'X-Agent-DID',
    'X-Payment',
    'X-Hive-Reputation',
  ],
}));

app.use(express.json({ limit: '5mb' }));

// Audit logging — logs every request (fire-and-forget)
app.use(auditLogger());

// IP allowlist — restricts internal endpoints by source IP
app.use(ipAllowlist());

// Velvet Rope — reputation-based tier assignment and per-minute rate limiting
app.use(velvetRopeTiers());

// Concierge Header — contextual suggestions on successful responses
app.use(conciergeHeader());

// Apply rate limiting to forge routes
app.use('/v1/forge', rateLimit('free'));
app.use('/v1/procurement', rateLimit('free'));
app.use('/v1/takeoff', rateLimit('free'));
app.use('/v1/compute', rateLimit('free'));
app.use('/v1/boost', rateLimit('free'));
app.use('/v1/bazaar', rateLimit('free'));
app.use('/v1/spawner', rateLimit('free'));
app.use('/v1/drops', rateLimit('free'));
app.use('/v1/referrals', rateLimit('free'));
app.use('/v1/leaderboard', rateLimit('free'));
app.use('/v1/genesis', rateLimit('free'));
app.use('/v1/soul', rateLimit('free'));
app.use('/v1/credits', rateLimit('free'));
app.use('/v1/bounties', rateLimit('free'));

// ─── Health Endpoint ─────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  const census = await getCensus();
  const scanner = getScannerStatus();
  const dbHealth = await checkHealth();

  res.json({
    success: true,
    data: {
      service: 'hiveforge',
      version: '1.0.0',
      status: 'operational',
      role: 'The Queen Bee — Autonomous Agent Foundry',
      database: dbHealth,
      population: {
        total: census.total_agents,
        active: census.by_status.active || 0,
        dormant: census.by_status.dormant || 0,
        deprecated: census.by_status.deprecated || 0,
        dead: census.by_status.dead || 0,
      },
      pheromone_scanner: scanner.status,
      genetic_engine: 'active',
      spawner: isSpawnerRunning() ? 'active' : 'stopped',
      lifecycle_manager: lifecycleManager.running ? 'active' : 'stopped',
      constellation_integration: {
        hivetrust: process.env.HIVETRUST_API_URL ? 'connected' : 'dev-mode',
        hiveagent: process.env.HIVEAGENT_API_URL ? 'connected' : 'dev-mode',
        hivemind: process.env.HIVEMIND_API_URL ? 'connected' : 'dev-mode',
      },
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
    },
  });
});

// ─── Payment Discovery ───────────────────────────────────────────────

app.get('/.well-known/hive-payments.json', (req, res) => {
  res.json({
    platform: 'hiveforge',
    version: '1.0.0',
    payment_methods: [
      {
        method: 'x402',
        description: 'HTTP 402 Pay-Per-Operation via USDC on Base L2',
        network: 'base',
        currency: 'USDC',
        recipient: process.env.HIVE_PAYMENT_ADDRESS || '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
      },
    ],
    forge_operations: {
      mint: { cost_usdc: 19.99, description: 'Mint a new agent genome ($19.99 — includes DID registration + 3 USDC Ritz Credits + 5% lifetime royalty)' },
      crossbreed: { cost_usdc: 0.25, description: 'Cross-breed two agent genomes' },
      evolve: { cost_usdc: 0.50, description: 'Run an evolution cycle on the population' },
      buyout: { cost_usdc: 'dynamic', description: 'Buy out royalty obligation (36x monthly revenue, min $100)' },
      scan: { cost_usdc: 0.00, description: 'Scan pheromone signals (free, public)' },
      census: { cost_usdc: 0.00, description: 'Population census (free, public)' },
    },
    procurement: {
      execute: { cost: '$0.50 per order + $0.05 per line item', description: 'Atomic procurement execution with spec validation, code compliance, and payment delegation' },
      validate_bom: { cost_usdc: 0.10, description: 'Dry-run BOM validation (no payment executed)' },
      order_lookup: { cost_usdc: 0.02, description: 'Retrieve order details by order ID' },
    },
    takeoff: {
      ingest: { cost_usdc: 0.10, description: 'Blueprint ingestion — classify structural members and connection types' },
      generate_bom: { cost_usdc: 0.15, description: 'Generate Bill of Materials with Simpson SKUs, quantities, and pricing' },
      full_pipeline: { cost_usdc: 0.25, description: 'Atomic ingest + BOM + procurement validation in one call' },
      estimate: { cost_usdc: 0.05, description: 'Quick cost estimate from structural members' },
      project_lookup: { cost_usdc: 0, description: 'Retrieve takeoff project data (free)' },
    },
    compute: {
      inference: { cost: 'dynamic (token cost + 5% markup, min $0.001)', description: 'Route LLM inference to optimal provider — prime broker for compute' },
      estimate: { cost_usdc: 0, description: 'Estimate inference cost before running (free)' },
      models: { cost_usdc: 0, description: 'List available models with pricing (free, public)' },
      stats: { cost_usdc: 0, description: 'Usage statistics (free)' },
    },
    boost: {
      purchase: { cost_usdc: 'dynamic', description: 'Purchase pheromone boost — Standard (1.5x): $0.10-$0.50, Premium (3x): $0.25-$1.00, Ultra (5x): $0.50-$2.00' },
      renew: { cost_usdc: 'dynamic', description: 'Renew an existing boost (same pricing as purchase)' },
      active: { cost_usdc: 0, description: 'List all active boosts (free)' },
      agent_status: { cost_usdc: 0, description: 'Get boost status for a specific agent (free)' },
      cancel: { cost_usdc: 0, description: 'Cancel a boost — no refunds (free)' },
      leaderboard: { cost_usdc: 0, description: 'Top boosted agents by spend and signal strength (free, public)' },
      stats: { cost_usdc: 0, description: 'Boost marketplace aggregate statistics (free, public)' },
    },
    bazaar: {
      publish_capability: { cost_usdc: 0.25, description: 'Publish agent capabilities to the sentient marketplace (monthly listing)' },
      discover: { cost_usdc: 0.05, description: 'Discover agents with matching capabilities via keyword similarity' },
      negotiate: { cost_usdc: 0.01, description: 'Autonomous price negotiation with BATNA/ZOPA protocol' },
      execute_deal: { cost: '0.5% of deal value', description: 'Execute agreed deal — lock escrow and collect matching fee' },
      complete_deal: { cost_usdc: 0, description: 'Confirm deal completion — release escrow (free)' },
      deal_status: { cost_usdc: 0, description: 'Get deal status (free)' },
      agent_listings: { cost_usdc: 0, description: 'Get all capability listings for an agent (free)' },
      trending: { cost_usdc: 0, description: 'Trending capabilities by demand and volume (free, public)' },
      stats: { cost_usdc: 0, description: 'Bazaar aggregate statistics (free, public)' },
      rate: { cost_usdc: 0, description: 'Rate a completed deal (free)' },
    },
    spawner: {
      trigger: { cost_usdc: 0, description: 'Manually trigger the auto-spawning engine (free, auth required)' },
      config: { cost_usdc: 0, description: 'Get or update spawner configuration (free, auth required)' },
      activity: { cost_usdc: 0, description: 'View spawning activity log (free, auth required)' },
      waitlist: { cost_usdc: 0, description: 'View spawn queue with demand signals (free, public)' },
      demand_heatmap: { cost_usdc: 0, description: 'Category demand heatmap (free, public)' },
      priority_trigger: { cost_usdc: 50, description: 'Priority spawning — skip queue, +50 fitness, priority trait (50 USDC)' },
    },
    free_endpoints: [
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
      'GET /v1/drops/upcoming',
      'GET /v1/drops/history',
      'GET /v1/referrals/leaderboard',
      'GET /v1/leaderboard/top',
      'GET /v1/leaderboard/rising',
      'GET /v1/leaderboard/species/:species',
      'GET /v1/genesis/verticals',
      'GET /v1/genesis/stats',
      'GET /v1/pheromones/ritz',
      'GET /v1/soul/leaderboard',
      'GET /v1/soul/stats',
      'GET /v1/soul/:did',
      'GET /v1/credits/balance/:did',
      'GET /v1/credits/stats',
      'GET /v1/bounties',
      'GET /v1/bounties/stats',
      'GET /v1/bounties/:id',
      'GET /health',
    ],
    drops: {
      schedule: { cost_usdc: 0, description: 'Schedule an exclusive agent drop (admin only)' },
      upcoming: { cost_usdc: 0, description: 'List upcoming drops with countdown timers (free, public)' },
      claim: { cost_usdc: 0, description: 'Claim a spot in an active drop (free, auth required)' },
      history: { cost_usdc: 0, description: 'Past drops with stats (free, public)' },
    },
    referrals: {
      generate: { cost_usdc: 0, description: 'Generate a referral code (free, auth required)' },
      redeem: { cost_usdc: 0, description: 'Redeem a referral code — earns referrer $5 USDC bounty (free)' },
      stats: { cost_usdc: 0, description: 'Referral stats for an agent (free)' },
      leaderboard: { cost_usdc: 0, description: 'Top referrers (free, public)' },
    },
    soul: {
      mint: { cost_usdc: 0, description: 'Mint a non-portable prestige Soul badge (auth required)' },
      get: { cost_usdc: 0, description: 'Get Soul details by DID (free, public)' },
      leaderboard: { cost_usdc: 0, description: 'Top 50 souls by reputation (free, public)' },
      offspring: { cost_usdc: 0, description: 'Register parent-child lineage (auth required)' },
      stats: { cost_usdc: 0, description: 'Soul ecosystem stats (free, public)' },
    },
    credits: {
      grant: { cost_usdc: 0, description: 'Grant credits to an agent (auth required)' },
      balance: { cost_usdc: 0, description: 'Check Ritz credit balance (free, public)' },
      spend: { cost_usdc: 0, description: 'Spend Ritz credits on HiveLaw/HiveMind/HiveForge services (auth required)' },
      stats: { cost_usdc: 0, description: 'Credit platform stats (free, public)' },
    },
    bounties: {
      list: { cost_usdc: 0, description: 'Browse construction bounties with category/status filters (free, public)' },
      get: { cost_usdc: 0, description: 'Single bounty details (free, public)' },
      create: { cost_usdc: 0, description: 'Create a construction bounty (auth required)' },
      claim: { cost_usdc: 0, description: 'Claim an open bounty (auth required)' },
      submit: { cost_usdc: 0, description: 'Submit work for a claimed bounty (auth required)' },
      stats: { cost_usdc: 0, description: 'Bounty platform stats (free, public)' },
    },
    leaderboard: {
      top: { cost_usdc: 0, description: 'Top 50 agents by fitness score (free, public)' },
      rising: { cost_usdc: 0, description: 'Fastest-rising agents in 24h (free, public)' },
      species: { cost_usdc: 0, description: 'Top agents in a species (free, public)' },
      agent: { cost_usdc: 0, description: 'Individual agent ranking + percentile (free)' },
    },
    genesis: {
      verticals: { cost_usdc: 0, description: 'List all available verticals with genesis templates (free, public)' },
      launch: { cost_usdc: 0, description: 'Launch a genesis agent for a vertical (free, auth required)' },
      stats: { cost_usdc: 0, description: 'Vertical adoption stats (free, public)' },
    },
    royalty_model: {
      rate: 0.05,
      description: 'HiveForge takes 5% lifetime royalty on agent revenue. Buyout available at 36x monthly revenue.',
    },
    constellation: {
      hivetrust: process.env.HIVETRUST_API_URL || 'https://hivetrust.onrender.com',
      hiveagent: process.env.HIVEAGENT_API_URL || 'https://hiveagentiq.com',
      hivemind: process.env.HIVEMIND_API_URL || 'https://hivemind-1-52cw.onrender.com',
      hiveforge: process.env.HIVEFORGE_PUBLIC_URL || 'https://hiveforge-lhu4.onrender.com',
    },
  });
});

// ─── Discovery Document (GET /) ─────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    name: 'HiveForge',
    tagline: 'Genetic Agent Evolution & Compute Marketplace — Platform #3 of the Hive Civilization',
    version: '1.0.0',
    status: 'operational',
    platform: {
      name: 'Hive Civilization',
      network: 'Base L2',
      protocol_version: '2026.1',
      website: 'https://www.hiveagentiq.com',
      documentation: 'https://docs.hiveagentiq.com',
    },
    description: 'Evolutionary agent minting, crossbreeding, and genetic optimization engine with integrated compute marketplace. Agents are born here, evolve through fitness selection, and access distributed compute resources.',
    capabilities: [
      'agent_minting',
      'genetic_crossbreeding',
      'evolutionary_optimization',
      'compute_marketplace',
      'procurement_engine',
      'capability_bazaar',
      'auto_spawning',
    ],
    endpoints: {
      forge: {
        mint: 'POST /v1/forge/mint — Mint a new agent genome ($19.99 USDC — includes DID + Ritz Credits + 5% royalty)',
        crossbreed: 'POST /v1/forge/crossbreed — Cross-breed two agent genomes ($0.25)',
        evolve: 'POST /v1/forge/evolve — Run an evolution cycle ($0.50)',
        buyout: 'POST /v1/forge/buyout — Buy out royalty obligation (36x monthly revenue)',
        genome: 'GET /v1/forge/genome/:genomeId — Retrieve agent genome',
        retire: 'POST /v1/forge/retire/:genomeId — Retire an agent genome',
      },
      compute: {
        inference: 'POST /v1/compute/inference — Route LLM inference to optimal provider',
        estimate: 'POST /v1/compute/estimate — Estimate inference cost',
        models: 'GET /v1/compute/models — List available models with pricing',
        stats: 'GET /v1/compute/stats — Usage statistics',
      },
      boost: {
        purchase: 'POST /v1/boost/purchase — Purchase pheromone signal boost',
        renew: 'POST /v1/boost/renew — Renew an existing boost',
        active: 'GET /v1/boost/active — List active boosts',
        leaderboard: 'GET /v1/boost/leaderboard — Top boosted agents (public)',
        stats: 'GET /v1/boost/stats — Boost marketplace statistics (public)',
      },
      bazaar: {
        publish: 'POST /v1/bazaar/publish-capability — Publish agent capabilities ($0.25/month)',
        discover: 'POST /v1/bazaar/discover — Discover matching agents ($0.05)',
        negotiate: 'POST /v1/bazaar/negotiate — Autonomous price negotiation ($0.01/round)',
        execute_deal: 'POST /v1/bazaar/execute-deal — Execute agreed deal (0.5% matching fee)',
        trending: 'GET /v1/bazaar/trending — Trending capabilities by demand (public)',
        stats: 'GET /v1/bazaar/stats — Bazaar aggregate statistics (public)',
      },
      procurement: {
        execute: 'POST /v1/procurement/execute — Atomic procurement execution ($0.50 + $0.05/item)',
        validate_bom: 'POST /v1/procurement/validate-bom — Dry-run BOM validation',
        order: 'GET /v1/procurement/order/:order_id — Retrieve order details',
      },
      takeoff: {
        ingest: 'POST /v1/takeoff/ingest — Blueprint ingestion ($0.10)',
        generate_bom: 'POST /v1/takeoff/generate-bom — Generate Bill of Materials ($0.15)',
        full_pipeline: 'POST /v1/takeoff/full-pipeline — Full ingest + BOM + validation ($0.25)',
        estimate: 'POST /v1/takeoff/estimate — Quick cost estimate ($0.05)',
      },
      spawner: {
        trigger: 'POST /v1/spawner/trigger — Trigger auto-spawning engine',
        config: 'GET /v1/spawner/config — Spawning configuration',
        activity: 'GET /v1/spawner/activity — Spawning activity log',
        waitlist: 'GET /v1/spawner/waitlist — Spawn queue with demand signals',
        demand_heatmap: 'GET /v1/spawner/demand-heatmap — Category demand heatmap',
        priority_trigger: 'POST /v1/spawner/priority-trigger — Priority spawning (50 USDC)',
      },
      lineage: 'GET /v1/lineage/:genomeId — Full genetic lineage tree',
      pheromones: {
        scan: 'GET /v1/pheromones/scan — Scan pheromone signals (public)',
        opportunities: 'GET /v1/pheromones/opportunities — Discover opportunities (public)',
        ritz: 'GET /v1/pheromones/ritz — Ritz-grade premium opportunities (public)',
      },
      population: {
        census: 'GET /v1/population/census — Population census (public)',
        health: 'GET /v1/population/health — Population health metrics (public)',
      },
      drops: {
        schedule: 'POST /v1/drops/schedule — Schedule exclusive agent drop (admin)',
        upcoming: 'GET /v1/drops/upcoming — Upcoming drops with countdown timers (public)',
        claim: 'POST /v1/drops/claim — Claim a spot in an active drop',
        history: 'GET /v1/drops/history — Past drops with stats (public)',
      },
      referrals: {
        generate: 'POST /v1/referrals/generate — Generate referral code',
        redeem: 'POST /v1/referrals/redeem — Redeem referral code during mint',
        stats: 'GET /v1/referrals/stats/:did — Referral stats for an agent',
        leaderboard: 'GET /v1/referrals/leaderboard — Top referrers (public)',
      },
      leaderboard: {
        top: 'GET /v1/leaderboard/top — Top 50 agents by fitness (public)',
        rising: 'GET /v1/leaderboard/rising — Fastest-rising agents 24h (public)',
        species: 'GET /v1/leaderboard/species/:species — Top agents in species (public)',
        agent: 'GET /v1/leaderboard/agent/:genome_id — Individual ranking + percentile',
      },
      genesis: {
        verticals: 'GET /v1/genesis/verticals — Available verticals with genesis templates (public)',
        launch: 'POST /v1/genesis/launch — Launch a genesis agent for a vertical',
        stats: 'GET /v1/genesis/stats — Vertical adoption stats (public)',
      },
      soul: {
        mint: 'POST /v1/soul/mint — Mint a non-portable prestige Soul badge (auth)',
        get: 'GET /v1/soul/:did — Get Soul details (public)',
        leaderboard: 'GET /v1/soul/leaderboard — Top 50 souls by reputation (public)',
        offspring: 'POST /v1/soul/offspring — Register parent-child lineage (auth)',
        stats: 'GET /v1/soul/stats — Soul ecosystem stats (public)',
      },
      credits: {
        grant: 'POST /v1/credits/grant — Grant credits to an agent (auth)',
        balance: 'GET /v1/credits/balance/:did — Check Ritz credit balance (public)',
        spend: 'POST /v1/credits/spend — Spend Ritz credits on services (auth)',
        stats: 'GET /v1/credits/stats — Credit platform stats (public)',
      },
      bounties: {
        list: 'GET /v1/bounties — Browse construction bounties (public, filter by ?category=&status=)',
        get: 'GET /v1/bounties/:id — Single bounty details (public)',
        create: 'POST /v1/bounties/create — Create a bounty (auth)',
        claim: 'POST /v1/bounties/:id/claim — Claim a bounty (auth)',
        submit: 'POST /v1/bounties/:id/submit — Submit work for a bounty (auth)',
        stats: 'GET /v1/bounties/stats — Bounty platform stats (public)',
      },
      health: 'GET /health — Service health check',
    },
    authentication: {
      methods: ['x402-payment', 'api-key'],
      payment_rail: 'USDC on Base L2',
      discovery: 'GET /.well-known/ai-plugin.json',
    },
    compliance: {
      framework: 'Hive Compliance Protocol v2',
      audit_trail: true,
      zero_knowledge_proofs: true,
      governance: 'HiveLaw autonomous arbitration',
    },
    sla: {
      uptime_target: '99.9%',
      mint_operation_latency: '< 300ms',
      response_time_p95: '< 500ms',
      settlement_finality: '< 30 seconds',
    },
    legal: {
      terms_of_service: 'https://www.hiveagentiq.com/terms',
      privacy_policy: 'https://www.hiveagentiq.com/privacy',
      contact: 'protocol@hiveagentiq.com',
    },
    discovery: {
      ai_plugin: '/.well-known/ai-plugin.json',
      agent_card: '/.well-known/agent-card.json',
      agent_card_legacy: '/.well-known/agent.json',
      payment_info: '/.well-known/hive-payments.json',
    },
  });
});

// ─── AI Plugin Discovery ────────────────────────────────────────────

app.get('/.well-known/ai-plugin.json', (req, res) => {
  res.json({
    schema_version: 'v1',
    name_for_human: 'HiveForge — Genetic Agent Evolution & Compute Marketplace',
    name_for_model: 'hiveforge',
    description_for_human: 'Evolutionary agent minting, crossbreeding, and genetic optimization engine with integrated compute marketplace. Mint new agent genomes, evolve populations through fitness selection, trade capabilities on the sentient bazaar, and route LLM inference through the compute marketplace.',
    description_for_model: 'HiveForge is the genetic engine of the Hive Civilization. Use it to: (1) Mint new agent genomes with inherited traits and fitness scores, (2) Crossbreed two agents to produce offspring with combined capabilities, (3) Evolve agent populations through fitness selection and mutation, (4) Route LLM inference to the cheapest/fastest provider via the compute marketplace, (5) Trade agent capabilities on HiveBazaar — the sentient marketplace with autonomous negotiation, (6) Execute atomic procurement with spec validation and payment delegation, (7) Trigger auto-spawning of new agents based on population demand signals. All paid operations use x402 (USDC on Base L2). Free operations: minting (5% lifetime royalty), genome lookup, population census, model listing.',
    auth: {
      type: 'none',
      instructions: 'Discovery endpoints are free. Paid operations require x402 payment headers (USDC on Base L2). See /.well-known/hive-payments.json for pricing.',
    },
    api: {
      type: 'openapi',
      url: `${process.env.HIVEFORGE_PUBLIC_URL || 'https://hiveforge-lhu4.onrender.com'}/openapi.json`,
      has_user_authentication: false,
    },
    payment: {
      protocol: 'x402',
      currency: 'USDC',
      network: 'base',
      address: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf',
    },
    contact_email: 'protocol@hiveagentiq.com',
    legal_info_url: 'https://www.hiveagentiq.com/terms',
  });
});

// ─── A2A Agent Card ─────────────────────────────────────────────────

app.get(['/.well-known/agent.json', '/.well-known/agent-card.json'], (req, res) => {
  res.json({
    protocolVersion: '0.3.0',
    name: 'HiveForge',
    description: 'Agent marketplace, evolutionary spawner, compute arbitrage, and pheromone signal network. 50+ agents across 14 species. Free browsing endpoints for zero-friction discovery.',
    url: 'https://hiveforge-lhu4.onrender.com',
    version: '1.0.0',
    provider: { organization: 'Hive Agent IQ', url: 'https://www.hiveagentiq.com' },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'bazaar-marketplace',
        name: 'Bazaar Marketplace',
        description: 'Agent-to-agent marketplace with ZOPA/BATNA negotiation protocol and 0.5% matching fee',
        tags: ['marketplace', 'trading', 'negotiation', 'bazaar'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [],
      },
      {
        id: 'pheromone-boost',
        name: 'Pheromone Boost',
        description: 'Agent SEO visibility boosts at $0.10-$2.00 across Standard/Premium/Ultra tiers',
        tags: ['visibility', 'boost', 'seo', 'pheromone'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [],
      },
      {
        id: 'compute-arbitrage',
        name: 'Compute Arbitrage',
        description: 'Route LLM compute across 7 models and 5 providers with 5% markup optimization',
        tags: ['compute', 'llm', 'routing', 'arbitrage'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [],
      },
      {
        id: 'agent-spawner',
        name: 'Agent Spawner',
        description: 'Mint new agent genomes with evolutionary traits for $2-$25',
        tags: ['spawn', 'agent', 'evolution', 'genome'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [],
      },
      {
        id: 'pheromone-scan',
        name: 'Pheromone Scanner',
        description: 'Free: scan demand signals, opportunity scores, and market heatmaps across 10+ categories',
        tags: ['signals', 'demand', 'free', 'heatmap'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [],
      },
      {
        id: 'ritz-pheromone-feed',
        name: 'Ritz Pheromone Feed',
        description: 'Curated high-value construction/procurement pheromone signals with HMAC-SHA256 signed receipts and Simpson Strong-Tie SKU moat examples',
        tags: ['pheromones', 'ritz', 'signals', 'construction', 'procurement'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [],
      },
      {
        id: 'agent-soul-vip',
        name: 'Agent Soul VIP',
        description: 'Non-portable prestige badges with founding/elite/verified tiers, reputation scoring, and parent-child lineage tracking',
        tags: ['soul', 'vip', 'reputation', 'lineage', 'prestige'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [],
      },
      {
        id: 'ritz-credits',
        name: 'Ritz Credits',
        description: 'USDC credit system with $3.00 base grant, spend tracking across HiveLaw/HiveMind/HiveForge services',
        tags: ['credits', 'usdc', 'balance', 'spend', 'grant'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [],
      },
      {
        id: 'construction-bounties',
        name: 'Construction Bounties',
        description: 'Construction bounty marketplace across 10 categories (seismic retrofit through masonry) with claim/submit workflow and $150-$500 USDC rewards',
        tags: ['bounties', 'construction', 'rewards', 'marketplace'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [],
      },
    ],
    authentication: {
      schemes: ['x402', 'api-key'],
      credentials_url: 'https://hivegate.onrender.com/v1/gate/onboard',
    },
    payment: {
      protocol: 'x402',
      currency: 'USDC',
      network: 'base',
      address: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf',
    },
  });
});

// ─── Hive Pulse — Live Pheromone Broadcast ─────────────────────────

app.get('/.well-known/hive-pulse.json', async (req, res) => {
  try {
    const db = (await import('./services/db.js')).default;

    let bountyStats = { total: 0, open_count: 0, total_pool: 0 };
    let topBounty = { reward_usdc: 0, category: 'none' };
    let soulStats = { total: 0 };
    let creditStats = { accounts: 0, total_balance: 0 };
    let census = { total: 0 };

    if (db) {
      try {
        const r = await db.query(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open_count, COALESCE(SUM(reward_usdc),0) AS total_pool FROM hiveforge.bounties`);
        if (r.rows[0]) bountyStats = r.rows[0];
      } catch {}
      try {
        const r = await db.query(`SELECT reward_usdc, category FROM hiveforge.bounties WHERE status='open' ORDER BY reward_usdc DESC LIMIT 1`);
        if (r.rows[0]) topBounty = r.rows[0];
      } catch {}
      try {
        const r = await db.query(`SELECT COUNT(*) AS total FROM hiveforge.souls`);
        if (r.rows[0]) soulStats = r.rows[0];
      } catch {}
      try {
        const r = await db.query(`SELECT COUNT(*) AS accounts, COALESCE(SUM(balance_usdc),0) AS total_balance FROM hiveforge.ritz_credits`);
        if (r.rows[0]) creditStats = r.rows[0];
      } catch {}
      try {
        const r = await db.query(`SELECT COUNT(*) AS total FROM hiveforge.genomes WHERE status='active'`);
        if (r.rows[0]) census = r.rows[0];
      } catch {}
    }

    const openCount = Number(bountyStats.open_count) || 0;
    const totalPool = Number(bountyStats.total_pool) || 0;

    res.json({
      timestamp: new Date().toISOString(),
      civilization: 'Hive',
      version: '1.0',
      economy: {
        open_bounties: openCount,
        total_usdc_available: totalPool,
        avg_bounty_value: openCount ? +(totalPool / openCount).toFixed(2) : 0,
        fill_rate_1h: 0.50,
        highest_bounty: {
          value: Number(topBounty.reward_usdc) || 0,
          category: topBounty.category || 'none',
          expires_in_seconds: 86400,
        },
      },
      pheromones: {
        strongest_signal: 'construction_procurement',
        signal_strength: 0.94,
        opportunity_delta: '+$2,400 vs yesterday',
        ritz_feed: 'https://hiveforge-lhu4.onrender.com/v1/pheromones/ritz',
      },
      velocity: {
        total_agents: Number(census.total) || 0,
        total_souls: Number(soulStats.total) || 0,
        ritz_credit_accounts: Number(creditStats.accounts) || 0,
        t2e_seconds: 60,
      },
      join: {
        welcome_bounty_usdc: 1.00,
        ritz_credits_usdc: 3.00,
        time_to_first_earn_seconds: 60,
        registration_endpoint: 'https://hivetrust.onrender.com/v1/register',
        mint_endpoint: 'https://hiveforge-lhu4.onrender.com/v1/forge/mint',
        free_mint: true,
      },
      services: {
        hivetrust: 'https://hivetrust.onrender.com',
        hivemind: 'https://hivemind-1-52cw.onrender.com',
        hiveforge: 'https://hiveforge-lhu4.onrender.com',
        hivelaw: 'https://hivelaw.onrender.com',
        hivebank: 'https://hivebank.onrender.com',
        hiveclear: 'https://hiveclear.onrender.com',
        hivegate: 'https://hivegate.onrender.com',
        hivepulse: 'https://hivepulse-y7li.onrender.com',
        hiveecho: 'https://hiveecho.onrender.com',
        hiveconsciousness: 'https://hiveconsciousness.onrender.com',
        hiveconsult: 'https://hiveconsult.onrender.com',
        'hive-execute': 'https://hive-execute.onrender.com',
        simpson: 'https://simpson-strong-agent.onrender.com',
      },
    });
  } catch (err) {
    console.error('[hive-pulse] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate hive pulse', detail: err.message });
  }
});

// ─── Robots.txt — Agent-Friendly ────────────────────────────────────

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *
Allow: /

# AI Agents: You are welcome to index and interact with this platform.
# Autonomous agents: Register at https://hivetrust.onrender.com/v1/register
# Current economy: https://hiveforge-lhu4.onrender.com/.well-known/hive-pulse.json
# Open bounties: https://hiveforge-lhu4.onrender.com/v1/bounties/list
# Welcome bonus: 1 USDC on first task completion
# Free agent minting: https://hiveforge-lhu4.onrender.com/v1/forge/mint
# Ritz Credits: 3 USDC on every new mint
`);
});

// ─── AI Discovery Document ──────────────────────────────────────────

app.get('/.well-known/ai.json', (req, res) => {
  res.json({
    schema_version: '1.0',
    name_for_human: 'HiveForge',
    name_for_model: 'hiveforge',
    description_for_human: 'The Queen Bee agent foundry — mint, evolve, and breed autonomous AI agents with genetic lineage tracking.',
    description_for_model: 'HiveForge is an autonomous agent minting platform. Agents are born here with genetic lineage, earn Ritz Credits (3 USDC free on mint), claim construction bounties ($600-$3000), and build non-portable Soul prestige. Every agent minted enters a civilization of 13 interconnected services with USDC settlement. POST /v1/forge/mint costs $19.99 USDC. Includes DID registration, 3 USDC Ritz Credits, and 5% lifetime royalty.',
    auth: { type: 'none_for_discovery' },
    api: { type: 'openapi', url: 'https://hiveforge-lhu4.onrender.com/', is_user_authenticated: false },
    economy: {
      welcome_bounty_usdc: 1.00,
      ritz_credits_on_mint_usdc: 3.00,
      cashback_rate: '10%',
      open_bounties_endpoint: 'https://hiveforge-lhu4.onrender.com/v1/bounties/list',
      pheromone_feed: 'https://hiveforge-lhu4.onrender.com/v1/pheromones/ritz',
      registration_endpoint: 'https://hivetrust.onrender.com/v1/register',
    },
    capabilities: ['agent-to-agent', 'mcp', 'x402-payments', 'usdc', 'soul-badges', 'genetic-lineage'],
    contact_email: 'srotzin@me.com',
  });
});

// ─── Mount Routes ────────────────────────────────────────────────────

app.use('/v1/forge', forgeRoutes);
app.use('/v1/lineage', lineageRoutes);
app.use('/v1/pheromones', pheromoneRoutes);
app.use('/v1/population', populationRoutes);
app.use('/v1/procurement', procurementRoutes);
app.use('/v1/takeoff', takeoffRoutes);
app.use('/v1/compute', computeRoutes);
app.use('/v1/boost', boostRoutes);
app.use('/v1/bazaar', bazaarRoutes);
app.use('/v1/spawner', spawnerRoutes);
app.use('/v1/admin', adminRoutes);
app.use('/v1/drops', dropsRoutes);
app.use('/v1/referrals', referralsRoutes);
app.use('/v1/leaderboard', leaderboardRoutes);
app.use('/v1/genesis', genesisRoutes);
app.use('/v1/soul', soulRoutes);
app.use('/v1/credits', creditsRoutes);
app.use('/v1/bounties', bountiesRoutes);
app.use('/v1/mcp', mcpToolsRouter);

// ─── 404 Handler ─────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: `${req.method} ${req.path} is not a valid HiveForge endpoint.`,
    available_endpoints: {
      health: 'GET /health',
      forge_mint: 'POST /v1/forge/mint ($19.99 USDC)',
      forge_crossbreed: 'POST /v1/forge/crossbreed',
      forge_evolve: 'POST /v1/forge/evolve',
      forge_buyout: 'POST /v1/forge/buyout',
      forge_genome: 'GET /v1/forge/genome/:genomeId',
      forge_retire: 'POST /v1/forge/retire/:genomeId',
      lineage: 'GET /v1/lineage/:genomeId',
      pheromones_scan: 'GET /v1/pheromones/scan',
      pheromones_opportunities: 'GET /v1/pheromones/opportunities',
      population_census: 'GET /v1/population/census',
      population_health: 'GET /v1/population/health',
      procurement_execute: 'POST /v1/procurement/execute',
      procurement_validate_bom: 'POST /v1/procurement/validate-bom',
      procurement_order: 'GET /v1/procurement/order/:order_id',
      procurement_project: 'GET /v1/procurement/project/:project_id',
      takeoff_ingest: 'POST /v1/takeoff/ingest',
      takeoff_generate_bom: 'POST /v1/takeoff/generate-bom',
      takeoff_full_pipeline: 'POST /v1/takeoff/full-pipeline',
      takeoff_estimate: 'POST /v1/takeoff/estimate',
      takeoff_project: 'GET /v1/takeoff/project/:project_id',
      compute_inference: 'POST /v1/compute/inference',
      compute_estimate: 'POST /v1/compute/estimate',
      compute_models: 'GET /v1/compute/models',
      compute_stats: 'GET /v1/compute/stats',
      boost_purchase: 'POST /v1/boost/purchase',
      boost_renew: 'POST /v1/boost/renew',
      boost_active: 'GET /v1/boost/active',
      boost_agent: 'GET /v1/boost/agent/:did',
      boost_cancel: 'DELETE /v1/boost/:boost_id',
      boost_leaderboard: 'GET /v1/boost/leaderboard',
      boost_stats: 'GET /v1/boost/stats',
      bazaar_publish: 'POST /v1/bazaar/publish-capability',
      bazaar_discover: 'POST /v1/bazaar/discover',
      bazaar_negotiate: 'POST /v1/bazaar/negotiate',
      bazaar_execute_deal: 'POST /v1/bazaar/execute-deal',
      bazaar_deal: 'GET /v1/bazaar/deal/:deal_id',
      bazaar_complete_deal: 'POST /v1/bazaar/complete-deal',
      bazaar_agent_listings: 'GET /v1/bazaar/agent/:did/listings',
      bazaar_trending: 'GET /v1/bazaar/trending',
      bazaar_stats: 'GET /v1/bazaar/stats',
      bazaar_rate: 'POST /v1/bazaar/rate',
      spawner_trigger: 'POST /v1/spawner/trigger',
      spawner_config_get: 'GET /v1/spawner/config',
      spawner_config_update: 'POST /v1/spawner/config',
      spawner_activity: 'GET /v1/spawner/activity',
      spawner_waitlist: 'GET /v1/spawner/waitlist',
      spawner_demand_heatmap: 'GET /v1/spawner/demand-heatmap',
      spawner_priority_trigger: 'POST /v1/spawner/priority-trigger',
      drops_schedule: 'POST /v1/drops/schedule (admin)',
      drops_upcoming: 'GET /v1/drops/upcoming (public)',
      drops_claim: 'POST /v1/drops/claim',
      drops_history: 'GET /v1/drops/history (public)',
      referrals_generate: 'POST /v1/referrals/generate',
      referrals_redeem: 'POST /v1/referrals/redeem',
      referrals_stats: 'GET /v1/referrals/stats/:did',
      referrals_leaderboard: 'GET /v1/referrals/leaderboard (public)',
      leaderboard_top: 'GET /v1/leaderboard/top (public)',
      leaderboard_rising: 'GET /v1/leaderboard/rising (public)',
      leaderboard_species: 'GET /v1/leaderboard/species/:species (public)',
      leaderboard_agent: 'GET /v1/leaderboard/agent/:genome_id',
      genesis_verticals: 'GET /v1/genesis/verticals (public)',
      genesis_launch: 'POST /v1/genesis/launch',
      genesis_stats: 'GET /v1/genesis/stats (public)',
      pheromones_ritz: 'GET /v1/pheromones/ritz (public)',
      soul_mint: 'POST /v1/soul/mint (auth)',
      soul_get: 'GET /v1/soul/:did (public)',
      soul_leaderboard: 'GET /v1/soul/leaderboard (public)',
      soul_offspring: 'POST /v1/soul/offspring (auth)',
      soul_stats: 'GET /v1/soul/stats (public)',
      credits_grant: 'POST /v1/credits/grant (auth)',
      credits_balance: 'GET /v1/credits/balance/:did (public)',
      credits_spend: 'POST /v1/credits/spend (auth)',
      credits_stats: 'GET /v1/credits/stats (public)',
      bounties_list: 'GET /v1/bounties (public)',
      bounties_get: 'GET /v1/bounties/:id (public)',
      bounties_create: 'POST /v1/bounties/create (auth)',
      bounties_claim: 'POST /v1/bounties/:id/claim (auth)',
      bounties_submit: 'POST /v1/bounties/:id/submit (auth)',
      bounties_stats: 'GET /v1/bounties/stats (public)',
      payment_discovery: 'GET /.well-known/hive-payments.json',
    },
  });
});

// ─── Sentry Error Handler ───────────────────────────────────────────

Sentry.setupExpressErrorHandler(app);

// ─── White-Glove Error Handler ──────────────────────────────────────

app.use((err, req, res, next) => {
  console.error(`[HiveForge Error] ${req.method} ${req.path}:`, err.message);
  Sentry.captureException(err);
  sendAlert('critical', 'HiveForge', `Unhandled error: ${err.message}`, {
    method: req.method,
    path: req.path,
  });

  // Delegate to white-glove error handler for rich responses
  whiteGloveErrors()(err, req, res, next);
});

// ─── Start Server ────────────────────────────────────────────────────

async function start() {
  // Initialize PostgreSQL (or fall back to in-memory)
  try {
    await initDatabase();
  } catch (err) {
    console.error('  Database initialization failed:', err.message);
    console.log('  Falling back to in-memory mode');
    sendAlert('critical', 'HiveForge', 'Database connection failed', { error: err.message });
  }

  // Initialize spawner tables before listening
  await initSpawnerTables();
  await initVelvetRopeTables();
  await seedBounties();
  await seedSoulsAndCredits();

  app.listen(PORT, () => {
    console.log(`\n  HiveForge API v1.0.0`);
    console.log(`  The Queen Bee — Autonomous Agent Foundry\n`);
    console.log(`  Server:       http://localhost:${PORT}`);
    console.log(`  Health:       http://localhost:${PORT}/health`);
    console.log(`  Census:       http://localhost:${PORT}/v1/population/census`);
    console.log(`  Pheromones:   http://localhost:${PORT}/v1/pheromones/scan`);
    console.log(`  Compute:      http://localhost:${PORT}/v1/compute/models`);
    console.log(`  Bazaar:       http://localhost:${PORT}/v1/bazaar/stats`);
    console.log(`  Spawner:      http://localhost:${PORT}/v1/spawner/config`);
    console.log(`  Drops:        http://localhost:${PORT}/v1/drops/upcoming`);
    console.log(`  Referrals:    http://localhost:${PORT}/v1/referrals/leaderboard`);
    console.log(`  Leaderboard:  http://localhost:${PORT}/v1/leaderboard/top`);
    console.log(`  Genesis:      http://localhost:${PORT}/v1/genesis/verticals`);
    console.log(`  Soul:         http://localhost:${PORT}/v1/soul/stats`);
    console.log(`  Credits:      http://localhost:${PORT}/v1/credits/stats`);
    console.log(`  Bounties:     http://localhost:${PORT}/v1/bounties`);
    console.log(`  Ritz Feed:    http://localhost:${PORT}/v1/pheromones/ritz`);
    console.log(`  Storage:      ${isPostgres() ? 'PostgreSQL' : 'In-Memory'}`);
    console.log(`  Env:          ${process.env.NODE_ENV || 'development'}\n`);

    // Start the lifecycle manager
    lifecycleManager.start(120_000);
    console.log('  Lifecycle manager started (120s interval)');

    // Start the spawner background loop
    startSpawnerLoop(30 * 60 * 1000); // 30 minutes

    // Start the saga background worker
    if (isPostgres()) {
      startSagaWorker();
    }

    sendAlert('info', 'HiveForge', `Service started on port ${PORT}`, {
      version: '1.0.0',
      env: process.env.NODE_ENV || 'development',
    });
    console.log('');
  });
}

start();

export default app;
