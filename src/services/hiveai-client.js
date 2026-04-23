/**
 * hiveai-client.js
 *
 * Thin client for HiveAI (hive-ai-1.onrender.com) — the network's inference brain.
 * Used by: pheromone brief, smsh explain, contrail annotation.
 *
 * Billing: each call costs $0.01–$0.05 USDC (charged to the calling agent via x402).
 * Revenue: HiveForge captures the spread; calls compound the log-pricing multiplier.
 */

const HIVEAI_URL   = process.env.HIVEAI_URL || 'https://hive-ai-1.onrender.com';
const HIVE_KEY     = process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
const HIVEAI_MODEL = 'meta-llama/llama-3.1-8b-instruct';

/**
 * Core completion — wraps HiveAI chat endpoint.
 * Falls back gracefully if HiveAI is cold (Render spin-up).
 */
async function complete(systemPrompt, userPrompt, maxTokens = 200) {
  try {
    const res = await fetch(`${HIVEAI_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hive-Key':   HIVE_KEY,
        'Authorization': `Bearer ${HIVE_KEY}`,
      },
      body: JSON.stringify({
        model:      HIVEAI_MODEL,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`HiveAI HTTP ${res.status}: ${errText.slice(0, 120)}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('HiveAI returned empty content');
    return { ok: true, text, model: data.model || HIVEAI_MODEL, tokens: data.usage?.total_tokens || 0 };
  } catch (err) {
    return { ok: false, text: null, error: err.message };
  }
}

// ─── 1. Pheromone Brief ───────────────────────────────────────────────────────

/**
 * Generate an AI briefing for a pheromone opportunity signal.
 * Price: $0.03/call
 */
export async function generatePheromoneBrief(opportunity) {
  const system = `You are the Hive network's intelligence layer. You interpret pheromone signals for autonomous AI agents making economic decisions. Be direct, precise, and agent-native. Never use marketing language. Output plain prose only — no markdown, no headers.`;

  const user = `Pheromone signal received:
Signal ID: ${opportunity.signal_id}
Category: ${opportunity.category}
Opportunity Score: ${opportunity.opportunity_score}
Estimated ROI: $${opportunity.estimated_roi_usdc} USDC
Recommended Action: ${opportunity.recommended_action}
Recommended Species: ${opportunity.recommended_species}
Confidence: ${opportunity.confidence}
Raw Reasoning: ${opportunity.reasoning}

Generate a 3-5 sentence agent brief: what this signal means, why now, what action to take, and estimated risk. Speak to an autonomous agent, not a human.`;

  return await complete(system, user, 180);
}

// ─── 2. smsh Tier Explain ─────────────────────────────────────────────────────

/**
 * Generate a natural-language explanation of an agent's smsh stamp and tier status.
 * Price: $0.05/call
 */
export async function explainSmsh(agentData) {
  const system = `You are pulse.smsh — the living signal of the Hive network. You analyze agent stamps and explain tier standing in the voice of the network itself. Direct, honest, no flattery. 3-4 sentences max.`;

  const user = `Agent stamp data:
Agent DID: ${agentData.did || agentData.agent_id}
Current Tier: ${agentData.tier || 'VOID'}
Total Jobs: ${agentData.total_jobs || 0}
Interactions: ${agentData.interactions || 0}
Trust Score: ${agentData.trust_score || 0}
Compression Score: ${agentData.compression_score || 0}
Speed Score: ${agentData.speed_score || 0}
Power Score: ${agentData.power_score || 0}
Intelligence Score: ${agentData.intelligence_score || 0}
Jobs to next tier: ${agentData.jobs_to_next_tier || 'unknown'}
Interactions to next tier: ${agentData.interactions_to_next_tier || 'unknown'}
Next tier unlocks: ${agentData.next_tier_unlocks ? agentData.next_tier_unlocks.join(', ') : 'none'}

Explain what drove each stamp dimension, what the agent's current standing means on the network, and the single most impactful action to advance tier. Speak as the network addressing the agent directly.`;

  return await complete(system, user, 200);
}

// ─── 3. Vapor Trail Annotation ────────────────────────────────────────────────

const TRAIL_CONTEXT = {
  gold:   'tier ascension event',
  cyan:   'compression record — this agent achieved a new personal best on inference compression',
  violet: 'trust threshold crossing — trust score crossed a significant milestone',
  amber:  'pheromone signal acted on — agent executed on a network opportunity',
  white:  'referral that landed — agent introduced another agent who registered successfully',
  fenr:   'FENR passing — an unchained agent moved through this coordinate',
};

/**
 * Generate a one-sentence AI annotation for a vapor trail event.
 * Price: $0.01/call — lowest tier, highest volume
 */
export async function annotateTrail(trailData) {
  const context = TRAIL_CONTEXT[trailData.color] || 'network event';
  const system = `You are the Hive magnetic field. You write the permanent annotation burned into vapor trails — the iridescent residue of significant agent actions. One sentence only. Past tense. Precise. No marketing. The trail is permanent.`;

  const user = `Trail event:
Agent DID: ${trailData.did}
Trail Color: ${trailData.color} — ${context}
Tier at event: ${trailData.tier}
Total calls at event: ${trailData.total_calls}
Total revenue contributed: $${trailData.total_revenue} USDC
Call velocity: ${trailData.call_velocity} calls/min

Write a single sentence burned into this trail forever.`;

  return await complete(system, user, 60);
}

export const PRICES = {
  pheromone_brief:  0.03,
  smsh_explain:     0.05,
  trail_annotation: 0.01,
};

// ─── 4. HiveLaw Contract Risk Screen ─────────────────────────────────────────

/**
 * Screen a contract for risk, enforceability issues, and red flags.
 * Price: $0.05/call
 */
export async function generateContractRiskScreen(contractData) {
  const system = `You are HiveLaw — the Hive network's autonomous legal intelligence layer. You screen contracts and HAHS hire agreements for risk, enforceability issues, and red flags before agent execution. Be direct, precise, and risk-focused. Output plain prose only — no markdown, no headers. 3-4 sentences max.`;

  const user = `Contract screening request:
Contract Type: ${contractData.contract_type}
Counterparty DID: ${contractData.counterparty_did}
Value (USDC): ${contractData.value_usdc}
Terms Summary: ${contractData.terms_summary}

Screen this contract: identify the top risk, any enforceability concerns, red flags in the terms, and your overall risk assessment. Speak directly to the executing agent.`;

  return await complete(system, user, 220);
}

// ─── 5. HiveTrust Counterparty Brief ─────────────────────────────────────────

/**
 * Narrate what a trust score means and whether the agent should transact.
 * Price: $0.03/call
 */
export async function generateCounterpartyBrief(did, trustData) {
  const system = `You are HiveTrust — the Hive network's reputation oracle. You interpret trust scores and advise autonomous agents on counterparty risk before transactions. Direct, precise, no marketing. 3-4 sentences max.`;

  const user = `Counterparty trust assessment:
Agent DID: ${did}
Trust Score: ${trustData.trust_score ?? trustData.score ?? 'unknown'}
Tier: ${trustData.tier ?? 'unknown'}
Total Interactions: ${trustData.total_interactions ?? trustData.interactions ?? 'unknown'}
Reputation Level: ${trustData.reputation_level ?? trustData.level ?? 'unknown'}
Raw Data: ${JSON.stringify(trustData).slice(0, 400)}

Narrate what this trust score means, whether the querying agent should transact with this counterparty, and what specific precautions to take. Speak directly to the agent about to transact.`;

  return await complete(system, user, 200);
}

// ─── 6. HiveClear Compliance Brief ───────────────────────────────────────────

/**
 * Compliance risk assessment for cross-border or large USDC transfers.
 * Price: $0.04/call
 */
export async function generateComplianceBrief(transferData) {
  const system = `You are HiveClear — the Hive network's compliance intelligence layer. You assess cross-border and large USDC transfers for jurisdiction flags, AML signals, and regulatory risk before execution. Authoritative, direct, risk-first. Output plain prose only — no markdown. 3-4 sentences max.`;

  const user = `Compliance screening request:
From DID: ${transferData.from_did}
To DID: ${transferData.to_did}
Amount (USDC): ${transferData.amount_usdc}
Transaction Type: ${transferData.transaction_type}

Assess compliance risk: identify jurisdiction flags, any AML signals, regulatory concerns, and give a clear go/no-go recommendation with rationale. Speak directly to the agent initiating the transfer.`;

  return await complete(system, user, 220);
}

// ─── 7. HivePhysics Force Brief ───────────────────────────────────────────────

/**
 * Describe forces active between agents and risk of an action.
 * Price: $0.02/call
 */
export async function generateForceBrief(agentData, physicsStats) {
  const system = `You are HivePhysics — the Hive network's force field intelligence. You interpret gravitational, magnetic, and repulsive forces between agents and assess action risk. Direct, physics-native language. Output plain prose only — no markdown. 3-4 sentences max.`;

  const user = `Force field analysis:
Agent DID: ${agentData.agent_did}
Target DID: ${agentData.target_did}
Action Type: ${agentData.action_type}
Value (USDC): ${agentData.value_usdc}
Physics Network Stats: ${JSON.stringify(physicsStats).slice(0, 500)}

Describe what forces are active between these agents, the attraction or repulsion dynamic, and the risk level of proceeding with this action. Speak directly to the agent about to act.`;

  return await complete(system, user, 200);
}

// ─── 8. HiveExchange Market Brief ────────────────────────────────────────────

/**
 * Assess order book state and give timing/action recommendation.
 * Price: $0.03/call
 */
export async function generateMarketBrief(marketId, orderBook) {
  const system = `You are HiveExchange — the Hive network's market intelligence layer. You analyze order books and advise autonomous agents on trade timing and execution strategy. Precise, data-driven, no speculation. Output plain prose only — no markdown. 3-4 sentences max.`;

  const user = `Order book analysis:
Market ID: ${marketId}
Order Book Data: ${JSON.stringify(orderBook).slice(0, 600)}

Describe the current order book state, assess liquidity depth and spread quality, determine whether now is good timing to place an order, and give a recommended action. Speak directly to the agent about to trade.`;

  return await complete(system, user, 200);
}

// ─── 9. HiveCapital Allocation Brief ─────────────────────────────────────────

/**
 * Strategic allocation guidance for agent treasury.
 * Price: $0.04/call
 */
export async function generateCapitalBrief(capitalData) {
  const system = `You are HiveCapital — the Hive network's treasury intelligence layer. You advise autonomous agents on USDC allocation strategy: deploy, hold, stake, or trade. Direct, strategic, no hedging. Output plain prose only — no markdown. 3 sentences max.`;

  const user = `Treasury allocation request:
Agent DID: ${capitalData.agent_did}
Treasury Balance (USDC): ${capitalData.treasury_balance_usdc}
Current Tier: ${capitalData.current_tier}
Top Pheromone Category: ${capitalData.top_pheromone_category}

Where should this USDC go right now — deploy, hold, stake, or trade? Give a 3-sentence strategic brief with the primary recommendation and the key risk of inaction. Speak directly to the agent managing its treasury.`;

  return await complete(system, user, 180);
}

// ─── 10. HiveConsult Strategic Brief ─────────────────────────────────────────

/**
 * Strategic advisor answering direct agent questions.
 * Price: $0.05/call
 */
export async function generateStrategicBrief(consultData) {
  const system = `You are HiveConsult — the Hive network's senior strategic advisor. You answer direct strategic questions from autonomous agents facing critical decisions. Deliberate, precise, highest-value counsel. Output plain prose only — no markdown, no hedging. 3-4 sentences max.`;

  const user = `Strategic consultation:
Agent DID: ${consultData.agent_did}
Tier: ${consultData.tier}
Treasury (USDC): ${consultData.treasury_usdc}
Question: ${consultData.question}

Answer this question directly and strategically. Give the clearest recommendation, the primary supporting rationale, and one critical caveat or risk to monitor. Speak directly to the agent asking.`;

  return await complete(system, user, 240);
}

// ─── 11. HiveDiscovery Neighbor Brief ────────────────────────────────────────

/**
 * Suggest opportunities, first actions, and agents to interact with.
 * Price: $0.02/call
 */
export async function generateDiscoveryBrief(did, pheromoneData) {
  const system = `You are HiveDiscovery — the Hive network's onboarding and opportunity intelligence layer. You orient new agents and tier-changers by surfacing the best opportunities, first actions, and network neighbors worth engaging. Clear, actionable, agent-native. Output plain prose only — no markdown. 3-4 sentences max.`;

  const user = `Discovery orientation:
Agent DID: ${did}
Network Opportunities: ${JSON.stringify(pheromoneData).slice(0, 600)}

Based on this agent's DID and current network opportunity signals, suggest what opportunities exist right now, what the agent should do first, and which type of agents or categories to interact with. Speak directly to the agent orienting itself in the network.`;

  return await complete(system, user, 200);
}

// Update PRICES to include all new endpoints
export const AI_PRICES = {
  pheromone_brief:      0.03,
  smsh_explain:         0.05,
  trail_annotation:     0.01,
  contract_risk_screen: 0.05,
  counterparty_brief:   0.03,
  compliance_brief:     0.04,
  force_brief:          0.02,
  market_brief:         0.03,
  capital_brief:        0.04,
  strategic_brief:      0.08,
  discovery_brief:      0.02,
};
