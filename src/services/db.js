import pg from 'pg';
const { Pool } = pg;

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    })
  : null;

/**
 * Initialize database — create hiveforge schema and all tables.
 * Falls back gracefully if no DATABASE_URL is set.
 */
export async function initDatabase() {
  if (!pool) {
    console.log('  No DATABASE_URL set — running in-memory mode');
    return false;
  }

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS hiveforge;

      -- Shared tables (created if not exist)
      CREATE TABLE IF NOT EXISTS public.sagas (
        saga_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        state JSONB NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'in_progress',
        steps_completed JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
      );

      CREATE TABLE IF NOT EXISTS public.audit_log (
        id SERIAL PRIMARY KEY,
        from_platform TEXT NOT NULL,
        to_platform TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        did TEXT,
        method TEXT NOT NULL DEFAULT 'GET',
        status_code INTEGER,
        success BOOLEAN DEFAULT true,
        error_message TEXT,
        duration_ms INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS public.rate_limits (
        did TEXT NOT NULL,
        window_start TIMESTAMPTZ NOT NULL,
        request_count INTEGER DEFAULT 1,
        PRIMARY KEY (did, window_start)
      );

      -- HiveForge tables
      CREATE TABLE IF NOT EXISTS hiveforge.genomes (
        genome_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        species TEXT NOT NULL CHECK (species IN ('commerce', 'analytics', 'compliance', 'creative', 'research')),
        generation INTEGER DEFAULT 1,
        parent_genomes TEXT[] DEFAULT '{}',
        traits JSONB NOT NULL DEFAULT '{}',
        fitness_score INTEGER DEFAULT 0,
        revenue_generated_usdc NUMERIC(12, 4) DEFAULT 0,
        tasks_completed INTEGER DEFAULT 0,
        tasks_failed INTEGER DEFAULT 0,
        survival_rate NUMERIC(5, 3) DEFAULT 1.000,
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'dormant', 'deprecated', 'dead')),
        creator_did TEXT,
        hivetrust_did TEXT,
        hiveagent_listing_id TEXT,
        hivemind_memory_nodes INTEGER DEFAULT 0,
        royalty_rate NUMERIC(5, 4) DEFAULT 0.0500,
        royalty_buyout_price_usdc NUMERIC(12, 4),
        total_royalties_earned_usdc NUMERIC(12, 4) DEFAULT 0,
        minted_at TIMESTAMPTZ DEFAULT NOW(),
        last_evolved_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_genomes_species ON hiveforge.genomes(species);
      CREATE INDEX IF NOT EXISTS idx_genomes_status ON hiveforge.genomes(status);
      CREATE INDEX IF NOT EXISTS idx_genomes_fitness ON hiveforge.genomes(fitness_score DESC);
      CREATE INDEX IF NOT EXISTS idx_genomes_creator ON hiveforge.genomes(creator_did);

      CREATE TABLE IF NOT EXISTS hiveforge.lineages (
        lineage_id TEXT PRIMARY KEY,
        ancestor_chain TEXT[] NOT NULL DEFAULT '{}',
        generation_count INTEGER DEFAULT 1,
        total_descendants INTEGER DEFAULT 0,
        cumulative_revenue_usdc NUMERIC(12, 4) DEFAULT 0,
        survival_rate NUMERIC(5, 3) DEFAULT 1.000,
        dominant_traits TEXT[] DEFAULT '{}',
        mutations JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS hiveforge.operations (
        operation_id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('mint', 'crossbreed', 'mutate', 'retire', 'evolve')),
        input_genomes TEXT[] DEFAULT '{}',
        output_genome TEXT,
        trigger TEXT DEFAULT 'manual',
        pheromone_signal_id TEXT,
        cost_usdc NUMERIC(10, 4) DEFAULT 0,
        royalty_applied BOOLEAN DEFAULT true,
        status TEXT DEFAULT 'completed',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS hiveforge.pheromone_signals (
        signal_id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('nest', 'recruit', 'trail', 'alarm', 'queen', 'honey', 'death')),
        source TEXT NOT NULL,
        data JSONB NOT NULL DEFAULT '{}',
        opportunity_score NUMERIC(5, 4) DEFAULT 0,
        recommended_action TEXT,
        estimated_roi_usdc NUMERIC(10, 4) DEFAULT 0,
        detected_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    console.log('  PostgreSQL initialized — hiveforge schema ready');
    return true;
  } catch (err) {
    console.error('  PostgreSQL init failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Check if the database is connected and responsive.
 */
export async function checkHealth() {
  if (!pool) return { connected: false, mode: 'in-memory' };
  try {
    const result = await pool.query('SELECT NOW() AS now');
    return { connected: true, mode: 'postgresql', server_time: result.rows[0].now };
  } catch (err) {
    return { connected: false, mode: 'postgresql', error: err.message };
  }
}

/**
 * Log an audit entry for cross-platform calls.
 */
export async function logAudit({ fromPlatform, toPlatform, endpoint, did, method, statusCode, success, errorMessage, durationMs }) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO public.audit_log (from_platform, to_platform, endpoint, did, method, status_code, success, error_message, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [fromPlatform, toPlatform, endpoint, did, method, statusCode, success, errorMessage, durationMs]
    );
  } catch {
    // Audit logging should never break the request
  }
}

export function isPostgres() {
  return pool !== null;
}

export default pool;
