const stripe = require('stripe');

// Available payment methods
const PAYMENT_METHODS = {
    cod: {
        id: 'cod',
        name: 'Nachnahme',
        description: 'Bezahlung bei Lieferung',
        icon: '💶',
        type: 'manual'
    },
    banktransfer: {
        id: 'banktransfer',
        name: 'Überweisung',
        description: 'Bezahlung per Banküberweisung',
        icon: '🏦',
        type: 'manual'
    },
    sepa: {
        id: 'sepa',
        name: 'Lastschrift (SEPA)',
        description: 'Bezahlung per SEPA-Lastschrift',
        icon: '📋',
        type: 'manual'
    },
    creditcard: {
        id: 'creditcard',
        name: 'Kreditkarte',
        description: 'Visa, MasterCard, American Express',
        icon: '💳',
        type: 'stripe'
    },
    paypal: {
        id: 'paypal',
        name: 'PayPal',
        description: 'Sichere Zahlung per PayPal',
        icon: '🅿️',
        type: 'paypal'
    },
    paypal_friends: {
        id: 'paypal_friends',
        name: 'PayPal Freunde & Familie',
        description: 'Direkte PayPal-Überweisung',
        icon: '💸',
        type: 'manual'
    },
    crypto: {
        id: 'crypto',
        name: 'Kryptowährung',
        description: 'Bitcoin, Ethereum, etc.',
        icon: '₿',
        type: 'crypto'
    }
};

// Get enabled payment methods for shop
function getEnabledPaymentMethods(shop) {
    const enabled = shop.payment_methods || ['banktransfer', 'cod'];
    return enabled.map((id) => PAYMENT_METHODS[id]).filter(Boolean);
}

// Initialize Stripe for shop
function getStripeClient(shop) {
    if (shop.stripe_secret_key) {
        return stripe(shop.stripe_secret_key);
    }
    if (process.env.STRIPE_SECRET_KEY) {
        return stripe(process.env.STRIPE_SECRET_KEY);
    }
    return null;
}

// Create Stripe Payment Intent
async function createStripePaymentIntent(order, shop) {
    const stripeClient = getStripeClient(shop);
    if (!stripeClient) {
        throw new Error('Stripe not configured');
    }

    const paymentIntent = await stripeClient.paymentIntents.create({
        amount: Math.round(order.total_amount * 100), // Convert to cents
        currency: 'eur',
        metadata: {
            order_id: order.id,
            order_number: order.order_number
        }
    });

    return {
        client_secret: paymentIntent.client_secret,
        payment_intent_id: paymentIntent.id
    };
}

// Simple PayPal integration without SDK
async function createPayPalOrder(order, shop) {
    const clientId = shop.paypal_client_id || process.env.PAYPAL_CLIENT_ID;
    const clientSecret = shop.paypal_client_secret || process.env.PAYPAL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('PayPal not configured');
    }

    const isLive = shop.paypal_mode === 'live';
    const baseUrl = isLive ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

    // Get access token
    const authResponse = await fetch(`${baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
            Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });

    const authData = await authResponse.json();

    if (!authResponse.ok) {
        throw new Error('PayPal authentication failed');
    }

    // Create order
    const orderResponse = await fetch(`${baseUrl}/v2/checkout/orders`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${authData.access_token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            intent: 'CAPTURE',
            purchase_units: [
                {
                    amount: {
                        currency_code: 'EUR',
                        value: order.total_amount.toFixed(2)
                    },
                    reference_id: order.order_number
                }
            ]
        })
    });

    const orderData = await orderResponse.json();

    if (!orderResponse.ok) {
        throw new Error('PayPal order creation failed');
    }

    return {
        order_id: orderData.id
    };
}

// Capture PayPal Payment
async function capturePayPalOrder(paypalOrderId, shop) {
    const clientId = shop.paypal_client_id || process.env.PAYPAL_CLIENT_ID;
    const clientSecret = shop.paypal_client_secret || process.env.PAYPAL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('PayPal not configured');
    }

    const isLive = shop.paypal_mode === 'live';
    const baseUrl = isLive ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

    // Get access token
    const authResponse = await fetch(`${baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
            Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });

    const authData = await authResponse.json();

    // Capture order
    const captureResponse = await fetch(`${baseUrl}/v2/checkout/orders/${paypalOrderId}/capture`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${authData.access_token}`,
            'Content-Type': 'application/json'
        }
    });

    return await captureResponse.json();
}

// Generate crypto payment address (simplified)
async function createCryptoPayment(order, currency = 'BTC') {
    const addresses = {
        BTC: process.env.CRYPTO_BTC_ADDRESS,
        ETH: process.env.CRYPTO_ETH_ADDRESS
    };

    const address = addresses[currency];
    if (!address) {
        throw new Error('Crypto address not configured');
    }

    // Get current exchange rate (simplified - use real API in production)
    const rates = {
        BTC: 0.000015,
        ETH: 0.00028
    };

    return {
        currency,
        address,
        amount: (order.total_amount * rates[currency]).toFixed(8),
        qr_code: `bitcoin:${address}?amount=${(order.total_amount * rates[currency]).toFixed(8)}`
    };
}

module.exports = {
    PAYMENT_METHODS,
    getEnabledPaymentMethods,
    getStripeClient,
    createStripePaymentIntent,
    createPayPalOrder,
    capturePayPalOrder,
    createCryptoPayment
};
