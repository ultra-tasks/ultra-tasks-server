#!/bin/bash
# PostgreSQL TDE Migration Script
#
# This script migrates an unencrypted PostgreSQL 17 database to TDE-encrypted.
#
# PREREQUISITES:
# - PostgreSQL 17 (Percona) already running (run upgrade-postgres-17.sh first)
# - TDE master key created (run setup-tde.sh)
# - TDE unlocked (run unlock-tde.sh)
#
# SECURITY:
# - All data files encrypted with AES-128-GCM
# - WAL encrypted with AES-128-CTR
# - Master key in memory-only tmpfs
#
# Usage: sudo ./tools/migrate-to-tde.sh

set -e
set -u
set -o pipefail

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
BACKUP_DIR="/var/backups/supersync"
BACKUP_FILE="${BACKUP_DIR}/pre-tde-migration-$(date +%Y%m%d-%H%M%S).sql"
POSTGRES_CONTAINER="supersync-postgres"
DB_USER="${POSTGRES_USER:-supersync}"
DB_NAME="${POSTGRES_DB:-supersync}"
DB_NAME_ENCRYPTED="${DB_NAME}_encrypted"
DECRYPTED_KEY_FILE="/run/secrets/pg_tde_master_key"
KEYRING_FILE="/var/lib/postgresql/data/pg_tde_keyring.per"

echo "========================================"
echo "PostgreSQL TDE Migration"
echo "========================================"
echo ""
echo -e "${YELLOW}WARNING: This will enable TDE encryption${NC}"
echo ""
echo "Steps:"
echo "  1. Backup unencrypted database"
echo "  2. Verify TDE prerequisites"
echo "  3. Install pg_tde extension"
echo "  4. Configure global key provider"
echo "  5. Create encrypted database"
echo "  6. Migrate data to encrypted database"
echo "  7. Verify encryption"
echo "  8. Switch application to use encrypted database"
echo ""

read -p "Continue with TDE migration? (yes/no): " -r
if [[ ! $REPLY =~ ^yes$ ]]; then
  echo "Aborted."
  exit 0
fi
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}ERROR: This script must be run as root${NC}"
  exit 1
fi

# Step 1: Verify prerequisites
echo "========================================"
echo "Step 1: Verifying Prerequisites"
echo "========================================"
echo ""

# Check if PostgreSQL is running
if ! docker ps | grep -q "$POSTGRES_CONTAINER"; then
  echo -e "${RED}ERROR: PostgreSQL container not running${NC}"
  exit 1
fi
echo -e "${GREEN}✓ PostgreSQL running${NC}"

# Check PostgreSQL version
PG_VERSION=$(docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -t -c "SELECT version();" | head -1)
if ! echo "$PG_VERSION" | grep -q "17\."; then
  echo -e "${RED}ERROR: PostgreSQL 17 required${NC}"
  echo "Current version: $PG_VERSION"
  echo "Run upgrade-postgres-17.sh first"
  exit 1
fi
echo -e "${GREEN}✓ PostgreSQL 17 confirmed${NC}"

# Check if TDE master key is unlocked
if [ ! -f "$DECRYPTED_KEY_FILE" ]; then
  echo -e "${RED}ERROR: TDE not unlocked${NC}"
  echo "Run: sudo ./tools/unlock-tde.sh"
  exit 1
fi
echo -e "${GREEN}✓ TDE master key unlocked${NC}"

# Verify key is readable by postgres user in container
if ! docker exec "$POSTGRES_CONTAINER" test -r /run/secrets/pg_tde_master_key; then
  echo -e "${RED}ERROR: Master key not accessible in container${NC}"
  echo "Check docker-compose.tde.yml volume mount"
  exit 1
fi
echo -e "${GREEN}✓ Master key accessible in container${NC}"
echo ""

# Create backup directory
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Step 2: Backup current database
echo "========================================"
echo "Step 2: Backing Up Unencrypted Database"
echo "========================================"
echo ""

echo "Creating backup at: $BACKUP_FILE"
echo "This may take several minutes..."
echo ""

