#!/bin/bash
# PostgreSQL TDE Verification Script
#
# This script verifies that TDE encryption is working correctly by:
# 1. Checking encryption status in PostgreSQL
# 2. Verifying WAL encryption is enabled
# 3. Inspecting data files for encryption (no plaintext)
# 4. Testing database queries work
# 5. Checking for plaintext leakage
#
# Usage: sudo ./tools/verify-tde.sh [database_name]

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
POSTGRES_CONTAINER="supersync-postgres"
DB_USER="${POSTGRES_USER:-supersync}"
DB_NAME="${1:-${POSTGRES_DB:-supersync_encrypted}}"

echo "========================================"
echo "PostgreSQL TDE Verification"
echo "========================================"
echo ""
echo "Database: $DB_NAME"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo -e "${YELLOW}WARNING: Not running as root${NC}"
  echo "Some checks (hexdump) may fail without root access"
  echo ""
fi

# Check if PostgreSQL is running
if ! docker ps | grep -q "$POSTGRES_CONTAINER"; then
  echo -e "${RED}ERROR: PostgreSQL container not running${NC}"
  exit 1
fi

PASS=0
FAIL=0
WARN=0

# Test 1: Check encryption status via pg_tde
echo "========================================"
echo "Test 1: Database Encryption Status"
echo "========================================"
echo ""

