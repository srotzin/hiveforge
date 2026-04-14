import crypto from 'crypto';
import { procurementService } from './procurement.js';

// ─── In-memory store ──────────────────────────────────────────────────────────
const takeoffs = new Map(); // project_id -> takeoff data

// ─── SDC hierarchy ────────────────────────────────────────────────────────────
const SDC_HIERARCHY = ['A', 'B', 'C', 'D', 'E', 'F'];

// ─── Connection Classification Rules ──────────────────────────────────────────
// Maps structural member types + context → connection type → Simpson product families
const CONNECTION_RULES = {
  wall: {
    foundation: {
      connection_type: 'holdown',
      description: 'Wall-to-foundation holdown',
      code_ref: 'IBC 2304.6, IRC R602.10',
      families: [
        { prefix: 'HDU', types: ['holdown'] },
        { prefix: 'HDUE', types: ['holdown_embedded'] },
      ],
    },
    lateral: {
      connection_type: 'shearwall_connector',
      description: 'Shearwall lateral restraint',
      code_ref: 'IBC 2305, SDPWS 4.3',
      families: [
        { prefix: 'SSW', types: ['shearwall_connector'] },
        { prefix: 'WSWH', types: ['wood_shearwall'] },
      ],
    },
    default: {
      connection_type: 'holdown',
      description: 'Wall connection (general)',
      code_ref: 'IBC 2304.6',
      families: [
        { prefix: 'HDU', types: ['holdown'] },
      ],
    },
  },
  beam: {
    column: {
      connection_type: 'post_base',
      description: 'Beam-to-column post base',
      code_ref: 'NDS 12.1, IBC 2304.9',
      families: [
        { prefix: 'ABU', types: ['post_base'] },
      ],
    },
    header: {
      connection_type: 'header_hanger',
      description: 'Beam/header hanger connection',
      code_ref: 'IBC 2304.9.3',
      families: [
        { prefix: 'HHDQ', types: ['header_hanger'] },
        { prefix: 'HUS', types: ['joist_hanger'] },
      ],
    },
    default: {
      connection_type: 'joist_hanger',
      description: 'Beam bearing connection',
      code_ref: 'IBC 2304.9',
      families: [
        { prefix: 'HUS', types: ['joist_hanger'] },
        { prefix: 'LUS', types: ['joist_hanger'] },
      ],
    },
  },
  column: {
    foundation: {
      connection_type: 'post_base',
      description: 'Column-to-foundation post base',
      code_ref: 'NDS 12.1, IBC 2304.9',
      families: [
        { prefix: 'ABU', types: ['post_base'] },
      ],
    },
    default: {
      connection_type: 'post_base',
      description: 'Column base connection',
      code_ref: 'NDS 12.1',
      families: [
        { prefix: 'ABU', types: ['post_base'] },
      ],
    },
  },
  truss: {
    wall: {
      connection_type: 'hurricane_tie',
      description: 'Truss-to-wall hurricane tie',
      code_ref: 'IBC 2304.9.5, IRC R802.11',
      families: [
        { prefix: 'H10', types: ['hurricane_tie'] },
        { prefix: 'H2.5A', types: ['hurricane_tie'] },
        { prefix: 'H1', types: ['hurricane_tie'] },
      ],
    },
    default: {
      connection_type: 'hurricane_tie',
      description: 'Truss connection',
      code_ref: 'IBC 2304.9.5',
      families: [
        { prefix: 'H10', types: ['hurricane_tie'] },
        { prefix: 'H2.5A', types: ['hurricane_tie'] },
      ],
    },
  },
  roof: {
    wall: {
      connection_type: 'hurricane_tie',
      description: 'Rafter-to-wall hurricane tie',
      code_ref: 'IBC 2304.9.5, IRC R802.11',
      families: [
        { prefix: 'H10', types: ['hurricane_tie'] },
        { prefix: 'H2.5A', types: ['hurricane_tie'] },
        { prefix: 'H1', types: ['hurricane_tie'] },
      ],
    },
    default: {
      connection_type: 'hurricane_tie',
      description: 'Roof-to-wall connection',
      code_ref: 'IRC R802.11',
      families: [
        { prefix: 'H10', types: ['hurricane_tie'] },
      ],
    },
  },
  foundation: {
    wall: {
      connection_type: 'anchor_bolt',
      description: 'Foundation anchor bolt / stud connector',
      code_ref: 'IBC 1908, IRC R403.1.6',
      families: [
        { prefix: 'SSTB', types: ['stud_connector'] },
        { prefix: 'HDU', types: ['holdown'] },
      ],
    },
    default: {
      connection_type: 'anchor_bolt',
      description: 'Foundation anchorage',
      code_ref: 'IBC 1908',
      families: [
        { prefix: 'SSTB', types: ['stud_connector'] },
      ],
    },
  },
  slab: {
    default: {
      connection_type: 'anchor_bolt',
      description: 'Slab-on-grade anchorage',
      code_ref: 'IBC 1908, IRC R403.1.6',
      families: [
        { prefix: 'SSTB', types: ['stud_connector'] },
      ],
    },
  },
  deck: {
    default: {
      connection_type: 'joist_hanger',
      description: 'Deck joist hanger',
      code_ref: 'IRC R507.6',
      families: [
        { prefix: 'LUS', types: ['joist_hanger'] },
        { prefix: 'HUS', types: ['joist_hanger'] },
      ],
    },
  },
};

