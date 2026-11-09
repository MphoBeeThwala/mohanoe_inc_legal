environment                = "staging"
platform_base_domain       = "staging.example-legal.co.za" # replace with the real platform domain
platform_hostnames         = []
postgres_sku               = "B_Standard_B1ms"
postgres_storage_mb        = 32768
postgres_high_availability = false
lock_audit_immutability    = false
audit_retention_days       = 30
api_min_replicas           = 1
api_max_replicas           = 2
alert_emails               = ["ops@example.co.za"] # replace
monthly_budget_zar         = 6000
mail_from                  = "no-reply@REPLACE.azurecomm.net" # the Azure-managed domain's sender

payfast_sandbox = true
