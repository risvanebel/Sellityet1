const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// Simple HTML-based invoice generator
function generateInvoiceHTML(order, shop) {
    const shippingAddress =
        typeof order.shipping_address === 'string'
            ? JSON.parse(order.shipping_address)
            : order.shipping_address;

    const itemsHtml = order.items
        .map((item) => {
            const price = parseFloat(item.unit_price);
            const total = price * item.quantity;
            return `
            <tr>
                <td>${item.product_name}${item.variant_name ? ` (${item.variant_name})` : ''}</td>
                <td style="text-align: center;">${item.quantity}</td>
                <td style="text-align: right;">€${price.toFixed(2)}</td>
                <td style="text-align: right;">€${total.toFixed(2)}</td>
            </tr>
        `;
        })
        .join('');

    const invoiceDate = new Date(order.created_at).toLocaleDateString('de-DE');

    return `
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <title>Rechnung ${order.order_number}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Helvetica', 'Arial', sans-serif;
            font-size: 12px;
            line-height: 1.4;
            color: #333;
            padding: 40px;
        }
        .header {
            display: flex;
            justify-content: space-between;
            margin-bottom: 40px;
        }
        .shop-info h1 {
            font-size: 24px;
            color: #2563EB;
            margin-bottom: 8px;
        }
        .invoice-title {
            text-align: right;
        }
        .invoice-title h2 {
            font-size: 28px;
            color: #111827;
            margin-bottom: 8px;
        }
        .addresses {
            display: flex;
            justify-content: space-between;
            margin-bottom: 40px;
        }
        .address-box {
            width: 45%;
        }
        .address-box h3 {
            font-size: 14px;
            color: #6B7280;
            margin-bottom: 8px;
            text-transform: uppercase;
        }
        .address-box p {
            line-height: 1.6;
        }
        .details {
            background: #F3F4F6;
            padding: 16px;
            margin-bottom: 30px;
        }
        .details-row {
            display: flex;
            margin-bottom: 8px;
        }
        .details-row:last-child {
            margin-bottom: 0;
        }
        .details-label {
            width: 150px;
            font-weight: 600;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 30px;
        }
        th {
            background: #111827;
            color: white;
            padding: 12px;
            text-align: left;
            font-weight: 600;
        }
        th:last-child, td:last-child {
            text-align: right;
        }
        td {
            padding: 12px;
            border-bottom: 1px solid #E5E7EB;
        }
        .totals {
            width: 300px;
            margin-left: auto;
        }
        .totals-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #E5E7EB;
        }
        .totals-row:last-child {
            border-bottom: none;
            font-size: 16px;
            font-weight: 700;
            color: #111827;
            padding-top: 12px;
            border-top: 2px solid #111827;
        }
        .footer {
            margin-top: 60px;
            padding-top: 20px;
            border-top: 1px solid #E5E7EB;
            font-size: 10px;
            color: #6B7280;
        }
        .footer p {
            margin-bottom: 4px;
        }
        @media print {
            body { padding: 20px; }
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="shop-info">
            <h1>${shop.name}</h1>
            <p>${shop.description || ''}</p>
        </div>
        <div class="invoice-title">
            <h2>RECHNUNG</h2>
            <p>${order.order_number}</p>
        </div>
    </div>
    
    <div class="addresses">
        <div class="address-box">
            <h3>Rechnungsempfänger</h3>
            <p>
                <strong>${order.customer_name}</strong><br>
                ${shippingAddress.street}<br>
                ${shippingAddress.zip} ${shippingAddress.city}<br>
                ${shippingAddress.country}
            </p>
        </div>
        <div class="address-box">
            <h3>Verkäufer</h3>
            <p>
                <strong>${shop.name}</strong><br>
                ${shop.email || ''}<br>
                ${shop.phone || ''}
            </p>
        </div>
    </div>
    
    <div class="details">
        <div class="details-row">
            <span class="details-label">Rechnungsnummer:</span>
            <span>${order.order_number}</span>
        </div>
        <div class="details-row">
            <span class="details-label">Rechnungsdatum:</span>
            <span>${invoiceDate}</span>
        </div>
        <div class="details-row">
            <span class="details-label">Kunden-E-Mail:</span>
            <span>${order.customer_email}</span>
        </div>
        <div class="details-row">
            <span class="details-label">Zahlungsmethode:</span>
            <span>${getPaymentMethodName(order.payment_method)}</span>
        </div>
    </div>
    
    <table>
        <thead>
            <tr>
                <th>Artikel</th>
                <th style="text-align: center;">Menge</th>
                <th style="text-align: right;">Preis</th>
                <th style="text-align: right;">Gesamt</th>
            </tr>
        </thead>
        <tbody>
            ${itemsHtml}
        </tbody>
    </table>
    
    <div class="totals">
        <div class="totals-row">
            <span>Zwischensumme:</span>
            <span>€${parseFloat(order.subtotal || order.total_amount).toFixed(2)}</span>
        </div>
        ${
            order.shipping_cost > 0
                ? `
        <div class="totals-row">
            <span>Versand:</span>
            <span>€${parseFloat(order.shipping_cost).toFixed(2)}</span>
        </div>`
                : '<div class="totals-row"><span>Versand:</span><span>€0.00</span></div>'
        }
        ${
            order.tax_amount > 0
                ? `
        <div class="totals-row">
            <span>Mehrwertsteuer (${order.tax_rate || 19}%):</span>
            <span>€${parseFloat(order.tax_amount).toFixed(2)}</span>
        </div>`
                : ''
        }
        <div class="totals-row">
            <span>Gesamtsumme:</span>
            <span>€${parseFloat(order.total_amount).toFixed(2)}</span>
        </div>
    </div>
    
    <div class="footer">
        ${shop.tax_number ? `<p><strong>Steuernummer:</strong> ${shop.tax_number}</p>` : ''}
        ${shop.vat_id ? `<p><strong>USt-IdNr.:</strong> ${shop.vat_id}</p>` : ''}
        <p><strong>Zahlungsinformationen:</strong></p>
        <p>${getPaymentInstructions(order.payment_method, shop)}</p>
        <p style="margin-top: 12px;">Diese Rechnung wurde elektronisch erstellt und ist ohne Unterschrift gültig.</p>
    </div>
</body>
</html>
    `;
}

