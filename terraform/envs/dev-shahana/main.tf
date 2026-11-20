# LabRole is the only role we have. Read it, never create roles.
data "aws_iam_role" "lab" {
  name = "LabRole"
}

module "queues" {
  source = "../../modules/queues"
  prefix = "sm-dev"
}

module "secrets" {
  source = "../../modules/secrets"
}

module "webhook" {
  source             = "../../modules/webhook"
  prefix             = "sm-dev"
  lab_role_arn       = data.aws_iam_role.lab.arn
  queue_url          = module.queues.scan_jobs_url
  webhook_secret_arn = module.secrets.webhook_secret_arn
  github_token_arn   = module.secrets.github_token_arn
}

module "notifier" {
  source           = "../../modules/notifier"
  prefix           = "sm-dev"
  lab_role_arn     = data.aws_iam_role.lab.arn
  github_token_arn = module.secrets.github_token_arn
  dlq_arn          = module.queues.scan_jobs_dlq_arn
}
