const stripe = require('stripe');
const paypal = require('@paypal/checkout-server-sdk');

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
    name: 'PayPal Business',
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
  return enabled.map(id => PAYMENT_METHODS[id]).filter(Boolean);
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

// Initialize PayPal for shop
function getPayPalClient(shop) {
  const clientId = shop.paypal_client_id || process.env.PAYPAL_CLIENT_ID;
  const clientSecret = shop.paypal_client_secret || process.env.PAYPAL_CLIENT_SECRET;
  
  if (!clientId || !clientSecret) {
    return null;
  }
  
  const environment = shop.paypal_mode === 'live' 
    ? new paypal.core.LiveEnvironment(clientId, clientSecret)
    : new paypal.core.SandboxEnvironment(clientId, clientSecret);
    
  return new paypal.core.PayPalHttpClient(environment);
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

// Create PayPal Order
async function createPayPalOrder(order, shop) {
  const paypalClient = getPayPalClient(shop);
  if (!paypalClient) {
    throw new Error('PayPal not configured');
  }
  
  const request = new paypal.orders.OrdersCreateRequest();
  request.requestBody({
    intent: 'CAPTURE',
    purchase_units: [{
      amount: {
        currency_code: 'EUR',
        value: order.total_amount.toFixed(2)
      },
      reference_id: order.order_number
    }]
  });
  
  const response = await paypalClient.execute(request);
  return {
    order_id: response.result.id
  };
}

// Capture PayPal Payment
async function capturePayPalOrder(paypalOrderId, shop) {
  const paypalClient = getPayPalClient(shop);
  if (!paypalClient) {
    throw new Error('PayPal not configured');
  }
  
  const request = new paypal.orders.OrdersCaptureRequest(paypalOrderId);
  request.requestBody({});
  
  const response = await paypalClient.execute(request);
  return response.result;
}

// Generate crypto payment address (simplified - in production use a service)
async function createCryptoPayment(order, currency = 'BTC') {
  // This is a placeholder - in production, integrate with Coinbase Commerce, BitPay, etc.
  const addresses = {
    BTC: process.env.CRYPTO_BTC_ADDRESS,
    ETH: process.env.CRYPTO_ETH_ADDRESS
  };
  
  const address = addresses[currency];
  if (!address) {
    throw new Error('Crypto address not configured');
  }
  
  // Get current exchange rate (in production, use real API)
  const rates = {
    BTC: 0.000015, // Example: 1 EUR = 0.000015 BTC
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
  getPayPalClient,
  createStripePaymentIntent,
  createPayPalOrder,
  capturePayPalOrder,
  createCryptoPayment
};
