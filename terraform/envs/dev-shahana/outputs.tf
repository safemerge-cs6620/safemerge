output "webhook_url" { value = module.webhook.webhook_url }
output "queue_url" { value = module.queues.scan_jobs_url }
output "dlq_url" { value = module.queues.scan_jobs_dlq_url }
output "notifier_function_name" { value = module.notifier.function_name }
