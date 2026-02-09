#!/bin/bash

# Demo script for Context Lens
# This simulates API calls to demonstrate the visualization

echo "🔍 Starting Context Lens..."
node dist/server.js &
SERVER_PID=$!

# Wait for server to start
sleep 2

echo ""
echo "📊 Sending test requests..."
echo ""

# Test 1: Simple Anthropic request
echo "1️⃣  Simple Claude request..."
curl -s http://localhost:4040/v1/messages \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Hello, Claude!"}]
  }' > /dev/null 2>&1

echo "   ✅ Captured (expected to fail API call, but parsing succeeded)"

# Test 2: Request with system prompt and tools
echo "2️⃣  Complex request with system + tools..."
curl -s http://localhost:4040/v1/messages \
  -H "content-type: application/json" \
  -d @test-request.json > /dev/null 2>&1

echo "   ✅ Captured (expected to fail API call, but parsing succeeded)"

# Test 3: OpenAI format
echo "3️⃣  OpenAI GPT request..."
curl -s http://localhost:4040/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "What is 2+2?"}
    ]
  }' > /dev/null 2>&1

echo "   ✅ Captured (expected to fail API call, but parsing succeeded)"

echo ""
echo "🌐 Web UI available at: http://localhost:4041"
echo "📊 API endpoint: http://localhost:4041/api/requests"
echo ""
echo "Press Ctrl+C to stop the server (PID: $SERVER_PID)"
echo ""

# Keep script running
wait $SERVER_PID
