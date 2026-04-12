const request = require('supertest');

// Für lokale Tests könnten wir die Express-App exportieren,
// aber hier testen wir direkt die Live/Staging-Umgebung, um echte Integrationstests zu haben.
const API_URL = process.env.TEST_API_URL || 'https://sellityet1-production.up.railway.app';

describe('Shop API Endpoints', () => {
    test('GET /api/health sollte 200 OK zurückgeben', async () => {
        const response = await request(API_URL).get('/api/health');
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('status', 'ok');
        expect(response.body).toHaveProperty('database', 'connected');
    });

    test('GET /api/shops sollte eine Liste der Shops zurückgeben', async () => {
        const response = await request(API_URL).get('/api/shops');
        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBeTruthy();
        if (response.body.length > 0) {
            expect(response.body[0]).toHaveProperty('id');
            expect(response.body[0]).toHaveProperty('name');
        }
    });
});