// ─── Seismic multiplier ───────────────────────────────────────────────────────
// Higher SDC categories require more connectors
const SDC_MULTIPLIER = { A: 1.0, B: 1.0, C: 1.1, D: 1.2, E: 1.3, F: 1.5 };

// ─── Wind uplift multiplier ───────────────────────────────────────────────────
function windMultiplier(windSpeedMph, exposureCategory) {
  let base = 1.0;
  if (windSpeedMph >= 150) base = 1.6;
  else if (windSpeedMph >= 130) base = 1.4;
  else if (windSpeedMph >= 115) base = 1.2;
  else if (windSpeedMph >= 100) base = 1.1;

  const exposureFactor = { B: 1.0, C: 1.1, D: 1.2 };
  return +(base * (exposureFactor[exposureCategory] || 1.0)).toFixed(2);
}

// ─── Unit pricing (USDC) ─────────────────────────────────────────────────────
const UNIT_PRICES = {
  joist_hanger: 4.85,
  holdown: 18.50,
  holdown_embedded: 22.00,
  hurricane_tie: 2.75,
  strap_tie: 3.25,
  post_base: 14.50,
  framing_angle: 1.85,
  stud_connector: 8.75,
  shearwall_connector: 45.00,
  wood_shearwall: 38.50,
  header_hanger: 12.50,
  structural_screw: 0.35,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateProjectId() {
  return 'tkf_' + crypto.randomBytes(8).toString('hex');
}

function deterministicHash(data) {
  const canonical = JSON.stringify(data, Object.keys(data).sort());
  return 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex');
}

// ─── Takeoff Engine ───────────────────────────────────────────────────────────

class TakeoffEngine {

  /**
   * Classify a structural member to determine what connection hardware it needs.
   * Returns { connection_type, description, code_ref, families[] }
   */
  classifyConnection(member) {
    const memberType = (member.type || '').toLowerCase();
    const location = (member.location || '').toLowerCase();

    const rules = CONNECTION_RULES[memberType];
    if (!rules) {
      return {
        connection_type: 'general',
        description: `General framing connection for ${memberType}`,
        code_ref: 'IBC 2304',
        families: [{ prefix: 'A35', types: ['framing_angle'] }],
      };
    }

    // Try to match a specific location context
    for (const [context, rule] of Object.entries(rules)) {
      if (context === 'default') continue;
      if (location.includes(context)) return rule;
    }

    return rules.default;
  }

  /**
   * Select the best Simpson product for a given connection, load, and SDC.
   * Returns the best-fit product from the catalog or null.
   */
  selectProduct(connectionRule, requiredLoadLbs, sdcCategory) {
    const catalog = procurementService.getCatalog();
    const candidates = [];

    for (const family of connectionRule.families) {
      for (const [sku, product] of Object.entries(catalog)) {
        const matchesFamily = family.types.includes(product.type);
        if (!matchesFamily) continue;

        // SDC check
        if (sdcCategory) {
          const reqIdx = SDC_HIERARCHY.indexOf(sdcCategory);
          if (reqIdx !== -1 && !product.sdc_ratings.includes(sdcCategory)) continue;
        }

        // Load check
        if (requiredLoadLbs && product.load_lbs < requiredLoadLbs) continue;

        candidates.push({
          sku,
          product,
          load_margin: requiredLoadLbs ? product.load_lbs - requiredLoadLbs : product.load_lbs,
          load_ratio: requiredLoadLbs ? +(requiredLoadLbs / product.load_lbs).toFixed(3) : 0,
        });
      }
    }

    if (candidates.length === 0) return null;

    // Select the product with the smallest adequate load margin (best fit, not overkill)
    candidates.sort((a, b) => a.load_margin - b.load_margin);
    return candidates[0];
  }

  /**
   * Calculate connector quantity for a structural member.
   */
  calculateQuantity(member, sdcCategory, windSpeedMph, exposureCategory) {
    let baseQty = member.quantity || 1;

    // For members with spacing, calculate count from span
    if (member.spacing_in && member.span_ft) {
      const spanInches = member.span_ft * 12;
      baseQty = Math.ceil(spanInches / member.spacing_in) + 1;
    }

    // Each structural member connection point needs at least 2 connectors (both ends)
    let connectorsPerMember = 2;

    // Apply SDC multiplier for seismic zones
    const sdcMult = SDC_MULTIPLIER[sdcCategory] || 1.0;

    // Apply wind multiplier
    const windMult = windMultiplier(windSpeedMph || 0, exposureCategory);

    const totalQty = Math.ceil(baseQty * connectorsPerMember * sdcMult * windMult);
    return Math.max(totalQty, 2); // minimum 2 connectors
  }

  /**
   * INGEST: Process a blueprint and extract classified structural requirements.
   */
  ingest(params) {
    const {
      project_name, building_type, stories, square_footage,
      seismic_design_category, wind_speed_mph, exposure_category,
      soil_class, structural_members, notes,
    } = params;

    if (!structural_members || !Array.isArray(structural_members) || structural_members.length === 0) {
      return { success: false, error: 'structural_members array is required and must not be empty' };
    }

    const projectId = generateProjectId();
    const timestamp = new Date().toISOString();

    const classifiedMembers = structural_members.map((member, idx) => {
      const connection = this.classifyConnection(member);
      return {
        index: idx,
        original: member,
        classified: {
          member_type: member.type,
          connection_type: connection.connection_type,
          connection_description: connection.description,
          code_reference: connection.code_ref,
          product_families: connection.families.map(f => f.prefix),
          required_load_lbs: member.load_lbs || null,
          location: member.location || 'unspecified',
          quantity: member.quantity || 1,
          span_ft: member.span_ft || null,
          spacing_in: member.spacing_in || null,
          material: member.material || 'wood',
        },
      };
    });

    const projectData = {
      project_id: projectId,
      project_name: project_name || 'Untitled Project',
      building_type: building_type || 'residential',
      stories: stories || 1,
      square_footage: square_footage || null,
      seismic_design_category: seismic_design_category || 'D',
      wind_speed_mph: wind_speed_mph || 115,
      exposure_category: exposure_category || 'B',
      soil_class: soil_class || null,
      notes: notes || null,
      members: classifiedMembers,
      member_count: classifiedMembers.length,
      ingested_at: timestamp,
      status: 'ingested',
    };

    // Store takeoff
    takeoffs.set(projectId, projectData);

    return {
      success: true,
      data: projectData,
      meta: {
        cost_usdc: 0.10,
        note: 'Blueprint ingested. Run /v1/takeoff/generate-bom to create Bill of Materials.',
      },
    };
  }

  /**
   * GENERATE BOM: For each classified member, match Simpson SKUs and build full BOM.
   */
  generateBOM(params) {
    const { project_id, seismic_design_category, wind_speed_mph, exposure_category } = params;

    const project = takeoffs.get(project_id);
    if (!project) {
      return { success: false, error: `Project ${project_id} not found. Run /ingest first.` };
    }

    const sdc = seismic_design_category || project.seismic_design_category || 'D';
    const wind = wind_speed_mph || project.wind_speed_mph || 115;
    const exposure = exposure_category || project.exposure_category || 'B';

    const bomItems = [];
    const warnings = [];
    let totalUsdc = 0;

    for (const classified of project.members) {
      const member = classified.original;
      const conn = this.classifyConnection(member);
      const requiredLoad = member.load_lbs || 0;

      const selection = this.selectProduct(conn, requiredLoad, sdc);

      if (!selection) {
        warnings.push({
          member_index: classified.index,
          member_type: member.type,
          location: member.location,
          issue: `No Simpson product found for ${conn.connection_type} with load >= ${requiredLoad} lbs in SDC ${sdc}`,
          recommendation: 'Requires engineered solution — consult structural engineer',
        });
        continue;
      }

      const quantity = this.calculateQuantity(member, sdc, wind, exposure);
      const unitPrice = UNIT_PRICES[selection.product.type] || 5.00;
      const lineTotal = +(quantity * unitPrice).toFixed(2);

      bomItems.push({
        member_index: classified.index,
        member_type: member.type,
        member_location: member.location || 'unspecified',
        connection_type: conn.connection_type,
        product_id: selection.sku,
        product_model: selection.product.model,
        product_description: selection.product.description,
        product_type: selection.product.type,
        load_capacity_lbs: selection.product.load_lbs,
        required_load_lbs: requiredLoad,
        load_utilization: selection.load_ratio,
        sdc_ratings: selection.product.sdc_ratings,
        required_sdc: sdc,
        code_reference: conn.code_ref,
        quantity,
        unit_price_usdc: unitPrice,
        line_total_usdc: lineTotal,
      });

      totalUsdc += lineTotal;
    }

    totalUsdc = +totalUsdc.toFixed(2);

    const bomHash = deterministicHash({
      project_id,
      items: bomItems.map(i => ({ sku: i.product_id, qty: i.quantity, price: i.unit_price_usdc })),
      sdc,
      wind,
    });

    const bom = {
      project_id,
      project_name: project.project_name,
      building_type: project.building_type,
      seismic_design_category: sdc,
      wind_speed_mph: wind,
      exposure_category: exposure,
      items: bomItems,
      warnings,
      summary: {
        total_line_items: bomItems.length,
        total_hardware_pieces: bomItems.reduce((sum, i) => sum + i.quantity, 0),
        total_usdc: totalUsdc,
        warnings_count: warnings.length,
        unique_skus: [...new Set(bomItems.map(i => i.product_id))].length,
      },
      bom_hash: bomHash,
      generated_at: new Date().toISOString(),
    };

    // Update project with BOM
    project.bom = bom;
    project.status = 'bom_generated';
    takeoffs.set(project_id, project);

    return {
      success: true,
      data: bom,
      meta: {
        cost_usdc: 0.15,
        note: 'BOM generated. Use /v1/takeoff/full-pipeline for procurement-ready output.',
      },
    };
  }

  /**
   * FULL PIPELINE: Ingest + BOM + procurement validation in one atomic call.
   */
  fullPipeline(params) {
    // Step 1: Ingest
    const ingestResult = this.ingest(params);
    if (!ingestResult.success) {
      return { success: false, error: ingestResult.error, stage: 'ingest' };
    }

    const projectId = ingestResult.data.project_id;

    // Step 2: Generate BOM
    const bomResult = this.generateBOM({
      project_id: projectId,
      seismic_design_category: params.seismic_design_category,
      wind_speed_mph: params.wind_speed_mph,
      exposure_category: params.exposure_category,
    });

    if (!bomResult.success) {
      return { success: false, error: bomResult.error, stage: 'bom_generation' };
    }

    // Step 3: Validate BOM against procurement catalog
    const procurementItems = bomResult.data.items.map(item => ({
      product_id: item.product_id,
      quantity: item.quantity,
      unit_price_usdc: item.unit_price_usdc,
      application: item.connection_type,
      required_load_lbs: item.required_load_lbs,
      sdc_category: item.required_sdc,
    }));

    let validation = null;
    if (procurementItems.length > 0) {
      validation = procurementService.validateBOM({ items: procurementItems });
    }

    // Update project status
    const project = takeoffs.get(projectId);
    project.status = 'pipeline_complete';
    project.validation = validation;
    takeoffs.set(projectId, project);

    return {
      success: true,
      data: {
        project_id: projectId,
        project_name: ingestResult.data.project_name,
        building_type: ingestResult.data.building_type,
        stories: ingestResult.data.stories,
        square_footage: ingestResult.data.square_footage,
        seismic_design_category: bomResult.data.seismic_design_category,
        wind_speed_mph: bomResult.data.wind_speed_mph,
        exposure_category: bomResult.data.exposure_category,
        members_ingested: ingestResult.data.member_count,
        bom: bomResult.data,
        procurement_validation: validation,
        pipeline_hash: deterministicHash({
          project_id: projectId,
          bom_hash: bomResult.data.bom_hash,
          validation_valid: validation ? validation.valid : null,
        }),
      },
      meta: {
        cost_usdc: 0.25,
        note: 'Full pipeline complete. BOM is procurement-ready.',
      },
    };
  }

  /**
   * ESTIMATE: Quick cost estimate without full BOM generation.
   */
  estimate(params) {
    const { structural_members, seismic_design_category, wind_speed_mph, exposure_category } = params;

    if (!structural_members || !Array.isArray(structural_members) || structural_members.length === 0) {
      return { success: false, error: 'structural_members array is required and must not be empty' };
    }

    const sdc = seismic_design_category || 'D';
    const wind = wind_speed_mph || 115;
    const exposure = exposure_category || 'B';

    let lowEstimate = 0;
    let highEstimate = 0;
    const memberEstimates = [];

    for (const member of structural_members) {
      const conn = this.classifyConnection(member);
      const qty = this.calculateQuantity(member, sdc, wind, exposure);

      // Get price range for the connection type families
      const catalog = procurementService.getCatalog();
      const prices = [];
      for (const family of conn.families) {
        for (const product of Object.values(catalog)) {
          if (family.types.includes(product.type)) {
            prices.push(UNIT_PRICES[product.type] || 5.00);
          }
        }
      }

      const minPrice = prices.length > 0 ? Math.min(...prices) : 2.00;
      const maxPrice = prices.length > 0 ? Math.max(...prices) : 20.00;

      const low = +(qty * minPrice).toFixed(2);
      const high = +(qty * maxPrice).toFixed(2);

      lowEstimate += low;
      highEstimate += high;

      memberEstimates.push({
        member_type: member.type,
        location: member.location || 'unspecified',
        connection_type: conn.connection_type,
        estimated_connectors: qty,
        price_range_usdc: { low, high },
      });
    }

    return {
      success: true,
      data: {
        member_count: structural_members.length,
        seismic_design_category: sdc,
        wind_speed_mph: wind,
        exposure_category: exposure,
        members: memberEstimates,
        total_estimate_usdc: {
          low: +lowEstimate.toFixed(2),
          high: +highEstimate.toFixed(2),
        },
        disclaimer: 'Estimate only. Run /v1/takeoff/full-pipeline for exact BOM with validated SKUs.',
      },
      meta: {
        cost_usdc: 0.05,
        note: 'Quick estimate generated.',
      },
    };
  }

  /**
   * GET PROJECT: Return full takeoff history for a project.
   */
  getProject(projectId) {
    const project = takeoffs.get(projectId);
    if (!project) return null;
    return project;
  }
}

export const takeoffEngine = new TakeoffEngine();
export default takeoffEngine;
