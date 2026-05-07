const { randomUUID } = require('crypto');
const { getSupabaseClient } = require('../config/supabase');
const { assessMatter } = require('./ai.service');
const {
  decryptJson,
  encryptJson,
  redactMatterForAi,
  redactText,
} = require('./privacy.service');
const auditService = require('./audit.service');

const memory = {
  clients: [],
  submissions: [],
  assessments: [],
  cases: [],
};

function toIso(value = new Date()) {
  return new Date(value).toISOString();
}

function normalizeSubmission(input = {}) {
  const fullName = String(input.fullName || '').trim();
  const email = String(input.email || '').trim();
  const phone = String(input.phone || '').trim();
  const practiceArea = String(input.practiceArea || '').trim();
  const jurisdiction = String(input.jurisdiction || 'South Africa').trim();
  const matterSummary = String(input.matterSummary || '').trim();
  const requestedOutcome = String(input.requestedOutcome || '').trim();
  const documentsMentioned = String(input.documentsMentioned || '').trim();
  const urgencyHint = String(input.urgencyHint || 'unspecified').trim();
  const preferredLanguage = String(input.preferredLanguage || 'English').trim();
  const consentToAi = Boolean(input.consentToAi);
  const consentToStorage = Boolean(input.consentToStorage);

  if (!fullName || !email || !phone || !practiceArea || !matterSummary) {
    const error = new Error(
      'fullName, email, phone, practiceArea, and matterSummary are required',
    );
    error.statusCode = 400;
    throw error;
  }

  if (!consentToAi || !consentToStorage) {
    const error = new Error(
      'Consent for storage and AI assessment is required before submission',
    );
    error.statusCode = 400;
    throw error;
  }

  return {
    fullName,
    email,
    phone,
    practiceArea,
    jurisdiction,
    matterSummary,
    requestedOutcome,
    documentsMentioned,
    urgencyHint,
    preferredLanguage,
    consentToAi,
    consentToStorage,
  };
}

function normalizeAssessmentSubmission(submission) {
  const redacted = redactMatterForAi({
    fullName: submission.fullName,
    practiceArea: submission.practiceArea,
    jurisdiction: submission.jurisdiction,
    urgencyHint: submission.urgencyHint,
    matterSummary: submission.matterSummary,
    requestedOutcome: submission.requestedOutcome,
    documentsMentioned: submission.documentsMentioned,
    contextNotes: submission.contextNotes,
  });

  return {
    clientLabel: redacted.clientLabel,
    practiceArea: redacted.practiceArea,
    jurisdiction: redacted.jurisdiction,
    urgencyHint: redacted.urgencyHint,
    matterSummary: redactText(redacted.matterSummary, {
      clientName: submission.fullName,
      fullName: submission.fullName,
    }),
  };
}

function createCaseNumber(existingCount) {
  const year = new Date().getFullYear();
  const sequence = String(existingCount + 1).padStart(4, '0');
  return `MHL-${year}-${sequence}`;
}

async function insertRow(table, record) {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db
      .from(table)
      .insert(record)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return data;
  }

  memory[table].push(record);
  return record;
}

async function upsertRow(table, record, matchKey = 'id') {
  const db = getSupabaseClient();
  if (db) {
    const existing = await db
      .from(table)
      .select('*')
      .eq(matchKey, record[matchKey])
      .maybeSingle();

    if (existing.data) {
      const { data, error } = await db
        .from(table)
        .update(record)
        .eq(matchKey, record[matchKey])
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    }

    return insertRow(table, record);
  }

  const index = memory[table].findIndex(
    (entry) => entry[matchKey] === record[matchKey],
  );

  if (index >= 0) {
    memory[table][index] = record;
  } else {
    memory[table].push(record);
  }

  return record;
}

async function listRows(table) {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db
      .from(table)
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    return data || [];
  }

  return [...memory[table]].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
}

async function findRow(table, id) {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db
      .from(table)
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data || null;
  }

  return memory[table].find((entry) => entry.id === id) || null;
}

