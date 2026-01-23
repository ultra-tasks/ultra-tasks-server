# TDE Migration Guide

## Overview

This guide walks through migrating SuperSync from unencrypted PostgreSQL 16 to encrypted PostgreSQL 17 with TDE (Transparent Data Encryption).

**Migration strategy:** Two-step process

1. **Step 1:** Upgrade PostgreSQL 16 → 17 (without TDE)
2. **Step 2:** Enable TDE on PostgreSQL 17

This isolates potential issues:

- If PG upgrade fails → rollback to PG 16
- If TDE setup fails → rollback to unencrypted PG 17
- Lower risk than doing both at once

**Time estimate:** 2-3 hours (includes testing)

---

## Prerequisites

Before starting, ensure:

- [ ] Root/sudo access to server
- [ ] At least 2x database size free disk space (for backups)
- [ ] Backup passphrase configured (`/run/secrets/backup_passphrase`)
- [ ] Recent backup created (`./tools/backup-encrypted.sh`)
- [ ] Maintenance window scheduled (database will be briefly unavailable)

---

## Migration Procedure

### Phase 0: Preparation (15 minutes)

```bash
# 1. Navigate to super-sync-server directory
cd /path/to/super-productivity/packages/super-sync-server

# 2. Verify current PostgreSQL version
docker exec supersync-postgres psql -U supersync -t -c "SELECT version();"
# Should show: PostgreSQL 16.x

# 3. Create pre-migration backup
sudo ./tools/backup-encrypted.sh
# Note the backup filename for rollback

# 4. Document current row counts (for verification)
docker exec supersync-postgres psql -U supersync supersync -c "
  SELECT 'operations' AS table, COUNT(*) FROM operations
  UNION ALL SELECT 'users', COUNT(*) FROM users
  UNION ALL SELECT 'user_sync_state', COUNT(*) FROM user_sync_state;
"
# Save this output

# 5. Stop non-essential services (optional, reduces load)
docker compose stop caddy  # Or your reverse proxy
```

---

### Phase 1: PostgreSQL 16 → 17 Upgrade (30-45 minutes)

```bash
# 1. Run upgrade script
sudo ./tools/upgrade-postgres-17.sh
# This will:
#   - Backup PG 16 database
#   - Stop PG 16
#   - Start PG 17 (Percona, without TDE)
#   - Restore data
#   - Verify row counts

# 2. Verify upgrade successful
docker exec supersync-postgres psql -U supersync -t -c "SELECT version();"
# Should show: PostgreSQL 17.x (Percona)

# 3. Test SuperSync application
docker compose restart supersync
curl http://localhost:1900/health
# Should return: {"status":"ok"}

# 4. Test login and sync (manually in browser/app)
# - Log in to SuperSync
# - Create a test task
# - Verify sync works
# - Delete test task

# 5. If everything works, make PG 17 permanent
# Edit docker-compose.yml:
#   Change: image: postgres:16-alpine
#   To:     image: percona/percona-postgresql:17

# 6. Restart to verify permanent config
docker compose restart postgres
```

**If issues found:** Rollback to PG 16 (see Rollback section)

---

### Phase 2: TDE Setup (30-45 minutes)

```bash
# 1. Create TDE master key
sudo ./tools/setup-tde.sh
# Enter a strong passphrase (20+ characters)
# CONFIRM passphrase (prevents typos)
# BACKUP encrypted key file (as instructed)

# 2. Unlock TDE for migration
sudo ./tools/unlock-tde.sh
# Enter the passphrase you just created

# 3. Verify master key accessible
sudo ls -lh /run/secrets/pg_tde_master_key
# Should show: -rw------- 1 root root 64 Jan 23 15:00 ...

# 4. Stop PostgreSQL 17
docker compose stop postgres

# 5. Start PostgreSQL 17 with TDE configuration
docker compose -f docker-compose.yml -f docker-compose.tde.yml up -d postgres

# 6. Wait for PostgreSQL to be ready
docker compose logs -f postgres
# Wait for: "database system is ready to accept connections"
# Press Ctrl+C to stop following logs

# 7. Run TDE migration
sudo ./tools/migrate-to-tde.sh
# This will:
#   - Backup unencrypted PG 17 database
#   - Install pg_tde extension
#   - Configure key provider (file-vault)
#   - Create encrypted database (supersync_encrypted)
#   - Migrate data
#   - Verify encryption
#   - Prompt you to update .env file

# 8. Update .env file (as prompted)
# Change: POSTGRES_DB=supersync
# To:     POSTGRES_DB=supersync_encrypted

# 9. Restart SuperSync
docker compose restart supersync
```

