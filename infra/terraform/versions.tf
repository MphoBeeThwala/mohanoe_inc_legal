terraform {
  required_version = ">= 1.9"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 4.42, < 5.14"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State holds generated secrets: keep it in a locked-down storage account
  # (RBAC only, no shared keys, versioning). Configure per environment with
  # `terraform init -backend-config=envs/<env>.backend.hcl`.
  backend "azurerm" {
    use_azuread_auth = true
    use_oidc         = true
  }
}

provider "azurerm" {
  subscription_id     = var.subscription_id
  storage_use_azuread = true
  use_oidc            = true

  features {
    key_vault {
      purge_soft_delete_on_destroy    = false
      recover_soft_deleted_key_vaults = true
    }
    resource_group {
      prevent_deletion_if_contains_resources = true
    }
  }
}
