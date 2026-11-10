# Key Vault: the key-encryption key that wraps every firm's data keys
# (HSM-backed in prod) and the app's secrets. Purge protection is on:
# deleting the key would make every firm's data unreadable.

resource "azurerm_key_vault" "main" {
  name                          = "kv-${local.compact}-${random_string.suffix.result}"
  location                      = var.location
  resource_group_name           = azurerm_resource_group.main.name
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = local.prod ? "premium" : "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = true
  soft_delete_retention_days    = 90
  public_network_access_enabled = true

  network_acls {
    default_action = "Deny"
    bypass         = "AzureServices"
    ip_rules       = compact(concat(var.key_vault_allowed_ips, [var.deployer_ip == "" ? "" : "${var.deployer_ip}/32"]))
  }

  tags = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

# Whoever runs Terraform manages keys and secrets.
resource "azurerm_role_assignment" "deployer_kv_admin" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Administrator"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_private_endpoint" "vault" {
  name                = "pe-${local.name}-kv"
  location            = var.location
  resource_group_name = azurerm_resource_group.main.name
  subnet_id           = azurerm_subnet.endpoints.id

  private_service_connection {
    name                           = "vault"
    private_connection_resource_id = azurerm_key_vault.main.id
    subresource_names              = ["vault"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "vault"
    private_dns_zone_ids = [azurerm_private_dns_zone.zones["vault"].id]
  }

  tags = local.tags
}

resource "azurerm_key_vault_key" "kek" {
  name         = "firm-key-encryption-key"
  key_vault_id = azurerm_key_vault.main.id
  key_type     = local.prod ? "RSA-HSM" : "RSA"
  key_size     = 3072
  key_opts     = ["wrapKey", "unwrapKey"]
  depends_on   = [azurerm_role_assignment.deployer_kv_admin]

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_role_assignment" "app_kek" {
  scope                = azurerm_key_vault_key.kek.resource_versionless_id
  role_definition_name = "Key Vault Crypto User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_role_assignment" "app_secrets" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# ---------------------------------------------------------------- secrets

resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "random_password" "audit_chain" {
  length  = 64
  special = false
}

# Local KEK / pre-epic-6 data key: 32 bytes as 64 hex characters.
resource "random_id" "intake_key" {
  byte_length = 32
}

locals {
  # Optional secrets exist only when given, so the app never sees a placeholder.
  secrets = merge(
    {
      "jwt-secret"            = random_password.jwt.result
      "audit-chain-secret"    = random_password.audit_chain.result
      "intake-encryption-key" = random_id.intake_key.hex
      "database-url"          = local.database_url
    },
    { for name, value in local.optional_secrets : name => value if contains(local.optional_secret_names, name) },
  )

  # Optional secrets that were given. Whether a secret is set is not itself
  # secret, so the names can drive for_each (sensitive values cannot).
  optional_secrets = {
    "smtp-url"             = var.smtp_url
    "sentry-dsn"           = var.sentry_dsn
    "payfast-merchant-key" = var.payfast_merchant_key
    "payfast-passphrase"   = var.payfast_passphrase
    "laws-africa-token"    = var.laws_africa_token
  }
  optional_secret_names = [
    for name in ["smtp-url", "sentry-dsn", "payfast-merchant-key", "payfast-passphrase", "laws-africa-token"] : name
    if nonsensitive(local.optional_secrets[name] != "")
  ]
  secret_names = concat(
    ["jwt-secret", "audit-chain-secret", "intake-encryption-key", "database-url"],
    local.optional_secret_names,
  )

  # Environment variable name for each secret.
  secret_env = {
    "jwt-secret"            = "JWT_SECRET"
    "audit-chain-secret"    = "AUDIT_CHAIN_SECRET"
    "intake-encryption-key" = "INTAKE_ENCRYPTION_KEY"
    "database-url"          = "DATABASE_URL"
    "smtp-url"              = "SMTP_URL"
    "sentry-dsn"            = "SENTRY_DSN"
    "payfast-merchant-key"  = "PAYFAST_MERCHANT_KEY"
    "payfast-passphrase"    = "PAYFAST_PASSPHRASE"
    "laws-africa-token"     = "LAWS_AFRICA_TOKEN"
  }
}

resource "azurerm_key_vault_secret" "app" {
  for_each     = toset(local.secret_names)
  name         = each.key
  value        = local.secrets[each.key]
  key_vault_id = azurerm_key_vault.main.id
  content_type = "text/plain"
  depends_on   = [azurerm_role_assignment.deployer_kv_admin]

  lifecycle {
    # Rotated in Key Vault (new versions) without Terraform; the app reads the
    # latest version on its next revision.
    ignore_changes = [value]
  }
}
