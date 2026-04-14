import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import { takeoffEngine } from '../services/takeoff-engine.js';

const router = Router();

/**
 * POST /v1/takeoff/ingest — Ingest a structured blueprint and classify connections
 * x402: $0.10 per blueprint ingestion
 */
router.post('/ingest', requireDID, requirePayment(0.10, 'Takeoff Blueprint Ingestion'), async (req, res) => {
  try {
    const {
      project_name, building_type, stories, square_footage,
      seismic_design_category, wind_speed_mph, exposure_category,
      soil_class, structural_members, notes,
    } = req.body;

    if (!structural_members || !Array.isArray(structural_members) || structural_members.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'structural_members array is required and must not be empty.',
      });
    }

    const result = takeoffEngine.ingest({
      project_name, building_type, stories, square_footage,
      seismic_design_category, wind_speed_mph, exposure_category,
      soil_class, structural_members, notes,
    });

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.status(201).json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Blueprint ingestion failed.', detail: err.message });
  }
});

/**
 * POST /v1/takeoff/generate-bom — Generate Bill of Materials from ingested project
 * x402: $0.15 per BOM generation
 */
router.post('/generate-bom', requireDID, requirePayment(0.15, 'Takeoff BOM Generation'), async (req, res) => {
  try {
    const { project_id, seismic_design_category, wind_speed_mph, exposure_category } = req.body;

    if (!project_id) {
      return res.status(400).json({
        success: false,
        error: 'project_id is required. Run POST /v1/takeoff/ingest first.',
      });
    }

    const result = takeoffEngine.generateBOM({
      project_id, seismic_design_category, wind_speed_mph, exposure_category,
    });

    if (!result.success) {
      return res.status(result.error.includes('not found') ? 404 : 400).json({
        success: false,
        error: result.error,
      });
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: 'BOM generation failed.', detail: err.message });
  }
});

/**
 * POST /v1/takeoff/full-pipeline — Atomic ingest + BOM + validation
 * x402: $0.25 per full pipeline run
 */
router.post('/full-pipeline', requireDID, requirePayment(0.25, 'Takeoff Full Pipeline'), async (req, res) => {
  try {
    const {
      project_name, building_type, stories, square_footage,
      seismic_design_category, wind_speed_mph, exposure_category,
      soil_class, structural_members, notes,
    } = req.body;

    if (!structural_members || !Array.isArray(structural_members) || structural_members.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'structural_members array is required and must not be empty.',
      });
    }

    const result = takeoffEngine.fullPipeline({
      project_name, building_type, stories, square_footage,
      seismic_design_category, wind_speed_mph, exposure_category,
      soil_class, structural_members, notes,
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        ...(result.stage && { stage: result.stage }),
      });
    }

    return res.status(201).json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Full pipeline failed.', detail: err.message });
  }
});

/**
 * GET /v1/takeoff/project/:project_id — Get full takeoff history for a project
 */
router.get('/project/:project_id', requireDID, async (req, res) => {
  try {
    const project = takeoffEngine.getProject(req.params.project_id);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found.' });
    }
    return res.status(200).json({ success: true, data: project });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Project lookup failed.', detail: err.message });
  }
});

/**
 * POST /v1/takeoff/estimate — Quick cost estimate from structural members
 * x402: $0.05 per estimate
 */
router.post('/estimate', requireDID, requirePayment(0.05, 'Takeoff Quick Estimate'), async (req, res) => {
  try {
    const { structural_members, seismic_design_category, wind_speed_mph, exposure_category } = req.body;

    if (!structural_members || !Array.isArray(structural_members) || structural_members.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'structural_members array is required and must not be empty.',
      });
    }

    const result = takeoffEngine.estimate({
      structural_members, seismic_design_category, wind_speed_mph, exposure_category,
    });

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Estimate generation failed.', detail: err.message });
  }
});

export default router;
