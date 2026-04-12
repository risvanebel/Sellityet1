const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Sellityet MicroStore API',
            version: '1.0.0',
            description: 'API Dokumentation für die Sellityet White-Label Plattform'
        },
        servers: [
            {
                url: 'https://sellityet1-production.up.railway.app',
                description: 'Live Server (Railway)'
            },
            {
                url: 'http://localhost:3000',
                description: 'Lokaler Entwicklungsserver'
            }
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT'
                }
            }
        },
        security: [
            {
                bearerAuth: []
            }
        ]
    },
    // Wir sagen Swagger, wo es nach JSDoc-Kommentaren für API-Endpunkte suchen soll:
    apis: ['./index.js', './src/routes/*.js']
};

const specs = swaggerJsdoc(options);

module.exports = { swaggerUi, specs };
