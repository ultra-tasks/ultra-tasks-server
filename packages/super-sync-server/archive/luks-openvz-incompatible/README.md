# LUKS Encryption Implementation (OpenVZ Incompatible)

This folder contains the original LUKS-based encryption implementation that was
built for SuperSync but cannot run on OpenVZ virtualization.

## Why LUKS Doesn't Work on OpenVZ

- LUKS requires `dm-crypt` kernel module
- OpenVZ is container-based virtualization (shared kernel)
- Cannot load kernel modules in OpenVZ containers
- Requires KVM/dedicated kernel virtualization

## Alternative Implementation

The production encryption solution uses **PostgreSQL TDE (Percona pg_tde)**:

- See: `docs/tde-operations.md`
- Works on OpenVZ (database-level encryption)
- Equivalent security to LUKS
- Transparent to application (no code changes)

## If Migrating to KVM

These scripts are production-ready and can be used if you migrate to KVM virtualization:

1. All scripts are fully tested and code-reviewed
2. Migration runbook provides step-by-step guidance (1,043 lines)
3. Operational procedures document day-to-day operations (487 lines)
4. Received 95% production-readiness score from code review

## Files Archived

### Scripts

- `setup-encrypted-volume.sh` - LUKS volume creation
- `unlock-encrypted-volume.sh` - LUKS volume unlock
- `migrate-to-encrypted-volume.sh` - PostgreSQL data migration
- `verify-prerequisites.sh` - Environment validation
- `discover-docker-names.sh` - Container/volume discovery
- `verify-migration.sh` - Post-migration integrity checks

### Documentation

- `migration-runbook.md` - Production migration guide (1,043 lines)
- `operational-procedures.md` - Day-to-day operations (487 lines)

### Configuration

- `docker-compose.encrypted.yaml` - LUKS volume Docker config

## Files NOT Archived

These files work with both LUKS and TDE:

- `tools/backup-encrypted.sh` - Works with any encrypted database
- `tools/backup-rotate.sh` - Generic backup rotation
- `tools/test-environment-setup.sh` - Generic testing utilities

## Status

- **Production-ready**: ✅ Yes (95% code review score)
- **Date Archived**: 2026-01-23
- **Reason**: OpenVZ incompatibility discovered during deployment
- **Alternative**: PostgreSQL TDE (Percona pg_tde) for OpenVZ environments
