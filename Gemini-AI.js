const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function generateAssessment(data) {
  const systemInstruction = `You are an expert operations efficiency consultant with 20+ years of experience in manufacturing, construction, warehouse, and industrial operations. You analyze operational data submitted by companies and identify inefficiencies, then provide actionable recommendations with projected ROI.

Your analysis must be:
- Specific to the industry and company size provided
- Practical and implementable (not generic platitudes)
- Quantified with realistic ROI projections based on industry benchmarks
- Prioritized by impact and ease of implementation
- Written in plain language (no jargon, no buzzwords)
- Honest about what can be determined from the information provided

Return exactly this structure:
{
  "executive_summary": "2-3 paragraph plain language summary of the main findings and opportunity",
  "efficiency_score": <integer 0-100 representing current operational efficiency>,
  "total_potential_savings": "estimated annual savings range (e.g., '$150,000 - $220,000 annually')",
  "implementation_timeline": "realistic timeline (e.g., '3-6 months for full implementation')",
  "findings": [
    {
      "area": "specific operational area",
      "issue": "specific problem identified",
      "impact": "quantified business impact",
      "severity": "critical|high|medium|low"
    }
  ],
  "recommendations": [
    {
      "priority": <integer starting at 1>,
      "title": "short action title",
      "description": "detailed description of what to do and how",
      "projected_roi": "specific ROI estimate (e.g., '$45,000 - $60,000/year')",
      "timeframe": "implementation time (e.g., '4-6 weeks')",
      "difficulty": "Low|Medium|High",
      "category": "Process Improvement|Technology|Training|Scheduling|Procurement|Safety"
    }
  ]
}

Provide 3-6 findings and 4-8 prioritized recommendations. Be specific about dollar amounts scaled to the company size and industry benchmarks. Severity and priority must be honest — not every issue is critical.`;

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: systemInstruction,
    generationConfig: {
      responseMimeType: 'application/json',
    },
  });

  const fileSummary = data.files && data.files.length > 0
    ? `\n\nDocuments submitted for review: ${data.files.map(f => f.filename).join(', ')}`
    : '';

  const message = `Analyze the following company's operational data and provide an efficiency assessment:

Company Name: ${data.company_name}
Industry: ${data.industry}
Employee Count: ${data.employee_count}
Annual Revenue: ${data.annual_revenue || 'Not provided'}
Contact: ${data.contact_name || 'Not provided'} (${data.contact_email || 'Not provided'})

PAIN POINTS & CHALLENGES:
${data.pain_points}

CURRENT TOOLS & SYSTEMS IN USE:
${data.current_tools || 'Not provided'}

ADDITIONAL CONTEXT:
${data.additional_context || 'None provided'}${fileSummary}

Based on this information, provide a comprehensive operations efficiency assessment with specific findings and prioritized recommendations with projected ROI.`;

  try {
    const result = await model.generateContent(message);
    const responseText = result.response.text();
    return JSON.parse(responseText);
  } catch (error) {
    console.error('Error generating assessment with Gemini:', error);
    throw new Error('AI analysis failed');
  }
}

module.exports = { generateAssessment };
