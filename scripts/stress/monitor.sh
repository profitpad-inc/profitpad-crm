#!/bin/bash
# Samples server load, memory, disk and the pc-db / pc-api containers every 30s into monitor.log.
cd "$(dirname "$0")"
while true; do
  ssh -o ClearAllForwardings=yes profitpad_claude_profitpad_crm \
    'echo "$(date -u +%H:%M:%S) load=$(cut -d" " -f1-3 /proc/loadavg) mem_avail=$(free -m | awk "/Mem/{print \$7}")MB swap_used=$(free -m | awk "/Swap/{print \$3}")MB disk_used=$(df -h / | awk "NR==2{print \$3}") $(sudo docker stats --no-stream --format "{{.Name}}:{{.CPUPerc}}/{{.MemUsage}}" pc-db pc-api n8n erpnext-backend-1 | tr "\n" " " | sed "s/ \/ [0-9.]*GiB//g")"' >> monitor.log 2>&1
  sleep 30
done
