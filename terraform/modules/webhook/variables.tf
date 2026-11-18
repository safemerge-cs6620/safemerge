variable "prefix" {
  type        = string
  description = "Name prefix, for example sm-dev or sm-prod"
}

variable "lab_role_arn" {
  type = string
}

variable "queue_url" {
  type = string
}

variable "webhook_secret_arn" {
  type = string
}

variable "github_token_arn" {
  type = string
}
