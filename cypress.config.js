// cypress.config.js
import { defineConfig } from 'cypress';

export default defineConfig({
  e2e: {
    setupNodeEvents(_on, _config) {
      // Configurar eventos de Cypress aquí.
    },
    baseUrl: 'http://localhost:1234',
  },
});