# Azure Front Door Premium: TLS for every firm's address (managed
# certificates), the web application firewall, and the only way in (the app
# rejects requests without this profile's X-Azure-FDID).

resource "azurerm_cdn_frontdoor_profile" "main" {
  name                     = "afd-${local.name}"
  resource_group_name      = azurerm_resource_group.main.name
  sku_name                 = "Premium_AzureFrontDoor"
  response_timeout_seconds = 120
  tags                     = local.tags
}

resource "azurerm_cdn_frontdoor_endpoint" "main" {
  name                     = "fde-${local.name}-${random_string.suffix.result}"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main.id
  tags                     = local.tags
}

resource "azurerm_cdn_frontdoor_origin_group" "api" {
  name                     = "api"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main.id
  session_affinity_enabled = false

  health_probe {
    path                = "/health"
    protocol            = "Https"
    request_type        = "GET"
    interval_in_seconds = 60
  }

  load_balancing {
    sample_size                 = 4
    successful_samples_required = 3
  }
}

resource "azurerm_cdn_frontdoor_origin" "api" {
  name                           = "container-app"
  cdn_frontdoor_origin_group_id  = azurerm_cdn_frontdoor_origin_group.api.id
  enabled                        = true
  host_name                      = azurerm_container_app.api.ingress[0].fqdn
  origin_host_header             = azurerm_container_app.api.ingress[0].fqdn
  http_port                      = 80
  https_port                     = 443
  priority                       = 1
  weight                         = 1000
  certificate_name_check_enabled = true
}

resource "azurerm_cdn_frontdoor_custom_domain" "hosts" {
  for_each                 = toset(compact(concat(var.platform_hostnames, [var.platform_console_host])))
  name                     = replace(each.value, ".", "-")
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main.id
  host_name                = each.value
  dns_zone_id              = var.platform_dns_zone != null && endswith(each.value, ".${var.platform_base_domain}") ? data.azurerm_dns_zone.platform[0].id : null

  tls {
    certificate_type = "ManagedCertificate"
  }
}

resource "azurerm_cdn_frontdoor_route" "api" {
  name                            = "all"
  cdn_frontdoor_endpoint_id       = azurerm_cdn_frontdoor_endpoint.main.id
  cdn_frontdoor_origin_group_id   = azurerm_cdn_frontdoor_origin_group.api.id
  cdn_frontdoor_origin_ids        = [azurerm_cdn_frontdoor_origin.api.id]
  cdn_frontdoor_custom_domain_ids = [for domain in azurerm_cdn_frontdoor_custom_domain.hosts : domain.id]
  patterns_to_match               = ["/*"]
  supported_protocols             = ["Http", "Https"]
  https_redirect_enabled          = true
  forwarding_protocol             = "HttpsOnly"
  link_to_default_domain          = true
}

# Web application firewall: Microsoft's managed rules and bot protection,
# plus a per-address rate limit. Run in Detection first in staging and tune
# exclusions (e.g. base64 uploads) before Prevention in prod.
resource "azurerm_cdn_frontdoor_firewall_policy" "main" {
  name                              = "waf${local.compact}"
  resource_group_name               = azurerm_resource_group.main.name
  sku_name                          = azurerm_cdn_frontdoor_profile.main.sku_name
  enabled                           = true
  mode                              = local.prod ? "Prevention" : "Detection"
  request_body_check_enabled        = true
  custom_block_response_status_code = 403

  custom_rule {
    name                           = "RateLimitPerAddress"
    enabled                        = true
    priority                       = 10
    type                           = "RateLimitRule"
    rate_limit_duration_in_minutes = 1
    rate_limit_threshold           = 600
    action                         = "Block"

    match_condition {
      match_variable = "RemoteAddr"
      operator       = "IPMatch"
      match_values   = ["0.0.0.0/0", "::/0"]
    }
  }

  managed_rule {
    type    = "Microsoft_DefaultRuleSet"
    version = "2.1"
    action  = "Block"
  }

  managed_rule {
    type    = "Microsoft_BotManagerRuleSet"
    version = "1.1"
    action  = "Block"
  }

  tags = local.tags
}

resource "azurerm_cdn_frontdoor_security_policy" "main" {
  name                     = "waf"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main.id

  security_policies {
    firewall {
      cdn_frontdoor_firewall_policy_id = azurerm_cdn_frontdoor_firewall_policy.main.id

      association {
        patterns_to_match = ["/*"]

        domain {
          cdn_frontdoor_domain_id = azurerm_cdn_frontdoor_endpoint.main.id
        }

        dynamic "domain" {
          for_each = azurerm_cdn_frontdoor_custom_domain.hosts
          content {
            cdn_frontdoor_domain_id = domain.value.id
          }
        }
      }
    }
  }
}

# ---------------------------------------------------------------- platform DNS (optional)

data "azurerm_dns_zone" "platform" {
  count               = var.platform_dns_zone == null ? 0 : 1
  name                = var.platform_dns_zone.name
  resource_group_name = var.platform_dns_zone.resource_group_name
}

locals {
  # Host names in the platform's own zone get their records here; firms
  # publish records for their own domains (shown in Firm settings).
  zone_hosts = var.platform_dns_zone == null ? {} : {
    for host in var.platform_hostnames : host => trimsuffix(host, ".${var.platform_dns_zone.name}")
    if endswith(host, ".${var.platform_dns_zone.name}")
  }
}

resource "azurerm_dns_cname_record" "hosts" {
  for_each            = local.zone_hosts
  name                = each.value
  zone_name           = data.azurerm_dns_zone.platform[0].name
  resource_group_name = var.platform_dns_zone.resource_group_name
  ttl                 = 3600
  record              = azurerm_cdn_frontdoor_endpoint.main.host_name
}

resource "azurerm_dns_txt_record" "validation" {
  for_each            = local.zone_hosts
  name                = "_dnsauth.${each.value}"
  zone_name           = data.azurerm_dns_zone.platform[0].name
  resource_group_name = var.platform_dns_zone.resource_group_name
  ttl                 = 3600

  record {
    value = azurerm_cdn_frontdoor_custom_domain.hosts[each.key].validation_token
  }
}

resource "azurerm_cdn_frontdoor_custom_domain_association" "hosts" {
  for_each                       = azurerm_cdn_frontdoor_custom_domain.hosts
  cdn_frontdoor_custom_domain_id = each.value.id
  cdn_frontdoor_route_ids        = [azurerm_cdn_frontdoor_route.api.id]
}
