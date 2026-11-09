# Azure Communication Services Email, data stored in Africa. Staging uses an
# Azure-managed sender domain; prod a customer-managed domain (publish the
# SPF, DKIM and DMARC records shown in the portal). SMTP needs an Entra app
# with the Communication and Email Service Owner role (see the runbook);
# its SMTP URL goes into var.smtp_url / the smtp-url secret.

resource "azurerm_email_communication_service" "main" {
  name                = "acs-email-${local.name}"
  resource_group_name = azurerm_resource_group.main.name
  data_location       = "Africa"
  tags                = local.tags
}

resource "azurerm_email_communication_service_domain" "main" {
  name              = var.mail_custom_domain == "" ? "AzureManagedDomain" : var.mail_custom_domain
  email_service_id  = azurerm_email_communication_service.main.id
  domain_management = var.mail_custom_domain == "" ? "AzureManaged" : "CustomerManaged"
  tags              = local.tags
}

resource "azurerm_communication_service" "main" {
  name                = "acs-${local.name}"
  resource_group_name = azurerm_resource_group.main.name
  data_location       = "Africa"
  tags                = local.tags
}

resource "azurerm_communication_service_email_domain_association" "main" {
  communication_service_id = azurerm_communication_service.main.id
  email_service_domain_id  = azurerm_email_communication_service_domain.main.id
}
