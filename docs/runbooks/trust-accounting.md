# Trust accounting

Trust money held for clients (Legal Practice Act s86). **It must not be used live until the firm's auditor has reviewed it**, following the roadmap: pilots first, behind a per-firm switch.

```
npm run ops -w apps/api -- trust enable --slug <firm>    # or disable
```

## What the software enforces
- **Ledgers:** one ledger per matter per trust bank account. The account kinds are s86(2) trust, s86(3) investment and s86(4) investment.
- **No changes after posting:** posted entries are never changed or deleted, and the database role has no DELETE on them. A mistake is corrected with a reversal (an equal, opposite entry), once per entry.
- **No ledger in debit:** a matter can never pay out more than it holds in that account. This is checked when money is requested, and again under a lock on the account when it is authorised, so two payments cannot both get through.
- **Four eyes:** receipts post when recorded. Money out, opening balances, interest and reversals wait for a practitioner (`trust.authorise`: attorneys and admins). That practitioner must not be the person who requested the entry. Bookkeepers record and reconcile but never authorise.
- **Fees:** fees and disbursements move to the business account only against an issued invoice on the same matter, for no more than it still owes. Authorising the transfer records the invoice payment (`trust_transfer`).
- **Transfers between matters:** both legs (out and in) post together on one authorisation.
- **Reconciliation:** prepared by one person and signed off by a different practitioner, for a statement date. An unbalanced reconciliation can be signed off only with a written explanation. It checks:
  - the bank statement's closing balance, plus uncleared receipts, minus uncleared payments, against the cash book
  - the cash book against the sum of the client ledgers
  - any client ledger in debit
- **Restricted matters:** they count in account balances and reconciliations. Their detail stays hidden from staff outside the matter, and the auditor's CSV shows their amounts only.
- **Privacy and audit:** references and descriptions are encrypted. Audit rows carry matter numbers, kinds and amounts. Everything is included in the firm export.

## For the auditor's review
Before a firm goes live, ask the auditor to confirm or adjust:
1. **Account structure:** separate s86(3) and s86(4) investment accounts, and how their interest is recorded (`interest` entries, authorised).
2. **Reconciliation frequency:** at least monthly, and who signs off.
3. **Reports:** which trust reports and listings they need beyond the cash book CSV, the client ledgers and the reconciliation history.
4. **Opening balances:** when the firm moves from another system, how they are captured (`opening_balance` entries, authorised, against the last signed-off reconciliation of the old system).
5. **Records retention, and the annual audit report process.**
6. **Legal Practice Council rules:** any rule that requires more than the controls above.

Not built yet:
- **Bank statement import and matching:** clearing is per entry for now.
- **Investment interest calculations and statutory deductions.**
- **The annual audit report form.**
