#!/usr/bin/env bash
set -euo pipefail

PROJECT=chapterly-508015
REGION=europe-west4
SERVICE=chapterly

# Grant each invited viewer roles/run.invoker on the service; do not make it public.
gcloud run deploy "$SERVICE" \
                --source . \
                --project="$PROJECT" \
                --region="$REGION" \
                --allow-unauthenticated \
                --memory 512Mi \
                --max-instances 1 \
                --clear-secrets \
                --set-env-vars NODE_ENV=production,CHAPTERDESK_RUNTIME=gcloud,PERSISTENCE=memory
