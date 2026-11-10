# Subscriptions (PayFast)

Firms pay Ahava on 88 through PayFast recurring billing. The platform is the merchant; each firm's administrator subscribes under **Account → Subscription**.

## Setup
1. Open a PayFast merchant account for Ahava on 88 (Pty) Ltd, enable **recurring billing** and set a **passphrase** (Settings → Security).
2. Configure `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY`, `PAYFAST_PASSPHRASE` (Terraform: `payfast_merchant_id` variable, the other two as GitHub secrets → Key Vault). Keep `PAYFAST_SANDBOX=true` until a sandbox payment has gone end to end.
3. Create the plans (prices per seat, **excluding VAT**, in cents):
   ```
   npm run ops -w apps/api -- plans set --code practice --name "Practice" \
     --description "For small practices" --monthly 45000 --annual 486000 --min-seats 1 --max-seats 25
   npm run ops -w apps/api -- plans list
   npm run ops -w apps/api -- plans disable --code practice   # retire for new checkouts
   ```
   `PLATFORM_VAT_RATE` (default 0.15) is added on top; set it to 0 if the company is not VAT-registered. The prices above are examples only.
4. Pilot firms: `npm run ops -w apps/api -- subscription comp --slug <firm> [--until 2027-03-31] [--seats 10]`.

## How it works
- **Trial**: a new firm gets `SUBSCRIPTION_TRIAL_DAYS` (30) with up to `SUBSCRIPTION_TRIAL_SEATS` (10) staff.
- **Checkout**: the API signs a PayFast subscription form (`subscription_type=1`, monthly or yearly, until cancelled). The browser posts it to PayFast, which collects the card or EFT details. Subscribing ends the trial; the first charge is the same day.
- **Notifications (ITN)**: PayFast posts to `https://<firm host>/api/payfast/notify`. A notification is applied only when the signature (with passphrase) matches, it comes from a PayFast address, it is for our merchant ID, PayFast's `/eng/query/validate` answers `VALID`, and the amount matches the checkout or the recurring amount. Payments are recorded once per `pf_payment_id`; mismatches are recorded and audited but change nothing.
- **Seats**: active staff plus pending invites (platform support isn't counted). Invites and reactivations beyond the paid seats are refused. Changing seats updates the PayFast amount from the next billing date.
- **Plan change**: a new checkout; once it is paid the previous PayFast agreement is cancelled.
- **Dunning** (`ops subscriptions`, daily 07:00): trial reminders 7 days and 1 day before the end; after the paid period (plus 2 days for the charge to land) the firm is **past due** and administrators are emailed; after `SUBSCRIPTION_GRACE_DAYS` (7) it is **read-only**: everyone can sign in, read and export, but changes answer 402 until a payment is confirmed. Signing in, the subscription pages and support grants keep working.
- **Cancelling** stops PayFast billing; access continues until the end of the paid period.

## Invoices to firms

Every payment PayFast confirms gets an invoice from the platform, issued after the payment is recorded and emailed as a PDF to the firm's administrators.

- **Tax invoice or invoice.** With `PLATFORM_VAT_NUMBER` set (and `PLATFORM_VAT_RATE` above 0), each one is a full tax invoice under s20(4) of the VAT Act, at any amount. It shows the words "Tax invoice", both parties' names, addresses and VAT numbers, the serial number, the date, what was supplied, the value, the VAT and the total. The VAT is the tax fraction (15/115) of what PayFast collected, because plan prices include VAT. Until the company is VAT-registered, set `PLATFORM_VAT_RATE=0` and leave the VAT number empty: the documents are then plain invoices, with no VAT.
- **Before the first live payment:** set `PLATFORM_ADDRESS`, `PLATFORM_REGISTRATION_NUMBER` and, once registered, `PLATFORM_VAT_NUMBER` (Terraform `platform_invoice_details`). Production refuses to start with PayFast configured but without them.
- **Firm details.** The firm's legal name, its billing address (Firm settings → Invoicing), its VAT number and its registration number are copied onto each invoice when it is issued. Ask firms to complete these before they subscribe; a firm needs its VAT number on the invoice to claim the input tax.
- **Numbers** are one gap-free series for the platform (`PI-000001`, …). Issued invoices never change. To correct one, issue a credit note; credit notes are not in the product yet, so ask your accountant how to handle a refund.
- **If issuing fails** when the ITN arrives (the error goes to Sentry), the payment still stands. The daily `ops subscriptions` job issues any missing invoice and exits with an error if one still fails.
- **Where to find them:** firms under Account → Subscription; operators in the console under *Invoices*, with the totals to reconcile against PayFast payouts and the VAT201 return.

## Support
- A firm paid but shows no change: check Log Analytics for `/api/payfast/notify` responses (400 means a check failed), and the firm's audit trail for `subscription_payment_unmatched`. PayFast's dashboard shows ITN delivery and retries.
- PayFast is behind Front Door; `TRUST_PROXY_HOPS=2` makes the source-address check see PayFast's address.
- Platform tax invoices to firms are not generated yet; PayFast sends payment receipts.