---

### Phase 3: Verification (15-30 minutes)

```bash
# 1. Verify TDE encryption
sudo ./tools/verify-tde.sh
# Should show: "Passed: 7, Failed: 0, Warnings: 0"

# 2. Test SuperSync application
curl http://localhost:1900/health
# Should return: {"status":"ok"}

# 3. Test all major features:
# - Log in
# - Create task
# - Edit task
# - Sync to mobile/desktop
# - Archive task
# - Restore from archive
# - Delete task

# 4. Verify row counts match pre-migration
docker exec supersync-postgres psql -U supersync supersync_encrypted -c "
  SELECT 'operations' AS table, COUNT(*) FROM operations
  UNION ALL SELECT 'users', COUNT(*) FROM users
  UNION ALL SELECT 'user_sync_state', COUNT(*) FROM user_sync_state;
"
# Compare with Phase 0 step 4 output

# 5. Create post-migration backup
sudo ./tools/backup-encrypted.sh
# Verify backup created successfully

# 6. Test backup restore (on test database, optional but recommended)
# See docs/tde-operations.md for restore procedure
```

---

### Phase 4: Cleanup (10 minutes)

```bash
# 1. After 1 week of successful operation, remove old unencrypted database
docker exec supersync-postgres psql -U supersync -c "DROP DATABASE supersync;"

# 2. Update docker-compose.yml to use TDE by default
# Change services.postgres section to reference docker-compose.tde.yml
# Or merge docker-compose.tde.yml into docker-compose.yml

# 3. Remove temporary files
rm /tmp/docker-compose.pg17-no-tde.yml

# 4. Restart non-essential services
docker compose start caddy  # Or your reverse proxy

# 5. Document the change
echo "$(date): Migrated to PostgreSQL 17 with TDE" >> /var/log/supersync-changes.log
```

---

## Rollback Procedures

### Rollback from PostgreSQL 17 to PostgreSQL 16

**When:** PG 17 upgrade failed or causes issues (BEFORE TDE migration)

```bash
# 1. Stop PostgreSQL 17
docker compose stop postgres
docker compose rm -f postgres

# 2. Remove temporary PG 17 config
rm /tmp/docker-compose.pg17-no-tde.yml

# 3. Start PostgreSQL 16 (from original config)
docker compose up -d postgres

# 4. Restore data from pre-upgrade backup
BACKUP_FILE="/var/backups/supersync/pre-pg17-upgrade-YYYYMMDD-HHMMSS.sql"
docker exec -i supersync-postgres psql -U supersync supersync < "$BACKUP_FILE"

# 5. Verify data restored
docker exec supersync-postgres psql -U supersync supersync -c "SELECT COUNT(*) FROM operations;"

# 6. Restart SuperSync
docker compose restart supersync
```

---

### Rollback from TDE to unencrypted PostgreSQL 17

**When:** TDE migration failed or causes issues (AFTER PG 17 upgrade)

