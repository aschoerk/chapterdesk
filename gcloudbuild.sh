#!/usr/bin/env bash
set -euo pipefail

PROJECT=chapterly-508015
REGION=europe-west4
SERVICE=chapterdesk

# Grant each invited viewer roles/run.invoker on the service; do not make it public.
# gcloud run deploy "$SERVICE" \
#                --source . \
#                --project="$PROJECT" \
#                --region="$REGION" \
#                --allow-unauthenticated \
#                --memory 512Mi \
#                --max-instances 1 \
#                --clear-secrets \
#                --set-env-vars NODE_ENV=production,CHAPTERDESK_RUNTIME=gcloud,PERSISTENCE=memory
#


PROJECT=chapterly-508015
REGION=europe-west4
SERVICE=chapterdesk
SA=chapterdesk

# 1. Dedizierten Service Account anlegen (einmalig)
# gcloud iam service-accounts create $SA \
#   --display-name="Chapterdesk Cloud Run SA" \
#   --project=$PROJECT

# 2. Minimal berechtigen (nur falls Secret Manager genutzt wird – sonst weglassen)
# gcloud projects add-iam-policy-binding $PROJECT \
#   --member="serviceAccount:${SA}@${PROJECT}.iam.gserviceaccount.com" \
#   --role="roles/secretmanager.secretAccessor"

# 3. Deploy mit eigenem SA + öffentlich
gcloud run deploy $SERVICE \
  --source . \
  --project=$PROJECT \
  --region=$REGION \
  --service-account=${SA}@${PROJECT}.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --memory 512Mi \
  --max-instances 1 \
  --clear-secrets \
  --set-env-vars NODE_ENV=production,CHAPTERDESK_RUNTIME=gcloud,PERSISTENCE=memory
