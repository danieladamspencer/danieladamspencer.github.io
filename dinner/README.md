# Dinner booking (`/dinner/`)

Friends open https://dancmdstat.com/dinner/, enter the shared password and see the next 90 nights:
**blue** = free, **red** = busy, **amber** = someone has already asked. Tapping a blue night asks for
their name, email, and whether they want to come to our place or have us over, plus an optional note.

You get an email with **Yes** / **No** buttons. Each opens a confirm page where you can add a note.
- **Yes**: a 6–9pm event goes on your Google Calendar (the friend is invited as a guest) and they get an email.
  The night then shows red.
- **No**: they get a polite email suggesting another night, and the night goes back to blue.

## How it works

The site is static (GitHub Pages), so the logic lives in a **Google Apps Script web app** that runs as you:

- `dinner/index.html`: the page. It POSTs to the script's `/exec` URL (`ENDPOINT` near the top of the script).
- `dinner/apps-script/Code.gs`: the backend. Paste it into an Apps Script project (steps below).

Privacy: the script only ever returns free/busy per night, never event titles. A night is busy if
anything marked "busy" overlaps 5–10pm Eastern on your calendar or any calendar in `CHECK_CALENDARS`
(events marked "free", like birthdays, don't count). The password is checked by the script, not
the page; after 30 wrong guesses in 10 minutes it stops accepting any password for 10 minutes.
The page is `noindex` and isn't linked from the rest of the site.

## One-time setup (about 10 minutes, on a computer)

1. Go to https://script.google.com, signed in as your Gmail account. Click **New project**,
   rename it "Dinner booking".
2. Replace everything in `Code.gs` with the contents of `dinner/apps-script/Code.gs`.
   Save (Ctrl+S).
   In the editor's left sidebar, click **+** next to **Services**, choose **Google Calendar API**,
   leave the identifier as `Calendar`, and click **Add**. (This turns the API on in the script's
   hidden Google Cloud project; you can't do that from the Cloud console.)
3. Click the gear (**Project Settings**):
   - Check that the time zone is "(GMT-05:00) Eastern Time - New York".
   - Under **Script properties**, add:
     - `PASSWORD`: the password you'll give friends.
     - `CHECK_CALENDARS`: Lisa's Gmail address, so her busy nights count too (optional;
       several IDs can be comma-separated).
4. Back in the editor (`< >` icon), pick **authorize** from the function dropdown and click **Run**.
   Approve the permissions. Google warns "Google hasn't verified this app": click **Advanced**, then
   **Go to Dinner booking**, because it's your own script. The execution log should list how many
   of the next 90 nights are free. If it warns that a calendar is "not readable", Lisa needs to
   share her calendar with you (at least "See only free/busy").
5. **Deploy → New deployment**, then the gear next to "Select type", then **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone** (friends don't need Google accounts; the password protects it)
   - Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).
6. Put that URL in `ENDPOINT` near the top of the `<script>` in `dinner/index.html`, then commit and push.

Preview the page without the backend: https://dancmdstat.com/dinner/?demo (password `demo`; nothing is sent).

## Changing things later

- **Settings** (evening window, dinner time, how far ahead, inviting the friend) are in `CONFIG`
  at the top of `Code.gs`. After editing, use **Deploy → Manage deployments → ✏️ Edit →
  Version: New version → Deploy**. That keeps the same URL, so the page needs no change.
- **New password**: change the `PASSWORD` script property. It takes effect immediately with no redeploy.
  Friends who saved the old one are asked again.
- **Pending requests** are stored as `req_…` script properties and pruned 30 days after their date.
