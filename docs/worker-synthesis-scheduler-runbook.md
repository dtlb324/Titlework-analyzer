# Worker Synthesis Scheduler — Setup Runbook

One-time setup so the scale-to-zero worker finishes synthesis for jobs whose
browser tab has closed. Run **after** a release that includes the worker
`POST /internal/drain` endpoint.

```bash
PROJECT=titlework-analyzer
REGION=us-south1            # worker's Cloud Run region
SCHED_LOCATION=us-central1  # Cloud Scheduler region (us-south1 is NOT a scheduler region)
WORKER=titlework-analyzer-worker
WORKER_URL=https://titlework-analyzer-worker-rqpu63u5tq-vp.a.run.app
SA=synthesis-scheduler@${PROJECT}.iam.gserviceaccount.com

# 0. Enable the Cloud Scheduler API (was not enabled on this project)
gcloud services enable cloudscheduler.googleapis.com --project "$PROJECT"

# 1. Service account that Cloud Scheduler uses to invoke the worker
gcloud iam service-accounts create synthesis-scheduler \
  --project "$PROJECT" --display-name "Synthesis worker scheduler"

# 2. Allow it to invoke the (private) worker service.
#    The SA can take ~1 min to propagate; if this errors with "does not exist", retry.
gcloud run services add-iam-policy-binding "$WORKER" \
  --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:${SA}" --role roles/run.invoker

# 3. Cloud Scheduler job: POST /internal/drain every minute with an OIDC token.
#    --location must be a Cloud Scheduler region (`gcloud scheduler locations list`);
#    us-south1 is not one, so us-central1 is used (region is functionally irrelevant —
#    the job just makes an HTTPS call to the worker URL).
#    --attempt-deadline 1800s lets the scheduler wait for a real (long) merge instead
#    of cutting the connection at the default 180s and aborting the drain mid-merge.
gcloud scheduler jobs create http synthesis-drain \
  --project "$PROJECT" --location "$SCHED_LOCATION" \
  --schedule "* * * * *" --attempt-deadline 1800s \
  --uri "${WORKER_URL}/internal/drain" --http-method POST \
  --oidc-service-account-email "$SA" \
  --oidc-token-audience "$WORKER_URL"
```

## Rollout order

1. Deploy a release that includes **both** the worker `/internal/drain` endpoint
   **and** the runnable-query hardening (exclude abstraction-incomplete jobs from
   `listRunnableSynthesisJobIds`). Without the hardening, the drain churns on
   abandoned jobs whose abstraction never finished.
2. Run steps 0–3 above. If the job already exists, update it instead of creating:
   `gcloud scheduler jobs update http synthesis-drain --project "$PROJECT" --location "$SCHED_LOCATION" --attempt-deadline 1800s`
3. If the job was paused during setup, resume it:
   `gcloud scheduler jobs resume synthesis-drain --project "$PROJECT" --location "$SCHED_LOCATION"`

## Validate (after deploy + resume)

```bash
# (a) No churn: abstraction-incomplete jobs should NOT enter the drain.
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="titlework-analyzer-worker" AND jsonPayload.event="worker_synthesis_error" AND jsonPayload.reason:"abstraction chunks"' \
  --project "$PROJECT" --freshness=5m --limit 5
# Expect: empty.

# (b) Scheduler attempts succeed (idle drains return fast; no DEADLINE_EXCEEDED on an idle system).
gcloud logging read 'resource.type="cloud_scheduler_job" AND resource.labels.job_id="synthesis-drain"' \
  --project "$PROJECT" --freshness=5m --limit 3 --format="value(jsonPayload.status)"
```

If the scheduler is paused or deleted, synthesis simply reverts to today's
browser-driven behavior (the tab must stay open) — no breakage.

## How it works

- Cloud Scheduler `POST`s `/internal/drain` every minute. The worker runs one
  bounded drain (`runWorkerDrain` → `runWorkerLoop` with `maxIdleCycles: 1`),
  processing all runnable work — synthesis plus any runnable abstraction — then
  the instance scales back to zero. The drain is time-bounded (default 25 min,
  under the 3600s timeout); a job that needs longer simply resumes on the next
  tick, which the lease makes safe.
- The browser still drives synthesis while its tab is open. The merge lease
  (`claimSynthesisMerge`) serializes the two, so only one runs the merge at a
  time — both-drivers is conflict-free.
- The worker service is already deployed with `--timeout 3600 --min-instances 0
  --no-cpu-throttling`, so no `release.yml` change is needed for this feature.
