#!/bin/bash
# Quick API Test Script for Sellityet
# Usage: ./tests/quick-test.sh

API_URL="https://sellityet1-production.up.railway.app/api"
EMAIL="admin@sellityet.com"
PASSWORD="admin123"

echo "🧪 Sellityet API Quick Test"
echo "============================"

# 1. Login
echo -n "⏳ Testing Login... "
LOGIN_RESPONSE=$(curl -s -X POST "$API_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")

TOKEN=$(echo $LOGIN_RESPONSE | grep -o '"token":"[^"]*' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
    echo "❌ Failed"
    echo "Response: $LOGIN_RESPONSE"
    exit 1
else
    echo "✅ Passed"
fi

# 2. Get Shops
echo -n "⏳ Testing Get Shops... "
SHOPS_RESPONSE=$(curl -s "$API_URL/owner/shops" \
  -H "Authorization: Bearer $TOKEN")

if echo "$SHOPS_RESPONSE" | grep -q '"id"'; then
    echo "✅ Passed"
    SHOP_ID=$(echo $SHOPS_RESPONSE | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
    echo "   Found shop ID: $SHOP_ID"
else
    echo "❌ Failed"
    echo "Response: $SHOPS_RESPONSE"
fi

# 3. Create Product with Image
echo -n "⏳ Testing Create Product with Image... "
if [ -n "$SHOP_ID" ]; then
    PRODUCT_RESPONSE=$(curl -s -X POST "$API_URL/owner/products" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"shop_id\":$SHOP_ID,\"name\":\"Test Product $(date +%s)\",\"price\":19.99,\"image_urls\":[\"https://example.com/test.jpg\"]}")
    
    if echo "$PRODUCT_RESPONSE" | grep -q '"image_urls"'; then
        echo "✅ Passed"
        echo "   Image saved: $(echo $PRODUCT_RESPONSE | grep -o '"image_urls":\[[^]]*\]')"
    else
        echo "❌ Failed"
        echo "Response: $PRODUCT_RESPONSE"
    fi
else
    echo "⚠️ Skipped (no shop)"
fi

# 4. Cloudinary Connection
echo -n "⏳ Testing Cloudinary Connection... "
CLOUD_TEST=$(curl -s "$API_URL/upload/test")

if echo "$CLOUD_TEST" | grep -q '"status":"ok"'; then
    echo "✅ Passed"
else
    echo "❌ Failed"
    echo "Response: $CLOUD_TEST"
fi

echo ""
echo "============================"
echo "✅ Quick test completed!"
