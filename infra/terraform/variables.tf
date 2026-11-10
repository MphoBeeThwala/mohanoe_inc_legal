variable "subscription_id" {
  description = "Azure subscription for this environment (one per environment)."
  type        = string
}

variable "environment" {
  description = "staging or prod."
  type        = string
  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

variable "location" {
  description = "Primary region. Client data stays in South Africa."
  type        = string
  default     = "southafricanorth"
}

variable "name_prefix" {
  description = "Short prefix for resource names (lower-case letters and digits)."
  type        = string
  default     = "ahava88"
}

variable "platform_base_domain" {
  description = "Firms' default addresses are <slug>.<platform_base_domain>."
  type        = string
}

variable "platform_hostnames" {
  description = "Host names served through Front Door: firm subdomains and verified custom domains."
  type        = list(string)
  default     = []
}

variable "platform_dns_zone" {
  description = "Optional Azure DNS zone (name and resource group) for platform_base_domain; records for its host names are then created here."
  type = object({
    name                = string
    resource_group_name = string
  })
  default = null
}

variable "image" {
  description = "Initial container image; deployments update it (see .github/workflows/deploy.yml)."
  type        = string
  default     = "mcr.microsoft.com/k8se/quickstart:latest"
}

variable "api_min_replicas" {
  type    = number
  default = 1
}

variable "api_max_replicas" {
  type    = number
  default = 4
}

variable "postgres_sku" {
  description = "B_Standard_B1ms (staging) or GP_Standard_D2ds_v5 and up (prod)."
  type        = string
}

variable "postgres_storage_mb" {
  type    = number
  default = 65536
}

variable "postgres_high_availability" {
  description = "Zone-redundant HA (prod)."
  type        = bool
  default     = false
}

variable "lock_audit_immutability" {
  description = "Lock the audit-anchor container's retention policy (prod). Locked policies can't be shortened or removed."
  type        = bool
  default     = false
}

variable "audit_retention_days" {
  type    = number
  default = 3650
}

variable "key_vault_allowed_ips" {
  description = "Public IPs (CIDR) allowed to manage Key Vault (deployers). The app uses a private endpoint."
  type        = list(string)
  default     = []
}

variable "deployer_ip" {
  description = "The pipeline runner's public IP while it applies (added to the Key Vault firewall, removed after)."
  type        = string
  default     = ""
}

variable "alert_emails" {
  description = "Who is told about outages and alerts."
  type        = list(string)
}

variable "monthly_budget_zar" {
  description = "Budget for the resource group; alerts at 80% (forecast) and 100%."
  type        = number
}

variable "mail_from" {
  description = "Sender address (MAIL_FROM), on the email domain."
  type        = string
}

variable "mail_custom_domain" {
  description = "Customer-managed email domain (prod). Empty: an Azure-managed domain (staging)."
  type        = string
  default     = ""
}

variable "smtp_url" {
  description = "SMTP URL for Azure Communication Services Email (smtps://<user>:<secret>@smtp.azurecomm.net:587). Set once; ignored afterwards."
  type        = string
  sensitive   = true
  default     = ""
}

variable "sentry_dsn" {
  type      = string
  sensitive = true
  default   = ""
}

variable "court_roll_sources" {
  description = "COURT_ROLL_SOURCES JSON (empty: no court roll sync)."
  type        = string
  default     = ""
}

variable "court_roll_user_agent" {
  type    = string
  default = ""
}

variable "platform_console_host" {
  description = "Host name of the platform operators' console (for example console.example.co.za). Empty turns the console off."
  type        = string
  default     = ""
}

variable "platform_status_url" {
  description = "The platform status page (https), linked from Help."
  type        = string
  default     = ""
}

variable "platform_support_email" {
  type    = string
  default = ""
}

variable "app_settings" {
  description = "Extra plain environment variables for the app (non-secret)."
  type        = map(string)
  default     = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}

# Firm subscriptions (PayFast, the platform's merchant account).
variable "payfast_merchant_id" {
  description = "PayFast merchant ID. Leave empty until the account is approved: firms then see that online payment isn't available."
  type        = string
  default     = ""
}

variable "payfast_merchant_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "payfast_passphrase" {
  description = "The passphrase set in the PayFast dashboard (required for recurring billing)."
  type        = string
  sensitive   = true
  default     = ""
}

variable "payfast_sandbox" {
  type    = bool
  default = true
}

variable "subscription_trial_days" {
  type    = number
  default = 30
}

variable "platform_invoice_details" {
  description = "The platform's details on its invoices to firms (VAT Act s20(4), Companies Act s32(4)). vat_number empty means not a VAT vendor (set platform_vat_rate = 0)."
  type = object({
    address             = string
    registration_number = string
    vat_number          = string
  })
  default = {
    address             = ""
    registration_number = ""
    vat_number          = ""
  }
}

variable "platform_vat_rate" {
  description = "VAT the platform charges firms (0.15, or 0 if not VAT-registered)."
  type        = number
  default     = 0.15
}

# AI (Claude in Microsoft Foundry, roadmap §7). Leave ai_endpoint empty to run
# without AI: intakes then open as "not assessed".
variable "ai_endpoint" {
  description = "Foundry Claude endpoint: https://<resource>.services.ai.azure.com/anthropic"
  type        = string
  default     = ""
}

variable "ai_model" {
  description = "Foundry deployment name used for triage."
  type        = string
  default     = ""
}

variable "ai_research_model" {
  description = "Foundry deployment name used for research (defaults to ai_model)."
  type        = string
  default     = ""
}

variable "ai_foundry_resource_id" {
  description = "Resource ID of the Foundry resource; the app identity gets Azure AI User on it (keyless Entra ID authentication)."
  type        = string
  default     = ""
}

variable "ai_firm_monthly_tokens" {
  description = "Default monthly AI token allowance per firm."
  type        = number
  default     = 2000000
}

variable "laws_africa_token" {
  description = "Laws.Africa Content API token (legislation source). Register the source with its terms first: ops sources add --code laws-africa."
  type        = string
  sensitive   = true
  default     = ""
}
