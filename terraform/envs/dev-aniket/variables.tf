variable "prefix" {
  type    = string
  default = "sm-dev"
}

variable "demo_image_tag" {
  type        = string
  default     = "s2-test"
  description = "Tag of the staging (demo-api) image in this account's ECR"
}

variable "pentest_image_tag" {
  type        = string
  default     = "s2-test"
  description = "Tag of the pentest image in this account's ECR"
}
