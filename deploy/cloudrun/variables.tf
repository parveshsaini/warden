variable "project_id" {
  description = "GCP project to deploy into."
  type        = string
}

variable "region" {
  description = "Cloud Run region."
  type        = string
  default     = "us-central1"
}

variable "image" {
  description = "Warden container image in Artifact Registry, e.g. us-central1-docker.pkg.dev/PROJECT/warden/warden-gateway:0.1.0."
  type        = string
}

variable "config_file" {
  description = "Path to the warden.config.yaml to deploy (stored in Secret Manager, mounted read-only)."
  type        = string
  default     = "../../examples/warden.config.docker.yaml"
}

variable "api_keys" {
  description = "Comma-separated Bearer keys accepted on /mcp and /metrics."
  type        = string
  sensitive   = true
}

variable "max_instances" {
  description = "Upper autoscaling bound."
  type        = number
  default     = 3
}

variable "allow_unauthenticated" {
  description = "Leave Cloud Run IAM open and rely on Warden's Bearer-key auth. Set false to require Google IAM."
  type        = bool
  default     = true
}
