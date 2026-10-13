/* QC sync configuration: the ONE place to set up the two-way sync with the shared Supabase table that the QC app uses.
 *
 * Only PUBLIC values belong here. The publishable key (sb_publishable_…) is public by design: Row Level Security in the
 * database decides what a signed-in user may read or write (members only, via public.is_member()). NEVER put a secret /
 * service_role key here.
 *
 * Set publishableKey to '' to switch QC sync off completely: no Customers file, no Sync button, no network calls.
 * Contract: ramgear-app/supabase/migrations/002_customer_cards.sql (see README › QC sync).
 * (Values set on window.CARDFILE_SUPABASE before this file loads win; the tests use that to point at a mock server.)
 */
window.CARDFILE_SUPABASE = Object.assign({
  url: 'https://dbveedcksommanxshpzx.supabase.co',             // Supabase project (same as the QC app)
  publishableKey: 'sb_publishable_GE8oGj58dn6AaFVKGPCM3Q_plAf4TST',
  table: 'customer_cards',
  shareAllFiles: true,              // every card file is shared with QC (Gary's decision, Oct 2026); false = per-file File › Share with QC
  columns: {                        // our name: column name in the table
    id: 'id', customerId: 'customer_id', title: 'title', body: 'body', notes: 'notes', source: 'source',
    createdAt: 'created_at', updatedAt: 'updated_at',
    deletedAt: 'deleted_at',        // soft delete: Cardfile sets it, NULL = live. (A boolean flag column would be `deleted: 'name'`.)
    deleted: null,
    file: 'file',                   // optional Cardfile card-file name; probed once per session, used only if the column exists
  },
  probeFile: true,                  // false = trust columns.file without probing (set file: null if there is no such column)
  titleMax: 39,                     // the table allows at most 39 characters in title (longer index lines are cut when uploaded)
  clientIds: true,                  // new rows get a UUID made in the browser, so a retried insert can't create a duplicate
  customersFile: 'CUSTOMERS',       // built-in, always-shared card file; rows without a file land here
  pageSize: 500,                    // rows per request when pulling
  autoSyncDelayMs: 4000,            // push this long after the last local edit (when online and signed in)
  unavailableRetryMs: 600000,       // table not created yet: automatic syncs check again after this long (Sync button: any time)
  auth: {
    method: 'qc',                   // 'qc' = QC username + PIN, same accounts as the QC app (default) | 'password' | 'otp' | 'magiclink'
    activateFunction: 'rg-admin',   // Edge Function that activates a QC user's cloud account on first sign-in
    storageKey: 'cardfile-sb-auth', // where supabase-js keeps the session in localStorage
  },
  lib: {                            // supabase-js v2, lazy-loaded only when sync is configured; pinned + Subresource Integrity
    url: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js',
    integrity: 'sha384-Rj26LVGvoeRVR6+mwQmFfcR3QOBEwT+ZmuCWpuiqeTzJpCs0ER4ITAWGb4Hiy3Ok',
  },
}, window.CARDFILE_SUPABASE || {});
