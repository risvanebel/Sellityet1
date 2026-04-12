const { test, expect } = require('@playwright/test');

test.describe('Shop Frontend E2E', () => {
    test('Lade die Shop-Startseite', async ({ page }) => {
        // Navigiere zur Live-Seite
        await page.goto('https://sellityet1-production.up.railway.app/');

        // Prüfe, ob die Seite grundlegend geladen hat
        await expect(page).toHaveTitle(/Shop|Sellityet/i);

        // Screenshot als Beweis
        await page.screenshot({ path: 'tests/screenshot-e2e.png' });
    });
});
