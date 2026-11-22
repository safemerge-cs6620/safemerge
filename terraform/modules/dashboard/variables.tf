variable "prefix" {
  type        = string
  description = "Name prefix, for example sm-prod"
}

variable "lab_role_arn" {
  type        = string
  description = "LabRole ARN, used as the Lambda execution role"
}

variable "oauth_secret_arn" {
  type        = string
  description = "Secrets Manager ARN of sm/github-oauth (client ID and secret)"
}

variable "session_secret_arn" {
  type        = string
  description = "Secrets Manager ARN of sm/session-secret (cookie signing key)"
}

variable "allowed_users" {
  type        = string
  description = "Comma-separated GitHub usernames allowed to sign in"
}
