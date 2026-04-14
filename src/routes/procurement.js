import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { procurementService } from '../services/procurement.js';

const router = Router();

/**
 * POST /v1/procurement/execute — Atomic procurement execution
 * Validates specs + code compliance + payment delegation in ONE call.
 * If ANY step fails, the ENTIRE operation rolls back.
 */
router.post('/execute', requireDID, async (req, res) => {
  try {
    const { buyer_did, delegation_id, project_id, items, compliance_required, inspector_did } = req.body;

    if (!buyer_did || !delegation_id || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Required fields: buyer_did, delegation_id, items (non-empty array)',
      });
    }

    const result = await procurementService.executeProcurement({
      buyer_did,
      delegation_id,
      project_id,
      items,
      compliance_required: compliance_required !== false,
      inspector_did,
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        ...(result.failed_item && { failed_item: result.failed_item }),
        ...(result.detail && { detail: result.detail }),
        ...(result.total_usdc !== undefined && { total_usdc: result.total_usdc }),
        ...(result.delegation_id && { delegation_id: result.delegation_id }),
      });
    }

    return res.status(201).json({
      success: true,
      ...result.data,
    });
  } catch (err) {
    if (err.message.includes('Duplicate order')) {
      return res.status(409).json({ success: false, error: err.message });
    }
    return res.status(500).json({ success: false, error: 'Procurement execution failed.', detail: err.message });
  }
});

/**
 * GET /v1/procurement/order/:order_id — Get full order details
 */
router.get('/order/:order_id', requireDID, async (req, res) => {
  try {
    const order = await procurementService.getOrder(req.params.order_id);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found.' });
    }
    return res.status(200).json({ success: true, data: order });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Order lookup failed.', detail: err.message });
  }
});

/**
 * GET /v1/procurement/project/:project_id — Get all orders for a project
 */
router.get('/project/:project_id', requireDID, async (req, res) => {
  try {
    const orders = await procurementService.getProjectOrders(req.params.project_id);
    return res.status(200).json({
      success: true,
      data: orders,
      count: orders.length,
      project_id: req.params.project_id,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Project orders lookup failed.', detail: err.message });
  }
});

/**
 * POST /v1/procurement/validate-bom — Dry-run BOM validation (no payment)
 * Same input as execute, returns validation results for each item.
 */
router.post('/validate-bom', requireDID, async (req, res) => {
  try {
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Items array is required and must not be empty.',
      });
    }

    const result = procurementService.validateBOM({ items });

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'BOM validation failed.', detail: err.message });
  }
});

export default router;