```bash
# 1. Update .env to use unencrypted database
# Change: POSTGRES_DB=supersync_encrypted
# To:     POSTGRES_DB=supersync

# 2. Restart SuperSync
docker compose restart supersync

# 3. Verify application works with unencrypted database
curl http://localhost:1900/health

# 4. If you need to restore from backup:
BACKUP_FILE="/var/backups/supersync/pre-tde-migration-YYYYMMDD-HHMMSS.sql"
docker exec -i supersync-postgres psql -U supersync supersync < "$BACKUP_FILE"

# 5. Remove TDE configuration (optional)
docker compose stop postgres
docker compose up -d postgres  # Without -f docker-compose.tde.yml
```

---

## Post-Migration Checklist

After successful migration, verify:

- [ ] PostgreSQL 17 running
- [ ] TDE encryption enabled (`sudo ./tools/verify-tde.sh` passes)
- [ ] SuperSync health check passes
- [ ] All features working (tasks, sync, archive)
- [ ] Row counts match pre-migration
- [ ] Encrypted backups working (`sudo ./tools/backup-encrypted.sh`)
- [ ] Unlock procedure documented (after reboot: `sudo ./tools/unlock-tde.sh`)
- [ ] Master key backed up in 2+ locations
- [ ] Passphrase stored in password manager + physical safe
- [ ] Monitoring configured (see docs/tde-operations.md)

---

## Common Issues

### Issue: "pg_tde extension not found"

**Solution:**

```bash
# Verify shared_preload_libraries set
docker exec supersync-postgres psql -U supersync -c "SHOW shared_preload_libraries;"
# Should include: pg_tde

# If missing, check docker-compose.tde.yml command section
# Restart with TDE config:
docker compose -f docker-compose.yml -f docker-compose.tde.yml restart postgres
```

---

### Issue: "Master key not accessible"

**Solution:**

```bash
# Unlock TDE
sudo ./tools/unlock-tde.sh

# Verify key accessible
sudo ls -lh /run/secrets/pg_tde_master_key

# Check docker mount
docker exec supersync-postgres ls -lh /run/secrets/pg_tde_master_key
```

---

### Issue: "Row count mismatch after migration"

**Solution:**

```bash
# Compare detailed counts
docker exec supersync-postgres psql -U supersync supersync_encrypted -c "
  SELECT schemaname, tablename, n_live_tup
  FROM pg_stat_user_tables
  ORDER BY schemaname, tablename;
"

# If discrepancy found, restore from backup
BACKUP_FILE="/var/backups/supersync/pre-tde-migration-YYYYMMDD-HHMMSS.sql"
docker exec -i supersync-postgres psql -U supersync supersync_encrypted < "$BACKUP_FILE"
```

---

## Timeline

**Total time:** 2-3 hours

| Phase                 | Duration  | Can rollback?              |
| --------------------- | --------- | -------------------------- |
| Phase 0: Preparation  | 15 min    | Yes (no changes yet)       |
| Phase 1: PG 16→17     | 30-45 min | Yes (to PG 16)             |
| Phase 2: TDE Setup    | 30-45 min | Yes (to unencrypted PG 17) |
| Phase 3: Verification | 15-30 min | Yes (to unencrypted PG 17) |
| Phase 4: Cleanup      | 10 min    | No (old DB deleted)        |

**Recommendation:** Schedule 4-hour maintenance window to allow for testing and rollback if needed.

---

## Next Steps

After successful migration:

1. **Read operational procedures:** `cat docs/tde-operations.md`
2. **Test unlock procedure:** Reboot server, run `sudo ./tools/unlock-tde.sh`, start PostgreSQL
3. **Schedule key rotation:** Add to calendar (annually)
4. **Configure monitoring:** Set up alerts for TDE status
5. **Test backup restore:** Verify you can restore from encrypted backups
6. **Update runbooks:** Document TDE unlock in your startup procedures

---

## Support

For issues during migration:

1. Check this guide's Common Issues section
2. Review `/var/backups/supersync/` for backup files
3. Check PostgreSQL logs: `docker compose logs postgres`
4. Verify TDE status: `sudo ./tools/verify-tde.sh`
5. See detailed troubleshooting: `docs/tde-operations.md`
