#!/bin/bash
# Loads stress-test records into the live CRM in 50k-row transactions and logs the time per batch.
# Usage: ./run_load.sh <table> <from> <to>   e.g. ./run_load.sh contacts 1001 1000000
set -u
cd "$(dirname "$0")"
T=$1; FROM=$2; TO=$3; STEP=${STEP:-50000}
LOG=${LOG:-load.log}
s=$FROM
while [ "$s" -le "$TO" ]; do
  e=$((s + STEP - 1)); [ "$e" -gt "$TO" ] && e=$TO
  t0=$(date +%s)
  psql -h localhost -p 5433 -U pc_migrator -d profitpad_crm_db -X -q -v ON_ERROR_STOP=1 -v s=$s -v e=$e -f load_$T.sql || { echo "$(date '+%H:%M:%S') $T $s-$e FAILED" >> "$LOG"; exit 1; }
  t1=$(date +%s)
  n=$((e - s + 1)); d=$((t1 - t0)); [ "$d" -eq 0 ] && d=1
  echo "$(date '+%H:%M:%S') $T $s-$e ${d}s $((n / d)) rows/s" >> "$LOG"
  s=$((e + 1))
done
