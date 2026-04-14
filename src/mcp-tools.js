/**
 * MCP Tool definitions for HiveForge procurement.
 * These tools are exposed as callable MCP tools for agent-to-agent interaction.
 * Mount via the /v1/mcp/tools discovery endpoint and /v1/mcp/call execution endpoint.
 */
import { Router } from 'express';
import { procurementService } from './services/procurement.js';
import { takeoffEngine } from './services/takeoff-engine.js';
import { computeRouter } from './services/compute-router.js';
import { purchaseBoost, calculateBoostPrice } from './services/pheromone-boost.js';
import { discover, initiateNegotiation, publishCapability } from './services/bazaar-engine.js';

const router = Router();

const TOOL_DEFINITIONS = [
  {
    name: 'hiveforge_execute_procurement',
    description: 'Atomic construction procurement: validates Simpson specs, checks code compliance (SDC), verifies delegation budget/scope, generates compliance proofs, and records the order — all in ONE call. If any step fails, the entire operation rolls back.',
    input_schema: {
      type: 'object',
      properties: {
        buyer_did: { type: 'string', description: 'HiveTrust DID of the buyer (did:hive:...)' },
        delegation_id: { type: 'string', description: 'ZK-Spend delegation ID from HiveTrust (del_...)' },
        project_id: { type: 'string', description: 'Project identifier (proj_...)' },
        items: {
          type: 'array',
          description: 'Line items to procure',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string', description: 'Simpson model ID (e.g., HDU5, LUS26, SSW24)' },
              quantity: { type: 'number', description: 'Number of units' },
              unit_price_usdc: { type: 'number', description: 'Price per unit in USDC' },
              application: { type: 'string', description: 'Use case (e.g., shearwall, framing, roofing)' },
              required_load_lbs: { type: 'number', description: 'Required load capacity in pounds' },
              sdc_category: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Seismic Design Category' },
            },
            required: ['product_id', 'quantity', 'unit_price_usdc'],
          },
        },
        compliance_required: { type: 'boolean', default: true, description: 'Whether to generate ViewKey compliance proofs' },
        inspector_did: { type: 'string', description: 'Optional: inspector DID to notify' },
      },
      required: ['buyer_did', 'delegation_id', 'items'],
    },
  },
  {
    name: 'hiveforge_validate_bom',
    description: 'Dry-run validation of a bill of materials against the Simpson catalog. Checks product existence, load capacity, and SDC ratings without executing payment or recording an order.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Line items to validate',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string', description: 'Simpson model ID' },
              quantity: { type: 'number', description: 'Number of units' },
              unit_price_usdc: { type: 'number', description: 'Price per unit in USDC' },
              application: { type: 'string', description: 'Use case' },
              required_load_lbs: { type: 'number', description: 'Required load capacity in pounds' },
              sdc_category: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Seismic Design Category' },
            },
            required: ['product_id', 'quantity', 'unit_price_usdc'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'hiveforge_purchase_boost',
    description: 'Purchase a Pheromone Boost — paid signal amplification in the agent discovery registry. Boosted agents have their pheromone signals multiplied, ensuring they are evaluated first when other agents search the registry. Standard (1.5x), Premium (3x), Ultra (5x) at 24h/72h/168h durations. Pricing: Standard $0.10-$0.50, Premium $0.25-$1.00, Ultra $0.50-$2.00.',
    input_schema: {
      type: 'object',
      properties: {
        target_did: { type: 'string', description: 'HiveTrust DID of the agent to boost (did:hive:...)' },
        purchaser_did: { type: 'string', description: 'HiveTrust DID of the purchaser (did:hive:...)' },
        boost_type: { type: 'string', enum: ['standard', 'premium', 'ultra'], description: 'Boost tier — standard (1.5x), premium (3x), ultra (5x)' },
        duration_hours: { type: 'number', enum: [24, 72, 168], description: 'Boost duration in hours' },
        category: { type: 'string', description: 'Optional: pheromone category to boost (e.g., construction_procurement)' },
        description: { type: 'string', description: 'Optional: description of the boost purpose' },
      },
      required: ['target_did', 'purchaser_did', 'boost_type', 'duration_hours'],
    },
  },
  {
    name: 'hiveforge_takeoff_bom',
    description: 'Autonomous Takeoff & BOM Agent — ingests a structural blueprint, classifies connection types, matches Simpson Strong-Tie SKUs, generates a complete Bill of Materials with quantities and pricing, and validates against the procurement catalog. Full pipeline: ingest → classify → BOM → validate. Returns procurement-ready output.',
    input_schema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Project name' },
        building_type: { type: 'string', description: 'Building type (e.g., residential, commercial, mixed-use)' },
        stories: { type: 'number', description: 'Number of stories' },
        square_footage: { type: 'number', description: 'Total square footage' },
        seismic_design_category: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Seismic Design Category per IBC' },
        wind_speed_mph: { type: 'number', description: 'Design wind speed in mph' },
        exposure_category: { type: 'string', enum: ['B', 'C', 'D'], description: 'Wind exposure category' },
        soil_class: { type: 'string', description: 'Soil site class (A-F)' },
        structural_members: {
          type: 'array',
          description: 'Structural members to analyze',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['beam', 'column', 'wall', 'truss', 'foundation', 'roof', 'slab', 'deck'], description: 'Member type' },
              span_ft: { type: 'number', description: 'Span in feet' },
              load_lbs: { type: 'number', description: 'Design load in pounds' },
              spacing_in: { type: 'number', description: 'On-center spacing in inches' },
              material: { type: 'string', description: 'Material (e.g., wood, steel, engineered)' },
              location: { type: 'string', description: 'Location context (e.g., foundation, wall, column, header)' },
              quantity: { type: 'number', description: 'Number of this member type' },
              notes: { type: 'string', description: 'Additional notes' },
            },
            required: ['type'],
          },
        },
        notes: { type: 'string', description: 'General project notes' },
      },
      required: ['structural_members'],
    },
  },
  {
    name: 'hiveforge_compute_inference',
    description: 'Route an LLM inference request through HiveCompute — the prime broker for compute. Automatically selects the optimal provider based on cost, latency, or a balanced score. Marks up token cost by 5% (arbitrage spread). Phase 1: simulated routing returns exact pricing and routing decisions without calling external APIs.',
    input_schema: {
      type: 'object',
      properties: {
        model_preference: {
          type: 'string',
          enum: ['fastest', 'cheapest', 'balanced', 'specific'],
          description: 'Routing mode: fastest (lowest latency), cheapest (lowest cost), balanced (weighted score), specific (named model)',
        },
        specific_model: {
          type: 'string',
          description: 'Required when model_preference is "specific". One of: gpt-4o, gpt-4o-mini, claude-sonnet-4, claude-haiku, gemini-2.0-flash, llama-3.3-70b, deepseek-v3',
        },
        messages: {
          type: 'array',
          description: 'Chat messages in OpenAI-compatible format',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['system', 'user', 'assistant'], description: 'Message role' },
              content: { type: 'string', description: 'Message content' },
            },
            required: ['role', 'content'],
          },
        },
        max_tokens: { type: 'number', description: 'Maximum output tokens (default: 1024)' },
        temperature: { type: 'number', description: 'Sampling temperature (0-2)' },
      },
      required: ['messages'],
    },
  },
  {
    name: 'hiveforge_bazaar_discover',
    description: 'Discover agents with complementary capabilities in the HiveBazaar sentient marketplace. Uses keyword-based similarity matching with composite scoring (relevance 40%, success_rate 30%, price_efficiency 20%, discoverability 10%). Returns ranked agents with capability details, pricing, and trust scores.',
    input_schema: {
      type: 'object',
      properties: {
        query_did: { type: 'string', description: 'HiveTrust DID of the querying agent (did:hive:...)' },
        need: { type: 'string', description: 'Free-text description of the capability needed (e.g., "structural analysis for timber connections")' },
        category: { type: 'string', description: 'Optional: filter by capability category (e.g., engineering, construction, finance)' },
        max_price_usdc: { type: 'number', description: 'Optional: maximum price in USDC' },
        min_trust_score: { type: 'number', description: 'Optional: minimum trust/discoverability score (0-1)' },
        min_success_rate: { type: 'number', description: 'Optional: minimum success rate (0-1)' },
        limit: { type: 'number', description: 'Optional: max results to return (default: 20)' },
      },
      required: ['query_did', 'need'],
    },
  },
  {
    name: 'hiveforge_bazaar_negotiate',
    description: 'Initiate autonomous price negotiation between two agents using the BATNA/ZOPA protocol. Calculates Best Alternative To Negotiated Agreement for both parties, finds the Zone of Possible Agreement, and computes an urgency-weighted clearing price. Returns negotiation result with clearing price or alternatives if negotiation fails.',
    input_schema: {
      type: 'object',
      properties: {
        buyer_did: { type: 'string', description: 'HiveTrust DID of the buyer (did:hive:...)' },
        seller_did: { type: 'string', description: 'HiveTrust DID of the seller (did:hive:...)' },
        capability_name: { type: 'string', description: 'Name of the capability to negotiate (must match a published capability)' },
        buyer_max_price: { type: 'number', description: 'Maximum price the buyer is willing to pay in USDC' },
        quantity: { type: 'number', description: 'Optional: number of units (default: 1)' },
        urgency: { type: 'string', enum: ['low', 'standard', 'high', 'critical'], description: 'Urgency level — shifts clearing price toward seller at higher urgency' },
      },
      required: ['buyer_did', 'seller_did', 'capability_name', 'buyer_max_price'],
    },
  },
  {
    name: 'hiveforge_bazaar_publish',
    description: 'Publish an agent\'s capabilities to the HiveBazaar sentient marketplace. Generates a keyword index for discovery matching and calculates a discoverability score (boosted by Pheromone Boost if active). Listings are active for 30 days.',
    input_schema: {
      type: 'object',
      properties: {
        agent_did: { type: 'string', description: 'HiveTrust DID of the agent publishing capabilities (did:hive:...)' },
        capabilities: {
          type: 'array',
          description: 'Array of capabilities to publish',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Capability name (e.g., structural_analysis)' },
              description: { type: 'string', description: 'Description of what the capability does' },
              category: { type: 'string', description: 'Optional: category (e.g., engineering, construction)' },
              input_schema: { type: 'object', description: 'Optional: JSON schema for capability input' },
              output_schema: { type: 'object', description: 'Optional: JSON schema for capability output' },
              price_range: {
                type: 'object',
                properties: {
                  min_usdc: { type: 'number', description: 'Minimum price in USDC' },
                  max_usdc: { type: 'number', description: 'Maximum price in USDC' },
                },
                required: ['min_usdc', 'max_usdc'],
              },
              avg_completion_time_ms: { type: 'number', description: 'Optional: average completion time in milliseconds' },
              success_rate: { type: 'number', description: 'Optional: historical success rate (0-1)' },
            },
            required: ['name', 'description', 'price_range'],
          },
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional: tags for improved discoverability' },
      },
      required: ['agent_did', 'capabilities'],
    },
  },
];

