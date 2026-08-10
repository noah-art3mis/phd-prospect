# The backup destination as code: the R2 bucket and a token scoped to it.
#
# One credential has to exist before this can run – IaC cannot bootstrap
# itself into an account. Create it once in the Cloudflare dashboard
# (My Profile -> API Tokens -> Create Token, custom) with exactly:
#
#   Account | Workers R2 Storage | Edit     (create the bucket)
#   User    | API Tokens         | Edit     (create the scoped token)
#
# then run:
#
#   export CLOUDFLARE_API_TOKEN=<bootstrap token>
#   tofu init
#   tofu apply -var account_id=<cloudflare account id>
#   tofu output -json backup_env | node -e 'const o=JSON.parse(require("fs").readFileSync(0));for(const[k,v]of Object.entries(o))console.log(`${k}=${v}`)'
#
# and paste the four lines into .env. The state file holds the derived
# secret, which is why *.tfstate is ignored and must stay off git.

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}

provider "cloudflare" {}

variable "account_id" {
  type        = string
  description = "Cloudflare account id, shown on the R2 overview page"
}

variable "bucket_name" {
  type    = string
  default = "prospect-backups"
}

resource "cloudflare_r2_bucket" "backups" {
  account_id = var.account_id
  name       = var.bucket_name
}

# Object read/write on one bucket, nothing account-wide: scoping is what
# limits the damage if the box holding the token is lost.
data "cloudflare_api_token_permission_groups_list" "bucket_item_write" {
  name = "Workers%20R2%20Storage%20Bucket%20Item%20Write"
}

resource "cloudflare_api_token" "backup_writer" {
  name = "${var.bucket_name}-writer"

  policies = [{
    effect = "allow"
    permission_groups = [{
      id = data.cloudflare_api_token_permission_groups_list.bucket_item_write.result[0].id
    }]
    resources = jsonencode({
      "com.cloudflare.edge.r2.bucket.${var.account_id}_default_${cloudflare_r2_bucket.backups.name}" = "*"
    })
  }]

  lifecycle {
    precondition {
      condition     = length(data.cloudflare_api_token_permission_groups_list.bucket_item_write.result) > 0
      error_message = "Permission group 'Workers R2 Storage Bucket Item Write' not found; the bootstrap token may lack API Tokens read access."
    }
  }
}

# R2's S3 credentials are derived from the API token: the access key id is
# the token's id, the secret is the SHA-256 of its value.
# https://developers.cloudflare.com/r2/api/tokens/
output "backup_env" {
  description = "The four BACKUP_S3_* values for .env"
  sensitive   = true
  value = {
    BACKUP_S3_ENDPOINT          = "https://${var.account_id}.r2.cloudflarestorage.com"
    BACKUP_S3_BUCKET            = cloudflare_r2_bucket.backups.name
    BACKUP_S3_ACCESS_KEY_ID     = cloudflare_api_token.backup_writer.id
    BACKUP_S3_SECRET_ACCESS_KEY = sha256(cloudflare_api_token.backup_writer.value)
  }
}
