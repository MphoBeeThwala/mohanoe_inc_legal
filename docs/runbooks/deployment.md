# Deployment (Azure)

Everything runs in **Azure South Africa North**; backups and storage replicate to **South Africa West**. Terraform in `infra/terraform` describes each environment; GitHub Actions deploys it.

## One-time setup per environment
1. A paid subscription per environment (`staging`, `prod`) under one management group.
2. A storage account for Terraform state (in South Africa North, versioned, no public access). Copy `infra/terraform/envs/backend.hcl.example` and fill it in.
3. An Entra app registration per environment with a federated credential for this repository's GitHub environment (`staging` or `production`), holding **Owner** on the environment's subscription (Terraform assigns roles) — or Contributor + User Access Administrator.
4. GitHub environments `staging` and `production` (with required reviewers). Variables in each:

   | Variable | Value |
   |---|---|
   | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | the app registration and subscription |
   | `TF_BACKEND_CONFIG` | the contents of your `backend.hcl` |
   | `RESOURCE_GROUP`, `ACR_NAME`, `API_APP`, `JOB_PREFIX` | from `terraform output` (`acr_login_server` without `.azurecr.io`) |
   | `PUBLIC_URL` | `https://<platform host>` (goes through Front Door) |
   | `STAGING_ACR_RESOURCE_ID` | production only: the staging registry's resource ID, for `az acr import` |

   Secrets: `SMTP_URL` and `SENTRY_DSN` (optional); `PAYFAST_MERCHANT_KEY` and `PAYFAST_PASSPHRASE` with variable `PAYFAST_MERCHANT_ID` once the PayFast account is approved (set `payfast_sandbox = false` in `prod.tfvars` for live payments).
5. Fill `envs/<env>.tfvars` (hostnames, alert emails, budget) and run the **Infrastructure** workflow (or `terraform apply -var-file=envs/<env>.tfvars` with `TF_VAR_deployer_ip` set to your address).
6. Point the platform hostnames at Front Door: if `platform_dns_zone` is set Terraform creates the records; otherwise create the CNAME and `_dnsauth` TXT records from `terraform output custom_domain_validation`.
7. First firm: run the migrate job, then `npm run firm -w apps/api -- create …` through `az containerapp exec` (or a one-off job) and invite its first administrator.

## Each release
`main` passes CI → **Deploy** builds one image tagged with the commit and:
1. runs the `migrate` job with it (migrations only ever add; a failed migration stops the release and the old revision keeps serving),
2. points the scheduled jobs (anchor, reminders, court-rolls, domains, subscriptions) at it,
3. rolls the API to it and waits for `/ready` through Front Door,
4. after approval, imports the **same image** into production and repeats.

Roll back: `az containerapp revision list` and `az containerapp ingress traffic set --revision-weight <previous>=100`. Migrations are not rolled back; fix forward.

## Scheduled jobs (UTC)
| Job | When | Command |
|---|---|---|
| anchor | 00:30 SAST daily | `ops anchor` |
| reminders | every 15 minutes | `ops reminders` |
| court-rolls | 06:00 SAST Monday and Thursday | `ops court-rolls` |
| domains | hourly | `ops domains` |
| subscriptions | 07:00 SAST daily | `ops subscriptions` (trial and overdue notices, read-only mode) |

A failed job execution raises the "job failures" alert.

## Key Vault firewall
Key Vault denies public traffic; the app reaches it over a private endpoint. Terraform needs the deployer's address in `key_vault_allowed_ips` or `TF_VAR_deployer_ip`; the Infrastructure workflow adds the runner's address and removes it afterwards.