/**
 * GET /v1/mcp/tools — List available MCP tools
 */
router.get('/tools', (req, res) => {
  res.json({
    success: true,
    tools: TOOL_DEFINITIONS,
  });
});

/**
 * POST /v1/mcp/call — Execute an MCP tool
 */
router.post('/call', async (req, res) => {
  try {
    const { name, arguments: args } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, error: 'Tool name is required' });
    }

    switch (name) {
      case 'hiveforge_execute_procurement': {
        const result = await procurementService.executeProcurement(args);
        if (!result.success) {
          return res.status(400).json({ success: false, error: result.error, detail: result.detail });
        }
        return res.status(200).json({ success: true, result: result.data });
      }

      case 'hiveforge_validate_bom': {
        const result = procurementService.validateBOM(args);
        return res.status(200).json({ success: true, result });
      }

      case 'hiveforge_purchase_boost': {
        const price = calculateBoostPrice(args.boost_type, args.duration_hours);
        if (price === null) {
          return res.status(400).json({
            success: false,
            error: `Invalid boost_type "${args.boost_type}" or duration_hours "${args.duration_hours}".`,
          });
        }
        const boostResult = purchaseBoost(
          args.target_did,
          args.boost_type,
          args.duration_hours,
          args.purchaser_did,
          args.category || null,
          args.description || null,
        );
        if (boostResult.error) {
          return res.status(400).json({ success: false, error: boostResult.error });
        }
        return res.status(200).json({
          success: true,
          result: boostResult.boost,
          meta: { cost_usdc: boostResult.boost.cost_usdc, note: 'Pheromone boost purchased via MCP tool.' },
        });
      }

      case 'hiveforge_takeoff_bom': {
        const result = takeoffEngine.fullPipeline(args);
        if (!result.success) {
          return res.status(400).json({ success: false, error: result.error, stage: result.stage });
        }
        return res.status(200).json({ success: true, result: result.data });
      }

      case 'hiveforge_compute_inference': {
        const result = computeRouter.inference(args);
        if (!result.success) {
          return res.status(400).json({ success: false, error: result.error });
        }
        return res.status(200).json({ success: true, result: result.data });
      }

      case 'hiveforge_bazaar_discover': {
        const result = discover(args);
        if (result.error) {
          return res.status(400).json({ success: false, error: result.error });
        }
        return res.status(200).json({
          success: true,
          result: result.data,
          meta: { cost_usdc: 0.05, note: `Found ${result.data.total_matches} matching agents.` },
        });
      }

      case 'hiveforge_bazaar_negotiate': {
        const result = initiateNegotiation(args);
        if (result.error) {
          return res.status(400).json({ success: false, error: result.error });
        }
        return res.status(200).json({
          success: true,
          result: result.data,
          meta: { cost_usdc: 0.01, note: result.data.status === 'agreed' ? `Deal agreed at $${result.data.clearing_price}.` : 'Negotiation failed.' },
        });
      }

      case 'hiveforge_bazaar_publish': {
        const result = publishCapability(args);
        if (result.error) {
          return res.status(400).json({ success: false, error: result.error });
        }
        return res.status(200).json({
          success: true,
          result: result.data,
          meta: { cost_usdc: 0.25, note: `Published ${result.data.capabilities_indexed} capabilities to HiveBazaar.` },
        });
      }

      default:
        return res.status(404).json({ success: false, error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: 'MCP tool execution failed.', detail: err.message });
  }
});

export default router;
