terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    # Zips Lambda code (dashboard, webhook, notifier)
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
  # Settings come from envs/<env>/backend.hcl through -backend-config
  backend "s3" {}
}
