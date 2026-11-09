# Incident response

## Severity
| | Meaning | Response |
|---|---|---|
| P1 | Platform down, data exposed or a tenant can see another's data | Immediately, around the clock |
| P2 | A major feature broken for many firms, backups failing, a security weakness being exploited | Within 1 hour in business hours |
| P3 | One firm or minor feature affected | Next business day |

## Steps
1. **Acknowledge** the alert (action group email) and name an incident lead.
2. **Status page**: post within 30 minutes for P1/P2.
3. **Contain**: roll back the API revision, stop a misbehaving job (`az containerapp job stop`), block traffic in the Front Door WAF, revoke a key or a support grant, or deactivate an account.
4. **Investigate** with request IDs (every error response and log line carries one), Log Analytics, Sentry and the per-firm audit trail (`GET /api/audit/verify` must stay valid).
5. **Recover** and confirm `/ready` and the affected feature.
6. **Review** within 5 business days: timeline, cause, fixes, and whether a test would have caught it.

## Personal information compromise (POPIA section 22)
Ahava on 88 is the **operator**; each firm is the **responsible party** for its clients' information.
- If there are reasonable grounds to believe personal information of a firm's clients was accessed or acquired by an unauthorised person, **notify the affected firm's administrators immediately** (section 21(2)) with what is known: which records, when, how, and what has been done.
- The firm notifies the Information Regulator and the affected people as soon as reasonably possible. Help them with the facts they need, the audit trail for the affected matters (party numbers, never names), and a plain-language description of the measures taken. Confirm the Regulator's current notification channel and form when it happens.
- Keep a record of every compromise, even when no notification was needed, and of who decided.
- Never paste client personal information into tickets, chat or Sentry; refer to firm slugs, matter numbers and party numbers.

## Contacts
Keep the on-call rota, the Azure support plan number and each firm's notification contacts in the operations log (not in this repository).

## Status page
Host it outside Azure (a hosted status service) so it stays up when the platform doesn't, and drive its automatic checks from `https://<platform host>/ready`. Firms subscribe from it.