function toPublicSubmission(submission, assessment = null, caseRecord = null) {
  return {
    id: submission.id,
    clientLabel: submission.client_label,
    practiceArea: submission.practice_area,
    jurisdiction: submission.jurisdiction,
    urgencyHint: submission.urgency_hint,
    status: submission.status,
    summary: submission.summary_redacted,
    createdAt: submission.created_at,
    assessment:
      assessment && {
        id: assessment.id,
        matterType: assessment.matter_type,
        urgency: assessment.urgency,
        summary: assessment.summary,
        keyFacts: assessment.key_facts || [],
        attorneyQuestions: assessment.attorney_questions || [],
        recommendedDocuments: assessment.recommended_documents || [],
        complianceFlags: assessment.compliance_flags || [],
        nextActions: assessment.next_actions || [],
        confidence: assessment.confidence,
        model: assessment.model_name,
        provider: assessment.provider,
        popiaNotes: assessment.popia_notes || [],
        createdAt: assessment.created_at,
      },
    matterCase:
      caseRecord && {
        id: caseRecord.id,
        submissionId: caseRecord.intake_submission_id,
        caseNumber: caseRecord.case_number,
        status: caseRecord.status,
        urgency: caseRecord.urgency,
        practiceArea: caseRecord.practice_area,
        nextAction: caseRecord.next_action,
        createdAt: caseRecord.created_at,
      },
  };
}

async function createSubmission(input) {
  const normalized = normalizeSubmission(input);
  const existingSubmissions = await listRows('submissions');
  const submissionId = randomUUID();
  const encryptedPayload = encryptJson(normalized);
  const redactedBrief = normalizeAssessmentSubmission(normalized);
  const now = toIso();
  const clientLabel = `Client ${String(existingSubmissions.length + 1).padStart(
    3,
    '0',
  )}`;

  const record = {
    id: submissionId,
    client_label: clientLabel,
    practice_area: normalized.practiceArea,
    jurisdiction: normalized.jurisdiction,
    urgency_hint: normalized.urgencyHint,
    status: 'received',
    summary_redacted: redactedBrief.matterSummary,
    raw_payload_encrypted: encryptedPayload,
    consent_to_ai: normalized.consentToAi,
    consent_to_storage: normalized.consentToStorage,
    created_at: now,
    updated_at: now,
  };

  const saved = await insertRow('submissions', record);
  await auditService
    .logEvent(
      {
        entityType: 'submission',
        entityId: saved.id,
        action: 'submission_created',
        summary: `Intake submitted: ${saved.client_label}`,
      },
      { email: normalized.email, fullName: normalized.fullName, role: 'client' },
    )
    .catch(() => {});
  return toPublicSubmission(saved);
}

async function listSubmissions() {
  const rows = await listRows('submissions');
  const assessments = await listRows('assessments');
  const cases = await listRows('cases');

  return rows.map((submission) =>
    toPublicSubmission(
      submission,
      assessments.find((item) => item.intake_submission_id === submission.id),
      cases.find((item) => item.intake_submission_id === submission.id),
    ),
  );
}

async function getSubmission(id) {
  const submission = await findRow('submissions', id);
  if (!submission) {
    return null;
  }

  const assessments = await listRows('assessments');
  const cases = await listRows('cases');

  return toPublicSubmission(
    submission,
    assessments.find((item) => item.intake_submission_id === submission.id),
    cases.find((item) => item.intake_submission_id === submission.id),
  );
}

async function getPrivateSubmission(id) {
  const submission = await findRow('submissions', id);
  if (!submission) {
    return null;
  }

  const raw = decryptJson(submission.raw_payload_encrypted);
  const assessments = await listRows('assessments');
  const cases = await listRows('cases');

  return {
    submission,
    raw,
    assessment:
      assessments.find((item) => item.intake_submission_id === submission.id) || null,
    caseRecord:
      cases.find((item) => item.intake_submission_id === submission.id) || null,
  };
}

async function findSubmissionsByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const submissions = await listRows('submissions');
  const assessments = await listRows('assessments');
  const cases = await listRows('cases');

  return submissions
    .map((submission) => ({
      submission,
      raw: decryptJson(submission.raw_payload_encrypted),
    }))
    .filter((item) => String(item.raw?.email || '').trim().toLowerCase() === normalized)
    .map((item) =>
      toPublicSubmission(
        item.submission,
        assessments.find((entry) => entry.intake_submission_id === item.submission.id),
        cases.find((entry) => entry.intake_submission_id === item.submission.id),
      ),
    );
}

