# The API (serving the web app) and the scheduled jobs, on Container Apps in
# the VNet. Secrets come from Key Vault through the app's identity. The image
# is set by the deploy pipeline (ignored here after creation).

resource "azurerm_container_app_environment" "main" {
  name                               = "cae-${local.name}"
  location                           = var.location
  resource_group_name                = azurerm_resource_group.main.name
  log_analytics_workspace_id         = azurerm_log_analytics_workspace.main.id
  infrastructure_subnet_id           = azurerm_subnet.apps.id
  infrastructure_resource_group_name = "rg-${local.name}-cae-infra"
  zone_redundancy_enabled            = local.prod
  internal_load_balancer_enabled     = false

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }

  tags = local.tags
}

locals {
  app_env = merge(
    {
      NODE_ENV                           = "production"
      PORT                               = "3000"
      DEPLOY_ENVIRONMENT                 = var.environment
      DB_MIGRATE_ON_START                = "false"
      DATABASE_POOL_MAX                  = "10"
      PLATFORM_BASE_DOMAIN               = var.platform_base_domain
      APP_ORIGIN                         = "https://${var.platform_base_domain}"
      KEY_PROVIDER                       = "azure-keyvault"
      AZURE_KEY_VAULT_KEY_ID             = azurerm_key_vault_key.kek.versionless_id
      AZURE_CLIENT_ID                    = azurerm_user_assigned_identity.app.client_id
      OBJECT_STORE                       = "azure-blob"
      AZURE_STORAGE_ACCOUNT_URL          = azurerm_storage_account.main.primary_blob_endpoint
      AUDIT_ANCHOR_CONTAINER             = azurerm_storage_container.audit_anchors.name
      AUDIT_ANCHOR_INTERVAL_HOURS        = "0"
      CALENDAR_REMINDER_INTERVAL_MINUTES = "0"
      COURT_ROLL_SYNC_INTERVAL_HOURS     = "0"
      COURT_ROLL_SOURCES                 = var.court_roll_sources
      COURT_ROLL_USER_AGENT              = var.court_roll_user_agent
      MAIL_FROM                          = var.mail_from
      FRONT_DOOR_ID                      = azurerm_cdn_frontdoor_profile.main.resource_guid
      TRUST_PROXY_HOPS                   = "2"
      CUSTOM_DOMAIN_CNAME_TARGET         = azurerm_cdn_frontdoor_endpoint.main.host_name
      SESSION_COOKIE_SECURE              = "true"
      LOG_HTTP                           = "true"
      PLATFORM_SUPPORT_EMAIL             = var.platform_support_email
      PLATFORM_CONSOLE_HOST              = var.platform_console_host
      PLATFORM_STATUS_URL                = var.platform_status_url
      PAYFAST_MERCHANT_ID                = var.payfast_merchant_id
      PAYFAST_SANDBOX                    = var.payfast_sandbox ? "true" : "false"
      SUBSCRIPTION_TRIAL_DAYS            = tostring(var.subscription_trial_days)
      PLATFORM_VAT_RATE                  = tostring(var.platform_vat_rate)
      AI_PROVIDER                        = var.ai_endpoint == "" ? "none" : "foundry"
      AI_ENDPOINT                        = var.ai_endpoint
      AI_MODEL                           = var.ai_model
      AI_RESEARCH_MODEL                  = var.ai_research_model
      AI_FIRM_MONTHLY_TOKENS             = tostring(var.ai_firm_monthly_tokens)
    },
    var.app_settings,
  )

  # Scheduled work (see README: calendar, court rolls, audit, domains).
  jobs = {
    anchor        = { cron = "30 22 * * *", args = ["apps/api/dist/scripts/ops.js", "anchor"] }                    # 00:30 SAST daily
    reminders     = { cron = "*/15 * * * *", args = ["apps/api/dist/scripts/ops.js", "reminders"] }                # every 15 minutes
    court-rolls   = { cron = "0 4 * * 1,4", args = ["apps/api/dist/scripts/ops.js", "court-rolls"] }               # Mon and Thu 06:00 SAST
    domains       = { cron = "0 * * * *", args = ["apps/api/dist/scripts/ops.js", "domains"] }                     # hourly
    subscriptions = { cron = "0 5 * * *", args = ["apps/api/dist/scripts/ops.js", "subscriptions"] }               # 07:00 SAST daily
    legislation   = { cron = "0 0 * * 0", args = ["apps/api/dist/scripts/ops.js", "sources", "sync-laws-africa"] } # Sun 02:00 SAST
  }
}

