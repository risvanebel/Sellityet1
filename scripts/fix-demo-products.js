// Fix Demo Products - Set status to published
const fetch = require('node-fetch');

const API_URL = 'https://sellityet1-production.up.railway.app/api';
const ADMIN_EMAIL = 'admin@sellityet.com';
const ADMIN_PASS = 'admin123';

async function login() {
    const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    return data.token;
}

async function getShopProducts(token, shopId) {
    const res = await fetch(`${API_URL}/owner/products`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to get products');
    return data.filter((p) => p.shop_id === shopId);
}

async function updateProduct(token, productId, updates) {
    const res = await fetch(`${API_URL}/owner/products/${productId}`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(updates)
    });
    const data = await res.json();
    if (!res.ok) {
        console.log(`Update error for product ${productId}:`, data.error);
        return null;
    }
    return data;
}

async function main() {
    try {
        console.log('🔐 Logging in...');
        const token = await login();
        console.log('✅ Logged in');

        console.log('📦 Getting demo shop products...');
        const products = await getShopProducts(token, 4);
        console.log(`Found ${products.length} products`);

        for (const product of products) {
            console.log(`Updating: ${product.name} (ID: ${product.id})`);
            await updateProduct(token, product.id, {
                status: 'published',
                is_active: true
            });
        }

        console.log('✅ All products updated to published!');
        console.log('\n🎉 DEMO SHOP NOW LIVE!');
        console.log('========================');
        console.log('🔗 https://sellityet1-production.up.railway.app/shop.html?shop=demo-shop');
        console.log('========================');
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

main();