async function assessSubmission(id) {
  const submission = await findRow('submissions', id);
  if (!submission) {
    const error = new Error('Intake submission not found');
    error.statusCode = 404;
    throw error;
  }

  const rawSubmission = decryptJson(submission.raw_payload_encrypted);
  const redactedBrief = normalizeAssessmentSubmission(rawSubmission);
  const assessment = await assessMatter(redactedBrief);
  const assessmentId = randomUUID();
  const now = toIso();

  const assessmentRecord = {
    id: assessmentId,
    intake_submission_id: submission.id,
    provider: assessment.provider,
    model_name: assessment.model,
    matter_type: assessment.matterType,
    urgency: assessment.urgency,
    summary: assessment.summary,
    key_facts: assessment.keyFacts || [],
    attorney_questions: assessment.attorneyQuestions || [],
    recommended_documents: assessment.recommendedDocuments || [],
    compliance_flags: assessment.complianceFlags || [],
    next_actions: assessment.nextActions || [],
    confidence: assessment.confidence,
    popia_notes: assessment.popiaNotes || [],
    raw_redacted_brief: redactedBrief,
    created_at: now,
  };

  const savedAssessment = await upsertRow(
    'assessments',
    assessmentRecord,
    'intake_submission_id',
  );

  const existingCases = await listRows('cases');
  const caseRecord = {
    id: randomUUID(),
    intake_submission_id: submission.id,
    case_number: createCaseNumber(existingCases.length),
    client_label: submission.client_label,
    practice_area: assessment.matterType || submission.practice_area,
    urgency: assessment.urgency,
    status: assessment.urgency === 'critical' ? 'priority-review' : 'triage',
    next_action:
      assessment.nextActions?.[0] ||
      'Attorney to review the intake and confirm next steps.',
    created_at: now,
    updated_at: now,
  };

  const savedCase = await upsertRow('cases', caseRecord, 'intake_submission_id');
  await auditService
    .logEvent(
      {
        entityType: 'case',
        entityId: savedCase.id,
        action: 'case_created',
        summary: `Case created: ${savedCase.case_number}`,
        details: {
          submissionId: submission.id,
          urgency: savedCase.urgency,
        },
      },
      { email: 'system', fullName: 'Intake pipeline', role: 'system' },
    )
    .catch(() => {});

  const updatedSubmission = {
    ...submission,
    status: 'assessed',
    updated_at: now,
  };

  await upsertRow('submissions', updatedSubmission);
  await auditService
    .logEvent(
      {
        entityType: 'submission',
        entityId: submission.id,
        action: 'submission_assessed',
        summary: `Intake assessed: ${submission.id}`,
        details: {
          provider: savedAssessment.provider,
          urgency: savedCase.urgency,
        },
      },
      { email: 'system', fullName: 'Assessment pipeline', role: 'system' },
    )
    .catch(() => {});

  return toPublicSubmission(updatedSubmission, savedAssessment, savedCase);
}

async function listCases() {
  const cases = await listRows('cases');
  return cases.map((item) => ({
    id: item.id,
    submissionId: item.intake_submission_id,
    caseNumber: item.case_number,
    clientLabel: item.client_label,
    practiceArea: item.practice_area,
    urgency: item.urgency,
    status: item.status,
    nextAction: item.next_action,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  }));
}

async function getSummary() {
  const submissions = await listRows('submissions');
  const assessments = await listRows('assessments');
  const cases = await listRows('cases');

  return {
    openIntakes: submissions.filter((item) => item.status === 'received').length,
    assessedIntakes: assessments.length,
    liveCases: cases.length,
    criticalMatters: cases.filter((item) => item.urgency === 'critical').length,
    encryptedStorage: true,
    popiaCompliantAi: true,
    latestIntake: submissions[0] || null,
  };
}

async function deleteSubmission(submissionId) {
  const cases = await listRows('cases');
  const relatedCases = cases.filter(
    (item) => item.intake_submission_id === submissionId,
  );

  const db = getSupabaseClient();
  if (db) {
    const { error } = await db.from('submissions').delete().eq('id', submissionId);
    if (error) {
      throw error;
    }
  } else {
    memory.submissions = memory.submissions.filter((item) => item.id !== submissionId);
    memory.assessments = memory.assessments.filter(
      (item) => item.intake_submission_id !== submissionId,
    );
    memory.cases = memory.cases.filter(
      (item) => item.intake_submission_id !== submissionId,
    );
  }

  return {
    submissionId,
    caseIds: relatedCases.map((item) => item.id),
  };
}

module.exports = {
  createSubmission,
  deleteSubmission,
  findSubmissionsByEmail,
  getPrivateSubmission,
  getSubmission,
  assessSubmission,
  listCases,
  listSubmissions,
  getSummary,
};
