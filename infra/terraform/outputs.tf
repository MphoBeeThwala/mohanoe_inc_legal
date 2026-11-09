output "resource_group" {
  value = azurerm_resource_group.main.name
}

output "acr_login_server" {
  value = azurerm_container_registry.main.login_server
}

output "api_app_name" {
  value = azurerm_container_app.api.name
}

output "migrate_job_name" {
  value = azurerm_container_app_job.migrate.name
}

output "job_names" {
  value = concat([azurerm_container_app_job.migrate.name], [for job in azurerm_container_app_job.scheduled : job.name])
}

output "front_door_endpoint" {
  description = "CNAME target for firm addresses (CUSTOM_DOMAIN_CNAME_TARGET)."
  value       = azurerm_cdn_frontdoor_endpoint.main.host_name
}

output "front_door_id" {
  description = "Sent as X-Azure-FDID; the app's FRONT_DOOR_ID."
  value       = azurerm_cdn_frontdoor_profile.main.resource_guid
}

output "custom_domain_validation" {
  description = "TXT records (_dnsauth.<host>) for host names outside the platform's DNS zone."
  value = {
    for host, domain in azurerm_cdn_frontdoor_custom_domain.hosts : host => {
      record = "_dnsauth.${host}"
      value  = domain.validation_token
    }
  }
}

output "postgres_server" {
  value = azurerm_postgresql_flexible_server.main.name
}

output "key_vault" {
  value = azurerm_key_vault.main.name
}

output "app_identity_client_id" {
  value = azurerm_user_assigned_identity.app.client_id
}

output "job_prefix" {
  description = "JOB_PREFIX for scripts/deploy-azure.sh"
  value       = "caj-${local.name}"
}
