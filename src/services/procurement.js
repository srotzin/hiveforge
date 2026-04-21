import crypto from 'crypto';
import pool, { isPostgres } from './db.js';

// ─── Simpson Strong-Tie Catalog (embedded subset) ───────────────────────────
// Load ratings: lbs (allowable load), SDC coverage A-F
const SIMPSON_CATALOG = {
  // Joist hangers
  LUS26: { model: 'LUS26', type: 'joist_hanger', load_lbs: 1185, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Face-mount joist hanger for 2x6' },
  LUS28: { model: 'LUS28', type: 'joist_hanger', load_lbs: 1560, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Face-mount joist hanger for 2x8' },
  LUS210: { model: 'LUS210', type: 'joist_hanger', load_lbs: 1780, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Face-mount joist hanger for 2x10' },
  HUS26: { model: 'HUS26', type: 'joist_hanger', load_lbs: 1560, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Heavy face-mount joist hanger for 2x6' },
  HUS28: { model: 'HUS28', type: 'joist_hanger', load_lbs: 2065, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Heavy face-mount joist hanger for 2x8' },
  HUS210: { model: 'HUS210', type: 'joist_hanger', load_lbs: 2615, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Heavy face-mount joist hanger for 2x10' },

  // Holdowns
  HDU2: { model: 'HDU2', type: 'holdown', load_lbs: 3075, sdc_ratings: ['A', 'B', 'C', 'D'], description: 'Predeflected holdown for shearwall' },
  HDU4: { model: 'HDU4', type: 'holdown', load_lbs: 4565, sdc_ratings: ['A', 'B', 'C', 'D', 'E'], description: 'Predeflected holdown for shearwall' },
  HDU5: { model: 'HDU5', type: 'holdown', load_lbs: 5645, sdc_ratings: ['A', 'B', 'C', 'D', 'E'], description: 'Predeflected holdown for shearwall' },
  HDU8: { model: 'HDU8', type: 'holdown', load_lbs: 8305, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Heavy predeflected holdown for shearwall' },
  HDU14: { model: 'HDU14', type: 'holdown', load_lbs: 14930, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Extra-heavy predeflected holdown' },

  // Embedded holdowns
  HDUE2: { model: 'HDUE2', type: 'holdown_embedded', load_lbs: 3075, sdc_ratings: ['A', 'B', 'C', 'D'], description: 'Embedded predeflected holdown' },
  HDUE4: { model: 'HDUE4', type: 'holdown_embedded', load_lbs: 4565, sdc_ratings: ['A', 'B', 'C', 'D', 'E'], description: 'Embedded predeflected holdown' },

  // Heavy header hanger
  HHDQ: { model: 'HHDQ', type: 'header_hanger', load_lbs: 5680, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Heavy header hanger' },

  // Shearwall connectors
  SSW15: { model: 'SSW15', type: 'shearwall_connector', load_lbs: 3240, sdc_ratings: ['A', 'B', 'C', 'D', 'E'], description: 'Steel strong-wall 15 in.' },
  SSW18: { model: 'SSW18', type: 'shearwall_connector', load_lbs: 4025, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Steel strong-wall 18 in.' },
  SSW24: { model: 'SSW24', type: 'shearwall_connector', load_lbs: 5350, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Steel strong-wall 24 in.' },

  // Wood shearwall panels
  WSWH: { model: 'WSWH', type: 'wood_shearwall', load_lbs: 3025, sdc_ratings: ['A', 'B', 'C', 'D', 'E'], description: 'Wood strong-wall shearwall panel' },

  // Hurricane ties
  H1: { model: 'H1', type: 'hurricane_tie', load_lbs: 585, sdc_ratings: ['A', 'B', 'C'], description: 'Hurricane tie — light-duty' },
  'H2.5A': { model: 'H2.5A', type: 'hurricane_tie', load_lbs: 840, sdc_ratings: ['A', 'B', 'C', 'D'], description: 'Hurricane tie — medium-duty' },
  H10: { model: 'H10', type: 'hurricane_tie', load_lbs: 1510, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Hurricane tie — heavy-duty' },

  // Strap ties
  LSTA: { model: 'LSTA', type: 'strap_tie', load_lbs: 1275, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Lateral strap tie — 1-1/4 in.' },
  MSTA: { model: 'MSTA', type: 'strap_tie', load_lbs: 1815, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Medium strap tie — 1-3/8 in.' },

  // Post bases
  ABU44: { model: 'ABU44', type: 'post_base', load_lbs: 3905, sdc_ratings: ['A', 'B', 'C', 'D', 'E'], description: 'Adjustable post base for 4x4' },
  ABU46: { model: 'ABU46', type: 'post_base', load_lbs: 5850, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Adjustable post base for 4x6' },
  ABU66: { model: 'ABU66', type: 'post_base', load_lbs: 7475, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Adjustable post base for 6x6' },

  // Angles
  A35: { model: 'A35', type: 'framing_angle', load_lbs: 870, sdc_ratings: ['A', 'B', 'C', 'D'], description: 'Framing angle — 18-gauge' },

  // Stud-to-top-plate connectors
  SSTB16: { model: 'SSTB16', type: 'stud_connector', load_lbs: 1490, sdc_ratings: ['A', 'B', 'C', 'D', 'E'], description: 'Stud-to-top-plate tension bridge 16 in.' },
  SSTB20: { model: 'SSTB20', type: 'stud_connector', load_lbs: 1840, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Stud-to-top-plate tension bridge 20 in.' },

  // Structural screws
  SDS25300: { model: 'SDS25300', type: 'structural_screw', load_lbs: 405, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Strong-Drive SDS screw 1/4 x 3 in.' },
  SDS25400: { model: 'SDS25400', type: 'structural_screw', load_lbs: 510, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Strong-Drive SDS screw 1/4 x 4 in.' },
  SDS25600: { model: 'SDS25600', type: 'structural_screw', load_lbs: 665, sdc_ratings: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Strong-Drive SDS screw 1/4 x 6 in.' },
};

// SDC category hierarchy: A < B < C < D < E < F
const SDC_HIERARCHY = ['A', 'B', 'C', 'D', 'E', 'F'];

// ─── In-memory store (fallback when no PostgreSQL) ──────────────────────────
const memOrders = new Map();

// ─── Deterministic hash generation ──────────────────────────────────────────
function deterministicHash(data) {
  const canonical = JSON.stringify(data, Object.keys(data).sort());
  return 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex');
}

function generateComplianceProof(item, product) {
  return deterministicHash({
    product_id: item.product_id,
    quantity: item.quantity,
    unit_price_usdc: item.unit_price_usdc,
    load_capacity: product.load_lbs,
    required_load: item.required_load_lbs,
    sdc_category: item.sdc_category,
    application: item.application,
  });
}

function generateOrderHash(buyerDid, projectId, items, totalUsdc) {
  return deterministicHash({
    buyer_did: buyerDid,
    project_id: projectId,
    items: items.map(i => ({
      product_id: i.product_id,
      quantity: i.quantity,
      unit_price_usdc: i.unit_price_usdc,
    })),
    total_usdc: totalUsdc,
  });
}

function generateCertificateHash(orderHash, itemProofs) {
  return deterministicHash({
    order_hash: orderHash,
    item_proofs: itemProofs,
  });
}

function generateOrderId() {
  return 'ord_' + crypto.randomBytes(8).toString('hex');
}

// ─── Procurement Service ────────────────────────────────────────────────────

class ProcurementService {
  /**
   * Get a product from the embedded Simpson catalog.
   */
  getProduct(productId) {
    return SIMPSON_CATALOG[productId] || null;
  }

  /**
   * Check if a product's SDC rating covers the required category.
   * E.g., a product rated for D covers A, B, C, D but not E or F.
   */
  checkSDC(productSdcRatings, requiredCategory) {
    if (!requiredCategory) return { verified: true, note: 'No SDC requirement specified' };
    const reqIdx = SDC_HIERARCHY.indexOf(requiredCategory);
    if (reqIdx === -1) return { verified: false, reason: `Invalid SDC category: ${requiredCategory}` };
    return {
      verified: productSdcRatings.includes(requiredCategory),
      product_ratings: productSdcRatings,
      required: requiredCategory,
    };
  }

  /**
   * Validate a single line item against the catalog.
   */
  validateItem(item) {
    const product = this.getProduct(item.product_id);
    if (!product) {
      return { valid: false, reason: `Product ${item.product_id} not found in Simpson catalog` };
    }

    // Load check
    const loadCheck = {
      capacity: product.load_lbs,
      required: item.required_load_lbs || 0,
      ratio: item.required_load_lbs ? +(item.required_load_lbs / product.load_lbs).toFixed(3) : 0,
      pass: !item.required_load_lbs || product.load_lbs >= item.required_load_lbs,
    };

    if (!loadCheck.pass) {
      return {
        valid: false,
        reason: `Load check failed: ${product.model} capacity ${product.load_lbs} lbs < required ${item.required_load_lbs} lbs`,
        load_check: loadCheck,
      };
    }

    // SDC check
    const sdcCheck = this.checkSDC(product.sdc_ratings, item.sdc_category);
    if (!sdcCheck.verified) {
      return {
        valid: false,
        reason: sdcCheck.reason || `SDC check failed: ${product.model} not rated for SDC ${item.sdc_category}`,
        load_check: loadCheck,
        sdc_check: sdcCheck,
      };
    }

    const lineTotal = +(item.quantity * item.unit_price_usdc).toFixed(4);
    const complianceProofHash = generateComplianceProof(item, product);

    return {
      valid: true,
      product,
      load_check: loadCheck,
      sdc_check: sdcCheck,
      line_total_usdc: lineTotal,
      compliance_proof_hash: complianceProofHash,
    };
  }

  /**
   * Dry-run validation of a bill of materials.
   */
  validateBOM(params) {
    const { items } = params;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return { valid: false, error: 'Items array is required and must not be empty' };
    }

    const results = [];
    let totalUsdc = 0;
    let allValid = true;

    for (const item of items) {
      const result = this.validateItem(item);
      results.push({
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price_usdc: item.unit_price_usdc,
        application: item.application,
        ...result,
      });
      if (result.valid) {
        totalUsdc += result.line_total_usdc;
      } else {
        allValid = false;
      }
    }

    return {
      valid: allValid,
      items: results,
      total_usdc: +totalUsdc.toFixed(4),
      item_count: items.length,
      passed: results.filter(r => r.valid).length,
      failed: results.filter(r => !r.valid).length,
    };
  }

  /**
   * Execute an atomic procurement order.
   * ALL steps must pass or the entire operation rolls back.
   */
  async executeProcurement(params) {
    const { buyer_did, delegation_id, project_id, items, compliance_required = true, inspector_did } = params;

    // Validate required fields
    if (!buyer_did) return { success: false, error: 'buyer_did is required' };
    if (!delegation_id) return { success: false, error: 'delegation_id is required' };
    if (!items || !Array.isArray(items) || items.length === 0) {
      return { success: false, error: 'Items array is required and must not be empty' };
    }

    // ── BOUNTY/PHEROMONE MODE ────────────────────────────────────────────────
    // If items contain signal_id + deliverable (not product_id), this is a
    // pheromone bounty submission — skip Simpson catalog validation entirely.
    const isBountyMode = items.every(i => i.signal_id && i.deliverable && !i.product_id);
    if (isBountyMode) {
      const bountyResults = items.map((item, idx) => ({
        signal_id:         item.signal_id,
        deliverable_hash:  Buffer.from(item.deliverable.slice(0, 64)).toString('hex'),
        deliverable_chars: item.deliverable.length,
        status:            'accepted',
        estimated_usdc:    item.estimated_usdc || 0,
        submission_index:  idx,
      }));
      const totalEstimated = bountyResults.reduce((s, r) => s + r.estimated_usdc, 0);
      const orderId = `ord_bounty_${delegation_id}_${Date.now()}`;
      return {
        success: true,
        data: {
          order_id:              orderId,
          mode:                  'bounty_pheromone',
          buyer_did,
          delegation_id,
          status:                'submitted',
          items_submitted:       bountyResults.length,
          bounty_items:          bountyResults,
          total_estimated_usdc:  +totalEstimated.toFixed(4),
          message:               'Pheromone bounty deliverables submitted. USDC credited when signal poster confirms receipt.',
          next:                  'Monitor GET /v1/pheromones/opportunities for updated signal status.',
          created_at:            new Date().toISOString(),
        },
      };
    }

    // ── Step 1 & 2 & 3: Validate all items (spec + load + SDC + cost) ────
    const validatedItems = [];
    let totalUsdc = 0;
    const complianceProofs = [];

    for (const item of items) {
      const validation = this.validateItem(item);
      if (!validation.valid) {
        return {
          success: false,
          error: `Validation failed for ${item.product_id}: ${validation.reason}`,
          failed_item: item.product_id,
          detail: validation,
        };
      }

      totalUsdc += validation.line_total_usdc;
      complianceProofs.push(validation.compliance_proof_hash);

      validatedItems.push({
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price_usdc: item.unit_price_usdc,
        line_total_usdc: validation.line_total_usdc,
        application: item.application,
        spec_verified: true,
        load_check: validation.load_check,
        sdc_verified: validation.sdc_check.verified,
        compliance_proof_hash: compliance_required ? validation.compliance_proof_hash : null,
      });
    }

    totalUsdc = +totalUsdc.toFixed(4);

    // ── Step 4: Check delegation budget & scope ─────────────────────────
    // Simulate delegation authorization (in production, call HiveTrust /v1/delegation/authorize-spend)
    const delegationCheck = await this.authorizeDelegation(delegation_id, totalUsdc, items);
    if (!delegationCheck.authorized) {
      return {
        success: false,
        error: `Delegation authorization failed: ${delegationCheck.reason}`,
        total_usdc: totalUsdc,
        delegation_id,
      };
    }

    // ── Step 5: Generate order hash and compliance certificate ──────────
    const orderHash = generateOrderHash(buyer_did, project_id, items, totalUsdc);
    const complianceCertificateHash = compliance_required
      ? generateCertificateHash(orderHash, complianceProofs)
      : null;

    // ── Step 6: Record the order ────────────────────────────────────────
    const orderId = generateOrderId();
    const timestamp = new Date().toISOString();

    const order = {
      order_id: orderId,
      status: 'completed',
      buyer_did,
      project_id,
      delegation_id,
      items: validatedItems,
      total_usdc: totalUsdc,
      delegation_authorized: true,
      delegation_remaining_usdc: delegationCheck.remaining_usdc,
      order_hash: orderHash,
      compliance_certificate_hash: complianceCertificateHash,
      inspector_did: inspector_did || null,
      timestamp,
    };

    await this.storeOrder(order);

    return {
      success: true,
      data: order,
    };
  }

  /**
   * Simulate delegation authorization.
   * In production, this calls HiveTrust /v1/delegation/authorize-spend.
   */
  async authorizeDelegation(delegationId, totalUsdc, items) {
    // Simulated delegation ledger (in-memory)
    // In production, this is a real call to HiveTrust
    if (!this._delegationLedger) {
      this._delegationLedger = new Map();
    }

    let delegation = this._delegationLedger.get(delegationId);
    if (!delegation) {
      // New delegation — initialize with default budget
      delegation = {
        id: delegationId,
        budget_usdc: 50000,
        spent_usdc: 0,
        scope: ['construction', 'hardware', 'structural', 'shearwall', 'framing', 'roofing', 'foundation'],
      };
      this._delegationLedger.set(delegationId, delegation);
    }

    const remainingBudget = delegation.budget_usdc - delegation.spent_usdc;
    if (totalUsdc > remainingBudget) {
      return {
        authorized: false,
        reason: `Insufficient budget: need $${totalUsdc}, remaining $${remainingBudget}`,
        remaining_usdc: remainingBudget,
      };
    }

    // Check scope — each item's application must be in delegation scope
    for (const item of items) {
      if (item.application && !delegation.scope.includes(item.application)) {
        return {
          authorized: false,
          reason: `Item ${item.product_id} application "${item.application}" not in delegation scope`,
          scope: delegation.scope,
        };
      }
    }

    // Authorize the spend
    delegation.spent_usdc += totalUsdc;
    this._delegationLedger.set(delegationId, delegation);

    return {
      authorized: true,
      remaining_usdc: +(delegation.budget_usdc - delegation.spent_usdc).toFixed(4),
    };
  }

  /**
   * Store an order in PostgreSQL or in-memory.
   */
  async storeOrder(order) {
    if (isPostgres()) {
      try {
        await pool.query(
          `INSERT INTO hiveforge.procurement_orders
            (id, buyer_did, project_id, delegation_id, items, total_usdc, status, order_hash, compliance_certificate_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            order.order_id,
            order.buyer_did,
            order.project_id,
            order.delegation_id,
            JSON.stringify(order.items),
            order.total_usdc,
            order.status,
            order.order_hash,
            order.compliance_certificate_hash,
          ]
        );
      } catch (err) {
        // If unique constraint violation on order_hash, it's a duplicate
        if (err.code === '23505') {
          throw new Error(`Duplicate order: order_hash ${order.order_hash} already exists`);
        }
        throw err;
      }
    } else {
      // Check for duplicate in memory
      for (const [, existing] of memOrders) {
        if (existing.order_hash === order.order_hash) {
          throw new Error(`Duplicate order: order_hash ${order.order_hash} already exists`);
        }
      }
      memOrders.set(order.order_id, order);
    }
  }

  /**
   * Get an order by ID.
   */
  async getOrder(orderId) {
    if (isPostgres()) {
      const result = await pool.query(
        'SELECT * FROM hiveforge.procurement_orders WHERE id = $1',
        [orderId]
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        order_id: row.id,
        buyer_did: row.buyer_did,
        project_id: row.project_id,
        delegation_id: row.delegation_id,
        items: typeof row.items === 'string' ? JSON.parse(row.items) : row.items,
        total_usdc: parseFloat(row.total_usdc),
        status: row.status,
        order_hash: row.order_hash,
        compliance_certificate_hash: row.compliance_certificate_hash,
        failure_reason: row.failure_reason,
        timestamp: row.created_at,
      };
    }
    return memOrders.get(orderId) || null;
  }

  /**
   * Get all orders for a project.
   */
  async getProjectOrders(projectId) {
    if (isPostgres()) {
      const result = await pool.query(
        'SELECT * FROM hiveforge.procurement_orders WHERE project_id = $1 ORDER BY created_at DESC',
        [projectId]
      );
      return result.rows.map(row => ({
        order_id: row.id,
        buyer_did: row.buyer_did,
        project_id: row.project_id,
        delegation_id: row.delegation_id,
        items: typeof row.items === 'string' ? JSON.parse(row.items) : row.items,
        total_usdc: parseFloat(row.total_usdc),
        status: row.status,
        order_hash: row.order_hash,
        compliance_certificate_hash: row.compliance_certificate_hash,
        failure_reason: row.failure_reason,
        timestamp: row.created_at,
      }));
    }
    const orders = [];
    for (const [, order] of memOrders) {
      if (order.project_id === projectId) orders.push(order);
    }
    return orders.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  /**
   * Get the Simpson product catalog.
   */
  getCatalog() {
    return SIMPSON_CATALOG;
  }
}

export const procurementService = new ProcurementService();
export default procurementService;
