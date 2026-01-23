# PostgreSQL TDE Operations Guide

## Overview

This guide covers day-to-day operations for SuperSync with PostgreSQL TDE (Transparent Data Encryption) using Percona pg_tde extension.

**Security Model:**

- Database files encrypted with AES-128-GCM
- WAL (transaction logs) encrypted with AES-128-CTR
- Master encryption key protected by passphrase
- Decrypted key stored in memory-only tmpfs (cleared on reboot)
- Similar to LUKS: requires passphrase to unlock after reboot

**Requirements:**

- PostgreSQL 17+ (Percona distribution)
- pg_tde extension installed
- Master key created and backed up
- Passphrase stored securely

---

## Starting the Server

### After Reboot

TDE requires manual unlock after each server reboot. This is intentional security: the master key is never stored unencrypted on disk.

**Procedure:**

```bash
# 1. Unlock TDE by decrypting master key to tmpfs
sudo ./tools/unlock-tde.sh
# Enter master key passphrase when prompted

# 2. Start PostgreSQL with TDE configuration
docker compose -f docker-compose.yml -f docker-compose.tde.yml up -d postgres

# 3. Wait for PostgreSQL to be ready
docker compose logs -f postgres
# Look for: "database system is ready to accept connections"

# 4. Start SuperSync application
docker compose up -d supersync

# 5. Verify TDE is working
sudo ./tools/verify-tde.sh
```

**Time estimate:** 1-2 minutes (passphrase entry + startup)

### Automated Startup (NOT RECOMMENDED)

You can automate the unlock process, but this reduces security:

```bash
# Store passphrase in file (encrypted at rest with disk encryption)
echo "your-passphrase" > /root/.tde_passphrase
chmod 600 /root/.tde_passphrase

# Modify unlock-tde.sh to read passphrase from file
openssl enc -d -aes-256-cbc -pbkdf2 -iter 1000000 \
  -in /var/lib/supersync/pg_tde_master_key.enc \
  -out /run/secrets/pg_tde_master_key \
  -pass file:/root/.tde_passphrase
```

**Security trade-off:** Anyone with root access can read the passphrase file. Only use if you have full-disk encryption (e.g., moved to KVM with LUKS).

---

## Verifying Encryption Status

### Quick Check

```bash
sudo ./tools/verify-tde.sh
```

This runs 7 tests:

1. Database encryption status (`pg_tde_is_encrypted`)
2. WAL encryption enabled
3. Extension loading configuration
4. Data file encryption (hexdump check)
5. Query functionality
6. Key provider configuration
7. Master key accessibility

**Expected output:**

```
Passed: 7
Failed: 0
Warnings: 0

✓ TDE verification successful!
```

### Manual Verification

```bash
# Check if database is encrypted
docker exec supersync-postgres psql -U supersync supersync_encrypted -c "
  SELECT pg_tde_is_encrypted(oid)
  FROM pg_database
  WHERE datname = 'supersync_encrypted';
"
# Should return: t (true)

# Check WAL encryption
docker exec supersync-postgres psql -U supersync -c "
  SHOW pg_tde.wal_encrypt;
"
# Should return: on

# Inspect data files for plaintext
docker exec supersync-postgres sh -c "
  hexdump -C /var/lib/postgresql/data/base/*/16384 | head -20
"
# Should show random bytes, not readable text
```

---

## Key Rotation

### When to Rotate

Rotate encryption keys:

- **Annually** (compliance requirement for GDPR, HIPAA, PCI DSS)
- **After suspected key exposure** (compromised server, leaked backups)
- **Before/after staff changes** (least privilege principle)
- **When moving to new key provider** (e.g., file-vault → HashiCorp Vault)

### Rotation Procedure

