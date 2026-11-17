# Email reminder trigger (Issue #29)

The server has no scheduler. An external cron calls one authenticated endpoint about every 5 minutes. Calls are replay-safe (a durable ledger prevents duplicate sends), so retries and overlapping schedules are harmless.

Required server env: `EMAIL_REMINDER_CRON_SECRET` (32+ random characters, e.g. `openssl rand -hex 32`), at least one provider (`SMTP_*` or `BREVO_API_KEY`), `EMAIL_FROM`.

## Command

```bash
curl -fsS --max-time 60 --retry 2 --retry-delay 10 \
  -X POST "$HALOTASK_API_URL/api/internal/email-reminders/run" \
  -H "Authorization: Bearer $EMAIL_REMINDER_CRON_SECRET"
```

`--max-time` and `--retry` cover a sleeping Render instance. A 409 means a run is in progress; 503 means no provider is configured; 404 means the secret is not set on the server.

## GitHub Actions example

```yaml
name: email-reminders
on:
  schedule: [{ cron: "*/5 * * * *" }]   # may be delayed by GitHub
  workflow_dispatch:
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: >
          curl -fsS --max-time 60 --retry 2 --retry-delay 10 -X POST
          "${{ secrets.HALOTASK_API_URL }}/api/internal/email-reminders/run"
          -H "Authorization: Bearer ${{ secrets.EMAIL_REMINDER_CRON_SECRET }}"
```

A Render Cron Job running the same `curl` works equally well. Keep the secret in the scheduler's secret store only. The response is counts only (no addresses or titles).
