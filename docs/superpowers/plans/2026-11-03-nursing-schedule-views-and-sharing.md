# Nursing Schedule Views and Sharing Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in the current workspace.

**Goal:** Add fast daily/weekly workflows, completion tracking, reusable week templates, and a secure path to shared online schedules.

**Architecture:** Keep the static HTML/CSS/JavaScript page and localStorage as the immediately usable default. Model completion and templates in the existing data record; implement cloud synchronization as a separately configured Supabase adapter with row-level access controls. Publish static files with GitHub Pages after account and project setup.

**Tech Stack:** HTML, CSS, vanilla JavaScript, localStorage; proposed Supabase Auth/Postgres and GitHub Pages for shared access.

**Spec:** `docs/superpowers/specs/2026-11-03-nursing-duty-calendar-design.md`

## Global Constraints

- Keep the interface Thai and responsive.
- Preserve current calendar, colors, backup/restore JSON, PDF print, and localStorage data.
- Never send local data to a remote service without sign-in and explicit migration/sync confirmation.
- Never put a Supabase service-role key in frontend code.
- Replacing a target week with a template requires confirmation.

## Review Focus

- Legacy localStorage without `completed` or `templates` continues to load.
- Completing an entry persists through reload and round-trips through JSON backup/restore.
- Applying a template across month boundaries targets the correct seven dates and does not mark copied entries complete.
- Empty days remain empty when a template is applied; replacing existing entries requires confirmation.
- Cloud records are readable/writable only by schedule members under database row-level security.

---

### Task 1: Add daily and weekly navigation

**Files:** Modify `index.html`.

**Interfaces:** Reuse `shownMonth`, `dateKey`, `data.entries`, and existing render functions.

- [x] Add an at-a-glance today card with entry status and an add/edit shortcut.
- [x] Add month/week view controls and a seven-day list that follows the selected week.
- [x] Keep month navigation and current selected date synchronized with the weekly view.

### Task 2: Add completion tracking

**Files:** Modify `index.html`.

**Interfaces:** Store `done: boolean` on each daily entry; legacy entries default to `false`.

- [x] Add an accessible completion control in today and weekly views.
- [x] Reflect completion in calendar chips and the edit dialog.
- [x] Preserve completion through local save, JSON export, and JSON import.

### Task 3: Add reusable weekly templates

**Files:** Modify `index.html`.

**Interfaces:** Store `templates` as named weekday-to-entry maps in the existing record.

- [x] Save the selected week as a named template.
- [x] List and delete saved templates.
- [x] Apply a selected template to the visible week after confirmation, clearing weekdays absent from the template and resetting completion.

### Task 4: Prepare and enable shared online storage

**Files:** Modify `index.html`; create `supabase/schema.sql` and `supabase/SETUP.md`.

**Interfaces:** A provider adapter exposes sign-in, sign-out, load shared schedule, and save shared schedule. Use one shared schedule with separate user accounts and membership-based access.

- [x] Add a setup screen that remains disabled until a Supabase project URL and public anon key are configured.
- [x] Add Auth and shared-schedule persistence without removing local-only use.
- [x] Add SQL tables and RLS policies for schedule membership and JSON data.
- [x] Provide an explicit, confirmed local-to-cloud migration path.
- [x] Document that user-owned Supabase and hosting accounts are required; never request passwords or one-time codes in chat.

### Task 5: Publish the static site

**Files:** `docs/superpowers/specs/2026-11-03-nursing-duty-calendar-design.md`, `docs/superpowers/plans/2026-11-03-nursing-schedule-views-and-sharing.md`.

- [x] Document GitHub Pages publishing steps after a repository and account are available.
- [ ] Confirm deployed URL and note that local-only mode remains device-specific.

### Task 6: Add scheduled phone reminders

**Files:** Modify `index.html`, `supabase/schema.sql`, `supabase/SETUP.md`; create `manifest.webmanifest`, `sw.js`, `icon.svg`, `supabase/functions/send-duty-reminders/index.ts`, `supabase/functions/send-duty-reminders/deno.json`, and `supabase/cron.sql`.

**Interfaces:** Store each push endpoint with its user, shared schedule, timezone, reminder time, day-before/same-day mode, enabled state, and last-sent date. The Edge Function checks due entries and sends one VAPID-authenticated notification per schedule date.

- [x] Register the PWA service worker and expose an explicit notification-permission action with a 20:00 previous-evening default.
- [x] Store device push subscriptions under RLS policies limited to the signed-in owner.
- [x] Send reminders from a scheduled Edge Function using server-side VAPID and cron secrets.
- [x] Document HTTPS hosting, iPhone Home Screen installation, VAPID generation, Supabase secrets, `pg_cron`/`pg_net`, and deployment steps.
- [x] Keep secrets out of browser code and local logs; notifications only include the duty names and date.
