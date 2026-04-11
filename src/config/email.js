const nodemailer = require('nodemailer');

// Configure email transporter
// Using Gmail SMTP as default - can be changed to any provider
const transporter = nodemailer.createTransporter({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Verify connection on startup
transporter.verify((error, success) => {
  if (error) {
    console.error('❌ Email configuration error:', error.message);
  } else {
    console.log('✅ Email server ready');
  }
});

async function sendOrderConfirmation(to, order, shop) {
  const itemsHtml = order.items.map(item => `
    <tr>
      <td style="padding: 10px; border-bottom: 1px solid #eee;">
        ${item.product_name}
        ${item.variant_name ? `<br><small style="color: #666;">${item.variant_name}</small>` : ''}
      </td>
      <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity}</td>
      <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right;">€${parseFloat(item.unit_price).toFixed(2)}</td>
      <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right;">€${(item.quantity * parseFloat(item.unit_price)).toFixed(2)}</td>
    </tr>
  `).join('');

  const shippingAddress = typeof order.shipping_address === 'string' 
    ? JSON.parse(order.shipping_address) 
    : order.shipping_address;

  const mailOptions = {
    from: `"${shop.name}" <${process.env.SMTP_USER}>`,
    to: to,
    subject: `Bestellbestätigung ${order.order_number}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #2563EB; color: white; padding: 30px; text-align: center;">
          <h1 style="margin: 0;">${shop.name}</h1>
          <p style="margin: 10px 0 0 0;">Bestellbestätigung</p>
        </div>
        
        <div style="padding: 30px; background: #f9fafb;">
          <h2 style="color: #111827;">Vielen Dank für Ihre Bestellung!</h2>
          <p style="color: #4b5563; font-size: 16px;">
            Bestellnummer: <strong>${order.order_number}</strong><br>
            Datum: ${new Date(order.created_at).toLocaleDateString('de-DE')}
          </p>
          
          <h3 style="color: #111827; margin-top: 30px;">Bestellte Artikel</h3>
          <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
            <thead>
              <tr style="background: #e5e7eb;">
                <th style="padding: 10px; text-align: left;">Produkt</th>
                <th style="padding: 10px; text-align: center;">Menge</th>
                <th style="padding: 10px; text-align: right;">Preis</th>
                <th style="padding: 10px; text-align: right;">Gesamt</th>
              </tr>
            </thead>
            <tbody>
              ${itemsHtml}
            </tbody>
            <tfoot>
              <tr>
                <td colspan="3" style="padding: 15px 10px; text-align: right; font-weight: bold;">Gesamtsumme:</td>
                <td style="padding: 15px 10px; text-align: right; font-weight: bold; font-size: 18px;">€${parseFloat(order.total_amount).toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>
          
          <h3 style="color: #111827; margin-top: 30px;">Lieferadresse</h3>
          <p style="color: #4b5563;">
            ${order.customer_name}<br>
            ${shippingAddress.street}<br>
            ${shippingAddress.zip} ${shippingAddress.city}<br>
            ${shippingAddress.country}
          </p>
          
          <div style="margin-top: 30px; padding: 20px; background: #dbeafe; border-radius: 8px;">
            <h4 style="color: #1e40af; margin: 0 0 10px 0;">Nächste Schritte</h4>
            <p style="color: #1e40af; margin: 0;">
              Wir bearbeiten Ihre Bestellung und senden Ihnen eine Versandbestätigung, 
              sobald Ihre Artikel unterwegs sind.
            </p>
          </div>
        </div>
        
        <div style="background: #111827; color: white; padding: 20px; text-align: center;">
          <p style="margin: 0; font-size: 14px;">
            ${shop.name}<br>
            <a href="https://sellityet1-production.up.railway.app/shop/${shop.slug}" style="color: #60a5fa;">
              Zum Shop
            </a>
          </p>
        </div>
      </div>
    `
  };

  return transporter.sendMail(mailOptions);
}

async function sendOrderNotificationToOwner(order, shop, ownerEmail) {
  const itemsHtml = order.items.map(item => `
    <tr>
      <td style="padding: 8px; border-bottom: 1px solid #eee;">${item.product_name}</td>
      <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity}</td>
    </tr>
  `).join('');

  const mailOptions = {
    from: `"${shop.name}" <${process.env.SMTP_USER}>`,
    to: ownerEmail,
    subject: `🛒 Neue Bestellung ${order.order_number}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563EB;">Neue Bestellung eingegangen!</h2>
        <p><strong>Bestellnummer:</strong> ${order.order_number}</p>
        <p><strong>Kunde:</strong> ${order.customer_name}</p>
        <p><strong>E-Mail:</strong> ${order.customer_email}</p>
        <p><strong>Telefon:</strong> ${order.customer_phone || 'Nicht angegeben'}</p>
        <p><strong>Gesamtbetrag:</strong> €${parseFloat(order.total_amount).toFixed(2)}</p>
        
        <h3>Artikel:</h3>
        <table style="width: 100%; border-collapse: collapse;">
          ${itemsHtml}
        </table>
        
        <p style="margin-top: 20px;">
          <a href="https://sellityet1-production.up.railway.app/admin.html" 
             style="background: #2563EB; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
            Bestellung ansehen
          </a>
        </p>
      </div>
    `
  };

  return transporter.sendMail(mailOptions);
}

async function sendShippingConfirmation(to, order, shop, trackingNumber) {
  const trackingInfo = trackingNumber 
    ? `<p><strong>Tracking-Nummer:</strong> ${trackingNumber}</p>` 
    : '';

  const mailOptions = {
    from: `"${shop.name}" <${process.env.SMTP_USER}>`,
    to: to,
    subject: `Ihre Bestellung ${order.order_number} wurde versendet`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #10B981; color: white; padding: 30px; text-align: center;">
          <h1 style="margin: 0;">📦 Versandbestätigung</h1>
        </div>
        
        <div style="padding: 30px;">
          <h2>Gute Nachrichten!</h2>
          <p>Ihre Bestellung <strong>${order.order_number}</strong> wurde soeben versendet.</p>
          
          ${trackingInfo}
          
          <p style="margin-top: 20px;">
            Vielen Dank für Ihren Einkauf bei ${shop.name}!
          </p>
        </div>
      </div>
    `
  };

  return transporter.sendMail(mailOptions);
}

module.exports = {
  sendOrderConfirmation,
  sendOrderNotificationToOwner,
  sendShippingConfirmation
};
