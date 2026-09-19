#!/usr/bin/env bash
# Gives one home machine the right to hold a tunnel open to this server — and nothing else.
#
#   bash setup-server.sh <loopback-port> "<ssh public key>"
#
# The key can open a reverse SOCKS listener on 127.0.0.1:<port> and that is all:
# no shell, no commands, no other forwarding, no agent or X11. If it leaks, what
# leaks is the ability to be this one account's exit, on a port only this
# machine can reach. Run as root; safe to run again with a new key or port.
set -euo pipefail
PORT=${1:?loopback port, e.g. 1080}
KEY=${2:?the home machine\'s public key}
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || { echo "port must be 1024-65535"; exit 1; }
[[ "$KEY" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256)\ [A-Za-z0-9+/=]+ ]] || { echo "that does not look like a public key"; exit 1; }

USER_NAME=homeroute
id "$USER_NAME" > /dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$USER_NAME"
HOME_DIR=$(getent passwd "$USER_NAME" | cut -d: -f6)
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.ssh"
AUTH="$HOME_DIR/.ssh/authorized_keys"
touch "$AUTH"
# One line per port: a second home machine gets its own port and its own line.
grep -v "permitlisten=\"127.0.0.1:$PORT\"" "$AUTH" > "$AUTH.new" || true
echo "restrict,port-forwarding,permitlisten=\"127.0.0.1:$PORT\",permitopen=\"127.0.0.1:1\" $KEY" >> "$AUTH.new"
mv "$AUTH.new" "$AUTH"
chown "$USER_NAME:$USER_NAME" "$AUTH"
chmod 600 "$AUTH"
echo "ok: $USER_NAME may listen on 127.0.0.1:$PORT"
