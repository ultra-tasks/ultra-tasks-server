#!/bin/bash
# PostgreSQL 16 → 17 Upgrade Script (Without TDE)
#
# This script upgrades PostgreSQL from version 16 to 17 WITHOUT enabling TDE.
# TDE will be added in a separate migration step after this upgrade is complete and tested.
#
# STRATEGY:
# - Two-step migration: (1) PG version upgrade, (2) TDE enablement
# - Isolates issues: version incompatibility vs TDE configuration
# - Safer rollback: can revert to PG 16 independently of TDE
#
# Prerequisites:
# - Current PostgreSQL 16 running
# - Docker and docker-compose installed
# - At least 2x database size free disk space
#
# Usage: sudo ./tools/upgrade-postgres-17.sh

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
BACKUP_FILE="${BACKUP_DIR}/pre-pg17-upgrade-$(date +%Y%m%d-%H%M%S).sql"
POSTGRES_CONTAINER="supersync-postgres"
DB_USER="${POSTGRES_USER:-supersync}"
DB_NAME="${POSTGRES_DB:-supersync}"

echo "========================================"
echo "PostgreSQL 16 → 17 Upgrade"
echo "========================================"
echo ""
echo -e "${YELLOW}WARNING: This will upgrade PostgreSQL to version 17${NC}"
echo ""
echo "Steps:"
echo "  1. Backup current PG 16 database"
echo "  2. Stop PostgreSQL 16"
echo "  3. Switch to Percona PostgreSQL 17"
echo "  4. Restore data to PG 17"
echo "  5. Verify data integrity"
echo ""
echo -e "${BLUE}TDE will NOT be enabled in this step.${NC}"
echo "TDE migration will be done separately after this upgrade is tested."
echo ""

read -p "Continue with upgrade? (yes/no): " -r
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

# Create backup directory
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
echo -e "${GREEN}✓ Backup directory ready${NC}"
echo ""

# Step 1: Backup current database
echo "========================================"
echo "Step 1: Backing up PostgreSQL 16"
echo "========================================"
echo ""

if ! docker ps | grep -q "$POSTGRES_CONTAINER"; then
  echo -e "${RED}ERROR: PostgreSQL container '$POSTGRES_CONTAINER' not running${NC}"
  echo "Start it with: docker compose up -d postgres"
  exit 1
fi

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
echo "$ROW_COUNTS" | sed 's/^[[:space:]]*//' > "${BACKUP_DIR}/pre-upgrade-row-counts.txt"
echo -e "${GREEN}✓ Row counts saved${NC}"
echo "$ROW_COUNTS" | sed 's/^[[:space:]]*/  /'
echo ""

# Step 2: Stop PostgreSQL 16
echo "========================================"
echo "Step 2: Stopping PostgreSQL 16"
echo "========================================"
echo ""

docker compose stop postgres
docker compose rm -f postgres
echo -e "${GREEN}✓ PostgreSQL 16 stopped and removed${NC}"
echo ""

# Step 3: Switch to Percona PostgreSQL 17
echo "========================================"
echo "Step 3: Starting Percona PostgreSQL 17"
echo "========================================"
echo ""
echo "Creating temporary docker-compose overlay..."

cat > /tmp/docker-compose.pg17-no-tde.yml << 'EOF'
# Temporary overlay for PostgreSQL 17 upgrade without TDE
services:
  postgres:
    image: percona/percona-postgresql:17
EOF

echo "Starting Percona PostgreSQL 17 (without TDE)..."
docker compose -f docker-compose.yml -f /tmp/docker-compose.pg17-no-tde.yml up -d postgres

echo "Waiting for PostgreSQL 17 to be ready..."
sleep 5

# Wait for PostgreSQL to be healthy
MAX_WAIT=60
WAITED=0
while ! docker exec "$POSTGRES_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" &> /dev/null; do
  if [ $WAITED -ge $MAX_WAIT ]; then
    echo -e "${RED}ERROR: PostgreSQL 17 failed to start after ${MAX_WAIT}s${NC}"
    exit 1
  fi
  echo "  Waiting for PostgreSQL... (${WAITED}s)"
  sleep 2
  WAITED=$((WAITED + 2))
done

echo -e "${GREEN}✓ PostgreSQL 17 is ready${NC}"
echo ""

# Step 4: Restore data to PG 17
echo "========================================"
echo "Step 4: Restoring data to PostgreSQL 17"
echo "========================================"
echo ""

echo "Restoring from: $BACKUP_FILE"
echo "This may take several minutes..."
echo ""

