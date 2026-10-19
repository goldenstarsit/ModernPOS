# ModernPOS

An extensible business point-of-sale platform.

## Initial Goal

Build a reliable POS for one shop on one computer, with an architecture
that supports future expansion to multiple computers, multiple shops,
and different business types with minimal changes.

## Technology Direction

- Frontend: HTML, CSS, and JavaScript
- Backend: Node.js
- Initial database: SQLite
- Future multi-shop database: PostgreSQL, when needed
- Desktop packaging: Electron
- Version control: Git and GitHub

## Development Principles

- Mobile-first, responsive UI for mobile and desktop
- Reuse the same frontend in the browser and Electron
- Separate business logic from database-specific code
- Use migrations and automated tests
- Verify each lesson before committing and pushing to GitHub
- Protect business data with validation, transactions, and backups

## Planned Business Core

- Products and inventory
- Sales and returns
- Purchases and suppliers
- Customers and payments
- Branches, users, permissions, and reporting

## Business-Specific Modules

The initial business module will support pharmacy requirements, including
medicine batches and expiry dates. Future modules may support grocery,
clothing, and other businesses without duplicating the shared core.

## Project Status

The project foundation is being established. Application implementation
will begin after the initial setup is verified.
