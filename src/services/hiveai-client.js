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
