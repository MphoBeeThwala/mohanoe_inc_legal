environment                = "staging"
platform_base_domain       = "staging.example-legal.co.za" # replace with the real platform domain
platform_hostnames         = []
postgres_sku               = "B_Standard_B1ms"
postgres_storage_mb        = 32768
postgres_high_availability = false
lock_audit_immutability    = false
audit_retention_days       = 30
api_min_replicas           = 0 # scale to zero when idle (the first request after a pause is slower)
api_max_replicas           = 2
alert_emails               = ["ops@example.co.za"] # replace
monthly_budget_zar         = 2500
mail_from                  = "no-reply@REPLACE.azurecomm.net" # the Azure-managed domain's sender

payfast_sandbox       = true
platform_console_host = "" # e.g. console.staging.<platform domain>
platform_invoice_details = {
  address             = "" # the company's registered address
  registration_number = "" # CIPC number, e.g. 2024/123456/07
  vat_number          = "" # empty until VAT-registered (then platform_vat_rate stays 0.15)
}

# Low-cost staging (production keeps the defaults: Premium Front Door, Standard registry).
front_door_sku         = "Standard_AzureFrontDoor"
container_registry_sku = "Basic"
