
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// Database connection (optional for preview mode)
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
  });
} else {
  console.warn('WARNING: DATABASE_URL not set. Running in preview mode — API endpoints will return errors.');
}

// Make pool available to routes
app.locals.pool = pool;

// Middleware to check database availability for API routes
function requireDatabase(req, res, next) {
  if (!req.app.locals.pool) {
    return res.status(503).json({ error: 'Database not configured. Set DATABASE_URL environment variable.' });
  }
  next();
}

app.use(express.json());

// Health check endpoint (required for Render)
// Note: Does NOT query database to allow Neon auto-suspend
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Assessment API routes
const assessRouter = require('./routes/assess');
app.use('/api/assessments', requireDatabase, assessRouter);

// Payment routes
const paymentsRouter = require('./routes/payments');
app.use('/api/payments', requireDatabase, paymentsRouter);

// Report data API — /api/reports/:id
// Returns limited data for Phase 1 (free), full data if Phase 2 is paid
app.get('/api/reports/:id', requireDatabase, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  const pool = req.app.locals.pool;

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

    // Check payment status for Phase 2 and Phase 3
    const paymentResult = await pool.query(
      "SELECT phase, status FROM assessment_payments WHERE assessment_id = $1 AND status = 'complete'",
      [id]
    );

    const paidPhases = {};
    paymentResult.rows.forEach(function (row) {
      paidPhases[row.phase] = true;
    });

    const phase2Paid = !!paidPhases[2];
    const phase3Paid = !!paidPhases[3];

    if (phase2Paid) {
      // Full report — all data
      res.json({
        phase: phase3Paid ? 3 : 2,
        phase_2_paid: true,
        phase_3_paid: phase3Paid,
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
    } else {
      // Phase 1 — limited teaser data
      const findings = report.findings || [];
      const recommendations = report.recommendations || [];

      // Only show area and severity for findings, hide details
      const limitedFindings = findings.slice(0, 3).map(function (f) {
        return {
          area: f.area,
          severity: f.severity,
          issue: null,
          impact: null,
        };
      });

      // Only show titles and categories for recommendations, hide details
      const limitedRecommendations = recommendations.slice(0, 2).map(function (r) {
        return {
          priority: r.priority,
          title: r.title,
          category: r.category,
          description: null,
          projected_roi: null,
          timeframe: null,
          difficulty: null,
        };
      });

      // Truncate executive summary to first paragraph
      const summaryParagraphs = (report.executive_summary || '').split('\n').filter(function (p) { return p.trim(); });
      const limitedSummary = summaryParagraphs.length > 0 ? summaryParagraphs[0] : '';

      res.json({
        phase: 1,
        phase_2_paid: false,
        phase_3_paid: false,
        total_findings: findings.length,
        total_recommendations: recommendations.length,
        assessment,
        report: {
          executive_summary: limitedSummary,
          efficiency_score: report.efficiency_score,
          total_potential_savings: report.total_potential_savings,
          implementation_timeline: null,
          findings: limitedFindings,
          recommendations: limitedRecommendations,
          created_at: report.created_at,
        },
      });
    }
  } catch (err) {
    console.error('Report fetch error:', err);
    res.status(500).json({ error: 'Failed to load report' });
  }
});

// Admin routes (both page routes and API routes)
const adminRouter = require('./routes/admin');
app.use('/admin', adminRouter);
app.use('/api/admin', adminRouter);

// Report page route — serve report.html for /report/:id
app.get('/report/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'report.html'));
});

// Phase 3 payment page
app.get('/phase3/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'phase3.html'));
});

// Phase 3 confirmation page
app.get('/confirmation/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'confirmation.html'));
});

// Assessment form route
app.get('/assess', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'assess.html'));
});

// Landing page with analytics beacon injected
app.get('/', (req, res) => {
  const slug = process.env.POLSIA_ANALYTICS_SLUG || '';
  const htmlPath = path.join(__dirname, 'public', 'index.html');

  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__POLSIA_SLUG__', slug);
    res.type('html').send(html);
  } else {
    res.json({ message: 'Hello from Polsia Instance!' });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log('SteadyForge server running on port ' + port);
});