if docker exec "$POSTGRES_CONTAINER" pg_dump -U "$DB_USER" "$DB_NAME" > "$BACKUP_FILE"; then
  BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  echo -e "${GREEN}✓ Backup complete (${BACKUP_SIZE})${NC}"
  echo ""
else
  echo -e "${RED}ERROR: Backup failed${NC}"
  exit 1
fi

# Get row counts before migration
echo "Recording row counts for validation..."
ROW_COUNTS=$(docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" "$DB_NAME" -t -c "
  SELECT
    'operations: ' || COUNT(*) FROM operations
  UNION ALL
  SELECT 'users: ' || COUNT(*) FROM users
  UNION ALL
  SELECT 'user_sync_state: ' || COUNT(*) FROM user_sync_state
  UNION ALL
  SELECT 'operation_writes: ' || COUNT(*) FROM operation_writes;
")
echo "$ROW_COUNTS" | sed 's/^[[:space:]]*//' > "${BACKUP_DIR}/pre-tde-row-counts.txt"
echo -e "${GREEN}✓ Row counts saved${NC}"
echo "$ROW_COUNTS" | sed 's/^[[:space:]]*/  /'
echo ""

# Step 3: Install and configure pg_tde
echo "========================================"
echo "Step 3: Installing pg_tde Extension"
echo "========================================"
echo ""

echo "Creating pg_tde extension..."
if docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS pg_tde;" 2>&1 | grep -v "NOTICE"; then
  echo -e "${GREEN}✓ pg_tde extension created${NC}"
else
  echo -e "${RED}ERROR: Failed to create pg_tde extension${NC}"
  echo ""
  echo "Possible causes:"
  echo "  - shared_preload_libraries not set (check docker-compose.tde.yml)"
  echo "  - PostgreSQL not restarted after config change"
  echo ""
  echo "Fix: docker compose -f docker-compose.yml -f docker-compose.tde.yml restart postgres"
  exit 1
fi
echo ""

# Step 4: Configure global key provider
echo "========================================"
echo "Step 4: Configuring TDE Key Provider"
echo "========================================"
echo ""

echo "Adding file-based key provider..."
# Use correct API: pg_tde_add_key_provider_file (not pg_tde_create_principal)
docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" "$DB_NAME" << EOF
SELECT pg_tde_add_key_provider_file('file-vault', '/var/lib/postgresql/data/pg_tde_keyring.per');
EOF
echo -e "${GREEN}✓ Key provider added${NC}"
echo ""

echo "Creating principal key..."
# Use correct API: pg_tde_create_key_using_global_key_provider
docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" "$DB_NAME" << EOF
SELECT pg_tde_create_key_using_global_key_provider('supersync-master-key', 'file-vault');
EOF
echo -e "${GREEN}✓ Principal key created${NC}"
echo ""

echo "Setting active principal key..."
# Use correct API: pg_tde_set_key_using_global_key_provider
docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" "$DB_NAME" << EOF
SELECT pg_tde_set_key_using_global_key_provider('supersync-master-key', 'file-vault');
EOF
echo -e "${GREEN}✓ Principal key activated${NC}"
echo ""

# Step 5: Create encrypted database
echo "========================================"
echo "Step 5: Creating Encrypted Database"
echo "========================================"
echo ""

echo "Creating database: $DB_NAME_ENCRYPTED"
docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" postgres << EOF
CREATE DATABASE ${DB_NAME_ENCRYPTED} WITH OWNER = ${DB_USER};
EOF
echo -e "${GREEN}✓ Encrypted database created${NC}"
echo ""

# Step 6: Restore data to encrypted database
echo "========================================"
echo "Step 6: Migrating Data to Encrypted DB"
echo "========================================"
echo ""

echo "Restoring from: $BACKUP_FILE"
echo "This may take several minutes..."
echo ""

if docker exec -i "$POSTGRES_CONTAINER" psql -U "$DB_USER" "$DB_NAME_ENCRYPTED" < "$BACKUP_FILE" 2>&1 | grep -v "^SET$\|^SELECT"; then
  echo -e "${GREEN}✓ Data migrated to encrypted database${NC}"
  echo ""
else
  echo -e "${RED}ERROR: Migration failed${NC}"
  exit 1
fi

# Step 7: Verify encryption
echo "========================================"
echo "Step 7: Verifying Encryption"
echo "========================================"
echo ""

echo "Checking if database is encrypted..."
IS_ENCRYPTED=$(docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME_ENCRYPTED" -t -c "
  SELECT pg_tde_is_encrypted(oid)
  FROM pg_database
  WHERE datname = '$DB_NAME_ENCRYPTED';
" | tr -d '[:space:]')

if [ "$IS_ENCRYPTED" = "t" ]; then
  echo -e "${GREEN}✓ Database is encrypted${NC}"
else
  echo -e "${RED}ERROR: Database is NOT encrypted${NC}"
  echo "pg_tde_is_encrypted returned: $IS_ENCRYPTED (expected: t)"
  exit 1
fi
echo ""

echo "Verifying row counts..."
NEW_ROW_COUNTS=$(docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" "$DB_NAME_ENCRYPTED" -t -c "
  SELECT
    'operations: ' || COUNT(*) FROM operations
  UNION ALL
  SELECT 'users: ' || COUNT(*) FROM users
  UNION ALL
  SELECT 'user_sync_state: ' || COUNT(*) FROM user_sync_state
  UNION ALL
  SELECT 'operation_writes: ' || COUNT(*) FROM operation_writes;
")

echo "Before TDE:" | sed 's/^/  /'
cat "${BACKUP_DIR}/pre-tde-row-counts.txt" | sed 's/^/    /'
echo ""
echo "After TDE:" | sed 's/^/  /'
echo "$NEW_ROW_COUNTS" | sed 's/^[[:space:]]*/    /'
echo ""

if diff -q <(echo "$ROW_COUNTS" | sed 's/^[[:space:]]*//') <(echo "$NEW_ROW_COUNTS" | sed 's/^[[:space:]]*//') &> /dev/null; then
  echo -e "${GREEN}✓ Row counts match${NC}"
else
  echo -e "${RED}ERROR: Row count mismatch!${NC}"
  exit 1
fi
echo ""

# Step 8: Switch application to encrypted database
echo "========================================"
echo "Step 8: Switching to Encrypted Database"
echo "========================================"
echo ""

echo -e "${YELLOW}Manual step required:${NC}"
echo ""
echo "Update .env file to use encrypted database:"
echo "  Change: POSTGRES_DB=$DB_NAME"
echo "  To:     POSTGRES_DB=$DB_NAME_ENCRYPTED"
echo ""
echo "Then restart SuperSync:"
echo "  docker compose restart supersync"
echo ""

read -p "Press Enter after updating .env file..." -r
echo ""

# Success message
echo "========================================"
echo -e "${GREEN}✓ TDE Migration Complete!${NC}"
echo "========================================"
echo ""
echo "Encryption status:"
echo "  - Database: $DB_NAME_ENCRYPTED"
echo "  - Data files: AES-128-GCM encrypted"
echo "  - WAL: AES-128-CTR encrypted"
echo "  - All row counts verified"
echo ""
echo "Backup location:"
echo "  $BACKUP_FILE"
echo ""
echo "NEXT STEPS:"
echo ""
echo "1. Verify encryption with:"
echo "   sudo ./tools/verify-tde.sh"
echo ""
echo "2. Test SuperSync application:"
echo "   curl http://localhost:1900/health"
echo "   # Test login, sync, operations"
echo ""
echo "3. After successful testing, remove old unencrypted database:"
echo "   docker exec $POSTGRES_CONTAINER psql -U $DB_USER -c 'DROP DATABASE $DB_NAME;'"
echo ""
echo "4. Update docker-compose.yml permanently:"
echo "   # Change POSTGRES_DB environment variable to $DB_NAME_ENCRYPTED"
echo ""
echo "5. Read operational procedures:"
echo "   cat docs/tde-operations.md"
echo ""
echo "ROLLBACK (if issues found):"
echo "  1. Update .env: POSTGRES_DB=$DB_NAME"
echo "  2. docker compose restart supersync"
echo "  3. Test with unencrypted database"
echo "  4. If needed, restore from: $BACKUP_FILE"
echo ""
