variable "prefix" {
  type        = string
  description = "Name prefix, the same value passed to modules/ecs (for example sm-prod)"
}

variable "lab_role_arn" {
  type        = string
  description = "LabRole ARN, used by the state machine and as the task role and execution role"
}

variable "task_tags" {
  type        = map(string)
  default     = {}
  description = "Tags put on every staging task definition revision the gate registers"
}

variable "max_health_polls" {
  type        = number
  default     = 30
  description = "How many 10-second polls to wait for the staging task to become healthy"
}
