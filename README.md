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
- Automated tests: Node.js built-in test runner

## Development Principles

- Mobile-first, responsive UI for mobile and desktop
- Reuse the same frontend in the browser and Electron
- Separate business logic from database-specific code
- Use migrations and automated tests
- Verify each lesson before committing and pushing to GitHub
- Protect business data with validation, transactions, and backups
- Implement features in small, verified steps
- Preserve a clean, working Git state after each completed lesson

## Planned Business Core

- Products and inventory
- Sales and returns
- Purchases and suppliers
- Customers and payments
- Branches, users, permissions, and reporting

## Business-Specific Modules

The initial business module will support pharmacy requirements, including
medicine batches and expiry dates. Future modules will be able to support
grocery, electronics, stationery, clothing, and other business types without
duplicating the shared core.

## First-Run Configuration Requirements

The first-run configuration is a planned final integration phase. Its
underlying logic must not be activated until the application foundation,
business modules, security, reliability, and required tests are ready.

The configuration experience must:

- Open before the normal POS application on a fresh installation.
- Require completion of mandatory configuration before normal use.
- Collect the business identity, including business name and logo.
- Collect the deployment type: single computer, multiple computers,
  or multiple shops.
- Collect the business type, initially including pharmacy, grocery,
  electronics, and stationery, while allowing future types to be added.
- Persist the completed configuration on the server, not only in browser
  storage.
- Enforce setup completion on the server so normal application routes and
  APIs cannot bypass an incomplete setup.
- Remain completed across restarts, page refreshes, and normal logins.
- Prevent the one-time setup wizard from reopening after completion.
- Keep future business identity changes, if needed, in separate authorized
  settings rather than reopening the initial setup wizard.
- Validate configuration data and protect it from accidental reset.
- Include automated tests for incomplete setup, successful completion,
  persistence, and attempts to reopen the wizard.

The setup interface and its final activation must be integrated only after
the underlying application components are ready and verified.

## Development Milestones

1. Project foundation and GitHub workflow.
2. Responsive UI, backend, API, and database foundation.
3. Shared business core and pharmacy module.
4. Security, reliability, automated tests, and backups.
5. Deployment preparation and final first-run configuration integration,
   including single-computer, multi-computer, and multi-shop settings.

## Project Status

- Milestone 1: complete.
- Milestone 2: in progress.
- Milestones 3-5: pending.
- First-run configuration: requirements documented; implementation deferred
  until the final integration phase.
