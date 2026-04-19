#!/bin/bash
set -e

CA_DIR="/ca"
CA_CERT="$CA_DIR/ca-cert.pem"
CA_KEY="$CA_DIR/ca-key.pem"

# Generate CA cert if it doesn't exist
if [ ! -f "$CA_CERT" ]; then
  echo "[proxy] Generating CA certificate..."
  mkdir -p "$CA_DIR"
  openssl genrsa -out "$CA_KEY" 2048 2>/dev/null
  openssl req -x509 -new -nodes -key "$CA_KEY" -sha256 -days 365 \
    -out "$CA_CERT" -subj "/CN=Vivi Proxy CA" 2>/dev/null
  echo "[proxy] CA certificate generated"
fi

exec tsx /app/proxy.ts
