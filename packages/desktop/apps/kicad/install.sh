set -e
echo "deb http://deb.debian.org/debian bookworm-backports main" > /etc/apt/sources.list.d/backports.list
apt-get update && apt-get install -y --no-install-recommends -t bookworm-backports kicad \
  && rm -rf /var/lib/apt/lists/*
