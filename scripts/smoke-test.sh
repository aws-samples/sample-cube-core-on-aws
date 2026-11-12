#!/usr/bin/env bash
# Usage: scripts/smoke-test.sh <CUBE_URL> <TOKEN>
# Verifies health, auth enforcement, metadata, a query, and (if enabled) the MCP endpoint.
set -uo pipefail
URL="${1:?CUBE_URL required}"; TOKEN="${2:?TOKEN required}"
fail=0
check() { if [ "$2" = "$3" ]; then echo "  ✔ $1"; else echo "  ✘ $1 (expected $3, got $2)"; fail=1; fi; }

echo "  waiting for $URL/readyz ..."
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/readyz")
  [ "$code" = "200" ] && break
  sleep 10
done
check "readyz" "$code" "200"
check "unauthenticated request is rejected" "$(curl -s -o /dev/null -w '%{http_code}' "$URL/cubejs-api/v1/meta")" "403"
check "playground / unknown paths are not exposed" "$(curl -s -o /dev/null -w '%{http_code}' "$URL/")" "404"

meta=$(curl -s -H "Authorization: $TOKEN" "$URL/cubejs-api/v1/meta")
cubes=$(echo "$meta" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).cubes.map(c=>c.name).join(","))}catch{console.log("ERR "+s.slice(0,200))}})')
first=$(echo "$cubes" | cut -d, -f1)
if [ -n "$first" ] && [[ "$first" != ERR* ]]; then
  echo "  ✔ meta: $cubes"
  measure=$(echo "$meta" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).cubes[0];console.log(c.measures[0].name)})')
  q="{\"measures\":[\"$measure\"]}"
  for i in $(seq 1 30); do
    res=$(curl -s -G -H "Authorization: $TOKEN" --data-urlencode "query=$q" "$URL/cubejs-api/v1/load")
    echo "$res" | grep -q '"Continue wait"' || break
    sleep 2
  done
  if echo "$res" | grep -q '"data"'; then
    echo "  ✔ query $measure: $(echo "$res" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).data)))')"
  else
    echo "  ✘ query failed: ${res:0:300}"; fail=1
  fi
else
  echo "  ✘ meta failed: $cubes"; fail=1
fi

mcp_code=$(curl -s -o /tmp/mcp-smoke.json -w '%{http_code}' -X POST "$URL/mcp" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"cube_list_models","arguments":{}}}')
if [ "$mcp_code" = "404" ]; then
  echo "  - MCP endpoint disabled"
else
  check "MCP tools/call cube_list_models" "$mcp_code" "200"
  check "MCP rejects an invalid token" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/mcp" \
    -H 'Authorization: Bearer invalid' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')" "401"
fi
exit $fail
