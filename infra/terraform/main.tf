locals {
  name    = "${var.name_prefix}-${var.environment}"
  compact = replace("${var.name_prefix}${var.environment}", "-", "")
  prod    = var.environment == "prod"
  tags = merge(var.tags, {
    application = "legal-practice-platform"
    environment = var.environment
    owner       = "Ahava on 88 (Pty) Ltd"
    managed_by  = "terraform"
  })
}

data "azurerm_client_config" "current" {}

resource "azurerm_resource_group" "main" {
  name     = "rg-${local.name}"
  location = var.location
  tags     = local.tags
}

resource "random_string" "suffix" {
  length  = 5
  upper   = false
  special = false
}

# ---------------------------------------------------------------- logs and telemetry

resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-${local.name}"
  location            = var.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = local.prod ? 180 : 30
  tags                = local.tags
}

resource "azurerm_application_insights" "main" {
  name                = "appi-${local.name}"
  location            = var.location
  resource_group_name = azurerm_resource_group.main.name
  workspace_id        = azurerm_log_analytics_workspace.main.id
  application_type    = "web"
  tags                = local.tags
}

# ---------------------------------------------------------------- identity

# The app and its jobs run as this identity: Key Vault (key and secrets),
# Blob Storage and the container registry, with no stored credentials.
resource "azurerm_user_assigned_identity" "app" {
  name                = "id-${local.name}-app"
  location            = var.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_container_registry" "main" {
  name                          = "acr${local.compact}${random_string.suffix.result}"
  location                      = var.location
  resource_group_name           = azurerm_resource_group.main.name
  sku                           = "Standard"
  admin_enabled                 = false
  anonymous_pull_enabled        = false
  public_network_access_enabled = true
  tags                          = local.tags
}

resource "azurerm_role_assignment" "app_acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}