resource "azurerm_container_app" "api" {
  name                         = "ca-${local.name}-api"
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  dynamic "secret" {
    for_each = toset(local.secret_names)
    content {
      name                = secret.key
      key_vault_secret_id = azurerm_key_vault_secret.app[secret.key].versionless_id
      identity            = azurerm_user_assigned_identity.app.id
    }
  }

  ingress {
    external_enabled = true
    target_port      = 3000
    transport        = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.api_min_replicas
    max_replicas = var.api_max_replicas

    container {
      name   = "api"
      image  = var.image
      cpu    = 1
      memory = "2Gi"

      dynamic "env" {
        for_each = local.app_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = toset(local.secret_names)
        content {
          name        = local.secret_env[env.key]
          secret_name = env.key
        }
      }

      startup_probe {
        transport               = "HTTP"
        path                    = "/health"
        port                    = 3000
        interval_seconds        = 5
        failure_count_threshold = 30
      }

      liveness_probe {
        transport = "HTTP"
        path      = "/health"
        port      = 3000
      }

      readiness_probe {
        transport = "HTTP"
        path      = "/ready"
        port      = 3000
      }
    }

    http_scale_rule {
      name                = "http"
      concurrent_requests = "50"
    }
  }

  tags = local.tags

  depends_on = [
    azurerm_role_assignment.app_acr_pull,
    azurerm_role_assignment.app_secrets,
    azurerm_role_assignment.app_kek,
    azurerm_role_assignment.app_blob,
  ]

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }
}

resource "azurerm_container_app_job" "scheduled" {
  for_each                     = local.jobs
  name                         = "caj-${local.name}-${each.key}"
  location                     = var.location
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 1800
  replica_retry_limit          = 1

  schedule_trigger_config {
    cron_expression          = each.value.cron
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  dynamic "secret" {
    for_each = toset(local.secret_names)
    content {
      name                = secret.key
      key_vault_secret_id = azurerm_key_vault_secret.app[secret.key].versionless_id
      identity            = azurerm_user_assigned_identity.app.id
    }
  }

  template {
    container {
      name    = each.key
      image   = var.image
      cpu     = 0.5
      memory  = "1Gi"
      command = ["node"]
      args    = each.value.args

      dynamic "env" {
        for_each = local.app_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = toset(local.secret_names)
        content {
          name        = local.secret_env[env.key]
          secret_name = env.key
        }
      }
    }
  }

  tags = local.tags

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }
}

# Migrations: started by the deploy pipeline before the new revision.
resource "azurerm_container_app_job" "migrate" {
  name                         = "caj-${local.name}-migrate"
  location                     = var.location
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 1800
  replica_retry_limit          = 0

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  dynamic "secret" {
    for_each = toset(local.secret_names)
    content {
      name                = secret.key
      key_vault_secret_id = azurerm_key_vault_secret.app[secret.key].versionless_id
      identity            = azurerm_user_assigned_identity.app.id
    }
  }

  template {
    container {
      name    = "migrate"
      image   = var.image
      cpu     = 0.5
      memory  = "1Gi"
      command = ["node"]
      args    = ["apps/api/dist/db/migrate.js"]

      dynamic "env" {
        for_each = local.app_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = toset(local.secret_names)
        content {
          name        = local.secret_env[env.key]
          secret_name = env.key
        }
      }
    }
  }

  tags = local.tags

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }
}
