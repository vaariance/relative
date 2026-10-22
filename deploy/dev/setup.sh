#!/bin/bash
set -euo pipefail

archive="${1:?usage: setup.sh <archive.tar.gz> <commit> <backup-bucket>}"
commit="${2:?usage: setup.sh <archive.tar.gz> <commit> <backup-bucket>}"
backup_bucket="${3:?usage: setup.sh <archive.tar.gz> <commit> <backup-bucket>}"
pnpm_version="11.18.0"

if [ "$(id -u)" -ne 0 ]; then
  echo "setup.sh must run as root" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
    > /etc/apt/sources.list.d/docker.list
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin nodejs >/dev/null
  corepack enable
fi

id eox >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/eox --shell /bin/bash eox
usermod -aG docker eox

rm -rf /opt/eox/app
mkdir -p /opt/eox/app /opt/eox/logs
tar xzf "$archive" -C /opt/eox/app
bash /opt/eox/app/deploy/dev/retire-exchange-stack.sh

if [ ! -f /opt/eox/.env ]; then
  password="$(openssl rand -hex 24)"
  printf 'POSTGRES_PASSWORD=%s\nDATABASE_URL=postgres://eox:%s@127.0.0.1:5433/eox\n' "$password" "$password" > /opt/eox/.env
fi

install -m 0644 /opt/eox/app/deploy/dev/docker-compose.override.yml /opt/eox/app/docker-compose.override.yml
rm -f /opt/eox/run-ingests.sh
install -m 0755 /opt/eox/app/deploy/dev/backup-db.sh /opt/eox/backup-db.sh
chown -R eox:eox /opt/eox
chmod 600 /opt/eox/.env

sudo -u eox -H PNPM_VERSION="$pnpm_version" bash -c '
  set -euo pipefail
  cd /opt/eox/app
  docker compose --env-file /opt/eox/.env up -d
  until docker compose exec -T postgres pg_isready -U eox >/dev/null 2>&1; do sleep 2; done
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null
  pnpm install --frozen-lockfile
  set -a
  . /opt/eox/.env
  set +a
  pnpm db:migrate
'

printf '%s\n' \
  "30 5 * * * /opt/eox/backup-db.sh ${backup_bucket} >> /opt/eox/logs/backup.log 2>&1" | crontab -u eox -
node24=/opt/eox/runtime/node-v24.21.0-linux-x64
if [ ! -x "$node24/bin/node" ]; then
  node_download=$(mktemp -d)
  curl -fsSL -o "$node_download/node.tar.xz" https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz
  echo "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6  $node_download/node.tar.xz" | sha256sum -c -
  install -d -m 0755 /opt/eox/runtime
  tar -xJf "$node_download/node.tar.xz" -C /opt/eox/runtime
  rm -rf "$node_download"
fi

start_service() {
  install -m 0644 "/opt/eox/app/deploy/dev/$1.service" "/etc/systemd/system/$1.service"
  systemctl daemon-reload
  systemctl enable "$1" >/dev/null
  systemctl restart "$1"
  for attempt in $(seq 1 30); do
    curl -fsS "http://127.0.0.1:$2/health" >/dev/null 2>&1 && return 0
    if [ "$attempt" -eq 30 ]; then
      journalctl -u "$1" -n 40 --no-pager >&2
      exit 1
    fi
    sleep 1
  done
}

start_service eox-evidence-api 8787
if [ -f /etc/systemd/system/eox-app-api.service ]; then
  systemctl disable --now eox-app-api >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/eox-app-api.service
  systemctl daemon-reload
fi
start_service cox-app-api 8790
if [ -f /etc/systemd/system/eox-app-api-live.service ]; then
  systemctl disable --now eox-app-api-live >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/eox-app-api-live.service /opt/eox/app-api-live.env
  rm -rf /opt/eox/state/app-api-live
  systemctl daemon-reload
fi
if [ -f /etc/systemd/system/cox-publication-archive-copy.timer ]; then
  systemctl disable --now cox-publication-archive-copy.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/cox-publication-archive-copy.timer /etc/systemd/system/cox-publication-archive-copy.service /opt/eox/copy-publication-archive.sh
  rm -rf /opt/eox/state/cox-publication-archive
  systemctl daemon-reload
fi
install -d -o eox -g eox -m 0750 /opt/eox/state/cox-app-api-live
start_service cox-app-api-live 8791

echo "$commit" > /opt/eox/DEPLOYED_COMMIT
chown eox:eox /opt/eox/DEPLOYED_COMMIT

echo "deployed $commit"
ss -ltn | grep -E ':(5433|8787|8790) '
