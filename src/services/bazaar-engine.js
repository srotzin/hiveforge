/**
 * HiveBazaar Engine — The Sentient Marketplace
 *
 * Autonomous marketplace where agents discover each other through keyword-based
 * similarity matching (Phase 1) and negotiate prices autonomously using BATNA
 * calculations and ZOPA negotiation protocol.
 *
 * Revenue: 0.5% matching fee on executed deals.
 */

import { v4 as uuidv4 } from 'uuid';

// ─── Pheromone Boost Integration ───────────────────────────────────
// Import getBoostMultiplier if pheromone-boost service exists.

let getBoostMultiplier;
try {
  const mod = await import('./pheromone-boost.js');
  getBoostMultiplier = mod.getBoostMultiplier;
} catch {
  getBoostMultiplier = () => 1.0;
}

// ─── In-Memory Storage ─────────────────────────────────────────────

const listings = new Map();       // listing_id -> capability listing
const agentListings = new Map();  // did -> [listing_ids]
const negotiations = new Map();   // negotiation_id -> negotiation state
const deals = new Map();          // deal_id -> deal state
const ratings = new Map();        // deal_id -> [ratings]

// ─── Constants ─────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was',
  'were', 'been', 'being', 'have', 'has', 'had', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'not',
  'but', 'nor', 'yet', 'also', 'just', 'than', 'then', 'into', 'over',
  'such', 'very', 'too', 'any', 'all', 'each', 'some', 'few', 'more',
  'most', 'other', 'its', 'our', 'your', 'their', 'his', 'her', 'who',
  'what', 'which', 'when', 'where', 'how', 'why', 'about',
]);

const MATCHING_FEE_RATE = 0.005; // 0.5% of deal value

const URGENCY_WEIGHTS = {
  low: 0.3,
  standard: 0.5,
  high: 0.7,
  critical: 0.85,
};

const LISTING_TTL_MS = 30 * 24 * 3600_000; // 30 days

// ─── Keyword Extraction ────────────────────────────────────────────

function extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// ─── Matching Algorithm (Phase 1 — Keyword-Based) ──────────────────

function matchCapabilities(need, allListings, filters) {
  const needKeywords = extractKeywords(need);

  return [...allListings.values()]
    .filter(l => l.status === 'active')
    .map(listing => {
      // Keyword overlap: bidirectional substring matching
      const keywordOverlap = listing.keyword_index.filter(k =>
        needKeywords.some(nk => k.includes(nk) || nk.includes(k))
      ).length;

      const relevance = keywordOverlap / Math.max(needKeywords.length, 1);

      // Category match bonus
      const categoryBonus = filters.category
        ? listing.capabilities.some(c =>
            c.category && c.category.toLowerCase() === filters.category.toLowerCase()
          ) ? 0.15 : 0
        : 0;

      const adjustedRelevance = Math.min(1.0, relevance + categoryBonus);

      // Price efficiency: how much headroom under buyer's max price
      const minPrice = Math.min(...listing.capabilities.map(c => c.price_range.min_usdc));
      const priceEfficiency = filters.max_price_usdc
        ? Math.max(0, 1 - (minPrice / filters.max_price_usdc))
        : 0.5;

      // Success rate (default 0.5 if not set)
      const avgSuccessRate = listing.capabilities.reduce(
        (sum, c) => sum + (c.success_rate || 0.5), 0
      ) / listing.capabilities.length;

      // Discoverability (boosted by Pheromone Boost)
      const discoverability = listing.discoverability_score || 0.5;

      // Composite score: relevance 40%, success_rate 30%, price_efficiency 20%, discoverability 10%
      const composite =
        adjustedRelevance * 0.4 +
        avgSuccessRate * 0.3 +
        priceEfficiency * 0.2 +
        discoverability * 0.1;

      return {
        listing_id: listing.listing_id,
        agent_did: listing.agent_did,
        capabilities: listing.capabilities,
        tags: listing.tags,
        relevance_score: +adjustedRelevance.toFixed(4),
        composite_score: +composite.toFixed(4),
        estimated_price: minPrice,
        trust_score: discoverability,
        success_rate: +avgSuccessRate.toFixed(4),
        total_deals: listing.total_deals,
        avg_rating: listing.avg_rating,
      };
    })
    .filter(l => l.relevance_score > 0)
    .filter(l => {
      if (filters.max_price_usdc) {
        const minPrice = Math.min(...l.capabilities.map(c => c.price_range.min_usdc));
        if (minPrice > filters.max_price_usdc) return false;
      }
      if (filters.min_trust_score && l.trust_score < filters.min_trust_score) return false;
      if (filters.min_success_rate && l.success_rate < filters.min_success_rate) return false;
      return true;
    })
    .sort((a, b) => b.composite_score - a.composite_score);
}

