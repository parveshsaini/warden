terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Runtime identity for the service — no default compute SA.
resource "google_service_account" "warden" {
  account_id   = "warden-gateway"
  display_name = "Warden MCP gateway"
}

# The gateway config file, delivered via Secret Manager and mounted read-only.
resource "google_secret_manager_secret" "config" {
  secret_id = "warden-config"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "config" {
  secret      = google_secret_manager_secret.config.id
  secret_data = file(var.config_file)
}

# Bearer keys for /mcp and /metrics, injected as WARDEN_API_KEYS.
resource "google_secret_manager_secret" "api_keys" {
  secret_id = "warden-api-keys"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "api_keys" {
  secret      = google_secret_manager_secret.api_keys.id
  secret_data = var.api_keys
}

resource "google_secret_manager_secret_iam_member" "config_access" {
  secret_id = google_secret_manager_secret.config.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.warden.email}"
}

resource "google_secret_manager_secret_iam_member" "api_keys_access" {
  secret_id = google_secret_manager_secret.api_keys.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.warden.email}"
}

resource "google_cloud_run_v2_service" "warden" {
  name     = "warden"
  location = var.region

  template {
    service_account = google_service_account.warden.email

    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image
      args  = ["--http", "--config", "/etc/warden/warden.config.yaml"]

      ports {
        container_port = 3000
      }

      env {
        name = "WARDEN_API_KEYS"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.api_keys.secret_id
            version = "latest"
          }
        }
      }

      volume_mounts {
        name       = "config"
        mount_path = "/etc/warden"
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      startup_probe {
        http_get {
          path = "/healthz"
          port = 3000
        }
        # First start downloads npx-declared upstream servers; give it room.
        initial_delay_seconds = 10
        period_seconds        = 5
        failure_threshold     = 12
      }
    }

    volumes {
      name = "config"
      secret {
        secret = google_secret_manager_secret.config.secret_id
        items {
          version = "latest"
          path    = "warden.config.yaml"
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.config,
    google_secret_manager_secret_version.api_keys,
  ]
}

# Cloud Run IAM stays open because Warden enforces its own Bearer-key auth.
# Flip the variable off to require Google IAM authentication instead.
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  count    = var.allow_unauthenticated ? 1 : 0
  name     = google_cloud_run_v2_service.warden.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "url" {
  description = "The gateway endpoint; MCP clients connect to <url>/mcp."
  value       = google_cloud_run_v2_service.warden.uri
}
