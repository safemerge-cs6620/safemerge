output "registry" {
  value = local.registry
}

output "cluster_name" {
  value = "${var.prefix}-cluster"
}

output "state_machine_arn" {
  value = module.deploy_gate.state_machine_arn
}