function getPaymentMethodName(method) {
    const names = {
        cod: 'Nachnahme',
        banktransfer: 'Überweisung',
        sepa: 'SEPA-Lastschrift',
        creditcard: 'Kreditkarte',
        paypal: 'PayPal',
        paypal_friends: 'PayPal (F&F)',
        crypto: 'Kryptowährung'
    };
    return names[method] || method || 'Unbekannt';
}

function getPaymentInstructions(method, shop) {
    switch (method) {
        case 'banktransfer':
            return `Bitte überweisen Sie den Betrag an:<br>
                    ${shop.bank_account_name || '[Kontoinhaber]'}<br>
                    IBAN: ${shop.bank_account_iban || '[IBAN]'}<br>
                    BIC: ${shop.bank_account_bic || '[BIC]'}`;
        case 'sepa':
            return 'Der Betrag wird per SEPA-Lastschrift eingezogen.';
        case 'cod':
            return 'Bitte bezahlen Sie bei Lieferung.';
        case 'paypal':
        case 'paypal_friends':
            return 'PayPal-Zahlung';
        default:
            return 'Zahlung bei Bestellung';
    }
}

// Generate PDF from HTML
async function generateInvoicePDF(order, shop) {
    const html = generateInvoiceHTML(order, shop);

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });

        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' }
        });

        return pdf;
    } catch (error) {
        console.error('PDF generation error:', error);
        throw error;
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = {
    generateInvoiceHTML,
    generateInvoicePDF
};
