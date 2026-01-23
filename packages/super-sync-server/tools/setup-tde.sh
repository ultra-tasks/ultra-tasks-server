#!/bin/bash
# PostgreSQL TDE (Transparent Data Encryption) Setup Script
#
# This script initializes TDE for SuperSync by:
# 1. Generating a strong master encryption key
# 2. Encrypting it with a user-provided passphrase
# 3. Storing the encrypted key for production use
#
# SECURITY MODEL:
# - Master key encrypted with AES-256-CBC + PBKDF2 (1M iterations)
# - Encrypted key stored on disk (useless without passphrase)
# - Passphrase stored separately (password manager + physical backup)
# - Similar security to LUKS (passphrase-protected encryption)
#
# Prerequisites:
# - PostgreSQL 17+ with pg_tde extension installed
# - OpenSSL installed
# - Docker and docker-compose installed
#
# Usage: sudo ./tools/setup-tde.sh

set -e
set -u
set -o pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
ENCRYPTED_KEY_DIR="/var/lib/supersync"
ENCRYPTED_KEY_FILE="${ENCRYPTED_KEY_DIR}/pg_tde_master_key.enc"
KEYRING_FILE="${ENCRYPTED_KEY_DIR}/pg_tde_keyring.per"
TMP_KEY_FILE="/tmp/pg_tde_master_key.plain"

echo "========================================"
echo "PostgreSQL TDE Setup for SuperSync"
echo "========================================"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}ERROR: This script must be run as root${NC}"
  echo "Usage: sudo $0"
  exit 1
fi

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v openssl &> /dev/null; then
  echo -e "${RED}ERROR: openssl not found${NC}"
  echo "Install with: apt-get install openssl"
  exit 1
fi

if ! command -v docker &> /dev/null; then
  echo -e "${RED}ERROR: docker not found${NC}"
  echo "Install Docker first"
  exit 1
fi

echo -e "${GREEN}✓ Prerequisites met${NC}"
echo ""

# Create storage directory
echo "Creating TDE storage directory..."
mkdir -p "$ENCRYPTED_KEY_DIR"
chmod 700 "$ENCRYPTED_KEY_DIR"
chown root:root "$ENCRYPTED_KEY_DIR"
echo -e "${GREEN}✓ Directory created: $ENCRYPTED_KEY_DIR${NC}"
echo ""

# Check if key already exists
if [ -f "$ENCRYPTED_KEY_FILE" ]; then
  echo -e "${YELLOW}WARNING: Encrypted key already exists at $ENCRYPTED_KEY_FILE${NC}"
  echo ""
  read -p "Do you want to regenerate it? This will make existing encrypted data unreadable! (yes/no): " -r
  if [[ ! $REPLY =~ ^yes$ ]]; then
    echo "Aborted."
    exit 0
  fi
  echo ""
  echo -e "${YELLOW}Backing up existing key...${NC}"
  cp "$ENCRYPTED_KEY_FILE" "${ENCRYPTED_KEY_FILE}.backup.$(date +%Y%m%d-%H%M%S)"
  echo -e "${GREEN}✓ Backup created${NC}"
  echo ""
fi

# Generate master key
echo "Generating 256-bit master encryption key..."
openssl rand -hex 32 > "$TMP_KEY_FILE"
chmod 600 "$TMP_KEY_FILE"
echo -e "${GREEN}✓ Master key generated (64 hex characters)${NC}"
echo ""

# Prompt for passphrase with confirmation
echo "You will now create a passphrase to protect the master key."
echo ""
echo -e "${YELLOW}CRITICAL: If you lose this passphrase, ALL encrypted data is unrecoverable!${NC}"
echo ""
echo "Passphrase requirements:"
echo "  - Minimum 20 characters recommended"
echo "  - Use mix of letters, numbers, symbols"
echo "  - Store in password manager + physical safe"
echo ""

while true; do
  read -s -p "Enter master key passphrase: " PASSPHRASE1
  echo ""
  read -s -p "Confirm passphrase: " PASSPHRASE2
  echo ""

  if [ "$PASSPHRASE1" != "$PASSPHRASE2" ]; then
    echo -e "${RED}ERROR: Passphrases do not match. Try again.${NC}"
    echo ""
    continue
  fi

  if [ ${#PASSPHRASE1} -lt 12 ]; then
    echo -e "${RED}ERROR: Passphrase too short (minimum 12 characters)${NC}"
    echo ""
    continue
  fi

  break
done

echo ""
echo "Encrypting master key with passphrase..."

# Encrypt master key with passphrase
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 1000000 \
  -in "$TMP_KEY_FILE" \
  -out "$ENCRYPTED_KEY_FILE" \
  -pass pass:"$PASSPHRASE1"

chmod 600 "$ENCRYPTED_KEY_FILE"
chown root:root "$ENCRYPTED_KEY_FILE"

echo -e "${GREEN}✓ Master key encrypted${NC}"
echo "  Location: $ENCRYPTED_KEY_FILE"
echo ""

# Securely delete plaintext key
echo "Securely deleting plaintext key..."
shred -u "$TMP_KEY_FILE"
echo -e "${GREEN}✓ Plaintext key securely deleted${NC}"
echo ""

# Clear passphrase from memory
unset PASSPHRASE1
unset PASSPHRASE2

# Display next steps
echo "========================================"
echo -e "${GREEN}TDE Setup Complete!${NC}"
echo "========================================"
echo ""
echo "Master key created and encrypted at:"
echo "  $ENCRYPTED_KEY_FILE"
echo ""
echo "NEXT STEPS:"
echo ""
echo "1. Backup the encrypted key file:"
echo "   cp $ENCRYPTED_KEY_FILE ~/pg_tde_master_key.enc.backup"
echo "   # Store in password manager (attach file)"
echo "   # Store copy in physical safe or bank deposit box"
echo ""
echo "2. Store passphrase separately (NEVER with encrypted key!):"
echo "   # Password manager: create secure note with passphrase"
echo "   # Physical backup: write on paper, store in safe"
echo ""
echo "3. Configure PostgreSQL for TDE:"
echo "   # See docs/tde-migration-guide.md for full instructions"
echo ""
echo "4. Before starting PostgreSQL, unlock TDE:"
echo "   sudo ./tools/unlock-tde.sh"
echo ""
echo -e "${YELLOW}WARNING: If you lose the passphrase, data is UNRECOVERABLE!${NC}"
echo "         Test passphrase recovery before encrypting production data."
echo ""
