# Aniket's test environment for the deploy gate (S2-1).
# It uses the shared modules, so what is tested here is what production runs.
# The only difference is that it creates its own ECR repos in this Learner Lab account.

data "aws_iam_role" "lab" {
  name = "LabRole"
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

locals {
  registry = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${data.aws_region.current.name}.amazonaws.com"
}

resource "aws_ecr_repository" "demo_api" {
  name         = "demo-api"
  force_delete = true
}

resource "aws_ecr_repository" "pentest" {
  name         = "safemerge-pentest"
  force_delete = true
}

module "ecs" {
  source = "../../modules/ecs"

  prefix        = var.prefix
  lab_role_arn  = data.aws_iam_role.lab.arn
  demo_image    = "${local.registry}/demo-api:${var.demo_image_tag}"
  pentest_image = "${local.registry}/safemerge-pentest:${var.pentest_image_tag}"
}

module "deploy_gate" {
  source = "../../modules/deploy-gate"

  prefix       = var.prefix
  lab_role_arn = data.aws_iam_role.lab.arn
  task_tags = {
    project = "safemerge"
    env     = "dev"
    owner   = "aniket"
  }

  # The gate looks up the cluster, security groups and pentest task definition by name
  depends_on = [module.ecs]
}
