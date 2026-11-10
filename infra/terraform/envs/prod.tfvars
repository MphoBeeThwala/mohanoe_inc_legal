environment                = "prod"
platform_base_domain       = "example-legal.co.za" # replace with the real platform domain
platform_hostnames         = []                    # firm subdomains and verified custom domains
postgres_sku               = "GP_Standard_D2ds_v5"
postgres_storage_mb        = 131072
postgres_high_availability = true
lock_audit_immutability    = true
audit_retention_days       = 3650
api_min_replicas           = 2
api_max_replicas           = 6
alert_emails               = ["ops@example.co.za"] # replace
monthly_budget_zar         = 25000
mail_from                  = "no-reply@mail.example-legal.co.za" # replace
mail_custom_domain         = "mail.example-legal.co.za"          # replace

# PayFast: sandbox until the merchant account is approved and tested.
payfast_sandbox       = true # set false for live payments
platform_console_host = ""   # e.g. console.<platform domain>
platform_invoice_details = {
  address             = "" # the company's registered address
  registration_number = "" # CIPC number, e.g. 2024/123456/07
  vat_number          = "" # empty until VAT-registered (then platform_vat_rate stays 0.15)
}
