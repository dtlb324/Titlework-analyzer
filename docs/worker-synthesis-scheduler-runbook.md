# Worker Synthesis Scheduler — Setup Runbook

One-time setup so the scale-to-zero worker finishes synthesis for jobs whose
browser tab has closed. Run **after** a release that includes the worker
`POST /internal/drain` endpoint.

```bash
PROJECT=titlework-analyzer
REGION=us-south1
WORKER=titlework-analyzer-worker
WORKER_URL=https://titlework-analyzer-worker-rqpu63u5tq-vp.a.run.app
SA=synthesis-scheduler@${PROJECT}.iam.gserviceaccount.com

# 1. Service account that Cloud Scheduler uses to invoke the worker
gcloud iam service-accounts create synthesis-scheduler \
  --project "$PROJECT" --display-name "Synthesis worker scheduler"

# 2. Allow it to invoke the (private) worker service
gcloud run services add-iam-policy-binding "$WORKER" \
  --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:${SA}" --role roles/run.invoker

# 3. Cloud Scheduler job: POST /internal/drain every minute with an OIDC token.
#    NOTE: --location must be a Cloud Scheduler-supported region. If us-south1
#    is unsupported, run `gcloud scheduler locations list` and pick the nearest.
gcloud scheduler jobs create http synthesis-drain \
  --project "$PROJECT" --location "$REGION" \
  --schedule "* * * * *" \
  --uri "${WORKER_URL}/internal/drain" --http-method POST \
  --oidc-service-account-email "$SA" \
  --oidc-token-audience "$WORKER_URL"
```

## Smoke test (after deploy)

```bash
curl -s -X POST \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "${WORKER_URL}/internal/drain"
# Expect: {"ok":true,...}  (your account needs roles/run.invoker on the worker)
```

## Rollout order

1. Deploy a release that includes the worker `/internal/drain` endpoint.
2. Run steps 1–3 above.
3. Confirm with the smoke test.

If the scheduler is paused or deleted, synthesis simply reverts to today's
browser-driven behavior (the tab must stay open) — no breakage.

## How it works

- Cloud Scheduler `POST`s `/internal/drain` every minute. The worker runs one
  bounded drain (`runWorkerDrain` → `runWorkerLoop` with `maxIdleCycles: 1`),
  processing all runnable synthesis jobs, then the instance scales back to zero.
- The browser still drives synthesis while its tab is open. The merge lease
  (`claimSynthesisMerge`) serializes the two, so only one runs the merge at a
  time — both-drivers is conflict-free.
- The worker service is already deployed with `--timeout 3600 --min-instances 0
  --no-cpu-throttling`, so no `release.yml` change is needed for this feature.
