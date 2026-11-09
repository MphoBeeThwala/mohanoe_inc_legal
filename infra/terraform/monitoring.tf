# Diagnostics, uptime checks, alerts and the budget.

resource "azurerm_monitor_action_group" "ops" {
  name                = "ag-${local.name}"
  resource_group_name = azurerm_resource_group.main.name
  short_name          = "legalops"

  dynamic "email_receiver" {
    for_each = toset(var.alert_emails)
    content {
      name                    = replace(email_receiver.value, "/[^A-Za-z0-9]/", "-")
      email_address           = email_receiver.value
      use_common_alert_schema = true
    }
  }

  tags = local.tags
}

# Diagnostic logs to Log Analytics (no request bodies are logged by these).
locals {
  diagnostics = {
    postgres  = azurerm_postgresql_flexible_server.main.id
    keyvault  = azurerm_key_vault.main.id
    frontdoor = azurerm_cdn_frontdoor_profile.main.id
  }
}

resource "azurerm_monitor_diagnostic_setting" "main" {
  for_each                   = local.diagnostics
  name                       = "to-log-analytics"
  target_resource_id         = each.value
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category_group = "allLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

# Uptime: /ready through Front Door from several locations every 5 minutes.
resource "azurerm_application_insights_standard_web_test" "ready" {
  name                    = "ready-${local.name}"
  location                = var.location
  resource_group_name     = azurerm_resource_group.main.name
  application_insights_id = azurerm_application_insights.main.id
  frequency               = 300
  timeout                 = 30
  enabled                 = true
  retry_enabled           = true
  geo_locations           = ["emea-ru-msa-edge", "emea-nl-ams-azr", "emea-gb-db3-azr", "us-va-ash-azr", "apac-sg-sin-azr"]

  request {
    url = "https://${azurerm_cdn_frontdoor_endpoint.main.host_name}/ready"
  }

  validation_rules {
    expected_status_code        = 200
    ssl_check_enabled           = true
    ssl_cert_remaining_lifetime = 14
  }

  tags = local.tags
}

resource "azurerm_monitor_metric_alert" "availability" {
  name                = "availability-${local.name}"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_application_insights_standard_web_test.ready.id, azurerm_application_insights.main.id]
  description         = "The platform is not answering /ready from two or more locations."
  severity            = 0
  frequency           = "PT1M"
  window_size         = "PT5M"

  application_insights_web_test_location_availability_criteria {
    web_test_id           = azurerm_application_insights_standard_web_test.ready.id
    component_id          = azurerm_application_insights.main.id
    failed_location_count = 2
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }

  tags = local.tags
}

locals {
  metric_alerts = {
    frontdoor-5xx = {
      scope       = azurerm_cdn_frontdoor_profile.main.id
      namespace   = "Microsoft.Cdn/profiles"
      metric      = "Percentage5XX"
      aggregation = "Average"
      operator    = "GreaterThan"
      threshold   = 5
      severity    = 1
      description = "More than 5% of requests fail with 5xx."
    }
    postgres-cpu = {
      scope       = azurerm_postgresql_flexible_server.main.id
      namespace   = "Microsoft.DBforPostgreSQL/flexibleServers"
      metric      = "cpu_percent"
      aggregation = "Average"
      operator    = "GreaterThan"
      threshold   = 80
      severity    = 2
      description = "Database CPU above 80%."
    }
    postgres-storage = {
      scope       = azurerm_postgresql_flexible_server.main.id
      namespace   = "Microsoft.DBforPostgreSQL/flexibleServers"
      metric      = "storage_percent"
      aggregation = "Average"
      operator    = "GreaterThan"
      threshold   = 80
      severity    = 2
      description = "Database storage above 80%."
    }
    api-restarts = {
      scope       = azurerm_container_app.api.id
      namespace   = "Microsoft.App/containerApps"
      metric      = "RestartCount"
      aggregation = "Total"
      operator    = "GreaterThan"
      threshold   = 3
      severity    = 2
      description = "API containers restarting."
    }
  }
}

resource "azurerm_monitor_metric_alert" "metrics" {
  for_each            = local.metric_alerts
  name                = "${each.key}-${local.name}"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [each.value.scope]
  description         = each.value.description
  severity            = each.value.severity
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = each.value.namespace
    metric_name      = each.value.metric
    aggregation      = each.value.aggregation
    operator         = each.value.operator
    threshold        = each.value.threshold
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }

  tags = local.tags
}

# Failed scheduled jobs (anchors, reminders, court rolls, domains).
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "job_failures" {
  name                 = "job-failures-${local.name}"
  resource_group_name  = azurerm_resource_group.main.name
  location             = var.location
  scopes               = [azurerm_log_analytics_workspace.main.id]
  description          = "A scheduled job failed in the last hour."
  severity             = 2
  evaluation_frequency = "PT15M"
  window_duration      = "PT1H"

  criteria {
    query                   = <<-KQL
      ContainerAppSystemLogs_CL
      | where JobName_s startswith "caj-${local.name}"
      | where Reason_s in ("Failed", "BackoffLimitExceeded", "DeadlineExceeded")
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0
  }

  action {
    action_groups = [azurerm_monitor_action_group.ops.id]
  }

  tags = local.tags
}

resource "azurerm_consumption_budget_resource_group" "main" {
  name              = "budget-${local.name}"
  resource_group_id = azurerm_resource_group.main.id
  amount            = var.monthly_budget_zar
  time_grain        = "Monthly"

  time_period {
    start_date = "2026-12-01T00:00:00Z"
  }

  notification {
    enabled        = true
    threshold      = 80
    operator       = "GreaterThan"
    threshold_type = "Forecasted"
    contact_emails = var.alert_emails
  }

  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThan"
    threshold_type = "Actual"
    contact_emails = var.alert_emails
  }
}
