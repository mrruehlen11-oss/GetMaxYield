const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Parse cookies from request header manually
function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach(function(part) {
    const [key, ...parts] = part.split('=');
    if (key && key.trim()) {
      cookies[key.trim()] = decodeURIComponent(parts.join('=').trim());
    }
  });
  return cookies;
}

// Generate a stable admin token from the password
function getAdminToken() {
  const password = process.env.ADMIN_PASSWORD || 'steadyforge-admin-2026';
  return crypto.createHmac('sha256', password).update('steadyforge-admin-session').digest('hex');
}

// Admin auth middleware
function requireAdmin(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies['sf_admin'];
  if (token && token === getAdminToken()) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// GET /admin — redirect to login or dashboard
router.get('/', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies['sf_admin'];
  if (token && token === getAdminToken()) {
    return res.redirect('/admin/dashboard');
  }
  res.redirect('/admin/login');
});

// GET /admin/login — serve login page
router.get('/login', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies['sf_admin'];
  if (token && token === getAdminToken()) {
    return res.redirect('/admin/dashboard');
  }
  const loginPath = path.join(__dirname, '..', 'public', 'admin-login.html');
  res.sendFile(loginPath);
});

// GET /admin/dashboard — serve dashboard (auth required)
router.get('/dashboard', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies['sf_admin'];
  if (!token || token !== getAdminToken()) {
    return res.redirect('/admin/login');
  }
  const dashPath = path.join(__dirname, '..', 'public', 'admin-dashboard.html');
  res.sendFile(dashPath);
});

// POST /api/admin/login — authenticate
router.post('/api/login', express.json(), (req, res) => {
  const { password } = req.body || {};
  const adminPassword = process.env.ADMIN_PASSWORD || 'steadyforge-admin-2026';

  if (!password || password !== adminPassword) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const token = getAdminToken();
  const cookieOptions = 'HttpOnly; Path=/; SameSite=Strict; Max-Age=86400';
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', 'sf_admin=' + token + '; ' + cookieOptions + secure);
  res.json({ ok: true });
});

// POST /api/admin/logout
router.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sf_admin=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// GET /api/admin/assessments — list all (auth required)
router.get('/api/assessments', requireAdmin, async (req, res) => {
  const pool = req.app.locals.pool;
  try {
    const result = await pool.query(
      `SELECT id, company_name, industry, employee_count, annual_revenue,
              contact_name, contact_email, status, created_at, updated_at
       FROM assessments
       ORDER BY created_at DESC
       LIMIT 200`
    );
    res.json({ assessments: result.rows });
  } catch (err) {
    console.error('Admin list error:', err);
    res.status(500).json({ error: 'Failed to load assessments' });
  }
});

// GET /api/admin/assessments/:id — single assessment detail (auth required)
router.get('/api/assessments/:id', requireAdmin, async (req, res) => {
  const pool = req.app.locals.pool;
  const id = parseInt(req.params.id, 10);

  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid ID' });
  }

  try {
    const aResult = await pool.query(
      `SELECT * FROM assessments WHERE id = $1`,
      [id]
    );

    if (aResult.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    const filesResult = await pool.query(
      `SELECT filename, r2_url, mime_type, file_size FROM assessment_files WHERE assessment_id = $1`,
      [id]
    );

    const reportResult = await pool.query(
      `SELECT efficiency_score, total_potential_savings, implementation_timeline
       FROM assessment_reports WHERE assessment_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [id]
    );

    res.json({
      assessment: aResult.rows[0],
      files: filesResult.rows,
      report_summary: reportResult.rows[0] || null,
    });

  } catch (err) {
    console.error('Admin detail error:', err);
    res.status(500).json({ error: 'Failed to load detail' });
  }
});

module.exports = router;
