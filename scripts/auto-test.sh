#!/bin/bash
# Auto-Test Script - Runs after deployment
# This script tests critical API endpoints

API_URL="https://sellityet1-production.up.railway.app/api"
EMAIL="admin@sellityet.com"
PASSWORD="admin123"
LOG_FILE="/tmp/sellityet-test.log"

echo "🧪 Auto-Test Started: $(date)" | tee $LOG_FILE
echo "============================" | tee -a $LOG_FILE

FAILED=0

# 1. Health Check
echo -n "🏥 Health Check... " | tee -a $LOG_FILE
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/health")
if [ "$HEALTH" = "200" ]; then
    echo "✅ PASSED" | tee -a $LOG_FILE
else
    echo "❌ FAILED (HTTP $HEALTH)" | tee -a $LOG_FILE
    FAILED=$((FAILED + 1))
fi

# 2. Login
echo -n "🔑 Login Test... " | tee -a $LOG_FILE
LOGIN=$(curl -s -X POST "$API_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")

TOKEN=$(echo $LOGIN | grep -o '"token":"[^"]*' | cut -d'"' -f4)

if [ -n "$TOKEN" ]; then
    echo "✅ PASSED" | tee -a $LOG_FILE
else
    echo "❌ FAILED" | tee -a $LOG_FILE
    echo "Response: $LOGIN" | tee -a $LOG_FILE
    FAILED=$((FAILED + 1))
fi

# 3. Get Shops (if login worked)
if [ -n "$TOKEN" ]; then
    echo -n "🏪 Get Shops... " | tee -a $LOG_FILE
    SHOPS=$(curl -s "$API_URL/owner/shops" \
      -H "Authorization: Bearer $TOKEN")
    
    if echo "$SHOPS" | grep -q '"id"'; then
        echo "✅ PASSED" | tee -a $LOG_FILE
        SHOP_ID=$(echo "$SHOPS" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
    else
        echo "❌ FAILED" | tee -a $LOG_FILE
        FAILED=$((FAILED + 1))
    fi
fi

# 4. Cloudinary Connection
echo -n "☁️  Cloudinary... " | tee -a $LOG_FILE
CLOUD=$(curl -s "$API_URL/upload/test")
if echo "$CLOUD" | grep -q '"status":"ok"'; then
    echo "✅ PASSED" | tee -a $LOG_FILE
else
    echo "❌ FAILED" | tee -a $LOG_FILE
    FAILED=$((FAILED + 1))
fi

# Summary
echo "" | tee -a $LOG_FILE
echo "============================" | tee -a $LOG_FILE
if [ $FAILED -eq 0 ]; then
    echo "✅ ALL TESTS PASSED" | tee -a $LOG_FILE
    exit 0
else
    echo "❌ $FAILED TEST(S) FAILED" | tee -a $LOG_FILE
    exit 1
fi
