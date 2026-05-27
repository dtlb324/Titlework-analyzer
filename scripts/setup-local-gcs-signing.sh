#!/usr/bin/env bash
# Configure local GCS signed uploads for Titlework-analyzer (macOS/Linux).
# Run on YOUR machine where gcloud is installed and you are logged in.
#
#   cd ~/Titlework-analyzer
#   bash scripts/setup-local-gcs-signing.sh
#
# Optional env overrides:
#   GCP_PROJECT=your-project-id
#   GCP_REGION=us-south1
#   API_SERVICE=titlework-analyzer-api
#   GCS_BUCKET=your-bucket-name
#   KEY_DIR=$HOME/keys

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

KEY_DIR="${KEY_DIR:-$HOME/keys}"
GCP_REGION="${GCP_REGION:-us-south1}"
API_SERVICE="${API_SERVICE:-titlework-analyzer-api}"
SA_NAME="${SA_NAME:-title-analyzer-local}"
ENV_FILE="${ENV_FILE:-$ROOT/.env.local}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud not found. Install Google Cloud SDK:"
  echo "  brew install --cask google-cloud-sdk"
  exit 1
fi

ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)"
if [[ -z "$ACCOUNT" ]]; then
  echo "Not logged in. Run:"
  echo "  gcloud auth login"
  echo "  gcloud auth application-default login"
  exit 1
fi
echo "Using gcloud account: $ACCOUNT"

PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "$PROJECT" || "$PROJECT" == "(unset)" ]]; then
  echo "No GCP project set. Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi
echo "Project: $PROJECT"

RUNTIME_SA="$(gcloud run services describe "$API_SERVICE" \
  --project="$PROJECT" \
  --region="$GCP_REGION" \
  --format='value(spec.template.spec.serviceAccountName)' 2>/dev/null || true)"

if [[ -n "$RUNTIME_SA" && "$RUNTIME_SA" != "(unset)" ]]; then
  SA_EMAIL="$RUNTIME_SA"
  echo "Cloud Run service account ($API_SERVICE): $SA_EMAIL"
  USE_RUNTIME=1
else
  echo "Could not read Cloud Run SA for $API_SERVICE in $GCP_REGION."
  SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
  USE_RUNTIME=0
  echo "Will create/use dev service account: $SA_EMAIL"
fi

if [[ -z "${GCS_BUCKET:-}" ]]; then
  echo ""
  echo "Buckets in project (pick one for GCS_BUCKET):"
  gcloud storage buckets list --project="$PROJECT" --format='value(name)' 2>/dev/null | head -20 || true
  echo ""
  read -r -p "GCS_BUCKET name: " GCS_BUCKET
fi
if [[ -z "$GCS_BUCKET" ]]; then
  echo "GCS_BUCKET is required."
  exit 1
fi
echo "Bucket: $GCS_BUCKET"

if [[ "$USE_RUNTIME" -eq 0 ]]; then
  if ! gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1; then
    echo "Creating service account $SA_NAME..."
    gcloud iam service-accounts create "$SA_NAME" \
      --project="$PROJECT" \
      --display-name="Title Analyzer local dev"
  fi
fi

echo "Granting Storage Object Admin on gs://$GCS_BUCKET ..."
gcloud storage buckets add-iam-policy-binding "gs://$GCS_BUCKET" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/storage.objectAdmin" \
  --project="$PROJECT" \
  --quiet

mkdir -p "$KEY_DIR"
KEY_PATH="$KEY_DIR/titlework-gcs.json"
if [[ -f "$KEY_PATH" ]]; then
  read -r -p "Key file exists ($KEY_PATH). Overwrite? [y/N] " ans
  if [[ "${ans,,}" != "y" ]]; then
    echo "Keeping existing key."
  else
    gcloud iam service-accounts keys create "$KEY_PATH" \
      --iam-account="$SA_EMAIL" \
      --project="$PROJECT"
  fi
else
  gcloud iam service-accounts keys create "$KEY_PATH" \
    --iam-account="$SA_EMAIL" \
    --project="$PROJECT"
fi
chmod 600 "$KEY_PATH"
echo "Wrote key: $KEY_PATH"

upsert_env() {
  local key="$1"
  local value="$2"
  local file="$3"
  touch "$file"
  if grep -q "^export ${key}=" "$file" 2>/dev/null; then
    if [[ "$(uname -s)" == "Darwin" ]]; then
      sed -i '' "s|^export ${key}=.*|export ${key}='${value}'|" "$file"
    else
      sed -i "s|^export ${key}=.*|export ${key}='${value}'|" "$file"
    fi
  else
    printf "export %s='%s'\n" "$key" "$value" >>"$file"
  fi
}

upsert_env GOOGLE_APPLICATION_CREDENTIALS "$KEY_PATH" "$ENV_FILE"
upsert_env GCS_BUCKET "$GCS_BUCKET" "$ENV_FILE"
echo "Updated $ENV_FILE"

echo ""
echo "=== Next steps ==="
echo "  source $ENV_FILE"
echo "  npm start"
echo ""
echo "Test (server running, replace YOUR_APP_PASSWORD):"
echo "  curl -s -H 'x-app-password: YOUR_APP_PASSWORD' http://127.0.0.1:8080/api/blob/upload"
echo ""
echo "Start a NEW job in the browser. You should NOT see client_email signing errors."
