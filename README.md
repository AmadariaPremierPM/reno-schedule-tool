# Renovation Schedule Generator

A small local web app that builds a new renovation project schedule directly in Smartsheet,
based on your existing standard templates.

**AUM projects** use the templates in the "Schedule Templates - AUM" workspace (single
scope selection): Guestroom, Model Room, Public Space Full, Public Space Select.

**Third Party projects** use the templates in the "Schedule Templates - Third Party"
workspace. Scope is multi-select (Guestroom / Model Room / Public Space, with Public Space
as a single option — no Full/Select split). Currently only one combination is configured:
selecting all three scopes together routes to **"All Services - GR, MR, PS"**. Selecting
any other combination will show a clear "not configured yet" message until more templates
are added (see "Updating the templates later" below).

It copies the right template, trims out any services you didn't select (skipped for the
combined "All Services" template, since it's inherently all-services already; AUM always
keeps all four), sets the start date, and lets Smartsheet's own dependency engine (the
Predecessors column already built into these sheets) recalculate every other date
automatically.

**Start date behavior:** the date you enter always becomes the "Arch SD" date.
- Simple templates (one "Arch SD" row): set directly.
- The combined "All Services" template has a "Concept" row that the Guestroom/Model Room
  "Arch SD" mirrors exactly — so the tool sets Concept to your input date and also syncs
  that Arch SD row to match. The Public Space "Arch SD" is left alone, running on its own
  offset from the rest of the template.

New schedules default to the **"Automated Schedule Builder"** workspace unless you browse to
a different location. The sheet's title is just the **Project Name**. **Location** and the
**start date** (labeled "Construction Start Date" for AUM, "Project Start Date" for Third
Party) are recorded in the sheet's Summary panel, not as grid rows. The **Notes/Comments**
column is kept on every generated schedule, but its content from the template is always
cleared.

## Why this runs locally instead of as a hosted website

Smartsheet's API doesn't allow direct calls from JavaScript running in a browser on another
website (a CORS restriction) — a hosted web app couldn't talk to your Smartsheet account
directly. Running it locally solves this cleanly: the app talks to Smartsheet from your own
machine, and your API token never leaves your computer.

## Setup (one-time)

1. **Install Node.js** if you don't have it already: https://nodejs.org (v18 or later).
2. **Get a Smartsheet API token**:
   In Smartsheet, click your account icon (top right) → **Apps & Integrations** →
   **API Access** → **Generate new access token**. Copy it.
3. **Configure the app**:
   - In this folder, copy `.env.example` to a new file named `.env`
   - Open `.env` and paste your token after `SMARTSHEET_API_TOKEN=`
4. **Install dependencies** (run once, from this folder):
   ```
   npm install
   ```

## Running it

**Easiest way:** double-click **`Start-Mac.command`** (Mac) or **`Start-Windows.bat`**
(Windows) in this folder. It starts the server and opens the right page in your browser
automatically. A terminal window will open and must stay open while you use the app —
closing it stops the server.

**Manual way:** from a terminal, in this folder:
```
npm start
```
Then open **http://localhost:3535** in your browser — type that address directly, don't
double-click any file to get there.

⚠️ **Do not double-click `public/index.html` directly.** That opens the page without the
server behind it, which causes a "Failed to fetch" error on every action. If you see that
error, this is almost always why — go to `http://localhost:3535` in the browser instead.

## Using the app

1. Choose **Project Type** — Third Party or AUM.
2. Choose the **Scope** — Guestroom, Model Room, or Public Space (Select or Full Service).
3. If Third Party, pick which **Services** are being rendered (Architecture, Interior Design,
   Procurement, Project Management). AUM projects automatically include all four.
4. Enter the **Project Name**, **Location**, and **start date**.
5. Destination defaults to "Automated Schedule Builder" — browse to a different folder or
   workspace if needed (click a name to open it, or "Use this location" to select it).
6. Click **Generate Schedule in Smartsheet**. When it finishes, click the link to open the
   new schedule directly in Smartsheet.

## Managing templates (no code editing needed)

Click **⚙ Manage Templates** at the top of the generator (or go to
`http://localhost:3535/admin.html`) to:

- **Change the default destination** — browse Smartsheet and pick a new default
  folder/workspace for generated schedules.
- **Change any AUM template** — one sheet per scope (Guestroom, Model Room, Public Space
  Full, Public Space Select). Click "Change" next to a scope, browse to the new sheet, and
  select it.
- **Add or remove Third Party templates** — click "+ Add new template," check the scopes it
  covers, check the services it includes, browse for the sheet, and save. Check "skip
  service filtering" only if the template is inherently "all services" (like the combined
  GR/MR/PS one) with nothing to remove for a subset. Existing templates can be deleted from
  the same screen.

All of this is saved to `templates.json` in this folder — no restart needed, and no editing
of `server.js` required for day-to-day template changes.

### What a template sheet needs to work correctly

Whatever sheet you pick in Manage Templates should keep this shape:

- A task-name column (title doesn't matter — the tool uses Smartsheet's own primary-column
  flag) and a "Start Date" column
- For templates with separate service sections: one row per service, labeled exactly
  `Architecture`, `Interior Design`, `Procurement`, or `Project Management`
- Either a row titled exactly "Arch SD" (simple templates), or a row titled exactly
  "Concept" plus one or more "Arch SD" rows that started on the same date as Concept in the
  original template (combined templates) — see the start-date behavior described above
- If a Public Space template ever needs to combine Full and Select Service in one sheet,
  the tool will still detect and separate them automatically by top-level row label

If a template's structure is unusual in some other way (a hidden business rule, a
differently-named anchor row, etc.), that's the kind of thing to flag directly rather than
expect the tool to infer — see `adding-new-templates-checklist.md` if you have it, or just
describe the rule when you mention the new template.

## Troubleshooting

- **"No Smartsheet API token configured"** — you haven't created/filled in `.env`, or you
  need to restart the server after adding it.
- **Smartsheet API error (401/403)** — your token is invalid or expired; generate a new one.
- **"Could not find expected Stage / Start Date columns"** — a template sheet's column names
  were changed; check the column titles match what's described above.
