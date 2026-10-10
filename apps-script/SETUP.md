# Backend setup (about 10 minutes) - needed once, before app v1.1.x can log in

Your existing pages and the old app (v1.0.x) keep working. The new app only uses actions named `app_...`.

## 1. Add the new file
Apps Script editor -> **+** next to Files -> **Script** -> name it `AppApi` -> paste the whole content of `AppApi.gs`.

## 2. Change `doPost` in Code.gs (replace the 3-line function)
```js
function doPost(e) {
  const appRes = appApiRoute_(e);      // new app (v1.1+)
  if (appRes) return appRes;
  return scnDoPost_(e);                // old app, unchanged
}
```

## 3. Two bugs in the files you sent me (recommended fix; skip if your live project already has them)
`Code.gs` and `ScanPage.gs` call two functions that are not in the `EntryScan.gs` you sent, and the public QR page never fills its card.
Result today: scanning a slip QR with a normal phone camera stays on "Checking registration...", and `?scan=1` shows no photos.

a) Add to `EntryScan.gs` (anywhere):
```js
function entryFindRow_(sheet, regId) { return findRowByRegId_(sheet, regId); }
function entryPhotoFor(regId) {
  const sheet = getSheet_();
  const row = findRowByRegId_(sheet, String(regId || '').trim());
  if (row < 1) return '';
  return entryPhoto_(sheet.getRange(row, CONFIG.COL_PHOTO_URL + 1).getValue());
}
```
b) In `EntryScan.gs`, last line of `ENTRY_JS_`, replace
`'if(GREG&&gPin()){gScan();}';`
with
`'if(GREG&&gPin()){gScan();}else{google.script.run.withSuccessHandler(function(h){var p=document.getElementById("pub");if(p)p.innerHTML=h;}).verifyInnerHtml(GREG);}';`

## 4. (Optional) Make scans from the web pages reach the phones instantly
Only if staff also use `?verify=` / `?scan=1`. In `EntryScan.gs`:
* in `scanEntry`, inside the `else {` branch, right after `entryLog_(regId, out.name, 'ENTERED');` add
  `try { appLogChange_(regId, 'ENTRY', t, 'web'); } catch (e) {}`
* in `entryEventScan_`, right after the `if (r.status === 'BAD_PIN') ...` line add
  `if (r.status === 'OK') { try { appLogChange_(r.person && r.person.id ? r.person.id : regId, r.event, r.time, 'web'); } catch (e) {} }`

(Without this the phones still catch up: each phone re-downloads everything every 10 minutes.)

## 5. Check it
Select `appApiSelfTest` -> **Run** -> **Execution log**. Expected: Registration ID column 0, Payment Verification column found,
the 6 events, "Gate PIN login ok". Run `appApiSelfTest("0009")` to test an event PIN too.

## 6. Publish
**Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy.** The URL does not change.
Execute as **Me**, Who has access **Anyone**.

## 7. Change the PINs
The gate PIN (`ENTRY.GATE_PIN`) is `2026` and the event PINs are `0009`-`0014`. Change them before the event;
anyone who has seen them can scan. Keep each PIN different.

---
## How it works
* Login downloads all registrations, who already entered, and who already got breakfast / lunch / snacks / gift / lottery.
* A scan is decided on the phone in milliseconds, saved there, and uploaded in the background.
* Every 4-12 s each phone asks "what changed?", so scans from other phones appear here.
* Two phones scanning the same person within those seconds: the first to reach the server wins, the other phone shows
  an orange conflict warning.
* A person whose "Payment Verification" is not "Verified" is always checked on the server for event scans (same rule as EventScanner.gs).
* New sheet created automatically: **App Sync Log** (the change feed). Do not delete it during the event.
