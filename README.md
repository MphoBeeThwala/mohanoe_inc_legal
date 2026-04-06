# Mohanoe Inc. Legal Practice Management

A full-featured legal practice management system for **Mohanoe Inc. Attorneys**, built for the South African legal market.

## Project Status
- `mohanoe_inc_legal_mvp.html` — Preserved MVP (single-file prototype, do not modify)
- `index.html` — Active development entry point

## Features (MVP)
- Dashboard with case statistics and court calendar
- Case management with practice area filtering
- Client management (10,000+ client capacity)
- New client intake with POPIA consent gate and 11 official languages
- CaseTrack live tracking
- LegalAI Research assistant
- Document Vault
- Billing & Invoicing
- Staff & Advocates management
- Court Calendar

## Roadmap (Full App)
- [ ] Backend API (Node.js / Supabase)
- [ ] Authentication & role-based access control
- [ ] Real-time case updates
- [ ] Document upload & e-signing
- [ ] Invoice generation & payment integration
- [ ] SMS/WhatsApp client notifications (multilingual)
- [ ] Court date automated reminders
- [ ] Mobile-responsive PWA
- [ ] Offline support

## Tech Stack
- **Frontend:** HTML5, CSS3, Vanilla JS (MVP) → React + TailwindCSS (Full App)
- **Icons:** Inline SVG
- **Fonts:** Inter (Google Fonts)

## Project Structure
```
mohanoe_inc_legal/
├── mohanoe_inc_legal_mvp.html   # Preserved MVP snapshot
├── index.html                   # Development entry point
├── src/
│   ├── css/                     # Extracted stylesheets
│   ├── js/                      # Extracted scripts & modules
│   └── components/              # Reusable UI components
├── assets/                      # Images, icons, fonts
└── README.md
```

## Setup
Open `index.html` in a browser or serve with any static file server:
```bash
npx serve .
```

## Compliance
- **POPIA** (Protection of Personal Information Act 4 of 2013)
- **Legal Practice Act 28 of 2014**
- Data encrypted at rest (AES-256)
