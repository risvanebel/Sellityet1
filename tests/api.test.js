// API Test Suite for Sellityet
// Run with: node tests/api.test.js

const API_URL = process.env.TEST_API_URL || 'https://sellityet1-production.up.railway.app/api';
const TEST_EMAIL = process.env.TEST_EMAIL || 'admin@sellityet.com';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'admin123';

let authToken = null;
let testShopId = null;
let testProductId = null;

// Simple test runner
async function runTests() {
    console.log('🧪 Starting API Tests...\n');
    
    const tests = [
        { name: 'Login', fn: testLogin },
        { name: 'Get Shops', fn: testGetShops },
        { name: 'Create Product', fn: testCreateProduct },
        { name: 'Create Product with Image', fn: testCreateProductWithImage },
        { name: 'Create Variants', fn: testCreateVariants },
        { name: 'Update Product (no duplicate variants)', fn: testUpdateProduct },
        { name: 'Image Upload', fn: testImageUpload },
    ];
    
    let passed = 0;
    let failed = 0;
    
    for (const test of tests) {
        try {
            console.log(`⏳ ${test.name}...`);
            await test.fn();
            console.log(`✅ ${test.name} passed\n`);
            passed++;
        } catch (error) {
            console.log(`❌ ${test.name} failed: ${error.message}\n`);
            failed++;
        }
    }
    
    console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

// Test 1: Login
async function testLogin() {
    const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD })
    });
    
    const data = await res.json();
    if (!res.ok || !data.token) {
        throw new Error(`Login failed: ${data.error || 'No token'}`);
    }
    authToken = data.token;
}

// Test 2: Get Shops
async function testGetShops() {
    const res = await fetch(`${API_URL}/owner/shops`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
    });
    
    const data = await res.json();
    if (!res.ok) {
        throw new Error(`Get shops failed: ${data.error}`);
    }
    
    if (data.length > 0) {
        testShopId = data[0].id;
    }
}

// Test 3: Create Product
async function testCreateProduct() {
    if (!testShopId) {
        console.log('   ⚠️  Skipping (no shop found)');
        return;
    }
    
    const res = await fetch(`${API_URL}/owner/products`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
            shop_id: testShopId,
            name: 'Test Product ' + Date.now(),
            price: 19.99,
            status: 'draft'
        })
    });
    
    const data = await res.json();
    if (!res.ok) {
        throw new Error(`Create product failed: ${data.error}`);
    }
    
    testProductId = data.id;
}

// Test 4: Create Product with Image
async function testCreateProductWithImage() {
    if (!testShopId) {
        console.log('   ⚠️  Skipping (no shop found)');
        return;
    }
    
    const res = await fetch(`${API_URL}/owner/products`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
            shop_id: testShopId,
            name: 'Test Product With Image ' + Date.now(),
            price: 29.99,
            image_urls: ['https://example.com/test-image.jpg'],
            status: 'draft'
        })
    });
    
    const data = await res.json();
    if (!res.ok) {
        throw new Error(`Create product with image failed: ${data.error}`);
    }
    
    if (!data.image_urls || data.image_urls.length === 0) {
        throw new Error('Image URLs not saved');
    }
}

// Test 5: Create Variants
async function testCreateVariants() {
    if (!testProductId) {
        console.log('   ⚠️  Skipping (no product found)');
        return;
    }
    
    // Create first variant
    const res1 = await fetch(`${API_URL}/owner/products/${testProductId}/variants`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
            name: '10ml',
            price_adjustment: 0,
            stock: 10
        })
    });
    
    if (!res1.ok) {
        const data = await res1.json();
        throw new Error(`Create variant failed: ${data.error}`);
    }
    
    // Create second variant
    const res2 = await fetch(`${API_URL}/owner/products/${testProductId}/variants`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
            name: '30ml',
            price_adjustment: 5,
            stock: 5
        })
    });
    
    if (!res2.ok) {
        const data = await res2.json();
        throw new Error(`Create second variant failed: ${data.error}`);
    }
}

// Test 6: Update Product (check for duplicate variants)
async function testUpdateProduct() {
    if (!testProductId) {
        console.log('   ⚠️  Skipping (no product found)');
        return;
    }
    
    // Get current variants count
    const variantsRes = await fetch(`${API_URL}/owner/products/${testProductId}/variants`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const variantsBefore = await variantsRes.json();
    const countBefore = variantsBefore.length;
    
    // Update product
    const res = await fetch(`${API_URL}/owner/products/${testProductId}`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
            name: 'Updated Product ' + Date.now(),
            price: 24.99,
            status: 'draft'
        })
    });
    
    if (!res.ok) {
        const data = await res.json();
        throw new Error(`Update product failed: ${data.error}`);
    }
    
    // Check variants weren't duplicated
    const variantsResAfter = await fetch(`${API_URL}/owner/products/${testProductId}/variants`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const variantsAfter = await variantsResAfter.json();
    
    if (variantsAfter.length !== countBefore) {
        throw new Error(`Variant count changed from ${countBefore} to ${variantsAfter.length} - possible duplication!`);
    }
}

// Test 7: Image Upload
async function testImageUpload() {
    // Create a simple 1x1 pixel PNG (base64)
    const base64Image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const buffer = Buffer.from(base64Image, 'base64');
    
    const formData = new FormData();
    const blob = new Blob([buffer], { type: 'image/png' });
    formData.append('image', blob, 'test.png');
    
    const res = await fetch(`${API_URL}/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` },
        body: formData
    });
    
    const data = await res.json();
    if (!res.ok) {
        throw new Error(`Image upload failed: ${data.error}`);
    }
    
    if (!data.url || !data.url.includes('cloudinary')) {
        throw new Error('Invalid upload URL');
    }
}

// Polyfills for Node.js
if (typeof fetch === 'undefined') {
    global.fetch = require('node-fetch');
}
if (typeof FormData === 'undefined') {
    global.FormData = require('form-data');
}
if (typeof Blob === 'undefined') {
    global.Blob = require('buffer').Blob;
}

// Run tests
runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});