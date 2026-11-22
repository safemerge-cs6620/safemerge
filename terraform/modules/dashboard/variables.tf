variable "prefix" {
  type        = string
  description = "Name prefix, for example sm-prod"
}

variable "lab_role_arn" {
  type        = string
  description = "LabRole ARN, used as the Lambda execution role"
}