**IMPORTANT:** Use `pg_tde_rotate_principal_key()`, NOT `pg_tde_rotate_key()` (which doesn't exist).

```bash
# 1. Generate new master key
openssl rand -hex 32 > /tmp/pg_tde_master_key_new.plain

# 2. Encrypt with passphrase
echo "Enter NEW passphrase for rotated key:"
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 1000000 \
  -in /tmp/pg_tde_master_key_new.plain \
  -out /var/lib/supersync/pg_tde_master_key_new.enc

# 3. Decrypt to tmpfs for rotation (temporary)
openssl enc -d -aes-256-cbc -pbkdf2 -iter 1000000 \
  -in /var/lib/supersync/pg_tde_master_key_new.enc \
  -out /run/secrets/pg_tde_master_key_new

# 4. Rotate principal key in PostgreSQL
docker exec supersync-postgres psql -U supersync supersync_encrypted -c "
  SELECT pg_tde_rotate_principal_key('supersync-master-key', '/run/secrets/pg_tde_master_key_new', 'file-vault');
"

# 5. Archive old key (DO NOT DELETE - needed for backups)
mv /var/lib/supersync/pg_tde_master_key.enc /var/lib/supersync/pg_tde_master_key.enc.$(date +%Y%m%d)

# 6. Activate new key
mv /var/lib/supersync/pg_tde_master_key_new.enc /var/lib/supersync/pg_tde_master_key.enc

# 7. Clean up temporary files
shred -u /tmp/pg_tde_master_key_new.plain /run/secrets/pg_tde_master_key_new

# 8. Restart PostgreSQL with new key
sudo ./tools/unlock-tde.sh
docker compose -f docker-compose.yml -f docker-compose.tde.yml restart postgres

# 9. Verify encryption still works
sudo ./tools/verify-tde.sh
```

### Key Archival

**CRITICAL:** Keep old keys to decrypt old backups!

```bash
# Archive old keys with date
mkdir -p /var/lib/supersync/archived-keys
cp /var/lib/supersync/pg_tde_master_key.enc.20260123 \
   /var/lib/supersync/archived-keys/

# Document which backups use which key
echo "2026-01-23: Rotated key, old key needed for backups before $(date)" >> \
  /var/lib/supersync/archived-keys/KEY_ROTATION_LOG.txt
```

**Retention policy:**

- Keep keys for as long as you keep backups (e.g., 90 days)
- After backup retention expires, securely delete old keys
- Store archived keys separately from active keys

---

## Backup and Recovery

### Backing Up Encrypted Database

Database backups (pg_dump) are **plaintext SQL**, then encrypted with a separate passphrase:

```bash
# Run backup script (same as before TDE)
./tools/backup-encrypted.sh
```

This creates:

```
/var/backups/supersync/supersync-20260123-140522.sql.gz.enc
```

**Backup contents:**

- SQL dump: Plaintext (decrypted) data
- Encrypted with: AES-256-CBC + PBKDF2 (backup passphrase)
- Independent from TDE master key

### Backing Up Master Key

**CRITICAL:** Backup the encrypted master key file AND passphrase separately!

```bash
# 1. Backup encrypted key file
cp /var/lib/supersync/pg_tde_master_key.enc ~/pg_tde_master_key.enc.backup

# 2. Store encrypted key in password manager
# - 1Password / Bitwarden: Attach file to secure note
# - Title: "SuperSync TDE Master Key (Encrypted)"

# 3. Store encrypted key on USB drive
cp /var/lib/supersync/pg_tde_master_key.enc /media/usb/
# Keep USB in physical safe or bank deposit box

# 4. Store passphrase SEPARATELY (never with encrypted key!)
# - Password manager: Create secure note "SuperSync TDE Passphrase"
# - Physical backup: Write on paper, store in safe (different from key)
```

**Why separate?**

- If password manager is compromised, attacker gets key OR passphrase (not both)
- If physical safe is stolen, attacker gets key OR passphrase (not both)
- Both must be compromised to decrypt data

### Restoring from Backup

**Scenario 1: Data corruption, TDE key intact**

```bash
# 1. Decrypt backup
./tools/backup-encrypted.sh restore supersync-20260123-140522.sql.gz.enc

# 2. Stop PostgreSQL
docker compose stop postgres

# 3. Restore database
docker exec -i supersync-postgres psql -U supersync supersync_encrypted < \
  /var/backups/supersync/supersync-20260123-140522.sql

# 4. Restart
docker compose start postgres
```

**Scenario 2: Lost TDE master key (catastrophic)**

```bash
# 1. Recover encrypted key from backup
cp ~/pg_tde_master_key.enc.backup /var/lib/supersync/pg_tde_master_key.enc

# 2. Unlock with passphrase (from password manager or paper backup)
sudo ./tools/unlock-tde.sh

# 3. Start PostgreSQL
docker compose -f docker-compose.yml -f docker-compose.tde.yml up -d postgres

# 4. Verify data accessible
docker exec supersync-postgres psql -U supersync supersync_encrypted -c "SELECT COUNT(*) FROM operations;"
```

**Scenario 3: Lost TDE key AND passphrase (unrecoverable)**

If both are lost, encrypted data is **permanently unrecoverable**. You must:

```bash
# 1. Restore from plaintext backup (if available)
./tools/backup-encrypted.sh restore supersync-20260123-140522.sql.gz.enc

# 2. Create new TDE key
sudo ./tools/setup-tde.sh

# 3. Re-encrypt database
sudo ./tools/migrate-to-tde.sh
```

**Data loss:** Any data created after last backup is lost.

---

## Monitoring

### Health Checks

Add to your monitoring system:

```bash
# Check TDE status (should return 't')
docker exec supersync-postgres psql -U supersync supersync_encrypted -t -c "
  SELECT pg_tde_is_encrypted(oid) FROM pg_database WHERE datname = 'supersync_encrypted';
" | tr -d '[:space:]'

# Check WAL encryption (should return 'on')
docker exec supersync-postgres psql -U supersync -t -c "
  SHOW pg_tde.wal_encrypt;
" | tr -d '[:space:]'

# Check master key accessible (should exit 0)
docker exec supersync-postgres test -r /run/secrets/pg_tde_master_key
```

### Alerts

Set up alerts for:

- **TDE unlocked = false** (after reboot, before manual unlock)
- **WAL encryption disabled** (config drift)
- **Master key not accessible** (file deleted, mount failed)
- **Backup failures** (encrypted backups not created)

Example (using Uptime Kuma / Prometheus):

```bash
# Create health check endpoint
curl http://localhost:1900/health/tde
# Returns 200 if TDE working, 500 if not
```

---

## Troubleshooting

### Issue: PostgreSQL won't start

**Symptoms:**

```
database system was not properly shut down
fatal: could not access file "/run/secrets/pg_tde_master_key": No such file or directory
```

**Cause:** TDE not unlocked after reboot

**Fix:**

```bash
sudo ./tools/unlock-tde.sh
docker compose -f docker-compose.yml -f docker-compose.tde.yml restart postgres
```

---

### Issue: "CREATE EXTENSION pg_tde" fails

**Symptoms:**

```
ERROR: could not load library "/usr/lib/postgresql/17/lib/pg_tde.so": cannot open shared object file: No such file or directory
```

**Cause:** `shared_preload_libraries` not set

**Fix:**

```bash
# Check current setting
docker exec supersync-postgres psql -U supersync -c "SHOW shared_preload_libraries;"

# If pg_tde missing, add to docker-compose.tde.yml:
#   command:
#     - postgres
#     - -c
#     - shared_preload_libraries=pg_tde

# Restart PostgreSQL
docker compose -f docker-compose.yml -f docker-compose.tde.yml restart postgres
```

---

### Issue: Database queries fail with "permission denied"

**Symptoms:**

```
ERROR: permission denied for table operations
```

**Cause:** Wrong database name (using unencrypted db name)

**Fix:**

```bash
# Check .env file
grep POSTGRES_DB .env
# Should be: POSTGRES_DB=supersync_encrypted (not supersync)

# Update and restart
docker compose restart supersync
```

---

### Issue: Backup fails with "pg_dump: error: connection to database failed"

**Symptoms:**

```
pg_dump: error: connection to server at "localhost", port 5432 failed: FATAL: the database system is starting up
```

**Cause:** PostgreSQL still starting (TDE adds ~5-10s startup time)

**Fix:**

```bash
# Wait for PostgreSQL to be fully ready
docker compose logs -f postgres | grep "ready to accept connections"

# Then run backup
./tools/backup-encrypted.sh
```

---

## Performance Impact

### Expected Overhead

- **Data encryption:** 5-10% CPU overhead
- **WAL encryption:** 2-5% additional overhead
- **Startup time:** +5-10 seconds (key loading)
- **Backup time:** No additional overhead (pg_dump is decrypted)

### Monitoring Performance

```bash
# Benchmark before and after TDE
docker exec supersync-postgres pgbench -i -s 10 supersync_encrypted
docker exec supersync-postgres pgbench -c 10 -j 2 -t 1000 supersync_encrypted

# Compare with historical benchmarks
# Expected: < 10% TPS reduction
```

### Optimization

If performance is degraded >10%:

1. **Check CPU has AES-NI** (hardware encryption acceleration)

   ```bash
   grep -o 'aes' /proc/cpuinfo | wc -l
   # Should return > 0 (number of CPU cores with AES-NI)
   ```

2. **Monitor CPU usage during queries**

   ```bash
   docker stats supersync-postgres
   # CPU should be <80% during normal load
   ```

3. **Check for swap usage** (indicates memory pressure)

   ```bash
   free -h
   # Swap should be mostly unused
   ```

4. **Tune PostgreSQL parameters**
   ```sql
   -- Increase shared_buffers if you have RAM
   ALTER SYSTEM SET shared_buffers = '256MB';  -- Default: 128MB
   ```

---

## Security Best Practices

### 1. Passphrase Management

- ✅ Use 20+ character passphrase (mix of letters, numbers, symbols)
- ✅ Store in password manager + physical safe (separately from key)
- ✅ Test passphrase recovery quarterly
- ✅ Rotate passphrase annually
- ❌ Never store passphrase in code, env files, or scripts
- ❌ Never store passphrase and encrypted key together

### 2. Key Storage

- ✅ Encrypted key on disk (useless without passphrase)
- ✅ Decrypted key in /run/secrets (tmpfs, root-only)
- ✅ Backup encrypted key in 2+ locations
- ✅ Archive old keys (needed for old backups)
- ❌ Never store decrypted key on disk
- ❌ Never commit keys to git

### 3. Access Control

- ✅ Limit root access (only trusted admins)
- ✅ Use sudo for unlock-tde.sh (audit log)
- ✅ Monitor /var/log/auth.log for sudo usage
- ❌ Don't automate unlock (reduces security)

### 4. Backup Strategy

- ✅ Encrypt database backups separately (backup passphrase)
- ✅ Test restore procedure monthly
- ✅ Store backups off-site (different from TDE key)
- ✅ Verify backup integrity (checksums)
- ❌ Don't store unencrypted backups

### 5. Compliance

For GDPR/HIPAA/PCI DSS:

- ✅ Enable audit logging (pgaudit extension)
- ✅ Rotate keys annually
- ✅ Document key access (who unlocked, when)
- ✅ Retain keys for backup retention period
- ✅ Securely delete old keys after retention expires

---

## Migration to HashiCorp Vault (Future)

For production environments, consider migrating from file-vault to HashiCorp Vault:

**Benefits:**

- Centralized key management
- Auto-rotation support
- Audit logging built-in
- Auto-unlock on server start (no manual passphrase)

**Migration procedure:** See `docs/tde-vault-migration.md` (TODO)

---

## References

- [Percona pg_tde Documentation](https://docs.percona.com/pg_tde/)
- [pg_tde Functions Reference](https://docs.percona.com/pg_tde/functions.html)
- [WAL Encryption Guide](https://percona.community/blog/2025/09/01/pg_tde-can-now-encrypt-your-wal-on-prod/)
- [Key Rotation Best Practices](https://forums.percona.com/t/key-rotation-management/39211)

---

## Support

For issues:

1. Check this guide's Troubleshooting section
2. Run `sudo ./tools/verify-tde.sh` for diagnostics
3. Check PostgreSQL logs: `docker compose logs postgres`
4. Check Percona documentation: https://docs.percona.com/pg_tde/
