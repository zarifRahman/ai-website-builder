#!/usr/bin/env bash
# One-shot EC2 bootstrap for the AI Website Builder (all-in-one Docker stack).
#
# Run this ON a fresh Ubuntu 22.04/24.04 EC2 instance:
#   curl -fsSL https://raw.githubusercontent.com/zarifRahman/ai-website-builder/main/deploy/ec2-setup.sh | bash
# or copy it over and: bash ec2-setup.sh
#
# It installs Docker + the compose plugin, clones the repo, and starts the
# stack (Postgres + API + Web) via docker-compose.yml.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/zarifRahman/ai-website-builder.git}"
APP_DIR="${APP_DIR:-$HOME/ai-website-builder}"

echo "==> Installing Docker Engine + compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl git
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER" || true
fi

echo "==> Cloning repo into ${APP_DIR}"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

if [ ! -f .env ]; then
  cp .env.docker.example .env
  echo
  echo "!! Created .env from template. Edit it to add your codegen API key(s):"
  echo "     nano $APP_DIR/.env"
  echo "   Then re-run:  cd $APP_DIR && sudo docker compose up -d --build"
  echo
  exit 0
fi

echo "==> Building and starting the stack"
sudo docker compose up -d --build

echo
echo "==> Done. Check status with:  sudo docker compose ps"
echo "    Web  → http://<EC2_PUBLIC_IP>:3000"
echo "    API  → http://<EC2_PUBLIC_IP>:4000"
echo
echo "NOTE: the web image bakes NEXT_PUBLIC_API_URL at build time. For a real"
echo "      domain/IP, set it in docker-compose.yml (web.build.args) + the API's"
echo "      WEB_ORIGIN, then: sudo docker compose up -d --build"
