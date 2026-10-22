#!/bin/bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "retire-exchange-stack.sh must run as root" >&2
  exit 1
fi

for unit in cox-archiver cox-monitor; do
  if [ "$(systemctl show "$unit.service" --property=LoadState --value)" = loaded ]; then
    systemctl disable --now "$unit.service"
  fi
  path="/etc/systemd/system/$unit.service"
  if [ -f "$path" ] && [ ! -L "$path" ]; then
    rm "$path"
  fi
  systemctl mask "$unit.service"
done
systemctl daemon-reload

for unit in cox-archiver cox-monitor; do
  [ "$(systemctl show "$unit.service" --property=UnitFileState --value)" = masked ]
  [ "$(systemctl show "$unit.service" --property=ActiveState --value)" = inactive ]
done