if docker exec -i "$POSTGRES_CONTAINER" psql -U "$DB_USER" "$DB_NAME" < "$BACKUP_FILE" 2>&1 | grep -v "^SET$\|^SELECT"; then
  echo -e "${GREEN}✓ Data restored to PostgreSQL 17${NC}"
  echo ""
else
  echo -e "${RED}ERROR: Restore failed${NC}"
  echo ""
  echo "ROLLBACK: To restore PostgreSQL 16:"
  echo "  1. docker compose stop postgres"
  echo "  2. docker compose rm -f postgres"
  echo "  3. rm /tmp/docker-compose.pg17-no-tde.yml"
  echo "  4. docker compose up -d postgres  # Uses PG 16 from base config"
  echo "  5. docker exec -i $POSTGRES_CONTAINER psql -U $DB_USER $DB_NAME < $BACKUP_FILE"
  exit 1
fi

# Step 5: Verify data integrity
echo "========================================"
echo "Step 5: Verifying data integrity"
echo "========================================"
echo ""

echo "Checking row counts..."
NEW_ROW_COUNTS=$(docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" "$DB_NAME" -t -c "
  SELECT
    'operations: ' || COUNT(*) FROM operations
  UNION ALL
  SELECT 'users: ' || COUNT(*) FROM users
  UNION ALL
  SELECT 'user_sync_state: ' || COUNT(*) FROM user_sync_state
  UNION ALL
  SELECT 'operation_writes: ' || COUNT(*) FROM operation_writes;
")

echo "Before upgrade:" | sed 's/^/  /'
cat "${BACKUP_DIR}/pre-upgrade-row-counts.txt" | sed 's/^/    /'
echo ""
echo "After upgrade:" | sed 's/^/  /'
echo "$NEW_ROW_COUNTS" | sed 's/^[[:space:]]*/    /'
echo ""

# Compare row counts
if diff -q <(echo "$ROW_COUNTS" | sed 's/^[[:space:]]*//') <(echo "$NEW_ROW_COUNTS" | sed 's/^[[:space:]]*//') &> /dev/null; then
  echo -e "${GREEN}✓ Row counts match${NC}"
else
  echo -e "${RED}ERROR: Row count mismatch!${NC}"
  echo "See rollback instructions above"
  exit 1
fi

# Test basic query
echo "Testing basic query..."
if docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" "$DB_NAME" -c "SELECT COUNT(*) FROM operations;" &> /dev/null; then
  echo -e "${GREEN}✓ Queries working${NC}"
else
  echo -e "${RED}ERROR: Query test failed${NC}"
  exit 1
fi

echo ""

# Check PostgreSQL version
PG_VERSION=$(docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -t -c "SELECT version();" | head -1 | sed 's/^[[:space:]]*//')
echo "PostgreSQL version:"
echo "  $PG_VERSION"
echo ""

if echo "$PG_VERSION" | grep -q "17\."; then
  echo -e "${GREEN}✓ PostgreSQL 17 confirmed${NC}"
else
  echo -e "${YELLOW}WARNING: Version string doesn't contain '17'${NC}"
  echo "Manual verification recommended"
fi

# Success message
echo ""
echo "========================================"
echo -e "${GREEN}✓ PostgreSQL 16 → 17 Upgrade Complete!${NC}"
echo "========================================"
echo ""
echo "Current state:"
echo "  - PostgreSQL 17 (Percona) running"
echo "  - All data migrated and verified"
echo "  - TDE NOT enabled yet (next step)"
echo ""
echo "Backup location:"
echo "  $BACKUP_FILE"
echo ""
echo "NEXT STEPS:"
echo ""
echo "1. Test SuperSync application:"
echo "   docker compose restart supersync"
echo "   curl http://localhost:1900/health"
echo "   # Test login, sync, basic operations"
echo ""
echo "2. After testing, make PG 17 permanent:"
echo "   # Edit docker-compose.yml, change:"
echo "   #   image: postgres:16-alpine"
echo "   # To:"
echo "   #   image: percona/percona-postgresql:17"
echo ""
echo "3. Then proceed with TDE migration:"
echo "   sudo ./tools/migrate-to-tde.sh"
echo ""
echo "ROLLBACK (if issues found):"
echo "  1. docker compose stop postgres"
echo "  2. docker compose rm -f postgres"
echo "  3. rm /tmp/docker-compose.pg17-no-tde.yml"
echo "  4. docker compose up -d postgres  # Uses PG 16"
echo "  5. docker exec -i $POSTGRES_CONTAINER psql -U $DB_USER $DB_NAME < $BACKUP_FILE"
echo ""