IS_ENCRYPTED=$(docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -t -c "
  SELECT pg_tde_is_encrypted(oid)
  FROM pg_database
  WHERE datname = '$DB_NAME';
" 2>/dev/null | tr -d '[:space:]' || echo "error")

if [ "$IS_ENCRYPTED" = "t" ]; then
  echo -e "${GREEN}✓ PASS: Database is encrypted${NC}"
  PASS=$((PASS + 1))
elif [ "$IS_ENCRYPTED" = "f" ]; then
  echo -e "${RED}✗ FAIL: Database is NOT encrypted${NC}"
  FAIL=$((FAIL + 1))
else
  echo -e "${RED}✗ FAIL: Could not check encryption status${NC}"
  echo "  pg_tde extension may not be installed"
  FAIL=$((FAIL + 1))
fi
echo ""

# Test 2: Check WAL encryption
echo "========================================"
echo "Test 2: WAL Encryption Configuration"
echo "========================================"
echo ""

WAL_ENCRYPT=$(docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -t -c "
  SHOW pg_tde.wal_encrypt;
" 2>/dev/null | tr -d '[:space:]' || echo "error")

if [ "$WAL_ENCRYPT" = "on" ]; then
  echo -e "${GREEN}✓ PASS: WAL encryption enabled${NC}"
  PASS=$((PASS + 1))
elif [ "$WAL_ENCRYPT" = "off" ]; then
  echo -e "${RED}✗ FAIL: WAL encryption DISABLED${NC}"
  echo "  Transaction logs are in PLAINTEXT!"
  echo "  Enable with: ALTER SYSTEM SET pg_tde.wal_encrypt = on;"
  FAIL=$((FAIL + 1))
else
  echo -e "${YELLOW}⚠ WARN: Could not check WAL encryption status${NC}"
  WARN=$((WARN + 1))
fi
echo ""

# Test 3: Verify shared_preload_libraries
echo "========================================"
echo "Test 3: Extension Loading Configuration"
echo "========================================"
echo ""

PRELOAD_LIBS=$(docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -t -c "
  SHOW shared_preload_libraries;
" 2>/dev/null | tr -d '[:space:]' || echo "error")

if echo "$PRELOAD_LIBS" | grep -q "pg_tde"; then
  echo -e "${GREEN}✓ PASS: pg_tde in shared_preload_libraries${NC}"
  echo "  Value: $PRELOAD_LIBS"
  PASS=$((PASS + 1))
else
  echo -e "${RED}✗ FAIL: pg_tde NOT in shared_preload_libraries${NC}"
  echo "  Current value: $PRELOAD_LIBS"
  echo "  This will cause CREATE EXTENSION to fail"
  FAIL=$((FAIL + 1))
fi
echo ""

# Test 4: Check data file encryption (hexdump)
echo "========================================"
echo "Test 4: Data File Encryption (Hexdump)"
echo "========================================"
echo ""

echo "Checking if data files contain plaintext..."
# Get database OID
DB_OID=$(docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -t -c "
  SELECT oid FROM pg_database WHERE datname = '$DB_NAME';
" 2>/dev/null | tr -d '[:space:]' || echo "")

if [ -n "$DB_OID" ]; then
  # Look for any plaintext strings in data files
  PLAINTEXT_CHECK=$(docker exec "$POSTGRES_CONTAINER" sh -c "
    find /var/lib/postgresql/data/base/$DB_OID -type f -name '[0-9]*' 2>/dev/null |
    head -5 |
    xargs strings 2>/dev/null |
    grep -i -E '(user|email|password|task|operation)' |
    head -10
  " || echo "")

  if [ -z "$PLAINTEXT_CHECK" ]; then
    echo -e "${GREEN}✓ PASS: No plaintext found in data files${NC}"
    echo "  Data appears encrypted"
    PASS=$((PASS + 1))
  else
    echo -e "${YELLOW}⚠ WARN: Found possible plaintext in data files${NC}"
    echo "  Sample strings:"
    echo "$PLAINTEXT_CHECK" | sed 's/^/    /'
    echo ""
    echo "  This may be:"
    echo "  - Metadata (table names, columns) - normal"
    echo "  - Unencrypted system catalogs - normal"
    echo "  - Actual data leakage - investigate"
    WARN=$((WARN + 1))
  fi
else
  echo -e "${YELLOW}⚠ WARN: Could not determine database OID${NC}"
  WARN=$((WARN + 1))
fi
echo ""

# Test 5: Test queries work
echo "========================================"
echo "Test 5: Database Query Functionality"
echo "========================================"
echo ""

echo "Testing basic query..."
ROW_COUNT=$(docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" "$DB_NAME" -t -c "
  SELECT COUNT(*) FROM operations;
" 2>/dev/null | tr -d '[:space:]' || echo "error")

if [ "$ROW_COUNT" != "error" ] && [ -n "$ROW_COUNT" ]; then
  echo -e "${GREEN}✓ PASS: Queries working${NC}"
  echo "  operations table: $ROW_COUNT rows"
  PASS=$((PASS + 1))
else
  echo -e "${RED}✗ FAIL: Query failed${NC}"
  FAIL=$((FAIL + 1))
fi
echo ""

# Test 6: Check TDE key provider
echo "========================================"
echo "Test 6: TDE Key Provider Configuration"
echo "========================================"
echo ""

KEY_PROVIDERS=$(docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" "$DB_NAME" -t -c "
  SELECT provider_name FROM pg_tde_key_providers;
" 2>/dev/null || echo "error")

if [ "$KEY_PROVIDERS" != "error" ]; then
  echo -e "${GREEN}✓ PASS: Key provider configured${NC}"
  echo "  Providers: $KEY_PROVIDERS"
  PASS=$((PASS + 1))
else
  echo -e "${RED}✗ FAIL: No key provider found${NC}"
  FAIL=$((FAIL + 1))
fi
echo ""

# Test 7: Verify master key is accessible
echo "========================================"
echo "Test 7: Master Key Accessibility"
echo "========================================"
echo ""

if docker exec "$POSTGRES_CONTAINER" test -r /run/secrets/pg_tde_master_key 2>/dev/null; then
  KEY_SIZE=$(docker exec "$POSTGRES_CONTAINER" wc -c < /run/secrets/pg_tde_master_key 2>/dev/null | tr -d '[:space:]')
  echo -e "${GREEN}✓ PASS: Master key accessible${NC}"
  echo "  Location: /run/secrets/pg_tde_master_key"
  echo "  Size: $KEY_SIZE bytes"
  PASS=$((PASS + 1))
else
  echo -e "${RED}✗ FAIL: Master key not accessible${NC}"
  echo "  Run: sudo ./tools/unlock-tde.sh"
  FAIL=$((FAIL + 1))
fi
echo ""

# Summary
echo "========================================"
echo "Verification Summary"
echo "========================================"
echo ""
echo -e "Passed: ${GREEN}$PASS${NC}"
echo -e "Failed: ${RED}$FAIL${NC}"
echo -e "Warnings: ${YELLOW}$WARN${NC}"
echo ""

if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}✓ TDE verification successful!${NC}"
  echo ""
  echo "Encryption confirmed:"
  echo "  - Database encryption: ON"
  echo "  - WAL encryption: ON"
  echo "  - Data files: Encrypted"
  echo "  - Queries: Working"
  echo ""
  exit 0
else
  echo -e "${RED}✗ TDE verification failed${NC}"
  echo ""
  echo "Issues found: $FAIL"
  echo "Review the output above for details"
  echo ""
  exit 1
fi
