output "account_id" {
  value = data.aws_caller_identity.me.account_id
}

output "lab_role_arn" {
  value = data.aws_iam_role.lab.arn
}

output "scan_jobs_queue_url" {
  value = module.queues.scan_jobs_url
}

output "scan_jobs_dlq_url" {
  value = module.queues.scan_jobs_dlq_url
}

output "repos_table" {
  value = module.data.repos_table
}

output "scans_table" {
  value = module.data.scans_table
}

output "findings_table" {
  value = module.data.findings_table
}

output "reports_bucket" {
  value = module.reports.bucket_name
}

output "github_token_secret_arn" {
  value = module.secrets.github_token_arn
}

output "webhook_secret_arn" {
  value = module.secrets.webhook_secret_arn
}

output "ecr_repository_urls" {
  value = module.ecr.repository_urls
}

output "ecs_cluster" {
  value = module.ecs.cluster_name
}

output "public_subnet_ids" {
  value = module.ecs.subnet_ids
}

output "staging_sg_id" {
  value = module.ecs.staging_sg_id
}

output "pentest_sg_id" {
  value = module.ecs.pentest_sg_id
}

output "staging_task_definition_arn" {
  value = module.ecs.staging_task_definition_arn
}

output "deploy_gate_arn" {
  value = module.deploy_gate.state_machine_arn
}

output "deploy_gate_name" {
  value = module.deploy_gate.state_machine_name
}

output "dashboard_url" {
  value = module.dashboard.dashboard_url
}
