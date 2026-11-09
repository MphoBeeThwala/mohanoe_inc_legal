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
