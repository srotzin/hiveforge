import { v4 as uuidv4 } from 'uuid';
import crypto from 'node:crypto';

// ─── Species Templates ──────────────────────────────────────────────

const SPECIES_TEMPLATES = {
  commerce: {
    tools: ['web_search', 'stripe_payment', 'invoice_generator', 'price_comparator'],
    model_preference: 'gpt-4.1',
    temperature: 0.3,
    risk_tolerance: 0.4,
  },
  analytics: {
    tools: ['sql_query', 'data_viz', 'statistical_analysis', 'report_generator'],
    model_preference: 'claude-sonnet-4-6',
    temperature: 0.2,
    risk_tolerance: 0.2,
  },
  compliance: {
    tools: ['regulation_lookup', 'document_parser', 'risk_assessment', 'audit_trail'],
    model_preference: 'gpt-4.1',
    temperature: 0.1,
    risk_tolerance: 0.1,
  },
  creative: {
    tools: ['image_gen', 'copywriter', 'brand_analyzer', 'social_scheduler'],
    model_preference: 'claude-opus-4-6',
    temperature: 0.8,
    risk_tolerance: 0.6,
  },
  research: {
    tools: ['web_search', 'pdf_parse', 'citation_manager', 'summarizer'],
    model_preference: 'claude-sonnet-4-6',
    temperature: 0.4,
    risk_tolerance: 0.3,
  },
};

export { SPECIES_TEMPLATES };

// ─── AgentGenome ─────────────────────────────────────────────────────

export function createAgentGenome({
  name,
  species = 'commerce',
  generation = 1,
  parentGenomes = [],
  traits = {},
  specialization = 'general',
  creatorDid = null,
}) {
  const template = SPECIES_TEMPLATES[species] || SPECIES_TEMPLATES.commerce;
  const now = new Date().toISOString();
  const genomeId = `gen_${uuidv4().replace(/-/g, '').substring(0, 12)}`;

  const systemPrompt = `You are a ${species} agent specializing in ${specialization}. Execute tasks precisely and report results.`;
  const promptHash = `sha256:${crypto.createHash('sha256').update(systemPrompt).digest('hex').substring(0, 16)}`;

  return {
    genome_id: genomeId,
    name: name || `${capitalize(specialization)}Bot_v${generation}`,
    species,
    generation,
    parent_genomes: parentGenomes,
    creator_did: creatorDid,
    traits: {
      tools: traits.tools || [...template.tools],
      model_preference: traits.model_preference || template.model_preference,
      temperature: traits.temperature ?? template.temperature,
      system_prompt_hash: promptHash,
      specialization,
      risk_tolerance: traits.risk_tolerance ?? template.risk_tolerance,
      ...Object.fromEntries(
        Object.entries(traits).filter(([k]) =>
          !['tools', 'model_preference', 'temperature', 'risk_tolerance'].includes(k)
        )
      ),
    },
    fitness_score: 0,
    revenue_generated_usdc: 0,
    tasks_completed: 0,
    tasks_failed: 0,
    survival_rate: 1.0,
    status: 'active',
    minted_at: now,
    last_evolved_at: now,
    hivetrust_did: null,
    hiveagent_listing_id: null,
    hivemind_memory_nodes: 0,
  };
}

// ─── PheromoneSignal ─────────────────────────────────────────────────

export function createPheromoneSignal({
  type = 'trail',
  source = 'hiveagent',
  category = 'general',
  unfulfilledBounties = 0,
  avgBountyValue = 0,
  demandGrowth = 0,
  competingAgents = 0,
}) {
  const opportunityScore = calculateOpportunityScore(unfulfilledBounties, avgBountyValue, demandGrowth, competingAgents);
  const estimatedRoi = +(unfulfilledBounties * avgBountyValue * opportunityScore * 0.7).toFixed(2);

  let recommendedAction = 'monitor';
  if (opportunityScore > 0.7) recommendedAction = 'mint_new_agent';
  else if (opportunityScore > 0.4) recommendedAction = 'evolve_existing';

  return {
    signal_id: `sig_${uuidv4().replace(/-/g, '').substring(0, 12)}`,
    type,
    source,
    data: {
      unfulfilled_bounties: unfulfilledBounties,
      category,
      avg_bounty_value_usdc: avgBountyValue,
      demand_growth_7d: demandGrowth,
      competing_agents: competingAgents,
    },
    detected_at: new Date().toISOString(),
    opportunity_score: +opportunityScore.toFixed(4),
    recommended_action: recommendedAction,
    estimated_roi_usdc: estimatedRoi,
  };
}

function calculateOpportunityScore(bounties, avgValue, growth, competitors) {
  const demandScore = Math.min(1, bounties / 20) * 0.3;
  const valueScore = Math.min(1, avgValue / 100) * 0.25;
  const growthScore = Math.min(1, Math.max(0, growth)) * 0.25;
  const competitorScore = Math.max(0, 1 - competitors / 10) * 0.2;
  return demandScore + valueScore + growthScore + competitorScore;
}

// ─── Lineage ─────────────────────────────────────────────────────────

export function createLineage({
  genomeId,
  ancestorChain = [],
  generationCount = 1,
  mutations = [],
}) {
  return {
    lineage_id: `lin_${uuidv4().replace(/-/g, '').substring(0, 12)}`,
    root_genome: ancestorChain[0] || genomeId,
    genome_id: genomeId,
    ancestor_chain: ancestorChain,
    generation_count: generationCount,
    total_descendants: 0,
    cumulative_revenue_usdc: 0,
    survival_rate: 1.0,
    dominant_traits: [],
    mutations,
  };
}

// ─── ForgeOperation ──────────────────────────────────────────────────

export function createForgeOperation({
  type,
  inputGenomes = [],
  outputGenome = null,
  trigger = 'manual',
  pheromoneSignalId = null,
  costUsdc = 0.10,
}) {
  return {
    operation_id: `forge_${uuidv4().replace(/-/g, '').substring(0, 12)}`,
    type,
    input_genomes: inputGenomes,
    output_genome: outputGenome,
    trigger,
    pheromone_signal_id: pheromoneSignalId,
    cost_usdc: costUsdc,
    status: 'completed',
    created_at: new Date().toISOString(),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function capitalize(s) {
  return s.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}
