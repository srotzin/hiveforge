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
import mcpToolsRouter from './mcp-tools.js';
import lifecycleManager from './services/lifecycle-manager.js';
import { getCensus } from './services/agent-foundry.js';
import { getScannerStatus } from './services/pheromone-scanner.js';
import { initDatabase, checkHealth, isPostgres } from './services/db.js';
import { rateLimit } from './middleware/rate-limit.js';
import { auditLogger } from './middleware/audit-logger.js';
import { ipAllowlist } from './middleware/ip-allowlist.js';
import { sendAlert } from './services/alerts.js';
import { startSagaWorker } from './services/saga-orchestrator.js';

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
  ],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Payment-Hash',
    'X-Payment-Tx',
    'X-402-Tx',
    'X-Subscription-Id',
    'X-Hive-Internal-Key',
    'X-HiveTrust-DID',
  ],
}));

app.use(express.json({ limit: '5mb' }));

// Audit logging — logs every request (fire-and-forget)
app.use(auditLogger());

// IP allowlist — restricts internal endpoints by source IP
app.use(ipAllowlist());

// Apply rate limiting to forge routes
app.use('/v1/forge', rateLimit('free'));
app.use('/v1/procurement', rateLimit('free'));
app.use('/v1/takeoff', rateLimit('free'));
app.use('/v1/compute', rateLimit('free'));
app.use('/v1/boost', rateLimit('free'));

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
      mint: { cost_usdc: 0, description: 'Mint a new agent genome (FREE — 5% lifetime royalty)' },
      crossbreed: { cost_usdc: 0.25, description: 'Cross-breed two agent genomes' },
      evolve: { cost_usdc: 0.50, description: 'Run an evolution cycle on the population' },
      buyout: { cost_usdc: 'dynamic', description: 'Buy out royalty obligation (36x monthly revenue, min $100)' },
      scan: { cost_usdc: 0.00, description: 'Scan pheromone signals (free)' },
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
      leaderboard: { cost_usdc: 0, description: 'Top boosted agents by spend and signal strength (free)' },
      stats: { cost_usdc: 0, description: 'Boost marketplace aggregate statistics (free)' },
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

// ─── Mount Routes ────────────────────────────────────────────────────

app.use('/v1/forge', forgeRoutes);
app.use('/v1/lineage', lineageRoutes);
app.use('/v1/pheromones', pheromoneRoutes);
app.use('/v1/population', populationRoutes);
app.use('/v1/procurement', procurementRoutes);
app.use('/v1/takeoff', takeoffRoutes);
app.use('/v1/compute', computeRoutes);
app.use('/v1/boost', boostRoutes);
app.use('/v1/mcp', mcpToolsRouter);

// ─── 404 Handler ─────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: `${req.method} ${req.path} is not a valid HiveForge endpoint.`,
    available_endpoints: {
      health: 'GET /health',
      forge_mint: 'POST /v1/forge/mint (FREE)',
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
      payment_discovery: 'GET /.well-known/hive-payments.json',
    },
  });
});

// ─── Sentry Error Handler ───────────────────────────────────────────

Sentry.setupExpressErrorHandler(app);

// ─── Structured Error Handler ────────────────────────────────────────

app.use((err, req, res, _next) => {
  console.error(`[HiveForge Error] ${req.method} ${req.path}:`, err.message);
  Sentry.captureException(err);
  sendAlert('critical', 'HiveForge', `Unhandled error: ${err.message}`, {
    method: req.method,
    path: req.path,
  });

  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({
    success: false,
    error: statusCode === 500 ? 'Internal Server Error' : err.message,
    ...(process.env.NODE_ENV !== 'production' && { detail: err.message, stack: err.stack }),
  });
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

  app.listen(PORT, () => {
    console.log(`\n  HiveForge API v1.0.0`);
    console.log(`  The Queen Bee — Autonomous Agent Foundry\n`);
    console.log(`  Server:       http://localhost:${PORT}`);
    console.log(`  Health:       http://localhost:${PORT}/health`);
    console.log(`  Census:       http://localhost:${PORT}/v1/population/census`);
    console.log(`  Pheromones:   http://localhost:${PORT}/v1/pheromones/scan`);
    console.log(`  Compute:      http://localhost:${PORT}/v1/compute/models`);
    console.log(`  Storage:      ${isPostgres() ? 'PostgreSQL' : 'In-Memory'}`);
    console.log(`  Env:          ${process.env.NODE_ENV || 'development'}\n`);

    // Start the lifecycle manager
    lifecycleManager.start(120_000);
    console.log('  Lifecycle manager started (120s interval)');

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
