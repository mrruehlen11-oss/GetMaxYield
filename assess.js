const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { generateAssessment } = require('../lib/gemini-ai');

const router = express.Router();

// Use disk storage instead of memory to prevent server crashes on large files
const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => {
      cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_'));
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB per file
});

// Configure direct R2/S3 client (No Polsia proxy)
const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  }
});

// Upload a single file directly to R2 and return the URL
async function uploadFileToR2(filePath, originalname, mimeType) {
  try {
    const fileStream = fs.createReadStream(filePath);
    const fileKey = Date.now() + '-' + originalname.replace(/[^a-zA-Z0-9.-]/g, '_');

    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileKey,
      Body: fileStream,
      ContentType: mimeType,
    }));
    
    // Clean up the local temp file to save disk space
    fs.unlinkSync(filePath);

    return `${process.env.R2_PUBLIC_URL}/${fileKey}`;
  } catch (err) {
    console.error('R2 upload error:', err.message);
    // Ensure local temp file is cleaned up even if the upload fails
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return null;
  }
}

// POST /api/assessments — submit intake form
router.post('/', upload.array('files', 10), async (req, res) => {
  const pool = req.app.locals.pool;

  try {
    const {
      company_name,
      industry,
      employee_count,
      annual_revenue,
      contact_name,
      contact_email,
      pain_points,
      current_tools,
      additional_context,
    } = req.body;

    // Validate required fields
    if (!company_name || !industry || !employee_count || !pain_points) {
      return res.status(400).json({ error: 'Missing required fields: company name, industry, employee count, and pain points are required.' });
    }

    // Insert assessment record
    const insertResult = await pool.query(
      `INSERT INTO assessments
        (company_name, industry, employee_count, annual_revenue, contact_name, contact_email, pain_points, current_tools, additional_context, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
       RETURNING id`,
      [
        company_name.trim(),
        industry,
        parseInt(employee_count, 10),
        annual_revenue || null,
        contact_name ? contact_name.trim() : null,
        contact_email ? contact_email.trim().toLowerCase() : null,
        pain_points.trim(),
        current_tools ? current_tools.trim() : null,
        additional_context ? additional_context.trim() : null,
      ]
    );

    const assessmentId = insertResult.rows[0].id;

    // Upload files to R2 asynchronously
    const uploadedFiles = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        // We now pass file.path because it is saved to disk temporarily
        const url = await uploadFileToR2(file.path, file.originalname, file.mimetype);
        if (url) {
          await pool.query(
            `INSERT INTO assessment_files (assessment_id, filename, r2_url, mime_type, file_size)
             VALUES ($1, $2, $3, $4, $5)`,
            [assessmentId, file.originalname, url, file.mimetype, file.size]
          );
          uploadedFiles.push({ filename: file.originalname, url });
        }
      }
    }

    // Trigger AI analysis asynchronously
    setImmediate(async () => {
      try {
        // Update status to processing
        await pool.query(
          `UPDATE assessments SET status = 'processing', updated_at = NOW() WHERE id = $1`,
          [assessmentId]
        );

        const analysisData = {
          company_name: company_name.trim(),
          industry,
          employee_count: parseInt(employee_count, 10),
          annual_revenue: annual_revenue || null,
          contact_name: contact_name || null,
          contact_email: contact_email || null,
          pain_points: pain_points.trim(),
          current_tools: current_tools || null,
          additional_context: additional_context || null,
          files: uploadedFiles,
        };

        const report = await generateAssessment(analysisData);

        // Save report to DB
        await pool.query(
          `INSERT INTO assessment_reports
            (assessment_id, executive_summary, efficiency_score, total_potential_savings, implementation_timeline, findings, recommendations, raw_ai_response)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            assessmentId,
            report.executive_summary || null,
            report.efficiency_score || null,
            report.total_potential_savings || null,
            report.implementation_timeline || null,
            JSON.stringify(report.findings || []),
            JSON.stringify(report.recommendations || []),
            JSON.stringify(report),
          ]
        );

        // Mark assessment as complete
        await pool.query(
          `UPDATE assessments SET status = 'complete', updated_at = NOW() WHERE id = $1`,
          [assessmentId]
        );

      } catch (aiErr) {
        console.error('AI analysis error for assessment', assessmentId, ':', aiErr.message);
        await pool.query(
          `UPDATE assessments SET status = 'error', updated_at = NOW() WHERE id = $1`,
          [assessmentId]
        ).catch(() => {});
      }
    });

    res.json({ id: assessmentId, status: 'pending' });

  } catch (err) {
    console.error('Assessment submission error:', err);
    res.status(500).json({ error: 'Failed to submit assessment. Please try again.' });
  }
});

// GET /api/assessments/:id/status — poll for completion
router.get('/:id/status', async (req, res) => {
  const pool = req.app.locals.pool;
  const id = parseInt(req.params.id, 10);

  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid ID' });
  }

  try {
    const result = await pool.query(
      `SELECT id, status, updated_at FROM assessments WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Assessment not found' });
    }

    const assessment = result.rows[0];
    res.json({
      id: assessment.id,
      status: assessment.status,
      updated_at: assessment.updated_at,
    });

  } catch (err) {
    console.error('Status poll error:', err);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// GET /reports/:id — get report data for display
router.get('/reports/:id', async (req, res) => {
  const pool = req.app.locals.pool;
  const id = parseInt(req.params.id, 10);

  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid ID' });
  }

  try {
    const assessmentResult = await pool.query(
      `SELECT id, company_name, industry, employee_count, annual_revenue, contact_name, contact_email, status, created_at
       FROM assessments WHERE id = $1`,
      [id]
    );

    if (assessmentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Assessment not found' });
    }

    const assessment = assessmentResult.rows[0];

    if (assessment.status !== 'complete') {
      return res.status(404).json({ error: 'Report not yet available', status: assessment.status });
    }

    const reportResult = await pool.query(
      `SELECT executive_summary, efficiency_score, total_potential_savings, implementation_timeline, findings, recommendations, created_at
       FROM assessment_reports WHERE assessment_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [id]
    );

    if (reportResult.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const report = reportResult.rows[0];

    res.json({
      assessment,
      report: {
        executive_summary: report.executive_summary,
        efficiency_score: report.efficiency_score,
        total_potential_savings: report.total_potential_savings,
        implementation_timeline: report.implementation_timeline,
        findings: report.findings || [],
        recommendations: report.recommendations || [],
        created_at: report.created_at,
      },
    });

  } catch (err) {
    console.error('Report fetch error:', err);
    res.status(500).json({ error: 'Failed to load report' });
  }
});

module.exports = router;
