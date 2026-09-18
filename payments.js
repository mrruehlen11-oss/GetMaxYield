const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const router = express.Router();

// MaxYield Pricing config
const PRICING = {
  2: {
    amount_cents: 499700,
    label: 'Full Diagnosis & Roadmap',
    description: 'Complete operational efficiency report with detailed findings, prioritized recommendations, and ROI projections.',
  },
  3: {
    amount_cents: 2499700,
    label: '2-Week On-Site Implementation',
    description: 'Dedicated MaxYield team on-site for 2 weeks to implement changes, train staff, and verify results.',
  },
};

// POST /api/payments/create-session
router.post('/create-session', express.json(), async (req, res) => {
  const pool = req.app.locals.pool;
  const { assessment_id, phase } = req.body;

  if (!assessment_id || !phase || ![2, 3].includes(phase)) {
    return res.status(400).json({ error: 'Invalid assessment_id or phase' });
  }

  const pricing = PRICING[phase];
  if (!pricing) {
    return res.status(400).json({ error: 'Invalid phase' });
  }

  try {
    // Verify assessment exists and is complete
    const assessResult = await pool.query(
      'SELECT id, company_name, contact_email, status FROM assessments WHERE id = $1',
      [assessment_id]
    );

    if (assessResult.rows.length === 0) {
      return res.status(404).json({ error: 'Assessment not found' });
    }

    const assessment = assessResult.rows[0];
    if (assessment.status !== 'complete') {
      return res.status(400).json({ error: 'Assessment not yet complete' });
    }

    // Check if already paid for this phase
    const existingPayment = await pool.query(
      'SELECT id, status FROM assessment_payments WHERE assessment_id = $1 AND phase = $2',
      [assessment_id, phase]
    );

    if (existingPayment.rows.length > 0 && existingPayment.rows[0].status === 'complete') {
      return res.json({ already_paid: true, redirect: phase === 2 ? '/report/' + assessment_id : '/confirmation/' + assessment_id });
    }

    // For Phase 3, require Phase 2 to be paid first
    if (phase === 3) {
      const phase2Payment = await pool.query(
        "SELECT id FROM assessment_payments WHERE assessment_id = $1 AND phase = 2 AND status = 'complete'",
        [assessment_id]
      );
      if (phase2Payment.rows.length === 0) {
        return res.status(400).json({ error: 'Phase 2 payment required before Phase 3' });
      }
    }

    // Use getmaxyield.com dynamically or via request host
    const baseUrl = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
    const successUrl = baseUrl + '/api/payments/success?assessment_id=' + assessment_id + '&phase=' + phase + '&session_id={CHECKOUT_SESSION_ID}';
    const cancelUrl = baseUrl + (phase === 2 ? '/report/' + assessment_id : '/phase3/' + assessment_id);

    // Create official Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: pricing.amount_cents,
            product_data: {
              name: 'MaxYield ' + pricing.label,
              description: pricing.description + ' — ' + assessment.company_name,
            },
          },
          quantity: 1,
        },
      ],
      customer_email: assessment.contact_email || undefined,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        assessment_id: String(assessment_id),
        phase: String(phase),
      },
    });

    // Record pending payment
    if (existingPayment.rows.length > 0) {
      await pool.query(
        'UPDATE assessment_payments SET stripe_session_id = $1, status = $2, created_at = NOW() WHERE assessment_id = $3 AND phase = $4',
        [session.id, 'pending', assessment_id, phase]
      );
    } else {
      await pool.query(
        'INSERT INTO assessment_payments (assessment_id, phase, amount_cents, stripe_session_id, customer_email, status) VALUES ($1, $2, $3, $4, $5, $6)',
        [assessment_id, phase, pricing.amount_cents, session.id, assessment.contact_email || null, 'pending']
      );
    }

    res.json({ checkout_url: session.url });

  } catch (err) {
    console.error('Payment session error:', err);
    res.status(500).json({ error: 'Payment processing error. Please try again.' });
  }
});

// GET /api/payments/success — redirect after successful checkout
router.get('/success', async (req, res) => {
  const pool = req.app.locals.pool;
  const { assessment_id, phase, session_id } = req.query;

  if (!assessment_id || !phase || !session_id) {
    return res.redirect('/');
  }

  try {
    // Verify session directly with Stripe
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status === 'paid') {
      await pool.query(
        "UPDATE assessment_payments SET status = 'complete', stripe_payment_intent = $1, completed_at = NOW() WHERE assessment_id = $2 AND phase = $3",
        [session.payment_intent || null, assessment_id, phase]
      );
    }
  } catch (err) {
    console.error('Payment verification error:', err);
  }

  const phaseNum = parseInt(phase, 10);
  if (phaseNum === 2) {
    res.redirect('/report/' + assessment_id + '?unlocked=1');
  } else {
    res.redirect('/confirmation/' + assessment_id);
  }
});

// POST /api/payments/webhook — handle Secure Stripe webhooks
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const pool = req.app.locals.pool;
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Verify the webhook is actually from Stripe using your webhook secret
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session && session.metadata) {
        const assessmentId = session.metadata.assessment_id;
        const phase = session.metadata.phase;

        if (assessmentId && phase) {
          await pool.query(
            "UPDATE assessment_payments SET status = 'complete', stripe_payment_intent = $1, completed_at = NOW() WHERE assessment_id = $2 AND phase = $3",
            [session.payment_intent || null, assessmentId, phase]
          );
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// GET /api/payments/status/:assessment_id — check payment status
router.get('/status/:assessment_id', async (req, res) => {
  const pool = req.app.locals.pool;
  const assessmentId = parseInt(req.params.assessment_id, 10);

  if (isNaN(assessmentId)) {
    return res.status(400).json({ error: 'Invalid assessment ID' });
  }

  try {
    const result = await pool.query(
      'SELECT phase, status, completed_at FROM assessment_payments WHERE assessment_id = $1',
      [assessmentId]
    );

    const payments = {};
    result.rows.forEach(function (row) {
      payments['phase_' + row.phase] = {
        status: row.status,
        completed_at: row.completed_at,
      };
    });

    res.json({
      assessment_id: assessmentId,
      phase_2: payments.phase_2 || { status: 'unpaid' },
      phase_3: payments.phase_3 || { status: 'unpaid' },
    });
  } catch (err) {
    console.error('Payment status error:', err);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

module.exports = router;
