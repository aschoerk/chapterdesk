#!/usr/bin/env bash
set -euo pipefail

PROJECT=chapterly-508015
REGION=europe-west4
SERVICE=chapterly

# Firebase persistence uses Cloud Firestore and the Cloud Run runtime identity.
gcloud services enable firestore.googleapis.com --project="$PROJECT" --quiet
gcloud firestore databases describe --database='(default)' --project="$PROJECT" >/dev/null
# The Cloud Run runtime service account needs roles/datastore.user on this project.
# Grant each invited viewer roles/run.invoker on the service; do not make it public.
gcloud run deploy "$SERVICE" \
                --source . \
                --project="$PROJECT" \
                --region="$REGION" \
                --allow-unauthenticated \
                --memory 512Mi \
                --max-instances 1 \
                --clear-secrets \
                --set-env-vars NODE_ENV=production,PERSISTENCE=firebase,FIREBASE_PROJECT_ID="$PROJECT"
