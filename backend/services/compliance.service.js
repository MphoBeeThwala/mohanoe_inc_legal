const { randomUUID } = require('crypto');
const { getSupabaseClient } = require('../config/supabase');
const { ensureStringArray } = require('./ai.service');
const intakeService = require('./intake.service');
const caseService = require('./case.service');
const documentsService = require('./documents.service');
const billingService = require('./billing.service');
const calendarService = require('./calendar.service');
const notificationsService = require('./notifications.service');
const auditService = require('./audit.service');

const memory = {
  requests: [],
};

function toIso(value = new Date()) {
  return new Date(value).toISOString();
}

function toDays(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getRetentionDays() {
  return toDays(process.env.CLIENT_DATA_RETENTION_DAYS, 3650);
}

function formatAssessmentExport(assessment) {
  if (!assessment) {
    return null;
  }

  return {
    id: assessment.id,
    matterType: assessment.matter_type,
    urgency: assessment.urgency,
    summary: assessment.summary,
    keyFacts: ensureStringArray(assessment.key_facts),
    attorneyQuestions: ensureStringArray(assessment.attorney_questions),
    recommendedDocuments: ensureStringArray(assessment.recommended_documents),
    complianceFlags: ensureStringArray(assessment.compliance_flags),
    nextActions: ensureStringArray(assessment.next_actions),
    confidence: assessment.confidence,
    model: assessment.model_name,
    provider: assessment.provider,
    popiaNotes: ensureStringArray(assessment.popia_notes),
    createdAt: assessment.created_at,
  };
}

function formatCaseExport(caseRecord) {
  if (!caseRecord) {
    return null;
  }

  return {
    id: caseRecord.id,
    submissionId: caseRecord.intake_submission_id,
    caseNumber: caseRecord.case_number,
    status: caseRecord.status,
    urgency: caseRecord.urgency,
    practiceArea: caseRecord.practice_area,
    nextAction: caseRecord.next_action,
    createdAt: caseRecord.created_at,
    updatedAt: caseRecord.updated_at,
  };
}

function formatSubmissionExport(privateSubmission) {
  if (!privateSubmission) {
    return null;
  }

  const { submission, raw, assessment, caseRecord } = privateSubmission;

  return {
    id: submission.id,
    clientLabel: submission.client_label,
    practiceArea: submission.practice_area,
    jurisdiction: submission.jurisdiction,
    urgencyHint: submission.urgency_hint,
    status: submission.status,
    summary: submission.summary_redacted,
    createdAt: submission.created_at,
    personalData: {
      fullName: raw?.fullName || '',
      email: raw?.email || '',
      phone: raw?.phone || '',
      practiceArea: raw?.practiceArea || '',
      jurisdiction: raw?.jurisdiction || '',
      matterSummary: raw?.matterSummary || '',
      requestedOutcome: raw?.requestedOutcome || '',
      documentsMentioned: raw?.documentsMentioned || '',
      urgencyHint: raw?.urgencyHint || '',
      preferredLanguage: raw?.preferredLanguage || '',
      consentToAi: Boolean(raw?.consentToAi),
      consentToStorage: Boolean(raw?.consentToStorage),
    },
    assessment: formatAssessmentExport(assessment),
    matterCase: formatCaseExport(caseRecord),
  };
}

async function listRows() {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db
      .from('compliance_requests')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      throw error;
    }

    return data || [];
  }

  return [...memory.requests].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
}

async function saveRow(record) {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db
      .from('compliance_requests')
      .insert(record)
      .select()
      .single();
    if (error) {
      throw error;
    }

    return data;
  }

  memory.requests.unshift(record);
  return record;
}