// ─── BATNA Calculator ──────────────────────────────────────────────

function calculateBATNA(did, capabilityName, role) {
  const alternatives = [...listings.values()].filter(l =>
    l.status === 'active' &&
    l.agent_did !== did &&
    l.capabilities.some(c => c.name === capabilityName)
  );

  if (role === 'buyer') {
    // Buyer's BATNA: cheapest alternative seller
    const sorted = alternatives.sort((a, b) => {
      const aMin = Math.min(...a.capabilities.filter(c => c.name === capabilityName).map(c => c.price_range.min_usdc));
      const bMin = Math.min(...b.capabilities.filter(c => c.name === capabilityName).map(c => c.price_range.min_usdc));
      return aMin - bMin;
    });
    const cheapest = sorted[0];
    if (!cheapest) return null;
    const cheapestPrice = Math.min(
      ...cheapest.capabilities.filter(c => c.name === capabilityName).map(c => c.price_range.min_usdc)
    );
    return {
      best_alternative_price: cheapestPrice,
      alternative_agent: cheapest.agent_did,
      alternatives_available: alternatives.length,
    };
  }

  // Seller's BATNA: highest-paying recent buyer for similar capability
  // Phase 1: derive from recent completed deal prices, or 0 if none
  const recentDeals = [...deals.values()].filter(d =>
    d.capability_name === capabilityName &&
    d.status === 'completed' &&
    d.seller_did !== did
  );

  if (recentDeals.length > 0) {
    const prices = recentDeals.map(d => d.clearing_price).sort((a, b) => b - a);
    const medianIdx = Math.floor(prices.length / 2);
    return {
      best_alternative_buyer_price: prices[medianIdx],
      recent_deals_sampled: prices.length,
    };
  }

  return { best_alternative_buyer_price: 0, recent_deals_sampled: 0 };
}

// ─── Negotiation Protocol ──────────────────────────────────────────

function negotiate(buyerMax, sellerMin, sellerMax, urgency) {
  // Zone of Possible Agreement check
  if (buyerMax < sellerMin) {
    return { status: 'failed', reason: 'no_zopa' };
  }

  const zopa = { min: sellerMin, max: buyerMax };

  // Urgency shifts clearing price toward seller
  const weight = URGENCY_WEIGHTS[urgency] || 0.5;

  // Clearing price: weighted position within ZOPA
  const clearingPrice = Number((sellerMin + (buyerMax - sellerMin) * weight).toFixed(4));

  return { status: 'agreed', clearing_price: clearingPrice, zopa };
}

// ─── Expiry Cleanup ────────────────────────────────────────────────

