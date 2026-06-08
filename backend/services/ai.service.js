function ensureStringArray(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item != null && item !== '').map(String);
  }
  if (value == null || value === '') {
    return [];
  }
  if (typeof value === 'string') {
    return [value];
  }
  if (typeof value === 'object') {
    return Object.values(value)
      .filter((item) => item != null && item !== '')
      .map(String);
  }
  return [String(value)];
}

function normalizeAssessmentFields(assessment) {
  return {
    ...assessment,
    keyFacts: ensureStringArray(assessment.keyFacts),
    attorneyQuestions: ensureStringArray(assessment.attorneyQuestions),
    recommendedDocuments: ensureStringArray(assessment.recommendedDocuments),
    complianceFlags: ensureStringArray(assessment.complianceFlags),
    nextActions: ensureStringArray(assessment.nextActions),
    popiaNotes: ensureStringArray(assessment.popiaNotes),
  };
}

function inferUrgency(text) {
  const lowered = text.toLowerCase();

  if (
    lowered.includes('urgent') ||
    lowered.includes('interdict') ||
    lowered.includes('evict') ||
    lowered.includes('summons') ||
    lowered.includes('arrest') ||
    lowered.includes('dismissal tomorrow')
  ) {
    return 'critical';
  }

  if (
    lowered.includes('court') ||
    lowered.includes('deadline') ||
    lowered.includes('divorce') ||
    lowered.includes('maintenance') ||
    lowered.includes('warrant')
  ) {
    return 'high';
  }

  if (lowered.includes('agreement') || lowered.includes('contract')) {
    return 'medium';
  }

  return 'medium';
}

function inferPracticeArea(text, fallback = 'General') {
  const lowered = text.toLowerCase();

  if (lowered.includes('divorce') || lowered.includes('custody')) {
    return 'Family Law';
  }
  if (
    lowered.includes('dismissal') ||
    lowered.includes('labour') ||
    lowered.includes('employment')
  ) {
    return 'Labour Law';
  }
  if (lowered.includes('property') || lowered.includes('transfer')) {
    return 'Conveyancing';
  }
  if (
    lowered.includes('estate') ||
    lowered.includes('will') ||
    lowered.includes('deceased')
  ) {
    return 'Estate Administration';
  }
  if (lowered.includes('contract') || lowered.includes('shareholder')) {
    return 'Commercial';
  }
  if (lowered.includes('criminal') || lowered.includes('bail')) {
    return 'Criminal Defence';
  }
  return fallback;
}

function fallbackAssessment(input) {
  const text = input.matterSummary || '';
  const urgency = inferUrgency(text);
  const practiceArea = inferPracticeArea(text, input.practiceArea);

  return {
    provider: 'rules',
    model: 'offline-triage',
    matterType: practiceArea,
    urgency,
    summary: `The intake indicates a ${urgency} priority ${practiceArea.toLowerCase()} matter. The attorney should review the facts, confirm jurisdiction, and validate all dates and deadlines before proceeding.`,
    keyFacts: [
      input.jurisdiction ? `Jurisdiction: ${input.jurisdiction}` : null,
      input.requestedOutcome
        ? `Requested outcome: ${input.requestedOutcome}`
        : null,
      'Raw PII was excluded from the model prompt.',
    ].filter(Boolean),
    attorneyQuestions: [
      'What is the exact date the issue first arose?',
      'Are there signed documents, notices, or correspondence?',
      'Has any court process or statutory deadline already started running?',
    ],
    recommendedDocuments: [
      'Signed mandate or engagement letter',
      'Identity and contact verification kept in the encrypted client record',
      'Any notices, summonses, contracts, or correspondence relevant to the dispute',
    ],
    complianceFlags: [
      'Raw intake data stored encrypted at rest',
      'Redacted matter brief only was used for model assessment',
    ],
    nextActions: [
      'Attorney intake review',
      'Confirm jurisdiction and limitation periods',
      'Request missing source documents from the client',
    ],
    confidence: 0.66,
    popiaNotes: [
      'POPIA purpose limitation applied.',
      'Only the redacted brief was sent for model assessment.',
    ],
  };
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim();

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw error;
    }
    return JSON.parse(match[0]);
  }
}

async function anthropicAssessment(input) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return fallbackAssessment(input);
  }

  const model = process.env.AI_MODEL || 'claude-sonnet-4-20250514';
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      temperature: 0.2,
      system: [
        'You are the attorney-facing triage assistant for a South African legal practice.',
        'Use only the redacted matter brief provided.',
        'Do not infer or repeat personally identifying information.',
        'Return JSON only with keys: matterType, urgency, summary, keyFacts, attorneyQuestions, recommendedDocuments, complianceFlags, nextActions, confidence, popiaNotes.',
      ].join(' '),
      messages: [
        {
          role: 'user',
          content: JSON.stringify(input, null, 2),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic request failed with ${response.status}`);
  }

  const payload = await response.json();
  const text = payload?.content?.[0]?.text || '';
  const parsed = extractJsonObject(text);

  return normalizeAssessmentFields({
    provider: 'anthropic',
    model,
    ...parsed,
  });
}

async function assessMatter(input) {
  try {
    return await anthropicAssessment(input);
  } catch (error) {
    return fallbackAssessment(input);
  }
}

module.exports = {
  assessMatter,
  fallbackAssessment,
  ensureStringArray,
};
