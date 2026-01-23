#!/bin/bash
# PostgreSQL TDE Unlock Script
#
# This script decrypts the master encryption key to a secure tmpfs location
# so PostgreSQL can use it to encrypt/decrypt data.
#
# SECURITY:
# - Decrypted key stored in /run/secrets/ (tmpfs, root-only, memory-only)
# - Key exists only in RAM, never written to disk
# - Cleared on reboot (requires manual unlock after restart)
# - Same security model as LUKS unlock
#
# Usage: sudo ./tools/unlock-tde.sh
#
# This must be run BEFORE starting PostgreSQL after each server reboot.

set -e
set -u
set -o pipefail

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Configuration
ENCRYPTED_KEY_FILE="/var/lib/supersync/pg_tde_master_key.enc"
SECRETS_DIR="/run/secrets"
DECRYPTED_KEY_FILE="${SECRETS_DIR}/pg_tde_master_key"

echo "========================================"
echo "PostgreSQL TDE Unlock"
echo "========================================"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}ERROR: This script must be run as root${NC}"
  echo "Usage: sudo $0"
  exit 1
fi

# Check if encrypted key exists
if [ ! -f "$ENCRYPTED_KEY_FILE" ]; then
  echo -e "${RED}ERROR: Encrypted key not found at $ENCRYPTED_KEY_FILE${NC}"
  echo ""
  echo "Run setup first: sudo ./tools/setup-tde.sh"
  exit 1
fi

# Check if already unlocked
if [ -f "$DECRYPTED_KEY_FILE" ]; then
  echo -e "${GREEN}✓ TDE already unlocked${NC}"
  echo "  Decrypted key exists at: $DECRYPTED_KEY_FILE"
  echo ""
  echo "If you want to re-unlock (e.g., key rotation), run:"
  echo "  sudo rm $DECRYPTED_KEY_FILE"
  echo "  sudo ./tools/unlock-tde.sh"
  exit 0
fi

# Create secrets directory if it doesn't exist
# /run is a tmpfs mount (memory-only, cleared on reboot)
if [ ! -d "$SECRETS_DIR" ]; then
  echo "Creating secrets directory..."
  mkdir -p "$SECRETS_DIR"
  chmod 700 "$SECRETS_DIR"
  chown root:root "$SECRETS_DIR"
  echo -e "${GREEN}✓ Created $SECRETS_DIR${NC}"
  echo ""
fi

# Prompt for passphrase
echo "Enter master key passphrase to unlock TDE:"
echo "(Passphrase will not be displayed)"
echo ""

# Decrypt master key to tmpfs
if openssl enc -d -aes-256-cbc -pbkdf2 -iter 1000000 \
  -in "$ENCRYPTED_KEY_FILE" \
  -out "$DECRYPTED_KEY_FILE" 2>/dev/null; then

  # Set secure permissions
  chmod 600 "$DECRYPTED_KEY_FILE"
  chown root:root "$DECRYPTED_KEY_FILE"

  echo ""
  echo "========================================"
  echo -e "${GREEN}✓ TDE Unlocked Successfully${NC}"
  echo "========================================"
  echo ""
  echo "Master key decrypted to: $DECRYPTED_KEY_FILE"
  echo ""
  echo "Key storage details:"
  echo "  - Location: tmpfs (memory-only filesystem)"
  echo "  - Permissions: 600 (root read/write only)"
  echo "  - Lifetime: Until reboot (requires unlock after restart)"
  echo ""
  echo "NEXT STEPS:"
  echo ""
  echo "1. Start PostgreSQL with TDE:"
  echo "   cd /path/to/super-sync-server"
  echo "   docker compose -f docker-compose.yml -f docker-compose.tde.yml up -d postgres"
  echo ""
  echo "2. Verify TDE is working:"
  echo "   sudo ./tools/verify-tde.sh"
  echo ""
  echo -e "${YELLOW}NOTE: After server reboot, you must run this script again before starting PostgreSQL${NC}"
  echo ""

else
  echo ""
  echo -e "${RED}ERROR: Failed to decrypt master key${NC}"
  echo ""
  echo "Possible causes:"
  echo "  - Incorrect passphrase"
  echo "  - Corrupted encrypted key file"
  echo "  - Wrong encryption algorithm (if key was created with different settings)"
  echo ""
  echo "If you forgot the passphrase:"
  echo "  - Restore encrypted key from backup"
  echo "  - Try passphrase from password manager"
  echo "  - Try passphrase from physical backup"
  echo ""
  echo "If all passphrases fail:"
  echo "  - Data encrypted with this key is UNRECOVERABLE"
  echo "  - Restore from unencrypted backup (if available)"
  echo "  - Re-run setup to create new key (loses existing encrypted data)"
  exit 1
fi
