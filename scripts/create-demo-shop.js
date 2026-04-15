// Demo-Shop Setup Script
const fetch = require('node-fetch');

const API_URL = process.env.API_URL || 'https://sellityet1-production.up.railway.app/api';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@sellityet.com';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

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

async function createShop(token) {
    const res = await fetch(`${API_URL}/owner/shops`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
            name: 'Demo Shop',
            slug: 'demo-shop',
            description: 'Ein Demo-Shop zum Testen',
            primary_color: '#0078D4'
        })
    });
    const data = await res.json();
    if (!res.ok) {
        if (data.error?.includes('exists')) {
            console.log('Shop already exists, getting existing...');
            const shopsRes = await fetch(`${API_URL}/owner/shops`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const shops = await shopsRes.json();
            return shops.find((s) => s.slug === 'demo-shop') || shops[0];
        }
        throw new Error(data.error || 'Create shop failed');
    }
    return data;
}

async function createProduct(token, shopId, product) {
    const res = await fetch(`${API_URL}/owner/products`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
            shop_id: shopId,
            cost_price: Math.round(product.price * 0.5 * 100) / 100, // 50% margin
            ...product
        })
    });
    const data = await res.json();
    if (!res.ok) {
        console.log('Product creation error:', data.error);
        return null;
    }
    return data;
}

async function main() {
    try {
        console.log('🔐 Logging in as admin...');
        const token = await login();
        console.log('✅ Logged in successfully');

        console.log('🏪 Creating demo shop...');
        const shop = await createShop(token);
        console.log(`✅ Shop ready: ${shop.name} (ID: ${shop.id})`);

        const demoProducts = [
            {
                name: 'Premium T-Shirt',
                description: 'Hochwertiges Baumwoll-T-Shirt in verschiedenen Farben',
                price: 29.99,
                cost_price: 15.0,
                stock: 50,
                category: 'Bekleidung'
            },
            {
                name: 'Sport Hoodie',
                description: 'Bequemer Hoodie für Sport und Freizeit',
                price: 49.99,
                cost_price: 25.0,
                stock: 30,
                category: 'Bekleidung'
            },
            {
                name: 'Baseball Cap',
                description: 'Klassische Basecap mit verstellbarem Verschluss',
                price: 19.99,
                cost_price: 8.0,
                stock: 100,
                category: 'Accessoires'
            },
            {
                name: 'Trinkflasche',
                description: 'Edelstahl Trinkflasche, 500ml, BPA-frei',
                price: 14.99,
                cost_price: 6.5,
                stock: 75,
                category: 'Accessoires'
            }
        ];

        console.log('📦 Adding demo products...');
        for (const product of demoProducts) {
            await createProduct(token, shop.id, product);
            console.log(`  ✅ ${product.name}`);
        }

        console.log('\n🎉 DEMO SHOP READY!');
        console.log('========================');
        console.log(
            `🔗 Shop URL: https://sellityet1-production.up.railway.app/shop.html?shop=${shop.slug}`
        );
        console.log(`🏪 Shop Name: ${shop.name}`);
        console.log(`📦 Products: ${demoProducts.length}`);
        console.log('========================');
        console.log('\n📱 So sieht ein Kunde den Shop:');
        console.log(`   https://sellityet1-production.up.railway.app/shop.html?shop=${shop.slug}`);
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

main();