function formatRequest(row) {
  return {
    id: row.id,
    requestType: row.request_type,
    subjectName: row.subject_name,
    subjectEmail: row.subject_email,
    caseRef: row.case_ref,
    description: row.description,
    status: row.status,
    responseSummary: row.response_summary,
    responsePayload: row.response_payload,
    dueAt: row.due_at,
    fulfilledAt: row.fulfilled_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listRequests(filters = {}) {
  const rows = await listRows();
  return rows
    .filter((row) => {
      if (filters.status && row.status !== filters.status) {
        return false;
      }

      if (filters.requestType && row.request_type !== filters.requestType) {
        return false;
      }

      return true;
    })
    .map(formatRequest);
}

async function createRequest(input = {}, actor = {}) {
  const requestType = String(input.requestType || 'access').trim();
  const subjectName = String(input.subjectName || '').trim();
  const subjectEmail = String(input.subjectEmail || '').trim().toLowerCase();
  const caseRef = String(input.caseRef || '').trim();
  const description = String(input.description || '').trim();

  if (!subjectName || !subjectEmail || !description) {
    const error = new Error('subjectName, subjectEmail, and description are required');
    error.statusCode = 400;
    throw error;
  }

  const now = toIso();
  const record = {
    id: randomUUID(),
    request_type: requestType,
    subject_name: subjectName,
    subject_email: subjectEmail,
    case_ref: caseRef || null,
    description,
    status: 'open',
    response_summary: '',
    response_payload: {},
    due_at: input.dueAt || null,
    fulfilled_at: null,
    created_by: actor?.fullName || actor?.email || 'system',
    created_at: now,
    updated_at: now,
  };

  const saved = await saveRow(record);
  await auditService
    .logEvent(
      {
        entityType: 'compliance_request',
        entityId: saved.id,
        action: 'compliance_request_created',
        summary: `${requestType} request submitted`,
        details: {
          subjectEmail,
          caseRef,
        },
      },
      actor,
    )
    .catch(() => {});

  return formatRequest(saved);
}

async function fulfillRequest(requestId, input = {}, actor = {}) {
  const rows = await listRows();
  const row = rows.find((item) => item.id === requestId);
  if (!row) {
    const error = new Error('Compliance request not found');
    error.statusCode = 404;
    throw error;
  }

  const updated = {
    ...row,
    status: String(input.status || 'fulfilled').trim(),
    response_summary: String(input.responseSummary || row.response_summary || '').trim(),
    response_payload: input.responsePayload || row.response_payload || {},
    fulfilled_at: input.fulfilledAt || toIso(),
    updated_at: toIso(),
  };

  const db = getSupabaseClient();
  if (db) {
    const { error } = await db
      .from('compliance_requests')
      .update({
        status: updated.status,
        response_summary: updated.response_summary,
        response_payload: updated.response_payload,
        fulfilled_at: updated.fulfilled_at,
        updated_at: updated.updated_at,
      })
      .eq('id', requestId);
    if (error) {
      throw error;
    }
  } else {
    const index = memory.requests.findIndex((item) => item.id === requestId);
    if (index >= 0) {
      memory.requests[index] = updated;
    }
  }

  await auditService
    .logEvent(
      {
        entityType: 'compliance_request',
        entityId: requestId,
        action: 'compliance_request_fulfilled',
        summary: updated.response_summary || updated.status,
      },
      actor,
    )
    .catch(() => {});

  return formatRequest(updated);
}

async function buildDataExport(input = {}) {
  const email = String(input.subjectEmail || '').trim().toLowerCase();
  const caseRef = String(input.caseRef || '').trim();

  if (!email && !caseRef) {
    const error = new Error('subjectEmail or caseRef is required');
    error.statusCode = 400;
    throw error;
  }

  const cases = await intakeService.listCases();
  const caseMatches = cases.filter((item) => {
    if (!caseRef) {
      return false;
    }

    return [item.id, item.caseNumber, item.submissionId].includes(caseRef);
  });

  const emailMatches = email ? await intakeService.findSubmissionsByEmail(email) : [];
  const emailSubmissionIds = new Set(emailMatches.map((item) => item.id));

  const targetCases = cases.filter((item) => {
    if (caseMatches.some((match) => match.id === item.id)) {
      return true;
    }

    if (email && emailSubmissionIds.has(item.submissionId)) {
      return true;
    }

    return false;
  });

  const targetSubmissionIds = new Set([
    ...caseMatches.map((item) => item.submissionId).filter(Boolean),
    ...targetCases.map((item) => item.submissionId).filter(Boolean),
    ...emailMatches.map((item) => item.id),
  ]);

  const privateLookups = await Promise.all(
    [...targetSubmissionIds].map((submissionId) =>
      intakeService.getPrivateSubmission(submissionId).catch(() => null),
    ),
  );
  const resolvedSubmissions = privateLookups.filter(Boolean);
  const targetCaseIds = new Set(targetCases.map((item) => item.id));
  resolvedSubmissions.forEach((item) => {
    if (item?.caseRecord?.id) {
      targetCaseIds.add(item.caseRecord.id);
    }
  });

  const documents = await documentsService.listDocuments();
  const invoices = await billingService.listInvoices();
  const ledger = await billingService.listLedgerEntries();
  const calendar = await calendarService.listEvents();
  const notifications = await notificationsService.listNotifications();

  return {
    generatedAt: toIso(),
    retentionDays: getRetentionDays(),
    subjectEmail: email || null,
    caseRef: caseRef || null,
    submissions: resolvedSubmissions.map(formatSubmissionExport),
    assessments: resolvedSubmissions
      .map((item) => formatAssessmentExport(item.assessment))
      .filter(Boolean),
    cases: targetCases.map(formatCaseExport),
    documents: documents.filter((item) => targetCaseIds.has(item.caseId)),
    invoices: invoices.filter((item) => targetCaseIds.has(item.caseId)),
    ledger: ledger.filter((item) => targetCaseIds.has(item.caseId)),
    calendar: calendar.filter((item) => targetCaseIds.has(item.caseId)),
    notifications: notifications.filter((item) => targetCaseIds.has(item.relatedEntityId)),
    notices: [
      'Internal audit records are retained separately for compliance and supervision.',
      'This export intentionally excludes password hashes and secret keys.',
      'Personal data included here is the subject data requested for export.',
    ],
  };
}

async function getComplianceSummary() {
  const requests = await listRequests();
  const cases = await intakeService.listCases();
  const retentionDays = getRetentionDays();
  const threshold = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  const eligibleForRetention = cases.filter((item) => {
    const closed = ['closed', 'resolved', 'completed'].includes(String(item.status || '').toLowerCase());
    const updatedAt = Date.parse(item.createdAt || item.updatedAt || item.created_at || new Date(0));
    return closed && Number.isFinite(updatedAt) && updatedAt < threshold;
  }).length;

  return {
    retentionDays,
    totalRequests: requests.length,
    openRequests: requests.filter((item) => item.status === 'open').length,
    fulfilledRequests: requests.filter((item) => item.status === 'fulfilled').length,
    eligibleForRetention,
    latestRequest: requests[0] || null,
  };
}

async function runRetentionSweep(actor = {}) {
  const retentionDays = getRetentionDays();
  const threshold = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const cases = await intakeService.listCases();
  const eligibleCases = cases.filter((item) => {
    const closed = ['closed', 'resolved', 'completed'].includes(String(item.status || '').toLowerCase());
    const updatedAt = Date.parse(item.createdAt || new Date(0));
    return closed && Number.isFinite(updatedAt) && updatedAt < threshold;
  });

  let removedSubmissions = 0;
  let removedCases = 0;
  let removedTasks = 0;
  let removedDocuments = 0;
  let removedInvoices = 0;
  let removedLedger = 0;
  let removedCalendar = 0;

  for (const item of eligibleCases) {
    const result = await intakeService.deleteSubmission(item.submissionId);
    removedSubmissions += 1;
    removedCases += result.caseIds.length || 0;
    removedTasks += await caseService.deleteByCaseIds(result.caseIds);
    removedDocuments += await documentsService.deleteByCaseIds(result.caseIds);
    removedInvoices += await billingService.deleteByCaseIds(result.caseIds);
    removedCalendar += await calendarService.deleteByCaseIds(result.caseIds);
    await notificationsService.createNotification(
      {
        title: `Retained matter removed: ${item.caseNumber}`,
        body: `Closed matter ${item.caseNumber} exceeded the retention window and was removed from active records.`,
        category: 'compliance',
        priority: 'medium',
        recipientRole: 'admin',
      },
      actor,
    ).catch(() => {});
  }

  const summary = {
    retentionDays,
    scannedCases: cases.length,
    eligibleCases: eligibleCases.length,
    removedSubmissions,
    removedCases,
    removedTasks,
    removedDocuments,
    removedInvoices,
    removedLedger,
    removedCalendar,
  };

  await auditService
    .logEvent(
      {
        entityType: 'compliance',
        entityId: 'retention-sweep',
        action: 'retention_sweep_completed',
        summary: `Retention sweep completed: ${removedCases} cases removed`,
        details: summary,
      },
      actor,
    )
    .catch(() => {});

  return summary;
}

module.exports = {
  buildDataExport,
  createRequest,
  fulfillRequest,
  getComplianceSummary,
  getRetentionDays,
  listRequests,
  runRetentionSweep,
};
