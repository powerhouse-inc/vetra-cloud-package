# Prune stale `environment_pods` rows (one-off)

Until the watcher fix, the observability pod watcher upserted pods even on
`DELETED` events and reconcile never deleted anything, so `environment_pods`
kept every pod ever seen. On prod (2026-11-05) that was 250,759 rows for 525
live pods; 250,234 rows are stale, 88k of them `FAILED`, which made the
console show healthy services as failing.

After the fix ships, the 60s reconcile prunes stale rows of every namespace
that still exists. It never touches tenants it did not list, so rows of
namespaces that are gone entirely (1,077 tenants, ~6.1k rows on prod) stay
until this script runs. Running it right after the deploy is still worth it:
it does the whole backlog in one go instead of in the reconcile loop.

`scripts/prune-environment-pods.mts` reuses the reconcile code
(`reconcilePods` in `subgraphs/vetra-cloud-observability/pod-sync.ts`). It
lists all pods cluster-wide once, upserts them, and deletes every other row
of every tenant in the table. If the pod listing fails or comes back
paginated, it exits before touching the DB. Rows updated after the listing
started are kept, so it is safe to run while the switchboard watcher is live.

## Prerequisites

- kubeconfig for the prod cluster (`--context` picks a context; the default
  is the current one). Needs `list pods` and `list namespaces` cluster-wide.
- Network access to the prod Postgres. Connect to `vetra-pg-ro` (dry run) or
  `vetra-pg-rw` (real run) directly, **not** the pooler: PgBouncer rejects
  the `options` startup parameter that makes the dry-run connection
  read-only.
- Run from a checkout of this repo with `pnpm install` done (Node >= 22.6).

## Steps

```sh
# 1. Credentials (app user of the vetra_db cluster)
export PGUSER=$(kubectl get secret -n vetra vetra-pg-app -o jsonpath='{.data.user}' | base64 -d)
export PGPASS=$(kubectl get secret -n vetra vetra-pg-app -o jsonpath='{.data.password}' | base64 -d)
ENC_PASS=$(node -e 'process.stdout.write(encodeURIComponent(process.env.PGPASS))')

# 2. Dry run against the read-only replica: prints stale rows per tenant.
kubectl port-forward -n vetra svc/vetra-pg-ro 15432:5432 &
DATABASE_URL="postgres://$PGUSER:$ENC_PASS@127.0.0.1:15432/vetra_db?sslmode=disable" \
  node --experimental-strip-types scripts/prune-environment-pods.mts --dry-run
kill %1

# 3. Real run against the primary.
kubectl port-forward -n vetra svc/vetra-pg-rw 15432:5432 &
DATABASE_URL="postgres://$PGUSER:$ENC_PASS@127.0.0.1:15432/vetra_db?sslmode=disable" \
  node --experimental-strip-types scripts/prune-environment-pods.mts
kill %1
```

The schema is auto-detected (the subgraph namespace schema holding
`environment_pods`; on prod it is `jziufckkaz`). Pass `--schema <name>` if
more than one schema has the table, e.g. on a shared staging DB.

The output lists stale rows per tenant, tagged `(namespace gone)` where the
namespace no longer exists, then totals.

## Verify

```sh
kubectl exec -n vetra vetra-pg-1 -c postgres -- psql -U postgres -d vetra_db -Atc \
  "BEGIN READ ONLY; select count(*), count(distinct \"tenantId\") from jziufckkaz.environment_pods; ROLLBACK;"
kubectl get pods -A --no-headers | wc -l   # should roughly match the row count
```

Deleting ~250k rows leaves dead tuples. Autovacuum handles it; to reclaim at
once, run `VACUUM (ANALYZE) jziufckkaz.environment_pods;` as `postgres`.

## SQL alternative (only if the script cannot be run)

Prefer the script: it compares against the live pod list, and SQL cannot.
The only safe SQL-only cleanup covers tenants whose namespace is gone.
Build the namespace list from `kubectl get ns -o name | sed 's#namespace/##'`
and paste it in:

```sql
BEGIN;
DELETE FROM jziufckkaz.environment_pods
 WHERE "tenantId" NOT IN ( /* 'ns-a', 'ns-b', ... every live namespace */ );
-- check the reported row count, then COMMIT (or ROLLBACK)
```
