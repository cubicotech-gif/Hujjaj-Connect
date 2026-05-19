# Hujjaj Connect

Hajj field-ops tool for Billoo Travels. Upload your hujjaj list, search by name,
add hotel/room/bus, then one tap opens WhatsApp with the message pre-filled
(no saving contacts, no ban risk). Team-synced in real time, installable as a
phone app.

Stack: Next.js 14 (App Router) - TypeScript - Supabase (Postgres + Realtime) -
PWA - Vercel. No login: anyone with the URL can use it.

--------------------------------------------------------------------

## 1. Supabase (database)
1. Create a project at supabase.com.
2. SQL Editor -> New query -> paste all of supabase/schema.sql -> Run.
3. Project Settings -> API -> copy the Project URL and the anon public key.
   (No Auth setup needed.)

## 2. GitHub
    git init
    git add .
    git commit -m "Hujjaj Connect"
    git branch -M main
    git remote add origin https://github.com/<you>/hujjaj-connect.git
    git push -u origin main

## 3. Vercel
1. vercel.com -> Add New -> Project -> import the repo.
2. Framework preset: Next.js (auto-detected).
3. Environment Variables, add both:
     NEXT_PUBLIC_SUPABASE_URL        = your Project URL
     NEXT_PUBLIC_SUPABASE_ANON_KEY   = your anon public key
4. Deploy. Every push to main auto-deploys.

## 4. Install on phone
Open the Vercel URL -> Add to Home Screen. Full-screen, survives bad signal.

--------------------------------------------------------------------

## Local dev
    cp .env.example .env.local      # fill the two Supabase values
    npm install
    npm run dev                     # http://localhost:3000

## WhatsApp
Official wa.me click-to-chat links. The chat opens with the message already
typed, for any number, no contact saved. You press Send. True automated bulk
sending needs the paid WhatsApp Business Cloud API (a post-Hajj project).

## Security note (read once)
No authentication. Anyone with the deployed URL can view and edit every
pilgrim's name and phone number. Keep the URL private. A shared-passcode gate
is a small change away if you want it later.

## Notes
- Edits sync live across devices via Supabase Realtime.
- Settings -> Export backup / CSV before big imports.
- Phone normalisation uses a configurable default country code
  (Pakistan = 92, Saudi = 966), set in Settings.
