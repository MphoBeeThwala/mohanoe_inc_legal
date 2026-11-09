# Disaster recovery

Targets: RPO ≤ 15 minutes, RTO ≤ 4 hours. Client data stays in South Africa: primary **South Africa North**, recovery **South Africa West**.

| Component | Protection | Recovery |
|---|---|---|
| PostgreSQL | Zone-redundant HA (prod), PITR 35 days, geo-redundant backups | Zone failure: automatic. Region loss: `az postgres flexible-server geo-restore` into South Africa West |
| Documents, audit anchors | RA-GZRS (prod), versioning, soft delete, immutable anchor container | Region loss: `az storage account failover` (read access to the secondary meanwhile) |
| Keys and secrets | Key Vault Premium (HSM keys), soft delete + purge protection; Microsoft replicates vault contents to the paired region | Read-only during regional failover; restore from soft delete if deleted |
| API and jobs | Container Apps across zones, 2+ replicas | Region loss: `terraform apply` with `location = "southafricawest"` into a recovery resource group, then deploy the last image |
| Edge | Front Door (global) | Point the origin at the recovery API |

## Region loss: order of work
1. Declare a P1 incident; update the status page.
2. Geo-restore PostgreSQL into South Africa West; fail over the storage account.
3. Apply Terraform for a recovery environment in South Africa West (`location`, a new name suffix) using the restored server's address for `database-url` and the failed-over storage account.
4. Deploy the last released image; run `ops restore-check`.
5. Switch the Front Door origin to the recovery API; confirm `/ready` and a sign-in.
6. Tell firms what happened and the restore point (data written after it may need re-entry).
7. Fail back in a planned window once South Africa North is healthy.

Practise steps 2–5 once a year in staging.
