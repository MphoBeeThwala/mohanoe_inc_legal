import { useEffect, useState, type FormEvent } from 'react';
import type { ApiClient } from '../api';
import { apiErrorMessage } from '../api';
import type { CaseDetail, MatterCase } from '@ahava88/shared';
import type { Notice } from './DismissibleNotice';
import MatterAccessPanel from './MatterAccessPanel';
import MatterPartiesPanel from './MatterPartiesPanel';
import MatterCourtPanel from './MatterCourtPanel';

interface CaseWorkspaceProps {
  api: ApiClient;
  selectedCaseId: string | null;
  onSelectCase?: (caseRow: Pick<MatterCase, 'id' | 'submissionId' | 'caseNumber'>) => void;
  onChanged: () => Promise<void>;
  /** matters.write: show the forms that change the matter. */
  canEdit?: boolean;
  /** calendar.write: add prescriptions and change their status. */
  canEditCalendar?: boolean;
}

function CaseWorkspace({
  api,
  selectedCaseId,
  onSelectCase,
  onChanged,
  canEdit = true,
  canEditCalendar = false,
}: CaseWorkspaceProps) {
  const [caseRecord, setCaseRecord] = useState<CaseDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [taskForm, setTaskForm] = useState({ title: '', description: '' });
  const [statusForm, setStatusForm] = useState({ status: '', nextAction: '' });
  const [noteForm, setNoteForm] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);

  const loadCase = async () => {
    if (!selectedCaseId) {
      setCaseRecord(null);
      return;
    }

    const { data } = await api.get<CaseDetail>(`/cases/${selectedCaseId}`);
    setCaseRecord(data);
    setStatusForm({
      status: data.status || '',
      nextAction: data.nextAction || '',
    });
  };

  useEffect(() => {
    loadCase().catch(() => {
      setNotice({
        tone: 'warn',
        message: 'Case details could not be loaded.',
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCaseId]);

  const submitTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedCaseId || !taskForm.title.trim()) {
      return;
    }

    setBusy(true);
    try {
      await api.post(`/cases/${selectedCaseId}/tasks`, taskForm);
      setTaskForm({ title: '', description: '' });
      await loadCase();
      await onChanged();
      setNotice({ tone: 'success', message: 'Task added to the matter.' });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: apiErrorMessage(error, 'Could not add task.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedCaseId || !statusForm.status) {
      return;
    }

    setBusy(true);
    try {
      await api.post(`/cases/${selectedCaseId}/status`, statusForm);
      await loadCase();
      await onChanged();
      setNotice({ tone: 'success', message: 'Case status updated.' });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: apiErrorMessage(error, 'Could not update status.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const addNote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedCaseId || !noteForm.trim()) {
      return;
    }

    setBusy(true);
    try {
      await api.post(`/cases/${selectedCaseId}/timeline`, {
        eventType: 'note',
        message: noteForm,
      });
      setNoteForm('');
      await loadCase();
      await onChanged();
      setNotice({ tone: 'success', message: 'Timeline note recorded.' });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: apiErrorMessage(error, 'Could not add note.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const completeTask = async (taskId: string) => {
    if (!selectedCaseId) {
      return;
    }

    setBusy(true);
    try {
      await api.post(`/cases/${selectedCaseId}/tasks/${taskId}/complete`);
      await loadCase();
      await onChanged();
    } catch (error) {
      setNotice({
        tone: 'error',
        message: apiErrorMessage(error, 'Could not complete task.'),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <p className="panel-kicker">Workspace</p>
      <h2>Case operations</h2>

      {!caseRecord ? (
        <div className="empty-state">
          Select a matter from the list to manage tasks, status changes, and the timeline.
        </div>
      ) : (
        <>
          <div className="case-hero">
            <div>
              <div className="mini-label">Case number</div>
              <strong>{caseRecord.caseNumber}</strong>
            </div>
            <div>
              <div className="mini-label">Practice area</div>
              <strong>{caseRecord.practiceArea}</strong>
            </div>
            <div>
              <div className="mini-label">Urgency</div>
              <strong>{caseRecord.urgency}</strong>
            </div>
          </div>

          {canEdit ? (
            <div className="workspace-grid">
              <section>
                <div className="mini-label">Update status</div>
                <form onSubmit={changeStatus} className="stack-form">
                  <select
                    value={statusForm.status}
                    onChange={(event) =>
                      setStatusForm((current) => ({
                        ...current,
                        status: event.target.value,
                      }))
                    }
                  >
                    <option value="">Select status</option>
                    <option value="triage">Triage</option>
                    <option value="priority-review">Priority review</option>
                    <option value="in-progress">In progress</option>
                    <option value="awaiting-client">Awaiting client</option>
                    <option value="awaiting-court">Awaiting court</option>
                    <option value="closed">Closed</option>
                  </select>
                  <textarea
                    rows={3}
                    value={statusForm.nextAction}
                    onChange={(event) =>
                      setStatusForm((current) => ({
                        ...current,
                        nextAction: event.target.value,
                      }))
                    }
                    placeholder="Describe the next action..."
                  />
                  <button className="secondary-button" disabled={busy}>
                    Save status
                  </button>
                </form>
              </section>

              <section>
                <div className="mini-label">Add task</div>
                <form onSubmit={submitTask} className="stack-form">
                  <input
                    value={taskForm.title}
                    onChange={(event) =>
                      setTaskForm((current) => ({
                        ...current,
                        title: event.target.value,
                      }))
                    }
                    placeholder="Draft notice, chase signature, prepare bundle..."
                  />
                  <textarea
                    rows={3}
                    value={taskForm.description}
                    onChange={(event) =>
                      setTaskForm((current) => ({
                        ...current,
                        description: event.target.value,
                      }))
                    }
                    placeholder="Task details..."
                  />
                  <button className="secondary-button" disabled={busy}>
                    Add task
                  </button>
                </form>
              </section>
            </div>
          ) : null}

          <div className="workspace-grid">
            {canEdit ? (
              <section>
                <div className="mini-label">Timeline note</div>
                <form onSubmit={addNote} className="stack-form">
                  <textarea
                    rows={4}
                    value={noteForm}
                    onChange={(event) => setNoteForm(event.target.value)}
                    placeholder="Add an internal note, client call summary, or court event..."
                  />
                  <button className="secondary-button" disabled={busy}>
                    Add note
                  </button>
                </form>
              </section>
            ) : null}

            <section>
              <div className="mini-label">Tasks</div>
              <div className="mini-list">
                {(caseRecord.tasks || []).map((task) => (
                  <div key={task.id} className="mini-item">
                    <div>
                      <strong>{task.title}</strong>
                      <div className="muted">{task.description}</div>
                    </div>
                    {canEdit ? (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => completeTask(task.id)}
                      >
                        {task.status === 'done' ? 'Done' : 'Complete'}
                      </button>
                    ) : (
                      <span className="muted">{task.status === 'done' ? 'Done' : 'Open'}</span>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </div>

          <section>
            <div className="mini-label">Timeline</div>
            <div className="timeline-list">
              {(caseRecord.timeline || []).map((entry) => (
                <div key={entry.id} className="timeline-item">
                  <div className="timeline-dot" />
                  <div>
                    <strong>{entry.eventType}</strong>
                    <div className="muted">{entry.message}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <MatterCourtPanel
            key={`court-${caseRecord.id}`}
            matter={caseRecord}
            canEditMatter={canEdit}
            canEditCalendar={canEditCalendar}
          />

          <MatterPartiesPanel
            key={`parties-${caseRecord.id}`}
            caseId={caseRecord.id}
            canEdit={canEdit}
          />

          <MatterAccessPanel
            key={caseRecord.id}
            caseId={caseRecord.id}
            onLostAccess={() => {
              setCaseRecord(null);
              setNotice({ tone: 'info', message: 'You no longer have access to that matter.' });
              onChanged().catch(() => undefined);
            }}
          />
        </>
      )}

      {notice ? <div className={`notice notice-${notice.tone}`}>{notice.message}</div> : null}
    </div>
  );
}

export default CaseWorkspace;