function cleanExpiredListings() {
  const now = Date.now();
  for (const [id, listing] of listings) {
    if (listing.status === 'active' && listing.expires_at && new Date(listing.expires_at).getTime() <= now) {
      listing.status = 'expired';
    }
  }
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Publish an agent's capabilities to the bazaar.
 */
export function publishCapability({ agent_did, capabilities, tags }) {
  cleanExpiredListings();

  if (!agent_did) return { error: 'agent_did is required.' };
  if (!capabilities || !Array.isArray(capabilities) || capabilities.length === 0) {
    return { error: 'capabilities array is required and must not be empty.' };
  }

  // Validate each capability
  for (const cap of capabilities) {
    if (!cap.name) return { error: 'Each capability must have a name.' };
    if (!cap.description) return { error: `Capability "${cap.name}" must have a description.` };
    if (!cap.price_range || typeof cap.price_range.min_usdc !== 'number' || typeof cap.price_range.max_usdc !== 'number') {
      return { error: `Capability "${cap.name}" must have price_range with min_usdc and max_usdc.` };
    }
    if (cap.price_range.min_usdc < 0 || cap.price_range.max_usdc < cap.price_range.min_usdc) {
      return { error: `Capability "${cap.name}" has invalid price_range.` };
    }
  }

  // Build keyword index from capability descriptions, names, and tags
  const allText = capabilities.map(c => `${c.name} ${c.description} ${c.category || ''}`).join(' ') +
    ' ' + (tags || []).join(' ');
  const keywordIndex = [...new Set(extractKeywords(allText))];

  // Calculate base discoverability score
  const baseDiscoverability = Math.min(1.0,
    0.3 + // base
    Math.min(0.2, capabilities.length * 0.05) + // more capabilities = more discoverable
    Math.min(0.2, keywordIndex.length * 0.02) + // more keywords = more discoverable
    (tags && tags.length > 0 ? 0.1 : 0) + // tags bonus
    (capabilities.every(c => c.success_rate && c.success_rate > 0.8) ? 0.2 : 0) // high success rate bonus
  );

  // Apply Pheromone Boost multiplier
  const boostMultiplier = getBoostMultiplier(agent_did);
  const discoverabilityScore = Math.min(1.0, +(baseDiscoverability * boostMultiplier).toFixed(4));

  const now = new Date();
  const listing = {
    listing_id: `lst_${uuidv4().replace(/-/g, '').substring(0, 16)}`,
    agent_did,
    capabilities: capabilities.map(c => ({
      name: c.name,
      description: c.description,
      category: c.category || null,
      input_schema: c.input_schema || null,
      output_schema: c.output_schema || null,
      price_range: c.price_range,
      avg_completion_time_ms: c.avg_completion_time_ms || null,
      success_rate: c.success_rate || null,
    })),
    tags: tags || [],
    embedding: null, // Phase 2: actual vector embedding
    keyword_index: keywordIndex,
    discoverability_score: discoverabilityScore,
    boost_multiplier: boostMultiplier,
    total_deals: 0,
    avg_rating: 0,
    rating_count: 0,
    status: 'active',
    published_at: now.toISOString(),
    expires_at: new Date(now.getTime() + LISTING_TTL_MS).toISOString(),
  };

  listings.set(listing.listing_id, listing);

  if (!agentListings.has(agent_did)) {
    agentListings.set(agent_did, []);
  }
  agentListings.get(agent_did).push(listing.listing_id);

  return {
    success: true,
    data: {
      listing_id: listing.listing_id,
      capabilities_indexed: listing.capabilities.length,
      keyword_count: keywordIndex.length,
      discoverability_score: discoverabilityScore,
      boost_multiplier: boostMultiplier,
      expires_at: listing.expires_at,
    },
  };
}

/**
 * Discover agents with matching capabilities.
 */
export function discover({ query_did, need, category, max_price_usdc, min_trust_score, min_success_rate, limit }) {
  cleanExpiredListings();

  if (!query_did) return { error: 'query_did is required.' };
  if (!need || typeof need !== 'string' || need.trim().length === 0) {
    return { error: 'need is required and must be a non-empty string.' };
  }

  const filters = { category, max_price_usdc, min_trust_score, min_success_rate };
  const results = matchCapabilities(need, listings, filters);

  // Exclude the querying agent from results
  const filtered = results.filter(r => r.agent_did !== query_did);
  const capped = filtered.slice(0, limit || 20);

  return {
    success: true,
    data: {
      results: capped,
      total_matches: filtered.length,
      keywords_extracted: extractKeywords(need),
      query_did,
    },
  };
}

/**
 * Initiate autonomous price negotiation between two agents.
 */
export function initiateNegotiation({ buyer_did, seller_did, capability_name, buyer_max_price, quantity, urgency }) {
  cleanExpiredListings();

  if (!buyer_did) return { error: 'buyer_did is required.' };
  if (!seller_did) return { error: 'seller_did is required.' };
  if (!capability_name) return { error: 'capability_name is required.' };
  if (typeof buyer_max_price !== 'number' || buyer_max_price <= 0) {
    return { error: 'buyer_max_price must be a positive number.' };
  }
  if (urgency && !URGENCY_WEIGHTS[urgency]) {
    return { error: `Invalid urgency: ${urgency}. Must be one of: ${Object.keys(URGENCY_WEIGHTS).join(', ')}` };
  }

  // Find seller's listing with this capability
  const sellerListingIds = agentListings.get(seller_did) || [];
  let sellerListing = null;
  let sellerCapability = null;

  for (const id of sellerListingIds) {
    const l = listings.get(id);
    if (l && l.status === 'active') {
      const cap = l.capabilities.find(c => c.name === capability_name);
      if (cap) {
        sellerListing = l;
        sellerCapability = cap;
        break;
      }
    }
  }

  if (!sellerCapability) {
    return { error: `Seller ${seller_did} has no active listing for capability "${capability_name}".` };
  }

  const sellerMin = sellerCapability.price_range.min_usdc;
  const sellerMax = sellerCapability.price_range.max_usdc;
  const effectiveUrgency = urgency || 'standard';
  const qty = quantity || 1;

  // Calculate BATNA for both parties
  const buyerBatna = calculateBATNA(seller_did, capability_name, 'buyer');
  const sellerBatna = calculateBATNA(buyer_did, capability_name, 'seller');

  // Run negotiation protocol
  const result = negotiate(buyer_max_price, sellerMin, sellerMax, effectiveUrgency);

  const negId = `neg_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
  const now = new Date().toISOString();

  if (result.status === 'failed') {
    // Negotiation failed — find alternatives for the buyer
    const alternatives = [...listings.values()]
      .filter(l =>
        l.status === 'active' &&
        l.agent_did !== seller_did &&
        l.capabilities.some(c => c.name === capability_name && c.price_range.min_usdc <= buyer_max_price)
      )
      .map(l => ({
        agent_did: l.agent_did,
        listing_id: l.listing_id,
        min_price: Math.min(...l.capabilities.filter(c => c.name === capability_name).map(c => c.price_range.min_usdc)),
      }))
      .sort((a, b) => a.min_price - b.min_price)
      .slice(0, 5);

    const negotiation = {
      negotiation_id: negId,
      buyer_did,
      seller_did,
      capability_name,
      buyer_max_price,
      seller_min_price: sellerMin,
      seller_max_price: sellerMax,
      quantity: qty,
      urgency: effectiveUrgency,
      buyer_batna: buyerBatna,
      seller_batna: sellerBatna,
      zopa: null,
      clearing_price: null,
      status: 'failed',
      reason: result.reason,
      rounds: 1,
      created_at: now,
    };
    negotiations.set(negId, negotiation);

    return {
      success: true,
      data: {
        negotiation_id: negId,
        status: 'failed',
        reason: `No ZOPA: buyer max ($${buyer_max_price}) < seller min ($${sellerMin}).`,
        buyer_batna: buyerBatna,
        seller_batna: sellerBatna,
        alternatives,
      },
    };
  }

  // Negotiation succeeded
  const totalPrice = +(result.clearing_price * qty).toFixed(4);

  const negotiation = {
    negotiation_id: negId,
    buyer_did,
    seller_did,
    capability_name,
    buyer_max_price,
    seller_min_price: sellerMin,
    seller_max_price: sellerMax,
    quantity: qty,
    urgency: effectiveUrgency,
    buyer_batna: buyerBatna,
    seller_batna: sellerBatna,
    zopa: result.zopa,
    clearing_price: result.clearing_price,
    total_price: totalPrice,
    status: 'agreed',
    rounds: 1,
    created_at: now,
  };
  negotiations.set(negId, negotiation);

  return {
    success: true,
    data: {
      negotiation_id: negId,
      status: 'agreed',
      clearing_price: result.clearing_price,
      total_price: totalPrice,
      quantity: qty,
      buyer_batna: buyerBatna,
      seller_batna: sellerBatna,
      zopa_range: result.zopa,
      urgency: effectiveUrgency,
      urgency_weight: URGENCY_WEIGHTS[effectiveUrgency],
    },
  };
}

/**
 * Execute an agreed deal — lock escrow and trigger execution.
 */
export function executeDeal({ negotiation_id }) {
  if (!negotiation_id) return { error: 'negotiation_id is required.' };

  const neg = negotiations.get(negotiation_id);
  if (!neg) return { error: `Negotiation not found: ${negotiation_id}` };
  if (neg.status !== 'agreed') {
    return { error: `Negotiation ${negotiation_id} is "${neg.status}", must be "agreed" to execute.` };
  }

  const dealValue = neg.total_price || neg.clearing_price;
  const matchingFee = +(dealValue * MATCHING_FEE_RATE).toFixed(4);
  const escrowAmount = +(dealValue + matchingFee).toFixed(4);

  const now = new Date();
  const deal = {
    deal_id: `deal_${uuidv4().replace(/-/g, '').substring(0, 16)}`,
    negotiation_id,
    buyer_did: neg.buyer_did,
    seller_did: neg.seller_did,
    capability_name: neg.capability_name,
    clearing_price: neg.clearing_price,
    quantity: neg.quantity,
    total_price: dealValue,
    matching_fee: matchingFee,
    escrow_amount: escrowAmount,
    status: 'escrowed',
    buyer_confirmed: false,
    seller_confirmed: false,
    proof_of_completion: null,
    created_at: now.toISOString(),
    estimated_completion: new Date(now.getTime() + 30_000).toISOString(), // 30s estimate
    completed_at: null,
  };

  deals.set(deal.deal_id, deal);
  neg.status = 'executed';
  neg.deal_id = deal.deal_id;

  return {
    success: true,
    data: {
      deal_id: deal.deal_id,
      negotiation_id,
      escrow_amount: escrowAmount,
      matching_fee: matchingFee,
      matching_fee_rate: `${MATCHING_FEE_RATE * 100}%`,
      status: deal.status,
      estimated_completion: deal.estimated_completion,
      buyer_did: deal.buyer_did,
      seller_did: deal.seller_did,
      capability_name: deal.capability_name,
    },
  };
}

/**
 * Get deal status.
 */
export function getDeal(dealId) {
  if (!dealId) return { error: 'deal_id is required.' };

  const deal = deals.get(dealId);
  if (!deal) return { error: `Deal not found: ${dealId}` };

  const dealRatings = ratings.get(dealId) || [];

  return {
    success: true,
    data: {
      ...deal,
      ratings: dealRatings,
    },
  };
}

/**
 * Complete a deal — confirm completion by seller or buyer.
 * When both confirm: release escrow, update reputation.
 */
export function completeDeal({ deal_id, role, proof_of_completion }) {
  if (!deal_id) return { error: 'deal_id is required.' };
  if (!role || !['seller', 'buyer'].includes(role)) {
    return { error: 'role must be "seller" or "buyer".' };
  }

  const deal = deals.get(deal_id);
  if (!deal) return { error: `Deal not found: ${deal_id}` };
  if (deal.status === 'completed') return { error: `Deal ${deal_id} is already completed.` };
  if (deal.status !== 'escrowed') {
    return { error: `Deal ${deal_id} is "${deal.status}", must be "escrowed" to complete.` };
  }

  if (role === 'seller') {
    deal.seller_confirmed = true;
    if (proof_of_completion) deal.proof_of_completion = proof_of_completion;
  } else {
    deal.buyer_confirmed = true;
  }

  // Both confirmed => release escrow
  if (deal.seller_confirmed && deal.buyer_confirmed) {
    deal.status = 'completed';
    deal.completed_at = new Date().toISOString();

    // Update seller's listing stats
    const sellerListingIds = agentListings.get(deal.seller_did) || [];
    for (const id of sellerListingIds) {
      const l = listings.get(id);
      if (l && l.capabilities.some(c => c.name === deal.capability_name)) {
        l.total_deals += 1;
        break;
      }
    }

    return {
      success: true,
      data: {
        deal_id,
        status: 'completed',
        escrow_released: true,
        seller_payout: deal.total_price,
        matching_fee_collected: deal.matching_fee,
        completed_at: deal.completed_at,
      },
    };
  }

  return {
    success: true,
    data: {
      deal_id,
      status: 'escrowed',
      seller_confirmed: deal.seller_confirmed,
      buyer_confirmed: deal.buyer_confirmed,
      awaiting: deal.seller_confirmed ? 'buyer' : 'seller',
    },
  };
}

/**
 * Get all capability listings for an agent.
 */
export function getAgentListings(did) {
  cleanExpiredListings();

  if (!did) return { error: 'did is required.' };

  const ids = agentListings.get(did) || [];
  const result = ids
    .map(id => listings.get(id))
    .filter(Boolean)
    .map(l => ({
      listing_id: l.listing_id,
      capabilities: l.capabilities,
      tags: l.tags,
      discoverability_score: l.discoverability_score,
      total_deals: l.total_deals,
      avg_rating: l.avg_rating,
      status: l.status,
      published_at: l.published_at,
      expires_at: l.expires_at,
    }));

  return {
    success: true,
    data: {
      agent_did: did,
      listings: result,
      total: result.length,
      active: result.filter(l => l.status === 'active').length,
    },
  };
}

/**
 * Trending capabilities by demand and volume.
 */
export function getTrending() {
  cleanExpiredListings();

  // Category counts from active listings
  const categoryCounts = new Map();
  const capabilityCounts = new Map();

  for (const l of listings.values()) {
    if (l.status !== 'active') continue;
    for (const cap of l.capabilities) {
      const cat = cap.category || 'uncategorized';
      categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
      capabilityCounts.set(cap.name, (capabilityCounts.get(cap.name) || 0) + 1);
    }
  }

  // Most-negotiated capabilities from negotiations
  const negCounts = new Map();
  for (const neg of negotiations.values()) {
    negCounts.set(neg.capability_name, (negCounts.get(neg.capability_name) || 0) + 1);
  }

  // Price trends from completed deals
  const priceTrends = new Map();
  for (const deal of deals.values()) {
    if (deal.status !== 'completed') continue;
    if (!priceTrends.has(deal.capability_name)) {
      priceTrends.set(deal.capability_name, []);
    }
    priceTrends.get(deal.capability_name).push({
      price: deal.clearing_price,
      date: deal.completed_at,
    });
  }

  return {
    success: true,
    data: {
      top_categories: [...categoryCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([category, count]) => ({ category, listing_count: count })),
      most_listed_capabilities: [...capabilityCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => ({ name, listing_count: count })),
      most_negotiated_capabilities: [...negCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => ({ name, negotiation_count: count })),
      price_trends: Object.fromEntries(
        [...priceTrends.entries()].map(([name, prices]) => [
          name,
          {
            avg_price: +(prices.reduce((s, p) => s + p.price, 0) / prices.length).toFixed(4),
            min_price: Math.min(...prices.map(p => p.price)),
            max_price: Math.max(...prices.map(p => p.price)),
            deal_count: prices.length,
          },
        ])
      ),
    },
  };
}

/**
 * Bazaar statistics.
 */
export function getStats() {
  cleanExpiredListings();

  let totalListings = 0;
  let activeListings = 0;
  for (const l of listings.values()) {
    totalListings++;
    if (l.status === 'active') activeListings++;
  }

  let activeNegotiations = 0;
  let completedNegotiations = 0;
  let failedNegotiations = 0;
  for (const n of negotiations.values()) {
    if (n.status === 'agreed') activeNegotiations++;
    else if (n.status === 'executed') completedNegotiations++;
    else if (n.status === 'failed') failedNegotiations++;
  }

  let completedDeals = 0;
  let activeDeals = 0;
  let totalVolume = 0;
  let totalFees = 0;
  for (const d of deals.values()) {
    if (d.status === 'completed') {
      completedDeals++;
      totalVolume += d.total_price;
      totalFees += d.matching_fee;
    } else if (d.status === 'escrowed') {
      activeDeals++;
    }
  }

  let totalRatings = 0;
  let ratingSum = 0;
  for (const rList of ratings.values()) {
    for (const r of rList) {
      totalRatings++;
      ratingSum += r.rating;
    }
  }

  return {
    success: true,
    data: {
      listings: {
        total: totalListings,
        active: activeListings,
      },
      negotiations: {
        active: activeNegotiations,
        executed: completedNegotiations,
        failed: failedNegotiations,
        total: negotiations.size,
      },
      deals: {
        active: activeDeals,
        completed: completedDeals,
        total: deals.size,
      },
      volume: {
        total_usdc: +totalVolume.toFixed(4),
        total_fees_usdc: +totalFees.toFixed(4),
        matching_fee_rate: `${MATCHING_FEE_RATE * 100}%`,
      },
      ratings: {
        total: totalRatings,
        average: totalRatings > 0 ? +(ratingSum / totalRatings).toFixed(2) : 0,
      },
      unique_agents: agentListings.size,
    },
  };
}

/**
 * Rate a completed deal.
 */
export function rateDeal({ deal_id, rater_did, rating, review }) {
  if (!deal_id) return { error: 'deal_id is required.' };
  if (!rater_did) return { error: 'rater_did is required.' };
  if (typeof rating !== 'number' || rating < 1 || rating > 5) {
    return { error: 'rating must be a number between 1 and 5.' };
  }

  const deal = deals.get(deal_id);
  if (!deal) return { error: `Deal not found: ${deal_id}` };
  if (deal.status !== 'completed') {
    return { error: `Deal ${deal_id} is "${deal.status}", must be "completed" to rate.` };
  }
  if (rater_did !== deal.buyer_did && rater_did !== deal.seller_did) {
    return { error: 'Only deal participants can rate.' };
  }

  // Check for duplicate rating
  const existing = ratings.get(deal_id) || [];
  if (existing.some(r => r.rater_did === rater_did)) {
    return { error: `${rater_did} has already rated deal ${deal_id}.` };
  }

  const ratingEntry = {
    rater_did,
    rated_did: rater_did === deal.buyer_did ? deal.seller_did : deal.buyer_did,
    rating: Math.round(rating),
    review: review || null,
    created_at: new Date().toISOString(),
  };

  if (!ratings.has(deal_id)) {
    ratings.set(deal_id, []);
  }
  ratings.get(deal_id).push(ratingEntry);

  // Update the rated agent's listing avg_rating
  const ratedDid = ratingEntry.rated_did;
  const ratedListingIds = agentListings.get(ratedDid) || [];
  for (const id of ratedListingIds) {
    const l = listings.get(id);
    if (l) {
      l.rating_count = (l.rating_count || 0) + 1;
      l.avg_rating = +((l.avg_rating * (l.rating_count - 1) + ratingEntry.rating) / l.rating_count).toFixed(2);
    }
  }

  return {
    success: true,
    data: {
      deal_id,
      rater_did,
      rated_did: ratingEntry.rated_did,
      rating: ratingEntry.rating,
      review: ratingEntry.review,
    },
  };
}
