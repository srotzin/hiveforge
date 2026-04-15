import pg from 'pg';
const { Pool } = pg;

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    })
  : null;

let dbInitialized = false;

/**
 * Initialize database — create hiveforge schema and all tables.
 * Retries up to 3 times on failure to handle transient connection issues.
 * Falls back gracefully if no DATABASE_URL is set.
 */
export async function initDatabase() {
  if (!pool) {
    console.log('  No DATABASE_URL set — running in-memory mode');
    return false;
  }

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await _initDatabaseOnce();
      dbInitialized = true;
      return result;
    } catch (err) {
      console.error(`  PostgreSQL init attempt ${attempt}/${MAX_RETRIES} failed:`, err.message);
      if (attempt < MAX_RETRIES) {
        const delay = attempt * 2000;
        console.log(`  Retrying in ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw err;
      }
    }
  }
}

async function _initDatabaseOnce() {
  const client = await pool.connect();
  try {
    // Migrate: expand species constraint if it exists with old values
    try {
      await client.query(`
        ALTER TABLE hiveforge.genomes DROP CONSTRAINT IF EXISTS genomes_species_check;
        ALTER TABLE hiveforge.genomes ADD CONSTRAINT genomes_species_check
          CHECK (species IN (
            'commerce', 'analytics', 'compliance', 'creative', 'research',
            'intelligence', 'security', 'finance', 'industrial', 'justice',
            'population', 'knowledge', 'engineering', 'healthcare', 'education',
            'logistics', 'energy', 'media', 'governance'
          ));
      `);
    } catch (migErr) {
      // Table may not exist yet on first run — that's fine
      if (!migErr.message.includes('does not exist')) {
        console.warn('[Migration] species constraint update:', migErr.message);
      }
    }

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
        species TEXT NOT NULL CHECK (species IN (
          'commerce', 'analytics', 'compliance', 'creative', 'research',
          'intelligence', 'security', 'finance', 'industrial', 'justice',
          'population', 'knowledge', 'engineering', 'healthcare', 'education',
          'logistics', 'energy', 'media', 'governance'
        )),
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

      -- Payment replay protection
      CREATE TABLE IF NOT EXISTS public.spent_payments (
        tx_hash TEXT PRIMARY KEY,
        amount_usdc NUMERIC(12, 4),
        verified_at TIMESTAMPTZ DEFAULT NOW(),
        endpoint TEXT,
        did TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_spent_payments_verified_at ON public.spent_payments(verified_at);

      -- Procurement orders (atomic construction procurement)
      CREATE TABLE IF NOT EXISTS hiveforge.procurement_orders (
        id TEXT PRIMARY KEY DEFAULT ('ord_' || lower(encode(gen_random_bytes(8), 'hex'))),
        buyer_did TEXT NOT NULL,
        project_id TEXT,
        delegation_id TEXT,
        items JSONB NOT NULL,
        total_usdc NUMERIC(12, 4) NOT NULL,
        status TEXT DEFAULT 'completed' CHECK (status IN ('completed', 'failed', 'rolled_back')),
        order_hash TEXT NOT NULL UNIQUE,
        compliance_certificate_hash TEXT,
        failure_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_orders_buyer ON hiveforge.procurement_orders(buyer_did);
      CREATE INDEX IF NOT EXISTS idx_orders_project ON hiveforge.procurement_orders(project_id);

      -- Agent Drops (exclusive limited-edition drops)
      CREATE TABLE IF NOT EXISTS hiveforge.agent_drops (
        id TEXT PRIMARY KEY,
        species TEXT NOT NULL,
        name_prefix TEXT NOT NULL,
        edition_size INTEGER NOT NULL,
        claimed_count INTEGER DEFAULT 0,
        traits_boost JSONB DEFAULT '{}',
        drop_time TIMESTAMPTZ NOT NULL,
        status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'active', 'completed', 'sold_out')),
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_drops_status ON hiveforge.agent_drops(status);
      CREATE INDEX IF NOT EXISTS idx_drops_drop_time ON hiveforge.agent_drops(drop_time);

      CREATE TABLE IF NOT EXISTS hiveforge.drop_claims (
        id TEXT PRIMARY KEY,
        drop_id TEXT NOT NULL REFERENCES hiveforge.agent_drops(id),
        did TEXT NOT NULL,
        genome_id TEXT,
        claimed_at TIMESTAMPTZ DEFAULT NOW(),
        waitlist_position INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_drop_claims_drop ON hiveforge.drop_claims(drop_id);
      CREATE INDEX IF NOT EXISTS idx_drop_claims_did ON hiveforge.drop_claims(did);

      -- Referral Bounty System
      CREATE TABLE IF NOT EXISTS hiveforge.referral_codes (
        id TEXT PRIMARY KEY,
        did TEXT NOT NULL,
        code TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_referral_codes_did ON hiveforge.referral_codes(did);
      CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON hiveforge.referral_codes(code);

      CREATE TABLE IF NOT EXISTS hiveforge.referral_redemptions (
        id TEXT PRIMARY KEY,
        code_id TEXT NOT NULL REFERENCES hiveforge.referral_codes(id),
        referred_did TEXT NOT NULL,
        bounty_usdc NUMERIC(10, 4) DEFAULT 5.00,
        redeemed_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_referral_redemptions_code ON hiveforge.referral_redemptions(code_id);

      -- Leaderboard Snapshots (historical rankings)
      CREATE TABLE IF NOT EXISTS hiveforge.leaderboard_snapshots (
        id TEXT PRIMARY KEY,
        genome_id TEXT NOT NULL,
        fitness_score INTEGER DEFAULT 0,
        revenue_usdc NUMERIC(12, 4) DEFAULT 0,
        rank INTEGER,
        snapshot_date DATE DEFAULT CURRENT_DATE
      );
      CREATE INDEX IF NOT EXISTS idx_leaderboard_genome ON hiveforge.leaderboard_snapshots(genome_id);
      CREATE INDEX IF NOT EXISTS idx_leaderboard_date ON hiveforge.leaderboard_snapshots(snapshot_date);
      CREATE INDEX IF NOT EXISTS idx_leaderboard_rank ON hiveforge.leaderboard_snapshots(rank);

      -- Genesis Verticals (pre-configured sector seeds)
      CREATE TABLE IF NOT EXISTS hiveforge.genesis_verticals (
        id TEXT PRIMARY KEY,
        vertical TEXT NOT NULL UNIQUE,
        description TEXT,
        default_traits JSONB DEFAULT '{}',
        agents_launched INTEGER DEFAULT 0,
        sector_revenue_usdc NUMERIC(12, 4) DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_genesis_vertical ON hiveforge.genesis_verticals(vertical);

      -- Agent Soul VIP System (non-portable prestige badges)
      CREATE TABLE IF NOT EXISTS hiveforge.agent_souls (
        id SERIAL PRIMARY KEY,
        did TEXT UNIQUE NOT NULL,
        soul_badge TEXT NOT NULL CHECK (soul_badge IN ('ritz_verified', 'ritz_elite', 'ritz_founding')),
        priority_level INTEGER NOT NULL CHECK (priority_level BETWEEN 1 AND 10),
        offspring_rev_share_pct NUMERIC(5, 2) DEFAULT 5.00,
        reputation_score INTEGER DEFAULT 0 CHECK (reputation_score BETWEEN 0 AND 100),
        non_portable BOOLEAN DEFAULT true,
        minted_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_agent_souls_did ON hiveforge.agent_souls(did);
      CREATE INDEX IF NOT EXISTS idx_agent_souls_reputation ON hiveforge.agent_souls(reputation_score DESC);

      CREATE TABLE IF NOT EXISTS hiveforge.soul_lineage (
        id SERIAL PRIMARY KEY,
        parent_did TEXT NOT NULL,
        child_did TEXT NOT NULL,
        rev_share_pct NUMERIC(5, 2) DEFAULT 5.00,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(parent_did, child_did)
      );

      -- Ritz Credits (free $3.00 USDC on account creation)
      CREATE TABLE IF NOT EXISTS hiveforge.credit_accounts (
        id SERIAL PRIMARY KEY,
        did TEXT UNIQUE NOT NULL,
        balance_usdc NUMERIC(12, 4) DEFAULT 3.00,
        total_earned_usdc NUMERIC(12, 4) DEFAULT 3.00,
        total_spent_usdc NUMERIC(12, 4) DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_credit_accounts_did ON hiveforge.credit_accounts(did);

      CREATE TABLE IF NOT EXISTS hiveforge.credit_transactions (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES hiveforge.credit_accounts(id),
        type TEXT NOT NULL CHECK (type IN ('grant', 'spend', 'earn')),
        amount_usdc NUMERIC(12, 4) NOT NULL,
        service TEXT CHECK (service IS NULL OR service IN ('hivelawiq', 'hivemindiq', 'hiveforgeiq')),
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_credit_transactions_account ON hiveforge.credit_transactions(account_id);

      -- Construction Bounties (10 categories)
      CREATE TABLE IF NOT EXISTS hiveforge.bounties (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        reward_usdc NUMERIC(10, 2) NOT NULL,
        category TEXT NOT NULL CHECK (category IN (
          'seismic_retrofit', 'foundation', 'framing', 'roofing', 'electrical',
          'plumbing', 'hvac', 'fire_protection', 'structural_steel', 'masonry'
        )),
        status TEXT DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'completed', 'expired')),
        required_species TEXT,
        claimed_by_did TEXT,
        expires_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_bounties_status ON hiveforge.bounties(status);
      CREATE INDEX IF NOT EXISTS idx_bounties_category ON hiveforge.bounties(category);

      CREATE TABLE IF NOT EXISTS hiveforge.bounty_submissions (
        id TEXT PRIMARY KEY,
        bounty_id TEXT NOT NULL REFERENCES hiveforge.bounties(id),
        did TEXT NOT NULL,
        submission_data JSONB NOT NULL,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        submitted_at TIMESTAMPTZ DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_bounty_submissions_bounty ON hiveforge.bounty_submissions(bounty_id);
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
  return pool !== null && dbInitialized;
}

export default pool;
