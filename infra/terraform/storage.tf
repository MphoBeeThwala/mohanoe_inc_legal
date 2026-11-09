# Documents (firm containers, created by the app) and audit anchors.
# Prod: geo-zone-redundant with read access in South Africa West. No shared
# keys or public access: the app uses its managed identity over a private
# endpoint. The audit-anchor container is write-once (time-based
# immutability), locked in prod.

resource "azurerm_storage_account" "main" {
  name                              = "st${local.compact}${random_string.suffix.result}"
  location                          = var.location
  resource_group_name               = azurerm_resource_group.main.name
  account_tier                      = "Standard"
  account_kind                      = "StorageV2"
  account_replication_type          = local.prod ? "RAGZRS" : "ZRS"
  min_tls_version                   = "TLS1_2"
  https_traffic_only_enabled        = true
  shared_access_key_enabled         = false
  public_network_access_enabled     = false
  allow_nested_items_to_be_public   = false
  infrastructure_encryption_enabled = true
  default_to_oauth_authentication   = true

  blob_properties {
    versioning_enabled  = true
    change_feed_enabled = true

    delete_retention_policy {
      days = 30
    }

    container_delete_retention_policy {
      days = 30
    }
  }

  tags = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "audit_anchors" {
  name                  = "audit-anchors"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

resource "azurerm_storage_container_immutability_policy" "audit_anchors" {
  storage_container_resource_manager_id = azurerm_storage_container.audit_anchors.id
  immutability_period_in_days           = var.audit_retention_days
  protected_append_writes_all_enabled   = false
  locked                                = var.lock_audit_immutability
}

resource "azurerm_private_endpoint" "blob" {
  name                = "pe-${local.name}-blob"
  location            = var.location
  resource_group_name = azurerm_resource_group.main.name
  subnet_id           = azurerm_subnet.endpoints.id

  private_service_connection {
    name                           = "blob"
    private_connection_resource_id = azurerm_storage_account.main.id
    subresource_names              = ["blob"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "blob"
    private_dns_zone_ids = [azurerm_private_dns_zone.zones["blob"].id]
  }

  tags = local.tags
}

resource "azurerm_role_assignment" "app_blob" {
  scope                = azurerm_storage_account.main.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# Microsoft Defender for Storage (malware scanning of uploads).
resource "azurerm_security_center_storage_defender" "main" {
  count                                       = local.prod ? 1 : 0
  storage_account_id                          = azurerm_storage_account.main.id
  malware_scanning_on_upload_enabled          = true
  malware_scanning_on_upload_cap_gb_per_month = 50
}
