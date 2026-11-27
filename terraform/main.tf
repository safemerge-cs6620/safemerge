provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = { project = "safemerge", env = var.env, owner = var.owner }
  }
}

locals {
  prefix = "sm-${var.env}"
}

# Learner Lab gives us one role. Everything uses it. Never create IAM roles here.
data "aws_iam_role" "lab" {
  name = "LabRole"
}

data "aws_caller_identity" "me" {}

module "queues" {
  source = "./modules/queues"
  prefix = local.prefix
}

module "data" {
  source = "./modules/data"
  prefix = local.prefix
}

module "reports" {
  source     = "./modules/reports"
  prefix     = local.prefix
  account_id = data.aws_caller_identity.me.account_id
}

module "secrets" {
  source = "./modules/secrets"
}

module "ecr" {
  source       = "./modules/ecr"
  repositories = ["demo-api", "safemerge-sast", "safemerge-pentest"]
}

module "ecs" {
  source        = "./modules/ecs"
  prefix        = local.prefix
  lab_role_arn  = data.aws_iam_role.lab.arn
  demo_image    = "${module.ecr.repository_urls["demo-api"]}:${var.demo_image_tag}"
  pentest_image = "${module.ecr.repository_urls["safemerge-pentest"]}:${var.pentest_image_tag}"
}

module "deploy_gate" {
  source                 = "./modules/deploy-gate"
  prefix                 = local.prefix
  lab_role_arn           = data.aws_iam_role.lab.arn
  notifier_function_name = "${local.prefix}-notifier"
  task_tags = {
    project = "safemerge"
    env     = var.env
    owner   = var.owner
  }

  # The gate looks up the cluster, security groups, and pentest task definition by name
  depends_on = [module.ecs]
}

module "dashboard" {
  source             = "./modules/dashboard"
  prefix             = local.prefix
  lab_role_arn       = data.aws_iam_role.lab.arn
  oauth_secret_arn   = module.secrets.github_oauth_arn
  session_secret_arn = module.secrets.session_secret_arn
  allowed_users      = "srujan-codes,shahana-neu,aniketnandi"
}
