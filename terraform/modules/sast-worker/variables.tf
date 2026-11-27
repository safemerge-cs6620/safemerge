variable "prefix" { type = string }
variable "lab_role_arn" { type = string }
variable "queue_arn" { type = string }
variable "ecr_repository_url" { type = string }
variable "image_tag" { type = string }
variable "scans_table_name" { type = string }
variable "reports_bucket_name" { type = string }
variable "github_token_secret_id" { type = string }
variable "notifier_function_name" { type = string }

variable "dashboard_url" {
  type    = string
  default = ""
}

variable "timeout_seconds" {
  type    = number
  default = 60
  validation {
    condition     = var.timeout_seconds <= 60
    error_message = "Keep the Lambda timeout at 60 s or less: the queue visibility timeout (360 s) and the delivery lease (120 s) depend on it."
  }
}

variable "memory_mb" {
  type    = number
  default = 1024
}
