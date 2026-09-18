module.exports = {
  name: 'assessment_payments',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS assessment_payments (
        id SERIAL PRIMARY KEY,
        assessment_id INTEGER NOT NULL REFERENCES assessments(id),
        phase INTEGER NOT NULL CHECK (phase IN (2, 3)),
        amount_cents INTEGER NOT NULL,
        currency VARCHAR(10) DEFAULT 'usd',
        status VARCHAR(50) DEFAULT 'pending',
        stripe_session_id VARCHAR(255),
        stripe_payment_intent VARCHAR(255),
        customer_email VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        UNIQUE(assessment_id, phase)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_assessment_id ON assessment_payments (assessment_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_stripe_session ON assessment_payments (stripe_session_id)
    `);
  }
};
