#!/bin/bash
# End-to-end test: server with an invalid LiteLLM endpoint.
pkill -f "node server.js" 2>/dev/null
sleep 1
LITELLM_BASE=http://localhost:9999 node server.js > /tmp/srv.log 2>&1 &
SRVPID=$!
sleep 2
echo "=== /api/sankey response ==="
curl -s -w "\nHTTP:%{http_code}\n" "http://localhost:5173/api/sankey?start=2024-01-01&end=2024-01-02"
echo "=== server log ==="
cat /tmp/srv.log
kill $SRVPID 2>/dev/null
pkill -f "node server.js" 2>/dev/null
echo "DONE"
