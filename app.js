(() => {
  const STORAGE_KEY = 'nursing-duty-calendar-v1';
  const SYNC_CONFIG_KEY = 'nursing-duty-sync-config-v1';
  // APP_VERSION is defined in index.html (bumped on every deploy via scripts/bump_version.py).
  async function checkForUpdate(manual = false) {
    const button = document.getElementById('versionButton');
    try {
      if (manual && button) button.textContent = 'กำลังตรวจสอบ…';
      const response = await fetch(`./index.html?v=${Date.now()}`, { cache: 'no-store' });
      const match = (await response.text()).match(/const APP_VERSION = '([^']+)'/);
      if (manual && button) {
        button.textContent = match && match[1] !== APP_VERSION ? `มีเวอร์ชันใหม่ ${match[1]}` : `✓ ล่าสุดแล้ว · v${APP_VERSION}`;
        setTimeout(() => { button.textContent = `v${APP_VERSION} · เช็กอัปเดต`; }, 3000);
      }
      if (!match || match[1] === APP_VERSION || document.getElementById('updateBanner')) return;
      const banner = document.createElement('button'); banner.type = 'button'; banner.id = 'updateBanner';
      banner.className = 'update-banner'; banner.textContent = '✨ มีเวอร์ชันใหม่ แตะเพื่ออัปเดต';
      banner.addEventListener('click', () => location.replace(`./?v=${Date.now()}`));
      document.body.append(banner);
    } catch (_) { if (manual && button) button.textContent = 'ออฟไลน์อยู่ ลองใหม่ภายหลัง'; }
  }
  // Built-in project settings so users don't have to paste them. The anon/publishable key is safe to expose.
  const DEFAULT_SUPABASE_URL = 'https://gksmldbkagkhljxkyseg.supabase.co';
  const DEFAULT_SUPABASE_KEY = 'sb_publishable_hUkZK4KY9nJEXnbkCcTvXQ_59l1g5eh'; // TODO: paste the anon/publishable key from Supabase → Settings → API
  const DEFAULT_VAPID_PUBLIC_KEY = 'BNiFUkEdbS06TES0n-658rchvp0LHEjk6W1FZ3L-okTqf36w8oX-yz76Plc-Ma4rIon7yCQBBlO2HZ0sTz3hxmg';
  function translateAuthError(error) {
    const code = error?.code || ''; const msg = (error?.message || '').toLowerCase();
    if (code === 'invalid_credentials' || msg.includes('invalid login credentials')) return 'อีเมลหรือรหัสผ่านไม่ถูกต้อง';
    if (code === 'email_not_confirmed' || msg.includes('email not confirmed')) return 'ยังไม่ได้ยืนยันอีเมล กรุณากดลิงก์ในอีเมล หรือกด "ส่งอีเมลยืนยันอีกครั้ง"';
    if (code === 'user_already_exists' || msg.includes('already registered')) return 'อีเมลนี้สมัครไว้แล้ว ลองเข้าสู่ระบบแทน';
    if (code === 'weak_password' || msg.includes('password should be')) return 'รหัสผ่านง่ายเกินไป ใช้อย่างน้อย 8 ตัวอักษร';
    if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || msg.includes('rate limit') || error?.status === 429) return 'ลองบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่';
    if (msg.includes('invalid api key') || msg.includes('no api key')) return 'คีย์ฐานข้อมูลไม่ถูกต้อง ตรวจที่ "ตั้งค่าขั้นสูง"';
    if (msg.includes('failed to fetch') || msg.includes('network')) return 'เชื่อมต่ออินเทอร์เน็ตไม่ได้';
    if (msg.includes('valid email') || code === 'email_address_invalid') return 'รูปแบบอีเมลไม่ถูกต้อง';
    return error?.message || 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ';
  }
  const SHARED_SCHEDULE_KEY = 'nursing-duty-shared-schedule-v1';
  const defaults = ['เวรเปิดประตู', 'ห้องยา', 'ห้องแผล', 'เยี่ยมบ้าน', 'สต็อกเวชภัณฑ์'];
  let data = readData();
  let supabaseClient = null;
  let cloudScheduleId = null;
  let syncChannel = null;
  let syncSaveTimer = null;
  let applyingRemoteData = false;
  let serviceWorkerRegistration = null;
  const today = new Date();
  let shownMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  let selectedDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let activeView = 'month';
  let selectedKey = null;
  const $ = (id) => document.getElementById(id);
  const thaiLong = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long' });
  const thaiMonth = new Intl.DateTimeFormat('th-TH', { month: 'long', year: 'numeric' });
  const thaiMonthShort = new Intl.DateTimeFormat('th-TH', { month: 'long' });

  function readData() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (stored && Array.isArray(stored.duties) && stored.entries && typeof stored.entries === 'object') {
        stored.colors = stored.colors && typeof stored.colors === 'object' ? stored.colors : {};
        stored.templates = stored.templates && typeof stored.templates === 'object' ? stored.templates : {};
        stored.members = Array.isArray(stored.members) ? stored.members.filter(item => typeof item === 'string') : [];
        stored.notes = stored.notes && typeof stored.notes === 'object' && !Array.isArray(stored.notes) ? stored.notes : {};
        stored.supplies = Array.isArray(stored.supplies) ? stored.supplies.filter(s => s && typeof s.name === 'string' && typeof s.expiry === 'string') : [];
        for (const entries of Object.values(stored.entries)) {
          if (Array.isArray(entries)) entries.forEach(entry => { entry.done = false; });
        }
        return stored;
      }
    } catch (_) { /* Use the example data when storage is unavailable or invalid. */ }
    return { duties: defaults.slice(), entries: {}, colors: {}, templates: {}, members: [], notes: {}, supplies: [] };
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
    catch (_) { alert('บันทึกข้อมูลในเบราว์เซอร์ไม่สำเร็จ'); }
    if (supabaseClient && cloudScheduleId && !applyingRemoteData) queueCloudSave();
  }
  function validateBackup(value) {
    if (!value || value.format !== 'nursing-duty-calendar' || value.version !== 1 ||
        !Array.isArray(value.duties) || !value.duties.every(item => typeof item === 'string') ||
        !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) return false;
    for (const [key, entries] of Object.entries(value.entries)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !Array.isArray(entries) ||
          !entries.every(entry => entry && typeof entry.duty === 'string' && typeof (entry.note || '') === 'string' &&
            (entry.done === undefined || typeof entry.done === 'boolean'))) return false;
    }
    if (value.templates !== undefined) {
      if (!value.templates || typeof value.templates !== 'object' || Array.isArray(value.templates)) return false;
      for (const template of Object.values(value.templates)) {
        const okEntry = item => item && typeof item.duty === 'string' && typeof (item.note || '') === 'string';
        if (!template || typeof template.name !== 'string' || !Array.isArray(template.days) || template.days.length !== 7 ||
            !template.days.every(day => day === null || (Array.isArray(day) ? day.every(okEntry) : okEntry(day)))) return false;
      }
    }
    return !value.colors || (typeof value.colors === 'object' && !Array.isArray(value.colors) &&
      Object.values(value.colors).every(index => Number.isInteger(index) && index >= 0));
  }
  function syncStatus(message) { $('syncStatus').textContent = message; }
  function normalizeScheduleData(value) {
    if (!value || typeof value !== 'object') throw new Error('รูปแบบข้อมูลตารางไม่ถูกต้อง');
    const normalized = {
      duties: Array.isArray(value.duties) ? value.duties.filter(item => typeof item === 'string') : defaults.slice(),
      entries: value.entries && typeof value.entries === 'object' ? value.entries : {},
      colors: value.colors && typeof value.colors === 'object' ? value.colors : {},
      templates: value.templates && typeof value.templates === 'object' ? value.templates : {},
      members: Array.isArray(value.members) ? value.members.filter(item => typeof item === 'string') : [],
      notes: value.notes && typeof value.notes === 'object' && !Array.isArray(value.notes) ? value.notes : {},
      supplies: Array.isArray(value.supplies) ? value.supplies.filter(s => s && typeof s.name === 'string' && typeof s.expiry === 'string') : []
    };
    for (const entries of Object.values(normalized.entries)) {
      if (Array.isArray(entries)) entries.forEach(entry => { entry.done = false; });
    }
    return normalized;
  }
  function loadSupabaseLibrary() {
    if (window.supabase?.createClient) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      script.onload = resolve; script.onerror = () => reject(new Error('โหลด Supabase client ไม่สำเร็จ'));
      document.head.append(script);
    });
  }
  function base64UrlToUint8Array(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64); return Uint8Array.from(raw, character => character.charCodeAt(0));
  }
  async function enablePushNotifications() {
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    if (isIOS && !standalone) { $('notificationStatus').textContent = 'บน iPhone/iPad ให้เพิ่มเว็บลงหน้าจอโฮมแล้วเปิดจากไอคอนก่อน'; return; }
    if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      $('notificationStatus').textContent = 'เบราว์เซอร์นี้ยังใช้ Web Push ไม่ได้ ต้องเปิดเว็บผ่าน HTTPS บนเบราว์เซอร์ที่รองรับ'; return;
    }
    if (!supabaseClient || !currentUser) { $('notificationStatus').textContent = 'เข้าสู่ระบบก่อนเปิดการแจ้งเตือน (ส่วน "ใช้ร่วมกันหลายเครื่อง")'; return; }
    const publicKey = $('vapidPublicKey').value.trim();
    if (!publicKey) { $('notificationStatus').textContent = 'ใส่ VAPID public key ในส่วนใช้ร่วมกันหลายเครื่องก่อน'; return; }
    const permissionRequest = Notification.requestPermission();
    const permission = await permissionRequest;
    if (permission !== 'granted') { $('notificationStatus').textContent = 'ยังไม่ได้รับอนุญาตให้ส่งการแจ้งเตือน'; return; }
    if (!cloudScheduleId) {
      // Reminders are sent from the server, so it needs a cloud copy of the schedule. Create one automatically.
      $('notificationStatus').textContent = 'กำลังเก็บตารางขึ้นคลาวด์เพื่อใช้แจ้งเตือน…';
      if (!(await createSharedSchedule(null, true))) { $('notificationStatus').textContent = 'สร้างตารางบนคลาวด์ไม่สำเร็จ ดูข้อความในส่วน "ใช้ร่วมกันหลายเครื่อง"'; return; }
    }
    try {
      serviceWorkerRegistration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      await navigator.serviceWorker.ready;
      const pushManager = serviceWorkerRegistration.pushManager;
      let subscription = await pushManager.getSubscription();
      if (!subscription) subscription = await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(publicKey) });
      const { data: auth, error: authError } = await supabaseClient.auth.getUser();
      if (authError || !auth.user) throw new Error('เข้าสู่ระบบใหม่ก่อนบันทึกการแจ้งเตือน');
      const row = {
        user_id: auth.user.id, schedule_id: cloudScheduleId, endpoint: subscription.endpoint,
        subscription: subscription.toJSON(), reminder_time: $('reminderTime').value || '20:00',
        reminder_offset: $('reminderOffset').value, morning_time: morningValue(), morning_message: morningMessageValue(), last_morning_for_date: null, ...weatherFields(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Bangkok',
        enabled: true, last_sent_for_date: null, updated_at: new Date().toISOString(),
        member_name: myName || null
      };
      const { error } = await supabaseClient.from('push_subscriptions').upsert(row, { onConflict: 'endpoint' });
      if (error) throw error;
      saveReminderPref();
      const devices = await syncAccountReminder().catch(() => 1);
      $('notificationStatus').textContent = `เปิดแจ้งเตือนแล้ว (${devices} เครื่องในบัญชีนี้) เวลา ${row.reminder_time} (${row.reminder_offset === 'day_before' ? 'คืนก่อนวันมีหน้าที่' : 'วันมีหน้าที่'})`;
    } catch (error) { $('notificationStatus').textContent = `เปิดแจ้งเตือนไม่สำเร็จ: ${error.message}`; }
  }
  const REMINDER_PREF_KEY = 'nursing-duty-reminder-pref-v1';
  function weatherPos() { try { return JSON.parse(localStorage.getItem('nursing-duty-weather-pos-v1') || 'null'); } catch (_) { return null; } }
  function weatherFields() {
    const pos = weatherPos();
    return { supply_alert: $('supplyAlertOn').checked, rain_alert: $('rainAlertOn').checked, work_end: $('workEnd').value || '16:30', weather_lat: pos?.lat ?? null, weather_lon: pos?.lon ?? null, last_rain_alert_for_date: null };
  }
  function morningMessageValue() { return null; } // greeting lines are built into the server; love notes stay hidden in the app
  function morningValue() { return $('morningOn').checked ? ($('morningTime').value || '07:30') : null; }
  function saveReminderPref() {
    try { localStorage.setItem(REMINDER_PREF_KEY, JSON.stringify({ time: $('reminderTime').value, offset: $('reminderOffset').value, morning: morningValue(), message: $('morningMessage').value, rain: $('rainAlertOn').checked, workEnd: $('workEnd').value, supply: $('supplyAlertOn').checked })); } catch (_) {}
  }
  function applyReminderPref(time, offset, morning) {
    if (time) $('reminderTime').value = String(time).slice(0, 5);
    if (offset) $('reminderOffset').value = offset;
    if (morning !== undefined) {
      $('morningOn').checked = Boolean(morning);
      if (morning) $('morningTime').value = String(morning).slice(0, 5);
      $('morningTime').disabled = !morning;
    }
  }
  // Show what is actually saved on the server for this device, if it is subscribed.
  async function loadServerReminder() {
    try {
      if (!supabaseClient || !('serviceWorker' in navigator)) return;
      const registration = serviceWorkerRegistration || await navigator.serviceWorker.getRegistration('./');
      const subscription = await registration?.pushManager?.getSubscription();
      let row = null;
      if (subscription) {
        ({ data: row } = await supabaseClient.from('push_subscriptions')
          .select('reminder_time,reminder_offset,morning_time,morning_message,rain_alert,work_end,supply_alert,enabled').eq('endpoint', subscription.endpoint).maybeSingle());
      }
      if (!row && currentUser) {
        // This device isn't registered yet: use the same time as the account's other devices.
        const { data: rows } = await supabaseClient.from('push_subscriptions')
          .select('reminder_time,reminder_offset,morning_time,morning_message,rain_alert,work_end,supply_alert').eq('user_id', currentUser.id).order('updated_at', { ascending: false }).limit(1);
        const shared = rows?.[0];
        if (shared) { applyReminderPref(shared.reminder_time, shared.reminder_offset, shared.morning_time); if (shared.work_end) $('workEnd').value = String(shared.work_end).slice(0, 5); $('rainAlertOn').checked = shared.rain_alert !== false; $('supplyAlertOn').checked = shared.supply_alert !== false; if (shared.morning_message) $('morningMessage').value = shared.morning_message; saveReminderPref(); }
        if ('Notification' in window && Notification.permission === 'granted') { await enablePushNotifications(); return; }
        if (shared) $('notificationStatus').textContent = `บัญชีนี้เตือนเวลา ${String(shared.reminder_time).slice(0, 5)} · กด "เปิด / บันทึกการแจ้งเตือน" เพื่อรับแจ้งเตือนบนเครื่องนี้ด้วย`;
        return;
      }
      if (!row) return;
      applyReminderPref(row.reminder_time, row.reminder_offset, row.morning_time); if (row.work_end) $('workEnd').value = String(row.work_end).slice(0, 5); $('rainAlertOn').checked = row.rain_alert !== false; $('supplyAlertOn').checked = row.supply_alert !== false; if (row.morning_message) $('morningMessage').value = row.morning_message; saveReminderPref();
      if (row.enabled) $('notificationStatus').textContent = `เปิดแจ้งเตือนอยู่ เวลา ${String(row.reminder_time).slice(0, 5)} (${row.reminder_offset === 'day_before' ? 'คืนก่อนวันมีหน้าที่' : 'วันมีหน้าที่'})`;
    } catch (_) { /* Keep local values if the server can't be reached. */ }
  }
  // Every device signed in to the same account shares one reminder time.
  async function syncAccountReminder() {
    if (!supabaseClient || !currentUser) return 0;
    const { data: updated, error } = await supabaseClient.from('push_subscriptions')
      .update({ reminder_time: $('reminderTime').value || '20:00', reminder_offset: $('reminderOffset').value, morning_time: morningValue(), morning_message: morningMessageValue(), member_name: myName || null, last_sent_for_date: null, last_morning_for_date: null, ...weatherFields(), updated_at: new Date().toISOString() })
      .eq('user_id', currentUser.id).select('id');
    if (error) throw error;
    return updated?.length || 0;
  }
  // Changing time/offset saves immediately for all of the account's devices.
  async function onReminderSettingChange() {
    saveReminderPref();
    try {
      if (!supabaseClient || !('serviceWorker' in navigator)) { $('notificationStatus').textContent = 'บันทึกเวลาในเครื่องแล้ว กด "เปิด / บันทึกการแจ้งเตือน" เพื่อใช้งาน'; return; }
      if (!currentUser) { $('notificationStatus').textContent = 'บันทึกเวลาในเครื่องแล้ว กด "เปิด / บันทึกการแจ้งเตือน" เพื่อใช้งาน'; return; }
      const updated = await syncAccountReminder();
      $('notificationStatus').textContent = updated
        ? `บันทึกเวลาแจ้งเตือนใหม่แล้ว: ${$('reminderTime').value} (${$('reminderOffset').value === 'day_before' ? 'คืนก่อนวันมีหน้าที่' : 'วันมีหน้าที่'})${morningValue() ? ` + เช้า ${morningValue()}` : ''} · ใช้กับ ${updated} เครื่องในบัญชีนี้`
        : 'บันทึกเวลาในเครื่องแล้ว กด "เปิด / บันทึกการแจ้งเตือน" เพื่อใช้งาน';
    } catch (error) { $('notificationStatus').textContent = `บันทึกเวลาไม่สำเร็จ: ${error.message}`; }
  }
  async function disablePushNotifications() {
    try {
      serviceWorkerRegistration = serviceWorkerRegistration || await navigator.serviceWorker?.getRegistration('./');
      const subscription = await serviceWorkerRegistration?.pushManager?.getSubscription();
      if (subscription && supabaseClient) {
        const { error } = await supabaseClient.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);
        if (error) throw error;
        await subscription.unsubscribe();
      }
      $('notificationStatus').textContent = 'ปิดการแจ้งเตือนบนอุปกรณ์นี้แล้ว';
    } catch (error) { $('notificationStatus').textContent = `ปิดการแจ้งเตือนไม่สำเร็จ: ${error.message}`; }
  }
  async function testPushNotification() {
    try {
      if (Notification.permission !== 'granted') { $('notificationStatus').textContent = 'เปิดการแจ้งเตือนก่อนจึงจะทดสอบได้'; return; }
      serviceWorkerRegistration = serviceWorkerRegistration || await navigator.serviceWorker.register('./sw.js', { scope: './' });
      await serviceWorkerRegistration.showNotification('ทดสอบแจ้งเตือน', { body: 'เว็บตารางหน้าที่พยาบาลส่งการแจ้งเตือนได้แล้ว', icon: new URL('./icon.svg', location.href).href });
      $('notificationStatus').textContent = 'ส่งการแจ้งเตือนทดสอบแล้ว';
    } catch (error) { $('notificationStatus').textContent = `ทดสอบไม่สำเร็จ: ${error.message}`; }
  }
  let currentUser = null;
  function updateStatusPill() {
    const pill = $('statusPill'); if (!pill) return;
    const note = $('notificationStatus')?.textContent || '';
    const bellOn = /^(เปิดแจ้งเตือน(แล้ว|อยู่)|บันทึกเวลาแจ้งเตือนใหม่)/.test(note);
    const bell = bellOn ? ` · 🔔 ${$('reminderTime').value}` : '';
    pill.classList.remove('ok', 'warn');
    if (!currentUser) { pill.textContent = '☁️ ยังไม่ซิงก์'; $('storageHint').textContent = 'ข้อมูลบันทึกไว้ในเครื่องนี้ · เข้าสู่ระบบและเข้าร่วมตารางที่แชร์เพื่อซิงก์หลายเครื่อง'; return; }
    if (!cloudScheduleId) { pill.classList.add('warn'); pill.textContent = '🟡 ยังไม่ได้แชร์'; $('storageHint').textContent = 'เข้าสู่ระบบแล้ว · สร้างหรือเข้าร่วมตารางที่แชร์เพื่อเริ่มซิงก์'; return; }
    pill.classList.add('ok'); pill.textContent = `🟢 ซิงก์แล้ว${bell}`;
    $('storageHint').textContent = 'ซิงก์กับตารางที่แชร์แล้ว · ทุกเครื่องที่เข้าร่วมเห็นข้อมูลเดียวกัน';
  }
  function showSyncSession(user) {
    const changed = (currentUser?.id || null) !== (user?.id || null);
    currentUser = user || null;
    if (!user && accountName) { accountName = ''; mineOnly = false; renderAll(); }
    if (user && (changed || !accountName)) ensureAccountName(user);
    $('syncAccount').classList.toggle('visible', Boolean(supabaseClient));
    $('syncWorkspace').classList.toggle('visible', Boolean(user));
    $('signOutSync').style.display = user ? 'block' : 'none';
    ['syncEmail', 'syncPassword'].forEach(id => { $(id).hidden = Boolean(user); });
    $('signInSync').closest('.template-actions').hidden = Boolean(user);
    $('forgotPassword').closest('.template-actions').hidden = Boolean(user);
    if (user) syncStatus(`เข้าสู่ระบบแล้ว: ${user.email || 'บัญชี Supabase'}`);
  }
  async function startRealtime(id) {
    if (syncChannel) await supabaseClient.removeChannel(syncChannel);
    syncChannel = supabaseClient.channel(`schedule-${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'schedule_data', filter: `schedule_id=eq.${id}` }, payload => {
        if (syncSaveTimer || !payload.new?.payload) return;
        try {
          applyingRemoteData = true; data = normalizeScheduleData(payload.new.payload);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); applyingRemoteData = false;
          renderDutyList(); renderAll(); syncStatus('รับการเปลี่ยนแปลงจากผู้ร่วมงานแล้ว');
        } catch (error) { applyingRemoteData = false; syncStatus(`รับข้อมูลไม่สำเร็จ: ${error.message}`); }
      })
      .subscribe(status => { if (status === 'SUBSCRIBED') syncStatus('ซิงก์ตารางร่วมกันแล้ว'); });
  }
  // Changes made offline are kept locally and flagged, then pushed when the phone is back online.
  const PENDING_SYNC_KEY = 'nursing-duty-pending-sync-v1';
  const setPending = on => { try { on ? localStorage.setItem(PENDING_SYNC_KEY, '1') : localStorage.removeItem(PENDING_SYNC_KEY); } catch (_) {} updateOfflineBadge(); };
  const hasPending = () => { try { return localStorage.getItem(PENDING_SYNC_KEY) === '1'; } catch (_) { return false; } };
  function updateOfflineBadge() {
    const badge = document.getElementById('offlineBadge'); if (!badge) return;
    const offline = !navigator.onLine;
    badge.hidden = !offline && !hasPending();
    badge.textContent = offline ? '📴 ออฟไลน์ · บันทึกในเครื่องไว้ก่อน จะซิงก์เมื่อมีเน็ต' : '⏳ มีการแก้ไขที่ยังไม่ได้ซิงก์ · กำลังส่ง…';
  }
  function queueCloudSave() {
    setPending(true);
    if (syncSaveTimer) clearTimeout(syncSaveTimer);
    syncSaveTimer = setTimeout(async () => {
      syncSaveTimer = null;
      if (!supabaseClient || !cloudScheduleId) return;
      if (!navigator.onLine) { syncStatus('ออฟไลน์อยู่ จะซิงก์ให้เมื่อมีอินเทอร์เน็ต'); return; }
      const { error } = await supabaseClient.from('schedule_data').upsert({
        schedule_id: cloudScheduleId, payload: data, updated_at: new Date().toISOString()
      }, { onConflict: 'schedule_id' });
      if (!error) setPending(false);
      syncStatus(error ? `ซิงก์ไม่สำเร็จ (จะลองใหม่เมื่อมีเน็ต): ${error.message}` : 'บันทึกลงตารางร่วมกันแล้ว');
    }, 650);
    syncStatus('กำลังบันทึกการเปลี่ยนแปลง…');
  }
  async function loadSharedSchedule(id) {
    const { data: record, error } = await supabaseClient.from('schedule_data').select('payload').eq('schedule_id', id).single();
    if (error) { cloudScheduleId = null; syncStatus(`เปิดตารางไม่สำเร็จ: ${error.message}`); return false; }
    try { data = normalizeScheduleData(record.payload); if (accountName && !data.members.includes(accountName)) data.members.push(accountName); }
    catch (parseError) { syncStatus(`ข้อมูลตารางอ่านไม่ได้: ${parseError.message}`); return false; }
    cloudScheduleId = id; localStorage.setItem(SHARED_SCHEDULE_KEY, id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    const { data: schedule } = await supabaseClient.from('shared_schedules').select('invite_code,name').eq('id', id).single();
    if (schedule?.invite_code) {
      $('currentShareCode').hidden = false; $('copyShareCode').hidden = false;
      $('currentShareCode').textContent = `รหัสเชิญ: ${schedule.invite_code}`;
      $('sharedScheduleName').value = schedule.name || '';
    }
    await startRealtime(id); renderDutyList(); renderAll(); loadServerReminder();
    syncStatus('เปิดตารางร่วมกันแล้ว'); return true;
  }
  async function connectSupabase() {
    const url = $('supabaseUrl').value.trim(); const key = $('supabaseAnonKey').value.trim();
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) || !key) { syncStatus('ใส่ Project URL และ public anon key ให้ครบ'); return; }
    const vapidPublicKey = $('vapidPublicKey').value.trim();
    localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify({ url, key, vapidPublicKey }));
    syncStatus('กำลังเชื่อมต่อ…');
    try {
      await loadSupabaseLibrary();
      supabaseClient = window.supabase.createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      const { data: authData, error } = await supabaseClient.auth.getSession();
      if (error) throw error;
      showSyncSession(authData.session?.user || null);
      if (!authData.session) syncStatus('เชื่อมต่อแล้ว เข้าสู่ระบบหรือสมัครบัญชีเพื่อเริ่มแชร์');
      if (authData.session) await openAccountSchedule(authData.session.user);
      supabaseClient.auth.onAuthStateChange((event, session) => {
        showSyncSession(session?.user || null);
        if (event === 'PASSWORD_RECOVERY') {
          setTimeout(async () => {
            const pw = prompt('ตั้งรหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)');
            if (!pw) return;
            if (pw.length < 8) { syncStatus('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร'); return; }
            const { error: updateError } = await supabaseClient.auth.updateUser({ password: pw });
            syncStatus(updateError ? `เปลี่ยนรหัสผ่านไม่สำเร็จ: ${translateAuthError(updateError)}` : 'เปลี่ยนรหัสผ่านแล้ว');
          }, 0);
        }
        if (event === 'SIGNED_IN' && session) openAccountSchedule(session.user);
      });
    } catch (error) { supabaseClient = null; syncStatus(`เชื่อมต่อไม่สำเร็จ: ${translateAuthError(error)}`); }
  }
  // Any device signed in to the same account opens that account's schedule automatically.
  let openingSchedule = false;
  async function openAccountSchedule(user) {
    if (!supabaseClient || !user || openingSchedule) return;
    let id = null; try { id = localStorage.getItem(SHARED_SCHEDULE_KEY); } catch (_) {}
    if (id && id === cloudScheduleId) return;
    openingSchedule = true;
    try {
      if (!id) {
        const { data: rows, error } = await supabaseClient.from('schedule_members')
          .select('schedule_id,role').eq('user_id', user.id);
        if (error) throw error;
        const pick = (rows || []).find(row => row.role === 'owner') || (rows || [])[0];
        id = pick?.schedule_id || null;
      }
      if (id && hasPending() && id === localStorage.getItem(SHARED_SCHEDULE_KEY)) {
        // Local edits made offline are newer: push them up instead of loading the cloud copy.
        cloudScheduleId = id; await startRealtime(id); queueCloudSave(); renderAll(); return;
      }
      if (id) await loadSharedSchedule(id);
    } catch (error) { syncStatus(`โหลดตารางของบัญชีไม่สำเร็จ: ${error.message}`); }
    finally { openingSchedule = false; }
  }
  async function createSharedSchedule(event, silent = false) {
    if (!supabaseClient) return false;
    const name = $('sharedScheduleName').value.trim() || 'ตารางหน้าที่พยาบาล';
    if (!silent && !confirm('สร้างตารางร่วมกันและส่งข้อมูลในเบราว์เซอร์นี้ไปยังฐานข้อมูลออนไลน์หรือไม่?')) return false;
    syncStatus('กำลังสร้างตารางร่วมกัน…');
    const { data: result, error } = await supabaseClient.rpc('create_shared_schedule', { p_name: name, p_payload: data });
    if (error) { syncStatus(`สร้างตารางไม่สำเร็จ: ${error.message}`); return false; }
    const created = Array.isArray(result) ? result[0] : result;
    if (!created?.schedule_id) { syncStatus('สร้างตารางแล้วแต่ไม่ได้รับรหัสตาราง'); return false; }
    cloudScheduleId = created.schedule_id; localStorage.setItem(SHARED_SCHEDULE_KEY, cloudScheduleId);
    $('currentShareCode').hidden = false; $('copyShareCode').hidden = false;
    $('currentShareCode').textContent = `รหัสเชิญ: ${created.invite_code}`;
    await startRealtime(cloudScheduleId); syncStatus('สร้างตารางแล้ว ส่งรหัสเชิญให้ผู้ร่วมงาน');
    return true;
  }
  async function joinSharedSchedule() {
    if (!supabaseClient) return;
    const inviteCode = $('sharedInviteCode').value.trim();
    if (!inviteCode) { syncStatus('ใส่รหัสเชิญก่อนเข้าร่วม'); return; }
    if (!confirm('เข้าร่วมตารางและแทนที่ข้อมูลในเบราว์เซอร์นี้ด้วยข้อมูลตารางร่วมกันหรือไม่?')) return;
    const { data: id, error } = await supabaseClient.rpc('join_shared_schedule', { p_invite_code: inviteCode });
    if (error) { syncStatus(`เข้าร่วมไม่สำเร็จ: ${error.message}`); return; }
    $('sharedInviteCode').value = ''; await loadSharedSchedule(id);
  }
  function dateKey(date) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }
  function weekStart(date) {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    start.setDate(start.getDate() - start.getDay()); return start;
  }
  function formatDay(date) {
    return new Intl.DateTimeFormat('th-TH', { weekday: 'long', day: 'numeric', month: 'short' }).format(date);
  }
  // ---- Members, "mine" filter ----
  const MY_NAME_KEY = 'nursing-duty-my-name-v1'; const MINE_ONLY_KEY = 'nursing-duty-mine-only-v1';
  const readPref = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch (_) { return fallback; } };
  const writePref = (key, value) => { try { localStorage.setItem(key, value); } catch (_) {} };
  let myName = ''; let mineOnly = readPref(MINE_ONLY_KEY, '0') === '1';
  function ensureMembers() { if (!Array.isArray(data.members)) data.members = []; return data.members; }
  function addMemberPrompt() {
    const name = (prompt('ชื่อสมาชิกใหม่ (เช่น ชื่อเล่น)') || '').trim().slice(0, 30);
    if (!name) return '';
    const members = ensureMembers(); if (!members.includes(name)) { members.push(name); save(); }
    return name;
  }
  function visible(entries) { return mineOnly && myName ? entries.filter(entry => entry.assignee === myName) : entries; }
  var accountName = '';
  function renderFilterBar() {
    myName = accountName;
    $('filterBar').hidden = !accountName;
    $('meLabel').textContent = accountName ? `👤 ${accountName}` : '';
    $('mineToggle').setAttribute('aria-pressed', String(mineOnly && Boolean(myName)));
  }
  // Name comes from the account (user_metadata.display_name); asked once, then shared by every device.
  let askingName = false;
  async function ensureAccountName(user, forceAsk = false) {
    if (!user || !supabaseClient || askingName) return;
    let name = (user.user_metadata?.display_name || '').trim();
    if (!name || forceAsk) {
      askingName = true;
      const fallback = name || (user.email || '').split('@')[0].slice(0, 30);
      const answer = (prompt('ชื่อเล่นของคุณ (ใช้แสดงในตารางเวรและแจ้งเตือน)', fallback) || '').trim().slice(0, 30);
      askingName = false;
      if (!answer && name) return;
      const oldName = name; name = answer || fallback;
      const { error } = await supabaseClient.auth.updateUser({ data: { display_name: name } });
      if (error) { syncStatus(`บันทึกชื่อไม่สำเร็จ: ${translateAuthError(error)}`); return; }
      if (oldName && oldName !== name) {
        for (const entries of Object.values(data.entries)) entries.forEach(entry => { if (entry.assignee === oldName) entry.assignee = name; });
        const members = ensureMembers(); const at = members.indexOf(oldName); if (at >= 0) members.splice(at, 1);
      }
    }
    accountName = name;
    const members = ensureMembers(); if (!members.includes(name)) members.push(name);
    save(); renderAll();
    onReminderSettingChange(); // tie this device's reminders to the account name
  }
  function fillAssigneeSelect(current) {
    const select = $('assigneeSelect'); select.replaceChildren();
    const none = document.createElement('option'); none.value = ''; none.textContent = '— ไม่ระบุ —'; select.append(none);
    const names = [...ensureMembers()]; if (current && !names.includes(current)) names.push(current);
    names.forEach(name => { const option = document.createElement('option'); option.value = name; option.textContent = name; select.append(option); });
    const add = document.createElement('option'); add.value = '__add'; add.textContent = '+ เพิ่มชื่อ…'; select.append(add);
    select.value = current || (myName && ensureMembers().includes(myName) ? myName : '');
  }
  // ---- Recurring duties ----
  function repeatDates(startKey, mode, untilKey) {
    const [y, m, d] = startKey.split('-').map(Number);
    const [uy, um, ud] = untilKey.split('-').map(Number);
    const until = new Date(uy, um - 1, ud); const keys = [];
    for (let i = 1; i <= 400; i++) {
      let next;
      if (mode === 'daily') next = new Date(y, m - 1, d + i);
      else if (mode === 'every2') next = new Date(y, m - 1, d + i * 2);
      else if (mode === 'weekly') next = new Date(y, m - 1, d + i * 7);
      else if (mode === 'biweekly') next = new Date(y, m - 1, d + i * 14);
      else if (mode === 'monthly') { next = new Date(y, m - 1 + i, d); if (next.getDate() !== d) { if (next > until) break; continue; } }
      else break;
      if (next > until) break;
      keys.push(dateKey(next));
    }
    return keys;
  }
  // ---- Share as image ----
  function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let out = text; while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) out = out.slice(0, -1);
    return out + '…';
  }
  function roundRect(ctx, x, y, w, h, radius) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, radius); else ctx.rect(x, y, w, h);
  }
  async function shareScheduleImage() {
    const button = $('shareImage'); const label = button.textContent; button.disabled = true; button.textContent = 'กำลังสร้างรูป…';
    try {
      if (document.fonts?.ready) await document.fonts.ready;
      const isWeek = activeView === 'week';
      const days = []; let title;
      if (isWeek) {
        const start = weekStart(selectedDate);
        for (let i = 0; i < 7; i++) { const date = new Date(start); date.setDate(start.getDate() + i); days.push(date); }
        title = `ตารางเวร ${formatDay(days[0])} – ${formatDay(days[6])}`;
      } else {
        const first = new Date(shownMonth.getFullYear(), shownMonth.getMonth(), 1);
        const start = new Date(first); start.setDate(1 - first.getDay());
        for (let i = 0; i < 42; i++) { const date = new Date(start); date.setDate(start.getDate() + i); days.push(date); }
        while (days.length > 35 && days.slice(-7).every(date => date.getMonth() !== shownMonth.getMonth())) days.splice(-7);
        title = `ตารางเวร ${thaiMonth.format(shownMonth)}`;
      }
      const font = getComputedStyle(document.body).fontFamily || 'sans-serif';
      const W = 1080, pad = 36, cols = 7, headH = 150, weekdayH = 50;
      const rows = isWeek ? 1 : days.length / 7;
      const cellW = (W - pad * 2) / cols; const cellH = isWeek ? 520 : 170;
      const H = headH + weekdayH + rows * cellH + pad + 40;
      const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#171b19'; ctx.fillRect(0, 0, W, H);
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#eef3ee'; ctx.font = `800 46px ${font}`; ctx.fillText(title, pad, 40);
      ctx.fillStyle = '#b3bfb5'; ctx.font = `500 24px ${font}`;
      ctx.fillText(mineOnly && myName ? `เฉพาะเวรของ ${myName}` : 'ทุกคน', pad, 100);
      const weekdays = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
      ctx.font = `700 24px ${font}`; ctx.fillStyle = '#b3bfb5';
      weekdays.forEach((name, i) => ctx.fillText(name, pad + i * cellW + 12, headH + 10));
      const todayKey = dateKey(new Date());
      days.forEach((date, i) => {
        const col = i % 7, row = Math.floor(i / 7);
        const x = pad + col * cellW, y = headH + weekdayH + row * cellH;
        const outside = !isWeek && date.getMonth() !== shownMonth.getMonth();
        ctx.globalAlpha = outside ? 0.35 : 1;
        const key = dateKey(date);
        ctx.fillStyle = holidayName(key) ? '#3a2b27' : '#222925'; roundRect(ctx, x + 3, y + 3, cellW - 6, cellH - 6, 14); ctx.fill();
        if (key === todayKey) { ctx.strokeStyle = '#8dde83'; ctx.lineWidth = 3; ctx.stroke(); }
        ctx.fillStyle = holidayName(key) ? '#ffb3a3' : '#eef3ee'; ctx.font = `800 28px ${font}`; ctx.fillText(String(date.getDate()), x + 14, y + 12);
        if (holidayName(key)) { ctx.font = `700 15px ${font}`; ctx.fillText(fitText(ctx, holidayName(key), cellW - 60), x + 52, y + 20); }
        const entries = visible(data.entries[key] || []);
        const maxChips = isWeek ? 9 : 3; let cy = y + 52;
        entries.slice(0, maxChips).forEach(entry => {
          const text = `${entry.done ? '✓ ' : ''}${entry.duty}${entry.assignee ? ' · ' + entry.assignee : ''}`;
          const chipH = isWeek ? 34 : 30;
          ctx.font = `700 ${isWeek ? 20 : 17}px ${font}`;
          ctx.fillStyle = colorForDuty(entry.duty); roundRect(ctx, x + 10, cy, cellW - 20, chipH, 10); ctx.fill();
          ctx.fillStyle = '#17211a'; ctx.fillText(fitText(ctx, text, cellW - 34), x + 17, cy + (isWeek ? 7 : 6));
          cy += chipH + 6;
        });
        if (entries.length > maxChips) { ctx.fillStyle = '#b3bfb5'; ctx.font = `700 18px ${font}`; ctx.fillText(`+${entries.length - maxChips} อื่นๆ`, x + 14, cy + 2); }
        ctx.globalAlpha = 1;
      });
      ctx.fillStyle = '#7f8b81'; ctx.font = `500 20px ${font}`;
      ctx.fillText('สร้างจาก ตารางหน้าที่ของฉัน', pad, H - 46);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('เบราว์เซอร์สร้างรูปไม่ได้');
      const fileName = `${title.replace(/\s+/g, '-')}.png`;
      const file = new File([blob], fileName, { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title }); return; }
        catch (error) { if (error?.name === 'AbortError') return; }
      }
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = fileName; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      alert('บันทึกรูปแล้ว ส่งรูปนี้เข้า LINE ได้เลย');
    } catch (error) { alert(`สร้างรูปไม่สำเร็จ: ${error.message}`); }
    finally { button.disabled = false; button.textContent = label; }
  }
  // Thai public holidays (ราชการ), B.E. 2569–2570. Sources: kapook / sanook / myhora calendars.
  const THAI_HOLIDAYS = {
    '2026-01-01': 'วันขึ้นปีใหม่', '2026-03-03': 'วันมาฆบูชา', '2026-04-06': 'วันจักรี',
    '2026-04-13': 'วันสงกรานต์', '2026-04-14': 'วันสงกรานต์', '2026-04-15': 'วันสงกรานต์',
    '2026-05-04': 'วันฉัตรมงคล', '2026-05-13': 'วันพืชมงคล', '2026-05-31': 'วันวิสาขบูชา', '2026-06-01': 'ชดเชยวันวิสาขบูชา',
    '2026-06-03': 'วันเฉลิมฯ พระราชินี', '2026-07-28': 'วันเฉลิมฯ ร.10', '2026-07-29': 'วันอาสาฬหบูชา', '2026-07-30': 'วันเข้าพรรษา',
    '2026-08-12': 'วันแม่แห่งชาติ', '2026-10-13': 'วันนวมินทรมหาราช', '2026-10-23': 'วันปิยมหาราช',
    '2026-12-05': 'วันพ่อแห่งชาติ', '2026-12-07': 'ชดเชยวันพ่อแห่งชาติ', '2026-12-10': 'วันรัฐธรรมนูญ', '2026-12-31': 'วันสิ้นปี',
    '2027-01-01': 'วันขึ้นปีใหม่', '2027-02-21': 'วันมาฆบูชา', '2027-02-22': 'ชดเชยวันมาฆบูชา', '2027-04-06': 'วันจักรี',
    '2027-04-13': 'วันสงกรานต์', '2027-04-14': 'วันสงกรานต์', '2027-04-15': 'วันสงกรานต์',
    '2027-05-04': 'วันฉัตรมงคล', '2027-05-10': 'วันพืชมงคล', '2027-05-20': 'วันวิสาขบูชา', '2027-06-03': 'วันเฉลิมฯ พระราชินี',
    '2027-07-18': 'วันอาสาฬหบูชา', '2027-07-19': 'วันเข้าพรรษา', '2027-07-20': 'ชดเชยวันอาสาฬหบูชา', '2027-07-28': 'วันเฉลิมฯ ร.10',
    '2027-08-12': 'วันแม่แห่งชาติ', '2027-10-13': 'วันนวมินทรมหาราช', '2027-10-23': 'วันปิยมหาราช', '2027-10-25': 'ชดเชยวันปิยมหาราช',
    '2027-12-05': 'วันพ่อแห่งชาติ', '2027-12-06': 'ชดเชยวันพ่อแห่งชาติ', '2027-12-10': 'วันรัฐธรรมนูญ', '2027-12-31': 'วันสิ้นปี'
  };
  function holidayName(key) { return THAI_HOLIDAYS[key] || ''; }
  // Newer years come from holidays.json (refreshed monthly by a GitHub Action). Built-in entries win.
  const HOLIDAY_CACHE_KEY = 'nursing-duty-holidays-v1';
  function mergeHolidays(extra) {
    let added = 0;
    for (const [key, name] of Object.entries(extra || {})) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(key) && typeof name === 'string' && !THAI_HOLIDAYS[key]) { THAI_HOLIDAYS[key] = name; added++; }
    }
    return added;
  }
  async function loadHolidayFile() {
    try { mergeHolidays(JSON.parse(localStorage.getItem(HOLIDAY_CACHE_KEY) || 'null')); } catch (_) {}
    for (const url of ['https://raw.githubusercontent.com/Thanaphat45/warning-boom/main/holidays.json', './holidays.json']) {
      try {
        const json = await (await fetch(url, { cache: 'no-cache' })).json();
        try { localStorage.setItem(HOLIDAY_CACHE_KEY, JSON.stringify(json)); } catch (_) {}
        if (mergeHolidays(json)) renderAll();
        return;
      } catch (_) { /* try the next source */ }
    }
  }
  function renderHolidayCountdown(todayKey) {
    const next = Object.keys(THAI_HOLIDAYS).sort().find(key => key > todayKey);
    const box = $('holidayCountdown');
    if (!next) { box.hidden = true; return; }
    const [y, m, d] = next.split('-').map(Number); const [ty, tm, td] = todayKey.split('-').map(Number);
    const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
    const when = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short' }).format(new Date(y, m - 1, d));
    box.textContent = days === 1 ? `🎉 พรุ่งนี้ได้หยุด! ${THAI_HOLIDAYS[next]}` : `🎉 อีก ${days} วันได้หยุด · ${THAI_HOLIDAYS[next]} (${when})`;
    box.hidden = false;
  }
  // ---- Weather (Open-Meteo, free, no key) ----
  const WEATHER_POS_KEY = 'nursing-duty-weather-pos-v1';
  const WEATHER_CACHE_KEY = 'nursing-duty-weather-cache-v1';
  const WMO = [
    [[0], '☀️', 'ฟ้าใส'], [[1], '🌤️', 'แดดเป็นส่วนใหญ่'], [[2], '⛅', 'มีเมฆบางส่วน'], [[3], '☁️', 'เมฆมาก'],
    [[45, 48], '🌫️', 'หมอก'], [[51, 53, 55, 56, 57], '🌦️', 'ฝนปรอยๆ'], [[61, 63, 66, 80, 81], '🌧️', 'ฝนตก'],
    [[65, 67, 82], '🌧️', 'ฝนตกหนัก'], [[71, 73, 75, 77, 85, 86], '🌨️', 'หิมะ'], [[95, 96, 99], '⛈️', 'พายุฝนฟ้าคะนอง']
  ];
  function describeWeather(code) { const hit = WMO.find(([codes]) => codes.includes(code)); return hit ? { icon: hit[1], text: hit[2] } : { icon: '🌡️', text: 'อากาศวันนี้' }; }
  function readJSON(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; } }
  function writeJSON(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} }
  function renderWeather(w) {
    const now = describeWeather(w.code);
    $('weatherIcon').textContent = now.icon;
    $('weatherMain').textContent = `${Math.round(w.temp)}° ${now.text} · สูง ${Math.round(w.max)}° ต่ำ ${Math.round(w.min)}°`;
    const tips = [];
    if (w.rain >= 50) tips.push(`☂️ โอกาสฝน ${w.rain}%${w.rainFrom ? ` ช่วง ${w.rainFrom}` : ''} พกร่มด้วยนะ`);
    else if (w.rain >= 25) tips.push(`🌂 อาจมีฝน ${w.rain}% เผื่อร่มไว้ก็ดี`);
    if (w.max >= 35) tips.push('🥵 ร้อนมาก ดื่มน้ำเยอะๆ นะ');
    if (w.uv >= 8) tips.push(`🔆 UV ${Math.round(w.uv)} สูงมาก ทาครีมกันแดดนะ`);
    else if (w.uv >= 6) tips.push(`🔆 UV ${Math.round(w.uv)} สูง`);
    const pmWorst = Math.max(w.pm ?? 0, w.pmMax ?? 0);
    if (pmWorst > 37.5) tips.push(`😷 PM2.5 ${pmWorst} ใส่หน้ากากนะ`);
    if (!tips.length) tips.push('😊 อากาศดี เดินทางสบาย');
    $('weatherTip').textContent = tips.join(' · ');
    const pmBadge = $('pmBadge');
    if (w.pm == null) { pmBadge.hidden = true; } else {
      const level = w.pm <= 15 ? ['ดีมาก', 'pm-good'] : w.pm <= 25 ? ['ดี', 'pm-good'] : w.pm <= 37.5 ? ['ปานกลาง', 'pm-mid'] : w.pm <= 75 ? ['เริ่มมีผลต่อสุขภาพ', 'pm-bad'] : ['มีผลต่อสุขภาพ', 'pm-worst'];
      pmBadge.hidden = false; pmBadge.className = `pm-badge ${level[1]}`; pmBadge.textContent = `PM2.5 ${w.pm} · ${level[0]}`;
    }
    $('weatherCard').classList.add('ready');
  }
  async function loadWeather(askLocation = false) {
    let pos = readJSON(WEATHER_POS_KEY);
    if (!navigator.onLine) {
      const cached = readJSON(WEATHER_CACHE_KEY);
      if (cached?.w && cached.day === dateKey(new Date())) renderWeather(cached.w);
      else { $('weatherMain').textContent = 'ออฟไลน์อยู่'; $('weatherTip').textContent = 'จะแสดงอากาศเมื่อมีอินเทอร์เน็ต'; }
      return;
    }
    if (!pos) {
      if (!askLocation || !navigator.geolocation) return;
      $('weatherMain').textContent = 'กำลังหาตำแหน่ง…';
      try {
        pos = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
          p => resolve({ lat: +p.coords.latitude.toFixed(2), lon: +p.coords.longitude.toFixed(2) }), reject, { timeout: 15000, maximumAge: 86400000 }));
        writeJSON(WEATHER_POS_KEY, pos);
        onReminderSettingChange(); // share rounded location so the morning reminder can include weather
      } catch (_) {
        $('weatherMain').textContent = 'ไม่ได้รับสิทธิ์ตำแหน่ง';
        $('weatherTip').textContent = 'เปิดสิทธิ์ตำแหน่งให้แอปนี้ แล้วแตะอีกครั้ง';
        return;
      }
    }
    const cache = readJSON(WEATHER_CACHE_KEY);
    if (cache && Date.now() - cache.at < 60 * 60 * 1000 && cache.day === dateKey(new Date())) { renderWeather(cache.w); return; }
    if (cache?.w) renderWeather(cache.w);
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${pos.lat}&longitude=${pos.lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max&hourly=precipitation_probability&timezone=auto&forecast_days=1`;
      const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${pos.lat}&longitude=${pos.lon}&current=pm2_5&hourly=pm2_5&timezone=auto&forecast_days=1`;
      const [json, aq] = await Promise.all([fetch(url).then(res => res.json()), fetch(aqUrl).then(res => res.json()).catch(() => null)]);
      const pmHours = (aq?.hourly?.pm2_5 || []).filter(v => typeof v === 'number');
      const hours = (json.hourly?.time || []).map((t, i) => ({ h: Number(t.slice(11, 13)), p: json.hourly.precipitation_probability[i] }));
      const wet = hours.find(x => x.h >= new Date().getHours() && x.h <= 20 && x.p >= 50);
      const w = {
        temp: json.current.temperature_2m, code: json.current.weather_code,
        max: json.daily.temperature_2m_max[0], min: json.daily.temperature_2m_min[0],
        rain: json.daily.precipitation_probability_max[0] ?? 0,
        rainFrom: wet ? `${String(wet.h).padStart(2, '0')}:00` : '',
        uv: json.daily.uv_index_max?.[0] ?? null,
        pm: typeof aq?.current?.pm2_5 === 'number' ? Math.round(aq.current.pm2_5) : null,
        pmMax: pmHours.length ? Math.round(Math.max(...pmHours)) : null
      };
      writeJSON(WEATHER_CACHE_KEY, { at: Date.now(), day: dateKey(new Date()), w });
      renderWeather(w);
    } catch (_) {
      if (!cache?.w) { $('weatherMain').textContent = 'โหลดอากาศไม่ได้'; $('weatherTip').textContent = 'เช็กอินเทอร์เน็ต แล้วแตะอีกครั้ง'; }
    }
  }
  // ---- Daily love notes ----
  // 90 messages in a fixed shuffled order: one per day, so a message comes back only after 90 days (~3 months).
  const DAILY_NOTES = ["ถ้ามีเรื่องให้หงุดหงิด นับหนึ่งถึงสิบแล้วนึกถึงชาบูไว้ 🍲", "กินวิตามินหรือยังวันนี้ ดูแลตัวเองด้วยนะ 🍊", "ไม่ว่าจะเหนื่อยแค่ไหน บ้านนี้มีอ้อมกอดรออยู่ 🏠", "ส่งพลังบวกไปให้หนึ่งกระบุง รับไปเลย ⚡", "เหนื่อยกายไม่เป็นไร ขอแค่ใจเธอสบายดีก็พอ 💞", "เธอคือฮีโร่ในชุดขาวของเรานะ 🦸‍♀️", "ขอบคุณที่เลือกทำงานที่ช่วยชีวิตคนนะ 🙇", "อย่าลืมยืดเส้นยืดสายบ้างนะ ยืนนานเมื่อยแย่ 🧘", "เสียงหัวเราะของเธอคือเพลงโปรดของเรา 🎶", "ขอให้ไม่มีเคสหนักๆ ให้ปวดหัววันนี้นะ 🍀", "ยิ้มให้ตัวเองในกระจกสักทีนะ คนในนั้นเก่งมาก 🪞", "อย่าแบกทุกอย่างไว้คนเดียว แบ่งมาให้เราบ้างได้นะ 🎒", "เธอไม่ได้อยู่คนเดียวนะ มีเราเป็นทีมเสมอ 🤝", "วันนี้มีอะไรไม่สบายใจ เล่าให้ฟังได้เสมอนะ 👂", "อยากให้รู้ว่าทุกความพยายามของเธอมีความหมาย 🌈", "ความเหนื่อยวันนี้ จะกลายเป็นความภูมิใจในวันหน้า 🏆", "ขอให้วันนี้เวลาเดินเร็วๆ ได้กลับบ้านไวๆ ⏰", "รักนะ วันนี้ก็ด้วย พรุ่งนี้ก็ด้วย ❤️", "ความใจเย็นของเธอช่วยคนไข้ได้มากเลยนะ 🕊️", "รักเธอที่สุดในโลก ทุกวันเลยนะ 🌏❤️", "ขอให้กาแฟแก้วนี้อร่อยเป็นพิเศษ ☕", "ทำงานเสร็จแล้วรีบกลับมาพักผ่อนนะ 🛏️", "ขอให้วันนี้ไม่มีโอที หรือถ้ามีก็ขอให้ได้เงินเยอะ 💸", "วันนี้อาจจะยาว แต่เธอผ่านมันไปได้แน่นอน 💪", "วันนี้ลองหาเรื่องเล็กๆ ที่ทำให้ยิ้มได้สักเรื่องนะ 🌼", "ไม่ว่าวันนี้จะเป็นยังไง เรายังอยู่ข้างเธอเสมอ 🫶", "วันนี้แต่งตัวสวยไหม ถึงไม่ได้ดูก็รู้ว่าสวย 💄", "อย่าลืมยิ้มนะ ยิ้มแล้วสวยขึ้นสามเท่า 😁", "คนที่ดูแลคนอื่นเก่ง ก็ควรได้รับการดูแลกลับเหมือนกัน 🫂", "ใครได้เจอเธอวันนี้ ถือว่าเจอนางฟ้า 👼", "วันนี้ให้คะแนนตัวเองเต็มร้อยไปเลย 💯", "อย่าลืมกินข้าวกลางวันนะ ห้ามข้าม 🍱", "เย็นนี้อยากดูหนังเรื่องไหน เลือกไว้เลยนะ 🎬", "ไม่ต้องเก่งทุกเรื่องก็ได้ แค่เป็นตัวเองก็ดีพอแล้ว 🌸", "ทุกคนที่เธอดูแลวันนี้ โชคดีมากที่ได้เจอเธอ 🩺", "วันนี้อย่าลืมกินขนมอร่อยๆ สักชิ้นนะ 🍰", "ถ้าเครียด ลองนึกถึงทริปที่เราอยากไปด้วยกันนะ ✈️", "เธอทำให้โลกนี้อบอุ่นขึ้นอีกนิดทุกวันเลย ☀️", "อย่าลืมทาครีมกันแดดนะ ถึงจะอยู่ในตึกก็เถอะ 🧴", "พักสายตาบ้างนะ จ้องจอจ้องชาร์ตนานๆ ล้า 👀", "เธอเป็นพยาบาลที่เก่ง และเป็นแฟนที่น่ารักที่สุด 💕", "วันนี้ทำงานให้สนุก แล้วกลับมาเล่าให้ฟังนะ 🗣️", "ขอให้วันนี้คนไข้น่ารัก งานไม่วุ่นนะ 🙏", "ขอบคุณที่อดทนกับทุกอย่างมาได้ไกลขนาดนี้ 🛤️", "แอบคิดถึงนะ ตั้งใจทำงานนะคนเก่ง 💭", "ถ้ารู้สึกท้อ ลองนึกถึงคนไข้ที่ยิ้มให้เธอเมื่อวาน 😌", "เลิกงานแล้วอยากกินอะไร บอกได้เลย เดี๋ยวพาไป 🍜", "แค่คิดถึงหน้าเธอก็มีแรงทำงานแล้ว 😚", "ขอบคุณที่เป็นคนที่ใส่ใจคนอื่นขนาดนี้ 🌷", "ถ้าวันนี้มีคนไม่น่ารักกับเธอ ไม่ต้องเก็บมาคิดนะ 🌧️➡️🌤️", "เธอเก่งกว่าที่ตัวเองคิดเยอะเลยนะ 💫", "ขอให้วันนี้ทุกอย่างราบรื่นเหมือนผ้าปูเตียงที่เพิ่งรีด 🛌", "เธอคือคนที่ทำให้วันธรรมดากลายเป็นวันพิเศษ 🎈", "แค่ตื่นมาทำงานได้ก็เก่งแล้ว ที่เหลือคือโบนัส ⭐", "อีกนิดเดียวก็ถึงวันหยุดแล้ว อดทนอีกหน่อยนะ 🏖️", "สู้ๆ นะ เย็นนี้มีรางวัลรออยู่ 🎁", "ทุกวันที่ผ่านไป เธอยิ่งเก่งขึ้นเรื่อยๆ 📈", "รอยยิ้มของเธอช่วยคนไข้ได้มากกว่าที่คิดนะ 😊", "ถ้าวันนี้เหนื่อย กลับมากอดกันนะ 🤗", "ขอให้วันนี้เพื่อนร่วมงานน่ารักกับเธอนะ 👭", "เราเชื่อในตัวเธอเสมอ ไม่ว่าจะเกิดอะไรขึ้น 🤞", "เก่งไม่ใช่แค่ทำงานได้ แต่คือยังใจดีได้ทุกวัน 💗", "เราโชคดีมากที่มีเธอเป็นแฟน 🥹", "วันนี้ขอให้หัวหน้าอารมณ์ดีนะ 555 😆", "เธอทำได้ดีเสมอ แม้ในวันที่รู้สึกว่าไม่ดี 🌙", "ใจดีกับคนอื่นแล้ว อย่าลืมใจดีกับตัวเองด้วยนะ 🤍", "อยากบอกว่าวันนี้ก็ยังรักเท่าเดิม หรืออาจมากกว่า 📏❤️", "จำไว้นะ เธอสำคัญกับเรามากที่สุด 🔑", "เธอเปลี่ยนโลกได้ทีละคน ทีละเตียง ทีละวัน 🌍", "ขอให้วันนี้มีแต่ข่าวดี และคนไข้อาการดีขึ้นนะ 📰", "ถ้าวันนี้มีอะไรผิดพลาด ไม่เป็นไรนะ ทุกคนเรียนรู้ได้ 📖", "ระหว่างพักเที่ยง ส่งรูปมาให้ดูหน่อยนะ คิดถึง 📸", "เธอเป็นแรงบันดาลใจให้เราอยากเป็นคนที่ดีขึ้น 🌱", "ทำดีที่สุดแล้วก็พอ ที่เหลือปล่อยไปนะ 🍃", "เก็บแรงไว้บ้างนะ เย็นนี้มีคนอยากชวนไปเดินเล่น 🚶", "ทุกครั้งที่เธอเหนื่อย อยากให้รู้ว่ามีคนภูมิใจอยู่ 🏅", "เธอคือเหตุผลที่ทำให้หลายคนหายป่วยไวขึ้น 💊", "หายใจลึกๆ หนึ่งที แล้วค่อยๆ ทำไปทีละอย่างนะ 🌬️", "เหนื่อยก็พักได้นะ พักแล้วค่อยไปต่อ 🌿", "ดื่มน้ำเยอะๆ นะ ร่างกายจะได้มีแรงดูแลคนอื่นต่อ 💧", "อย่าลืมเข้าห้องน้ำนะ อย่ากลั้นนาน 555 🚻", "วันนี้ลองชมตัวเองสักเรื่องนะ เธอสมควรได้ 👏", "ไม่ต้องรีบนะ ค่อยๆ ทำ ช้าแต่ชัวร์ 🐢", "เธอคือส่วนที่ดีที่สุดของทุกวันของเรา 🌅", "วันนี้ก็เก่งมากแล้วนะ ไม่ต้องสมบูรณ์แบบก็ได้ 💛", "ความอดทนของเธอคือสิ่งที่น่าชื่นชมที่สุดเลย 🌻", "งานหนักแค่ไหน เธอก็ยังน่ารักเหมือนเดิม 🥰", "วันนี้ขอให้เจอแต่เรื่องดีๆ นะ ✨", "ภูมิใจในตัวเธอมากๆ เลย รู้ไหม ❤️", "ทุกคนที่ได้รับการดูแลจากเธอ คงรู้สึกอุ่นใจมาก 🧣"];
  function dailyNote(key) {
    if ((data.notes || {})[key]) return data.notes[key];
    const [y, m, d] = key.split('-').map(Number);
    const dayNumber = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
    return DAILY_NOTES[((dayNumber % DAILY_NOTES.length) + DAILY_NOTES.length) % DAILY_NOTES.length];
  }
  const OPENED_NOTES_KEY = 'nursing-duty-opened-notes-v1';
  function openedNotes() { try { return JSON.parse(localStorage.getItem(OPENED_NOTES_KEY) || '{}'); } catch (_) { return {}; } }
  function renderLoveNote(todayKey) {
    const text = dailyNote(todayKey);
    const button = $('loveNote');
    if (!text) { button.hidden = true; return; }
    button.hidden = false;
    const opened = openedNotes()[todayKey];
    button.classList.toggle('opened', Boolean(opened));
    $('loveNoteText').textContent = opened ? text : 'วันนี้มีข้อความถึงคุณ · แตะเพื่อเปิดอ่าน';
  }
  function openLoveNote() {
    const key = dateKey(new Date()); if (!dailyNote(key)) return;
    const opened = openedNotes(); opened[key] = true;
    try { localStorage.setItem(OPENED_NOTES_KEY, JSON.stringify(opened)); } catch (_) {}
    renderLoveNote(key);
    const button = $('loveNote'); button.classList.remove('pop'); void button.offsetWidth; button.classList.add('pop');
  }
  function renderNoteEditor() {
    const list = $('noteList'); if (!list) return; list.replaceChildren();
    const todayKey = dateKey(new Date());
    const keys = Object.keys(data.notes || {}).filter(key => key >= todayKey).sort();
    if (!keys.length) { const empty = document.createElement('p'); empty.className = 'step-hint'; empty.textContent = 'ยังไม่มีข้อความที่ตั้งไว้'; list.append(empty); return; }
    const fmt = new Intl.DateTimeFormat('th-TH', { weekday: 'short', day: 'numeric', month: 'short' });
    keys.forEach(key => {
      const [y, m, d] = key.split('-').map(Number);
      const row = document.createElement('button'); row.type = 'button'; row.className = 'note-row';
      const date = document.createElement('strong'); date.textContent = `💌 ${fmt.format(new Date(y, m - 1, d))}`;
      const hidden = document.createElement('span'); hidden.textContent = key === todayKey ? 'วันนี้' : 'ซ่อนไว้จนถึงวันนั้น · แตะเพื่อแก้ไข';
      row.append(date, hidden);
      row.addEventListener('click', () => { $('noteDate').value = key; $('noteText').value = data.notes[key]; $('noteText').focus(); });
      list.append(row);
    });
  }
  function saveNote() {
    const key = $('noteDate').value; const text = $('noteText').value.trim().slice(0, 300);
    if (!key) { $('noteStatus').textContent = 'เลือกวันที่ก่อน'; return; }
    data.notes = data.notes || {};
    if (text) data.notes[key] = text; else delete data.notes[key];
    save(); renderNoteEditor(); renderToday();
    $('noteStatus').textContent = text ? 'ตั้งข้อความแล้ว 💌' : 'ลบข้อความของวันนั้นแล้ว';
    $('noteText').value = '';
  }
  function renderAll() {
    renderFilterBar(); renderCalendar(); renderToday(); renderWeek(); renderTemplates(); setView(activeView);
    if (typeof renderSupplies === 'function' && $('supplyList')) renderSupplies();
  }
  function setView(view) {
    activeView = view;
    $('daysGrid').style.display = view === 'month' ? 'grid' : 'none';
    $('monthWeekdays').style.display = view === 'month' ? 'grid' : 'none';
    $('weekList').classList.toggle('visible', view === 'week');
    $('weekNavigation').classList.toggle('visible', view === 'week');
    $('monthControls').style.display = view === 'month' ? 'flex' : 'none';
    document.querySelectorAll('.view-tab').forEach(button => {
      const active = button.dataset.view === view;
      button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active));
    });
  }
  function colorForDuty(duty) {
    if (!Number.isInteger(data.colors[duty])) {
      const used = new Set(Object.values(data.colors).filter(Number.isInteger));
      let index = 0; while (used.has(index)) index++;
      data.colors[duty] = index;
      save();
    }
    const hue = (data.colors[duty] * 137.508 + 94) % 360;
    return `hsl(${hue.toFixed(1)}, 70%, 72%)`;
  }
  function renderCalendar() {
    $('monthTitle').textContent = thaiMonth.format(shownMonth);
    $('monthSub').textContent = `พ.ศ. ${shownMonth.getFullYear() + 543} · เลือกวันที่เพื่อบันทึก`;
    const first = new Date(shownMonth.getFullYear(), shownMonth.getMonth(), 1);
    const start = new Date(first); start.setDate(1 - first.getDay());
    const grid = $('daysGrid'); grid.replaceChildren();
    const dayTotals = new Set();
    for (let i = 0; i < 42; i++) {
      const date = new Date(start); date.setDate(start.getDate() + i);
      const key = dateKey(date); const entries = visible(data.entries[key] || []);
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'day';
      if (date.getMonth() !== shownMonth.getMonth()) btn.classList.add('outside');
      if (key === dateKey(today)) btn.classList.add('today');
      btn.setAttribute('aria-label', `${thaiLong.format(date)}${entries.length ? ` มีหน้าที่ ${entries.map(e => e.duty).join(', ')}` : ''}`);
      const num = document.createElement('span'); num.className = 'date-number'; num.textContent = date.getDate(); btn.append(num);
      const holiday = holidayName(key);
      if (holiday) {
        btn.classList.add('holiday');
        const tag = document.createElement('span'); tag.className = 'holiday-label'; tag.textContent = holiday; btn.append(tag);
        btn.setAttribute('aria-label', `${btn.getAttribute('aria-label')} · วันหยุด ${holiday}`);
      }
      if (date.getDate() === 1) {
        const label = document.createElement('span'); label.className = 'day-label'; label.textContent = thaiMonthShort.format(date); btn.append(label);
      }
      const chips = document.createElement('span'); chips.className = 'chips';
      entries.slice(0, 2).forEach(entry => {
        const chip = document.createElement('span'); chip.className = `chip${entry.done ? ' completed' : ''}`; chip.textContent = `${entry.done ? '✓ ' : ''}${entry.duty}${entry.assignee ? ' · ' + entry.assignee : ''}`;
        chip.style.backgroundColor = colorForDuty(entry.duty); chip.style.color = '#17211a'; chips.append(chip);
      });
      if (entries.length > 2) { const more = document.createElement('span'); more.className = 'chip more'; more.textContent = `+${entries.length - 2}`; chips.append(more); }
      btn.append(chips);
      btn.addEventListener('click', () => { selectedDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()); openDialog(key); });
      grid.append(btn);
      if (date.getMonth() === shownMonth.getMonth() && entries.length) dayTotals.add(key);
    }
    $('monthCount').textContent = dayTotals.size;
    renderDutySummary();
  }
  function makeTaskRow(key, entry, index) {
    const row = document.createElement('div'); row.className = `task-row${entry.done ? ' completed' : ''}`;
    const name = document.createElement('span'); name.className = 'task-name'; name.textContent = entry.duty; name.style.backgroundColor = colorForDuty(entry.duty); row.append(name);
    if (entry.assignee) { const who = document.createElement('span'); who.className = 'assignee-tag'; who.textContent = `👤 ${entry.assignee}`; row.append(who); }
    if (entry.note) { const note = document.createElement('span'); note.className = 'task-note'; note.textContent = entry.note; row.append(note); }
    return row;
  }
  function renderToday() {
    const now = new Date(); const key = dateKey(now); const entries = visible(data.entries[key] || []);
    $('todayHeading').textContent = new Intl.DateTimeFormat('th-TH', { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
    $('todayDate').textContent = entries.length ? `มีหน้าที่ ${entries.length} อย่าง` : 'พ.ศ. ' + (now.getFullYear() + 543);
    const holiday = holidayName(key);
    $('todayHoliday').hidden = !holiday; $('todayHoliday').textContent = holiday ? `🎌 ${holiday}` : '';
    renderHolidayCountdown(key); renderLoveNote(key);
    const container = $('todayEntries'); container.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('div'); empty.className = 'today-empty';
      empty.textContent = holiday ? `วันนี้${holiday} 🎉\nไม่มีหน้าที่ พักผ่อนให้เต็มที่นะ` : 'วันนี้ยังไม่มีหน้าที่ 🌿\nแตะ "เพิ่มหน้าที่วันนี้" เพื่อลงเวร';
      empty.style.whiteSpace = 'pre-line'; container.append(empty); return;
    }
    entries.forEach(entry => {
      const tile = document.createElement('button'); tile.type = 'button'; tile.className = 'today-tile';
      tile.style.backgroundColor = colorForDuty(entry.duty);
      const icon = document.createElement('span'); icon.className = 'tile-icon'; icon.textContent = '📌';
      const text = document.createElement('span');
      const name = document.createElement('span'); name.className = 'tile-name'; name.textContent = entry.duty; text.append(name);
      if (entry.note) { const note = document.createElement('span'); note.className = 'tile-note'; note.textContent = entry.note; text.append(note); }
      tile.append(icon, text);
      tile.addEventListener('click', () => { selectedDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()); openDialog(key); });
      container.append(tile);
    });
  }
  function renderWeek() {
    const start = weekStart(selectedDate); const end = new Date(start); end.setDate(start.getDate() + 6);
    $('weekTitle').textContent = `${formatDay(start)} – ${formatDay(end)}`;
    const list = $('weekList'); list.replaceChildren();
    for (let i = 0; i < 7; i++) {
      const date = new Date(start); date.setDate(start.getDate() + i);
      const key = dateKey(date); const allEntries = data.entries[key] || []; const entries = visible(allEntries);
      const day = document.createElement('section'); day.className = 'week-day';
      const head = document.createElement('div'); head.className = 'week-day-head';
      const dateLabel = document.createElement('span'); dateLabel.textContent = formatDay(date) + (holidayName(key) ? ` · 🎌 ${holidayName(key)}` : '');
      if (holidayName(key)) dateLabel.style.color = '#ffb3a3';
      const add = document.createElement('button'); add.type = 'button'; add.textContent = entries.length ? 'เพิ่ม / แก้ไข' : '+ เพิ่ม'; add.addEventListener('click', () => { selectedDate = new Date(date); openDialog(key); });
      head.append(dateLabel, add); day.append(head);
      if (!entries.length) { const empty = document.createElement('div'); empty.className = 'week-empty'; empty.textContent = 'ยังไม่มีหน้าที่'; day.append(empty); }
      else entries.forEach(entry => day.append(makeTaskRow(key, entry, allEntries.indexOf(entry))));
      list.append(day);
    }
  }
  function weekRangeLabel() {
    const start = weekStart(selectedDate); const end = new Date(start); end.setDate(start.getDate() + 6);
    const short = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short' });
    return `${short.format(start)} – ${short.format(end)}`;
  }
  function renderTemplatePreview() {
    const box = $('templatePreview'); if (!box) return; box.replaceChildren();
    const template = data.templates?.[$('templateSelect').value]; if (!template) return;
    ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'].forEach((name, index) => {
      const day = template.days[index]; const list = Array.isArray(day) ? day : (day ? [day] : []);
      const col = document.createElement('div'); col.className = 'tp-day';
      const head = document.createElement('span'); head.className = 'tp-name'; head.textContent = name; col.append(head);
      if (!list.length) { const dash = document.createElement('span'); dash.className = 'tp-empty'; dash.textContent = '–'; col.append(dash); }
      list.forEach(item => { const dot = document.createElement('span'); dot.className = 'tp-chip'; dot.textContent = item.duty; dot.style.backgroundColor = colorForDuty(item.duty); col.append(dot); });
      box.append(col);
    });
  }
  function renderTemplates() {
    if ($('templateWeekLabel')) $('templateWeekLabel').textContent = weekRangeLabel();
    if ($('applyWeekLabel')) $('applyWeekLabel').textContent = weekRangeLabel();
    setTimeout(renderTemplatePreview, 0);
    const select = $('templateSelect'); const previous = select.value; select.replaceChildren();
    const templates = Object.entries(data.templates || {});
    if (!templates.length) {
      const option = document.createElement('option'); option.value = ''; option.textContent = 'ยังไม่มีแม่แบบ'; select.append(option); select.disabled = true;
      $('applyTemplate').disabled = true; $('deleteTemplate').disabled = true; return;
    }
    select.disabled = false; $('applyTemplate').disabled = false; $('deleteTemplate').disabled = false;
    templates.forEach(([id, template]) => { const option = document.createElement('option'); option.value = id; option.textContent = template.name; select.append(option); });
    if (templates.some(([id]) => id === previous)) select.value = previous;
  }
  function saveWeekTemplate() {
    const name = $('templateName').value.trim();
    if (!name) { $('templateStatus').textContent = 'ตั้งชื่อแม่แบบก่อนบันทึก'; $('templateName').focus(); return; }
    const start = weekStart(selectedDate);
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start); date.setDate(start.getDate() + index);
      const list = (data.entries[dateKey(date)] || []).map(entry => ({ duty: entry.duty, note: entry.note || '' }));
      return list.length ? list : null;
    });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    data.templates[id] = { name, days }; save(); renderTemplates(); $('templateSelect').value = id;
    $('templateName').value = ''; $('templateStatus').textContent = `บันทึกแม่แบบ “${name}” แล้ว`;
  }
  function applyWeekTemplate() {
    const id = $('templateSelect').value; const template = data.templates[id];
    if (!template) return;
    if (!confirm(`ใช้แม่แบบ “${template.name}” กับสัปดาห์นี้หรือไม่? ข้อมูลเดิมทั้งสัปดาห์จะถูกแทนที่`)) return;
    const start = weekStart(selectedDate);
    for (let index = 0; index < 7; index++) {
      const date = new Date(start); date.setDate(start.getDate() + index); const key = dateKey(date);
      const day = template.days[index];
      const list = Array.isArray(day) ? day : (day ? [day] : []);
      if (list.length) data.entries[key] = list.map(entry => ({ duty: entry.duty, note: entry.note || '', done: false }));
      else delete data.entries[key];
    }
    save(); renderAll(); $('templateStatus').textContent = `ใช้แม่แบบ “${template.name}” แล้ว`;
  }
  function deleteWeekTemplate() {
    const id = $('templateSelect').value; const template = data.templates[id];
    if (!template || !confirm(`ลบแม่แบบ “${template.name}” หรือไม่?`)) return;
    delete data.templates[id]; save(); renderTemplates(); $('templateStatus').textContent = 'ลบแม่แบบแล้ว';
  }
  function renderDutyList() {
    const list = $('dutyList'); list.replaceChildren();
    data.duties.forEach((duty, index) => {
      const row = document.createElement('div'); row.className = 'duty-row';
      const label = document.createElement('div'); label.className = 'label'; label.style.backgroundColor = colorForDuty(duty);
      const name = document.createElement('span'); name.textContent = duty;
      label.append(name);
      const remove = document.createElement('button'); remove.className = 'remove-duty'; remove.type = 'button'; remove.textContent = '×'; remove.title = `ลบ ${duty}`; remove.setAttribute('aria-label', `ลบ ${duty}`);
      remove.addEventListener('click', () => {
        if (!confirm(`ลบ “${duty}” ออกจากรายการที่ใช้บ่อย? รายการในวันที่บันทึกไว้จะยังอยู่`)) return;
        data.duties.splice(index, 1); save(); renderDutyList();
      });
      row.append(label, remove); list.append(row);
    });
    $('emptyState').style.display = data.duties.length ? 'none' : 'block';
    renderDutySummary();
  }
  function renderMemberSummary() {
    return; // single-user app: per-person summary removed
    const container = $('memberCounts'); if (!container) return; container.replaceChildren();
    const year = shownMonth.getFullYear(); const month = shownMonth.getMonth();
    const perMember = new Map(); let unassigned = 0;
    for (const [key, entries] of Object.entries(data.entries)) {
      const [y, m] = key.split('-').map(Number); if (y !== year || m !== month + 1) continue;
      for (const entry of entries) {
        if (!entry.assignee) { unassigned++; continue; }
        const item = perMember.get(entry.assignee) || { total: 0, duties: new Map() };
        item.total++; item.duties.set(entry.duty, (item.duties.get(entry.duty) || 0) + 1);
        perMember.set(entry.assignee, item);
      }
    }
    for (const name of ensureMembers()) if (!perMember.has(name)) perMember.set(name, { total: 0, duties: new Map() });
    $('memberSummaryTitle').hidden = !perMember.size;
    if (!perMember.size) return;
    const max = Math.max(1, ...[...perMember.values()].map(item => item.total));
    [...perMember.entries()].sort((a, b) => b[1].total - a[1].total).forEach(([name, item]) => {
      const row = document.createElement('div'); row.className = 'member-row';
      const head = document.createElement('div'); head.className = 'member-head';
      const label = document.createElement('span'); label.textContent = `👤 ${name}${name === myName ? ' (ฉัน)' : ''}`;
      const count = document.createElement('strong'); count.textContent = `${item.total} เวร`;
      head.append(label, count);
      const bar = document.createElement('div'); bar.className = 'member-bar';
      const fill = document.createElement('span'); fill.style.width = `${(item.total / max) * 100}%`; bar.append(fill);
      const detail = document.createElement('div'); detail.className = 'member-detail';
      detail.textContent = item.total ? [...item.duties.entries()].sort((a, b) => b[1] - a[1]).map(([duty, n]) => `${duty} ${n}`).join(' · ') : 'ยังไม่มีเวรเดือนนี้';
      row.append(head, bar, detail); container.append(row);
    });
    if (unassigned) { const note = document.createElement('div'); note.className = 'member-detail'; note.textContent = `ยังไม่ระบุผู้รับผิดชอบ ${unassigned} เวร`; container.append(note); }
  }
  function renderDutySummary() {
    renderMemberSummary();
    const container = $('monthlyDutyCounts');
    if (!container) return;
    container.replaceChildren();
    const counts = new Map();
    const year = shownMonth.getFullYear(); const month = shownMonth.getMonth();
    for (const [key, entries] of Object.entries(data.entries)) {
      const [entryYear, entryMonth] = key.split('-').map(Number);
      if (entryYear !== year || entryMonth !== month + 1) continue;
      for (const entry of entries) counts.set(entry.duty, (counts.get(entry.duty) || 0) + 1);
    }
    const duties = [...data.duties];
    for (const duty of counts.keys()) if (!duties.includes(duty)) duties.push(duty);
    if (!duties.length) {
      const empty = document.createElement('p'); empty.className = 'monthly-duty-empty'; empty.textContent = 'เพิ่มชื่อเวรเพื่อเริ่มสรุป'; container.append(empty); return;
    }
    const totalDays = Object.keys(data.entries).filter(key => { const [y, m] = key.split('-').map(Number); return y === year && m === month + 1 && data.entries[key]?.length; }).length;
    $('summaryTotal').textContent = totalDays ? `· ${totalDays} วันมีหน้าที่` : '';
    const used = duties.filter(duty => counts.get(duty));
    if (!used.length) {
      const empty = document.createElement('p'); empty.className = 'monthly-duty-empty'; empty.textContent = 'ยังไม่มีเวรในเดือนนี้ แตะวันที่ในปฏิทินเพื่อเพิ่ม'; container.append(empty); return;
    }
    used.sort((a, b) => counts.get(b) - counts.get(a)).forEach(duty => {
      const row = document.createElement('div'); row.className = 'monthly-duty-row';
      const label = document.createElement('span'); label.className = 'label'; label.textContent = duty; label.style.backgroundColor = colorForDuty(duty);
      const count = document.createElement('strong'); count.textContent = `${counts.get(duty) || 0} วัน`;
      row.append(label, count); container.append(row);
    });
  }
  function openDialog(key) {
    selectedKey = key;
    const [year, month, day] = key.split('-').map(Number);
    $('selectedDate').textContent = thaiLong.format(new Date(year, month - 1, day)) + (holidayName(key) ? ` · 🎌 ${holidayName(key)} (ลงเวรได้ตามปกติ)` : '');
    const sourceDate = new Date(year, month - 1, day); sourceDate.setDate(sourceDate.getDate() - 1);
    $('copyPrevious').textContent = `คัดลอกจาก ${new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short' }).format(sourceDate)}`;
    const entries = data.entries[key] || [];
    editIndex = entries.length;
    const entry = undefined;
    $('dialogTitle').textContent = entries.length ? `เพิ่มหน้าที่ (มีแล้ว ${entries.length} รายการ)` : 'เพิ่มหน้าที่';
    $('noteInput').value = entry?.note || '';
    $('doneInput').checked = Boolean(entry?.done);
    fillAssigneeSelect(entry?.assignee || '');
    $('repeatSelect').value = 'none'; $('repeatRow').hidden = true;
    $('repeatUntil').value = dateKey(new Date(year, month - 1 + 3, day)); $('repeatUntil').min = key;
    const select = $('dutySelect'); select.replaceChildren();
    if (!data.duties.length) {
      const option = document.createElement('option'); option.value = ''; option.textContent = 'เพิ่มหน้าที่จากรายการด้านข้างก่อน'; select.append(option); select.disabled = true;
    } else {
      select.disabled = false;
      data.duties.forEach(duty => { const option = document.createElement('option'); option.value = duty; option.textContent = duty; select.append(option); });
      if (entry && !data.duties.includes(entry.duty)) { const option = document.createElement('option'); option.value = entry.duty; option.textContent = entry.duty; select.append(option); }
      if (entry) select.value = entry.duty;
    }
    $('deleteEntry').hidden = true; $('deleteSeries').hidden = true;
    setPickerMode(true);
    $('copyStatus').textContent = '';
    renderDayEntries();
    $('overlay').classList.add('open');
    setTimeout(() => (select.disabled ? $('closeDialog') : select).focus(), 30);
  }
  let editIndex = 0;
  // Add mode: pick several duties at once. Edit mode: the single select.
  function setPickerMode(multi) {
    const picker = $('dutyPicker'); const select = $('dutySelect');
    picker.hidden = !multi || !data.duties.length; select.hidden = multi && data.duties.length > 0;
    $('dutyLabel').textContent = multi ? 'เลือกหน้าที่ (เลือกได้หลายอย่าง)' : 'เลือกหน้าที่';
    if (!multi) return;
    picker.replaceChildren();
    data.duties.forEach(duty => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'duty-pick';
      button.textContent = duty; button.dataset.duty = duty; button.style.backgroundColor = colorForDuty(duty);
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true')));
      picker.append(button);
    });
  }
  function pickedDuties() {
    if ($('dutyPicker').hidden) return $('dutySelect').value ? [$('dutySelect').value] : [];
    return [...$('dutyPicker').querySelectorAll('.duty-pick[aria-pressed="true"]')].map(button => button.dataset.duty);
  }
  function renderDayEntries() {
    const entries = (selectedKey && data.entries[selectedKey]) || [];
    const wrap = $('dayEntriesWrap'); const list = $('dayEntries'); list.replaceChildren();
    wrap.hidden = !entries.length; if (!entries.length) return;
    entries.forEach((item, index) => {
      const button = document.createElement('button'); button.type = 'button';
      button.className = `day-entry${index === editIndex ? ' active' : ''}`;
      const pill = document.createElement('span'); pill.className = 'pill'; pill.style.backgroundColor = colorForDuty(item.duty);
      pill.textContent = `${item.done ? '✓ ' : ''}${item.duty}`; button.append(pill);
      if (item.assignee) { const who = document.createElement('span'); who.className = 'who'; who.textContent = `👤 ${item.assignee}`; button.append(who); }
      if (item.note) { const note = document.createElement('span'); note.className = 'who'; note.textContent = `· ${item.note}`; button.append(note); }
      button.addEventListener('click', () => editEntryAt(index));
      list.append(button);
    });
    const addNew = document.createElement('button'); addNew.type = 'button'; addNew.className = 'add-new-entry';
    addNew.textContent = '＋ เพิ่มหน้าที่ใหม่ในวันนี้'; addNew.addEventListener('click', () => editEntryAt(entries.length));
    list.append(addNew);
  }
  function editEntryAt(index) {
    const entries = data.entries[selectedKey] || []; const item = entries[index];
    editIndex = index;
    $('dialogTitle').textContent = item ? 'แก้ไขหน้าที่' : 'เพิ่มหน้าที่';
    if (item) {
      const select = $('dutySelect');
      if (![...select.options].some(option => option.value === item.duty)) { const option = document.createElement('option'); option.value = item.duty; option.textContent = item.duty; select.append(option); }
      select.value = item.duty;
    }
    $('noteInput').value = item?.note || ''; $('doneInput').checked = Boolean(item?.done);
    fillAssigneeSelect(item?.assignee || '');
    $('repeatSelect').value = 'none'; $('repeatRow').hidden = true;
    $('deleteEntry').hidden = !item;
    $('deleteSeries').hidden = !item?.seriesId;
    setPickerMode(!item);
    renderDayEntries();
  }
  function closeDialog() { $('overlay').classList.remove('open'); selectedKey = null; }
  $('prevMonth').addEventListener('click', () => { shownMonth.setMonth(shownMonth.getMonth() - 1); selectedDate = new Date(shownMonth.getFullYear(), shownMonth.getMonth(), 1); renderAll(); });
  $('nextMonth').addEventListener('click', () => { shownMonth.setMonth(shownMonth.getMonth() + 1); selectedDate = new Date(shownMonth.getFullYear(), shownMonth.getMonth(), 1); renderAll(); });
  $('prevWeek').addEventListener('click', () => { selectedDate.setDate(selectedDate.getDate() - 7); shownMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1); renderAll(); });
  $('nextWeek').addEventListener('click', () => { selectedDate.setDate(selectedDate.getDate() + 7); shownMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1); renderAll(); });
  $('todayButton').addEventListener('click', () => { const now = new Date(); shownMonth = new Date(now.getFullYear(), now.getMonth(), 1); selectedDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()); renderAll(); });
  $('addToday').addEventListener('click', () => { selectedDate = new Date(); shownMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1); openDialog(dateKey(selectedDate)); });
  document.querySelectorAll('.view-tab').forEach(button => button.addEventListener('click', () => { setView(button.dataset.view); renderWeek(); }));
  $('saveTemplate').addEventListener('click', saveWeekTemplate);
  $('applyTemplate').addEventListener('click', applyWeekTemplate);
  $('templateSelect').addEventListener('change', renderTemplatePreview);
  $('deleteTemplate').addEventListener('click', deleteWeekTemplate);
  $('printSchedule').addEventListener('click', () => window.print());
  $('shareImage').addEventListener('click', shareScheduleImage);
  $('loveNote').addEventListener('click', openLoveNote);
  // ---------------- Supplies (เวชภัณฑ์) with expiry dates ----------------
  let supplyFilter = 'all'; let editingSupplyId = null;
  function supplies() { if (!Array.isArray(data.supplies)) data.supplies = []; return data.supplies; }
  function daysUntil(key) {
    const [y, m, d] = key.split('-').map(Number); const t = new Date();
    return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
  }
  function supplyState(days) { return days < 0 ? 'expired' : days <= 30 ? 'soon' : days <= 90 ? 'watch' : 'ok'; }
  function leftLabel(days) {
    if (days < 0) return `หมดแล้ว ${-days} วัน`;
    if (days === 0) return 'หมดวันนี้';
    if (days === 1) return 'หมดพรุ่งนี้';
    if (days <= 60) return `อีก ${days} วัน`;
    const months = Math.round(days / 30); return months < 12 ? `อีก ~${months} เดือน` : `อีก ~${(days / 365).toFixed(1)} ปี`;
  }
  function renderSupplies() {
    const list = $('supplyList'); if (!list) return;
    const all = supplies().map(item => ({ ...item, days: daysUntil(item.expiry) })).sort((a, b) => a.days - b.days);
    const count = { expired: all.filter(i => i.days < 0).length, soon: all.filter(i => i.days >= 0 && i.days <= 30).length };
    count.ok = all.length - count.expired - count.soon;
    $('supplyStats').replaceChildren(...[['expired', 'หมดอายุแล้ว'], ['soon', 'ใกล้หมด (≤30 วัน)'], ['ok', 'ปกติ']].map(([key, label]) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = `supply-stat ${key}`;
      b.innerHTML = `<strong>${count[key]}</strong><span>${label}</span>`;
      b.addEventListener('click', () => setSupplyFilter(key === 'ok' ? 'all' : key)); return b;
    }));
    const urgent = count.expired + count.soon;
    $('supplyBadge').hidden = !urgent; $('supplyBadge').textContent = urgent;
    const alert = $('todaySupplyAlert');
    alert.hidden = !urgent;
    alert.textContent = urgent ? `💊 เวชภัณฑ์${count.expired ? ` หมดอายุแล้ว ${count.expired}` : ''}${count.expired && count.soon ? ' ·' : ''}${count.soon ? ` ใกล้หมด ${count.soon}` : ''} รายการ · แตะเพื่อดู` : '';
    const q = ($('supplySearch').value || '').trim().toLowerCase();
    const shown = all.filter(i => (supplyFilter === 'all' || (supplyFilter === 'expired' ? i.days < 0 : i.days >= 0 && i.days <= 30)) &&
      (!q || `${i.name} ${i.location || ''} ${i.lot || ''}`.toLowerCase().includes(q)));
    list.replaceChildren();
    if (!shown.length) {
      const empty = document.createElement('div'); empty.className = 'supply-empty';
      empty.textContent = all.length ? 'ไม่มีรายการที่ตรงกับตัวกรอง' : 'ยังไม่มีเวชภัณฑ์\nกด "＋ เพิ่ม" เพื่อบันทึกรายการแรก';
      empty.style.whiteSpace = 'pre-line'; list.append(empty); return;
    }
    const fmt = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
    // "Use first" = the earliest not-yet-expired item among supplies sharing the same name.
    const nameKey = n => n.trim().toLowerCase().replace(/\s+/g, ' ');
    const groups = new Map();
    all.forEach(i => { const k = nameKey(i.name); groups.set(k, (groups.get(k) || []).concat(i)); });
    const useFirst = new Set();
    groups.forEach(list => { if (list.length < 2) return; const first = list.filter(i => i.days >= 0).sort((a, b) => a.days - b.days)[0]; if (first) useFirst.add(first.id); });
    shown.forEach(item => {
      const [y, m, d] = item.expiry.split('-').map(Number);
      const row = document.createElement('button'); row.type = 'button'; row.className = `supply-item ${supplyState(item.days)}`;
      const name = document.createElement('span'); name.className = 's-name'; name.textContent = item.name;
      if (useFirst.has(item.id)) { const tag = document.createElement('span'); tag.className = 'use-first'; tag.textContent = '⭐ ใช้ก่อน'; name.append(' ', tag); }
      const meta = document.createElement('span'); meta.className = 's-meta';
      meta.textContent = [`EXP ${fmt.format(new Date(y, m - 1, d))}`, item.location, item.lot].filter(Boolean).join(' · ');
      const left = document.createElement('span'); left.className = 's-left'; left.textContent = leftLabel(item.days);
      row.append(name, left, meta);
      row.addEventListener('click', () => openSupplyDialog(item.id));
      list.append(row);
    });
  }
  function setSupplyFilter(filter) {
    supplyFilter = filter;
    document.querySelectorAll('.supply-filter').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
    renderSupplies();
  }
  function fillDatalist(id, values) {
    const box = $(id); box.replaceChildren(...[...new Set(values.filter(Boolean))].sort().map(v => { const o = document.createElement('option'); o.value = v; return o; }));
  }
  function openSupplyDialog(id = null) {
    editingSupplyId = id; const item = supplies().find(s => s.id === id);
    $('supplyDialogTitle').textContent = item ? 'แก้ไขเวชภัณฑ์' : 'เพิ่มเวชภัณฑ์';
    $('supplyName').value = item?.name || ''; $('supplyExpiry').value = item?.expiry || '';
    $('supplyLocation').value = item?.location || ''; $('supplyLot').value = item?.lot || '';
    $('deleteSupply').hidden = !item;
    fillDatalist('supplyNameList', supplies().map(s => s.name));
    fillDatalist('supplyLocationList', supplies().map(s => s.location));
    $('supplyOverlay').classList.add('open');
    setTimeout(() => $('supplyName').focus(), 30);
  }
  function closeSupplyDialog() { $('supplyOverlay').classList.remove('open'); editingSupplyId = null; }
  $('supplyForm').addEventListener('submit', event => {
    event.preventDefault();
    const name = $('supplyName').value.trim(); const expiry = $('supplyExpiry').value;
    if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return;
    const record = { id: editingSupplyId || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, expiry,
      location: $('supplyLocation').value.trim(), lot: $('supplyLot').value.trim() };
    const list = supplies(); const at = list.findIndex(s => s.id === record.id);
    if (at >= 0) list[at] = record; else list.push(record);
    save(); closeSupplyDialog(); renderSupplies();
  });
  $('deleteSupply').addEventListener('click', () => {
    const item = supplies().find(s => s.id === editingSupplyId);
    if (!item || !confirm(`ลบ "${item.name}" (EXP ${item.expiry}) หรือไม่?`)) return;
    data.supplies = supplies().filter(s => s.id !== editingSupplyId); save(); closeSupplyDialog(); renderSupplies();
  });
  $('addSupply').addEventListener('click', () => openSupplyDialog());
  // ---- Bulk add: one supply per line, "name date [@ location]" ----
  const MONTHS = { 'ม.ค.': 1, 'ก.พ.': 2, 'มี.ค.': 3, 'เม.ย.': 4, 'พ.ค.': 5, 'มิ.ย.': 6, 'ก.ค.': 7, 'ส.ค.': 8, 'ก.ย.': 9, 'ต.ค.': 10, 'พ.ย.': 11, 'ธ.ค.': 12,
    'มกราคม': 1, 'กุมภาพันธ์': 2, 'มีนาคม': 3, 'เมษายน': 4, 'พฤษภาคม': 5, 'มิถุนายน': 6, 'กรกฎาคม': 7, 'สิงหาคม': 8, 'กันยายน': 9, 'ตุลาคม': 10, 'พฤศจิกายน': 11, 'ธันวาคม': 12,
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function toYear(raw) {
    let y = Number(raw);
    if (raw.length <= 2) y = y >= 50 ? 2500 + y : 2000 + y; // 69 -> 2569 (พ.ศ.), 27 -> 2027 (ค.ศ.)
    if (y > 2400) y -= 543;                                 // พ.ศ. -> ค.ศ.
    return y;
  }
  function validDate(y, m, d) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return y >= 2000 && y <= 2100 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
  }
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  function parseSupplyLine(line) {
    let text = line.replace(/\s+/g, ' ').trim(); if (!text) return null;
    let location = '';
    const at = text.lastIndexOf('@'); if (at > 0) { location = text.slice(at + 1).trim(); text = text.slice(0, at).trim(); }
    text = text.replace(/(^|\s)(exp\.?|expiry|วันหมดอายุ|หมดอายุ)\s*[:.]?\s*/gi, ' ').replace(/\s+/g, ' ').trim();
    const monthNames = Object.keys(MONTHS).map(k => k.replace(/\./g, '\\.')).join('|');
    const patterns = [
      // (?<!\d) stops a date from starting in the middle of a longer number (e.g. 2027-01-31).
      [new RegExp(`(?<!\\d)(\\d{1,2})\\s*(${monthNames})\\s*(\\d{2,4})$`, 'i'), m => validDate(toYear(m[3]), MONTHS[m[2].toLowerCase()] || MONTHS[m[2]], Number(m[1]))],
      [/(?<!\d)(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})$/, m => validDate(toYear(m[1]), Number(m[2]), Number(m[3]))],
      [/(?<!\d)(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/, m => validDate(toYear(m[3]), Number(m[2]), Number(m[1]))],
      [new RegExp(`(${monthNames})\\s*(\\d{2,4})$`, 'i'), m => { const y = toYear(m[2]); const mo = MONTHS[m[1].toLowerCase()] || MONTHS[m[1]]; return validDate(y, mo, lastDay(y, mo)); }],
      [/(?<!\d)(\d{1,2})[\/.\-](\d{4})$/, m => { const y = toYear(m[2]); const mo = Number(m[1]); return mo >= 1 && mo <= 12 ? validDate(y, mo, lastDay(y, mo)) : null; }]
    ];
    for (const [re, toKey] of patterns) {
      const m = text.match(re);
      if (!m) continue;
      const expiry = toKey(m); const name = text.slice(0, m.index).replace(/[-–:,]\s*$/, '').trim();
      if (!expiry) return { line, error: 'วันที่ไม่ถูกต้อง' };
      if (!name) return { line, error: 'ไม่มีชื่อ' };
      return { name, expiry, location };
    }
    return { line, error: 'ไม่พบวันหมดอายุ' };
  }
  let bulkParsed = []; let bulkMode = 'rows';
  // ---- Row mode (default): name + date picker per row ----
  function addBulkRow(focus = false) {
    const row = document.createElement('div'); row.className = 'bulk-row-edit';
    const name = document.createElement('input'); name.placeholder = 'เช่น Paracetamol 500 mg'; name.maxLength = 60; name.setAttribute('list', 'supplyNameList');
    const date = document.createElement('input'); date.type = 'date';
    const place = document.createElement('input'); place.className = 'bulk-place'; place.maxLength = 40; place.placeholder = '📍 ที่เก็บ (ถ้ามี)'; place.setAttribute('list', 'supplyLocationList');
    // New rows start with the previous row's storage place; edit it only when this item lives elsewhere.
    const prev = $('bulkRows').lastElementChild?.querySelector('.bulk-place');
    if (prev) place.value = prev.value;
    place.addEventListener('input', () => {
      // Typing a place also fills the empty rows below it, so a whole batch for one room needs typing only once.
      let next = row.nextElementSibling;
      while (next) { const p = next.querySelector('.bulk-place'); const [n] = next.querySelectorAll('input'); if (!n.value.trim()) p.value = place.value; next = next.nextElementSibling; }
    });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'bulk-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', 'ลบแถว');
    remove.addEventListener('click', () => { row.remove(); if (!$('bulkRows').children.length) addBulkRow(); updateBulkCount(); });
    name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); date.focus(); try { date.showPicker(); } catch (_) {} } });
    const touched = () => {
      updateBulkCount();
      const rows = [...$('bulkRows').children]; const last = rows[rows.length - 1];
      if (row === last && name.value.trim() && date.value) addBulkRow();
    };
    name.addEventListener('input', touched); date.addEventListener('change', touched); date.addEventListener('input', touched);
    row.append(name, date, remove, place); $('bulkRows').append(row);
    if (focus) setTimeout(() => name.focus(), 30);
    return row;
  }
  function rowEntries() {
    return [...$('bulkRows').children].map(row => { const [name, date] = row.querySelectorAll('input'); return { name: name.value.trim(), expiry: date.value, location: row.querySelector('.bulk-place').value.trim() }; })
      .filter(r => r.name && /^\d{4}-\d{2}-\d{2}$/.test(r.expiry));
  }
  function updateBulkCount() {
    if (bulkMode !== 'rows') return renderBulkPreview();
    const ready = rowEntries().length;
    const missing = [...$('bulkRows').children].filter(row => { const [n, d] = row.querySelectorAll('input'); return Boolean(n.value.trim()) !== Boolean(d.value); }).length;
    $('bulkCount').textContent = missing ? `ยังกรอกไม่ครบ ${missing} แถว` : '';
    $('saveBulk').disabled = !ready;
    $('saveBulk').textContent = ready ? `บันทึก ${ready} รายการ` : 'บันทึก';
  }
  function setBulkMode(mode) {
    bulkMode = mode;
    $('bulkRowsMode').hidden = mode !== 'rows'; $('bulkPasteMode').hidden = mode !== 'paste';
    $('bulkHint').textContent = mode === 'rows' ? 'กรอกชื่อ แล้วเลือกวันหมดอายุ · เลือกวันแล้วจะมีแถวใหม่ให้เอง' : 'บรรทัดละ 1 รายการ: ชื่อ ตามด้วยวันหมดอายุ (ใส่ที่เก็บหลัง @ ได้)';
    if (mode === 'paste') { renderBulkPreview(); setTimeout(() => $('bulkText').focus(), 30); } else updateBulkCount();
  }
  function renderBulkPreview() {
    bulkParsed = $('bulkText').value.split('\n').map(parseSupplyLine).filter(Boolean);
    const ok = bulkParsed.filter(r => !r.error); const bad = bulkParsed.length - ok.length;
    const fmt = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
    $('bulkPreview').replaceChildren(...bulkParsed.map(r => {
      const row = document.createElement('div'); row.className = `bulk-row${r.error ? ' bad' : ''}`;
      const name = document.createElement('b'); name.textContent = r.error ? r.line : r.name;
      const info = document.createElement('span');
      if (r.error) info.textContent = `⚠️ ${r.error}`;
      else { const [y, m, d] = r.expiry.split('-').map(Number); info.textContent = `${fmt.format(new Date(y, m - 1, d))}${r.location ? ` · ${r.location}` : ''}`; }
      row.append(name, info); return row;
    }));
    $('bulkCount').textContent = bulkParsed.length ? `พร้อมเพิ่ม ${ok.length} รายการ${bad ? ` · อ่านไม่ได้ ${bad}` : ''}` : '';
    $('saveBulk').disabled = !ok.length;
    $('saveBulk').textContent = ok.length ? `เพิ่ม ${ok.length} รายการ` : 'เพิ่มรายการ';
  }
  function closeBulk() { $('bulkOverlay').classList.remove('open'); }
  $('bulkSupply').addEventListener('click', () => {
    $('bulkText').value = ''; $('bulkRows').replaceChildren();
    fillDatalist('supplyNameList', supplies().map(s => s.name)); fillDatalist('supplyLocationList', supplies().map(s => s.location));
    addBulkRow(true); addBulkRow(); addBulkRow();
    setBulkMode('rows'); $('bulkOverlay').classList.add('open');
  });
  $('bulkToPaste').addEventListener('click', () => setBulkMode('paste'));
  $('bulkToRows').addEventListener('click', () => setBulkMode('rows'));
  $('bulkText').addEventListener('input', renderBulkPreview);
  $('closeBulk').addEventListener('click', closeBulk);
  $('cancelBulk').addEventListener('click', closeBulk);
  $('bulkOverlay').addEventListener('click', event => { if (event.target === $('bulkOverlay')) closeBulk(); });
  $('saveBulk').addEventListener('click', () => {
    const ok = bulkMode === 'rows' ? rowEntries() : bulkParsed.filter(r => !r.error); if (!ok.length) return;
    const list = supplies();
    ok.forEach(r => list.push({ id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, name: r.name, expiry: r.expiry, location: r.location, lot: '' }));
    save(); closeBulk(); setSupplyFilter('all');
  });

  function sortedSupplies() { return supplies().map(item => ({ ...item, days: daysUntil(item.expiry) })).sort((a, b) => a.days - b.days); }
  const thaiFullDate = key => { const [y, m, d] = key.split('-').map(Number); return new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(y, m - 1, d)); };
  const statusText = days => days < 0 ? 'หมดอายุแล้ว' : days <= 30 ? 'ใกล้หมด' : days <= 90 ? 'เฝ้าระวัง' : 'ปกติ';
  $('printSupplies').addEventListener('click', () => {
    const rows = sortedSupplies();
    if (!rows.length) { alert('ยังไม่มีรายการเวชภัณฑ์'); return; }
    $('supplyPrintDate').textContent = `พิมพ์เมื่อ ${thaiFullDate(dateKey(new Date()))} · ทั้งหมด ${rows.length} รายการ · หมดอายุแล้ว ${rows.filter(r => r.days < 0).length} · ใกล้หมด (≤30 วัน) ${rows.filter(r => r.days >= 0 && r.days <= 30).length}`;
    $('supplyPrintBody').replaceChildren(...rows.map((item, index) => {
      const tr = document.createElement('tr'); tr.className = item.days < 0 ? 'expired' : item.days <= 30 ? 'soon' : '';
      [String(index + 1), item.name, thaiFullDate(item.expiry), leftLabel(item.days), item.location || '', item.lot || '', ''].forEach((text, col) => {
        const td = document.createElement('td'); td.textContent = text; if (col === 6) td.className = 'check'; tr.append(td);
      });
      return tr;
    }));
    document.body.classList.add('print-supplies');
    const done = () => { document.body.classList.remove('print-supplies'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
    setTimeout(done, 1500);
  });
  $('exportSupplies').addEventListener('click', () => {
    const rows = sortedSupplies();
    if (!rows.length) { alert('ยังไม่มีรายการเวชภัณฑ์'); return; }
    const esc = v => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const lines = [['ลำดับ', 'ชื่อเวชภัณฑ์', 'วันหมดอายุ', 'เหลือ (วัน)', 'สถานะ', 'ที่เก็บ', 'Lot / หมายเหตุ']]
      .concat(rows.map((item, index) => [index + 1, item.name, thaiFullDate(item.expiry), item.days, statusText(item.days), item.location || '', item.lot || '']));
    // BOM so Excel opens Thai text correctly.
    const blob = new Blob(['\ufeff' + lines.map(row => row.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `เวชภัณฑ์-${dateKey(new Date())}.csv`; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
  $('closeSupply').addEventListener('click', closeSupplyDialog);
  $('cancelSupply').addEventListener('click', closeSupplyDialog);
  $('supplyOverlay').addEventListener('click', event => { if (event.target === $('supplyOverlay')) closeSupplyDialog(); });
  $('supplySearch').addEventListener('input', renderSupplies);
  document.querySelectorAll('.supply-filter').forEach(b => b.addEventListener('click', () => setSupplyFilter(b.dataset.filter)));
  $('todaySupplyAlert').addEventListener('click', () => { showTab('supplies'); setSupplyFilter($('todaySupplyAlert').textContent.includes('หมดอายุแล้ว') ? 'expired' : 'soon'); });
  $('supplyAlertOn').addEventListener('change', onReminderSettingChange);

  // Font size (per device)
  const ZOOM_KEY = 'nursing-duty-ui-zoom';
  function applyZoom(value) {
    document.documentElement.style.setProperty('--ui-zoom', value);
    document.querySelectorAll('.size-option').forEach(b => b.classList.toggle('active', b.dataset.size === String(value)));
  }
  let savedZoom = '1'; try { savedZoom = localStorage.getItem(ZOOM_KEY) || '1'; } catch (_) {}
  applyZoom(savedZoom);
  document.querySelectorAll('.size-option').forEach(b => b.addEventListener('click', () => {
    applyZoom(b.dataset.size); try { localStorage.setItem(ZOOM_KEY, b.dataset.size); } catch (_) {}
  }));
  loadHolidayFile();
  // Swipe left/right on the calendar to change month (or week in week view).
  (() => {
    const area = document.querySelector('.calendar-card'); let sx = 0, sy = 0, tracking = false;
    area.addEventListener('touchstart', e => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; tracking = e.touches.length === 1; }, { passive: true });
    area.addEventListener('touchend', e => {
      if (!tracking) return; tracking = false;
      const t = e.changedTouches[0]; const dx = t.clientX - sx; const dy = t.clientY - sy;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const forward = dx < 0;
      const grid = activeView === 'week' ? $('weekList') : $('daysGrid');
      grid.classList.remove('swipe-left', 'swipe-right'); void grid.offsetWidth;
      $(activeView === 'week' ? (forward ? 'nextWeek' : 'prevWeek') : (forward ? 'nextMonth' : 'prevMonth')).click();
      grid.classList.add(forward ? 'swipe-left' : 'swipe-right');
    }, { passive: true });
  })();
  $('weatherCard').addEventListener('click', () => { writeJSON(WEATHER_CACHE_KEY, null); loadWeather(true); });
  loadWeather(false);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadWeather(false); });
  // Secret entrance: tap the footer heart 5 times quickly.
  let heartTaps = 0, heartTimer = null;
  $('secretHeart').addEventListener('click', () => {
    heartTaps++; clearTimeout(heartTimer); heartTimer = setTimeout(() => { heartTaps = 0; }, 1500);
    if (heartTaps < 5) return;
    heartTaps = 0; renderNoteEditor(); $('noteStatus').textContent = ''; $('noteText').value = '';
    $('secretSheet').hidden = false; $('secretSheet').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('closeSecret').addEventListener('click', () => { $('secretSheet').hidden = true; $('noteText').value = ''; });
  $('saveNote').addEventListener('click', saveNote);
  $('noteDate').value = (() => { const t = new Date(); t.setDate(t.getDate() + 1); return dateKey(t); })();
  // Bottom navigation
  const TAB_KEY = 'nursing-duty-tab-v1';
  function showTab(name, focus) {
    document.querySelectorAll('.view').forEach(view => { view.hidden = view.id !== `view-${name}`; });
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.tab === name));
    try { localStorage.setItem(TAB_KEY, name); } catch (_) {}
    if (focus) focus.scrollIntoView({ behavior: 'smooth', block: 'start' }); else window.scrollTo({ top: 0 });
    if (name === 'duties') renderTemplates();
    $('secretSheet').hidden = true;
  }
  document.querySelectorAll('.nav-item').forEach(item => item.addEventListener('click', () => showTab(item.dataset.tab)));
  try { const savedTab = localStorage.getItem(TAB_KEY); if (savedTab && $(`view-${savedTab}`)) showTab(savedTab); } catch (_) {}
  $('scrollCalendar').addEventListener('click', () => document.querySelector('.calendar-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  $('deleteSeries').addEventListener('click', () => {
    const item = (data.entries[selectedKey] || [])[editIndex]; if (!item?.seriesId) return;
    const keys = Object.keys(data.entries).filter(key => key >= selectedKey && data.entries[key].some(e => e.seriesId === item.seriesId));
    if (!confirm(`ลบ "${item.duty}" ที่ทำซ้ำทั้งหมด ${keys.length} วัน ตั้งแต่วันนี้เป็นต้นไปหรือไม่?`)) return;
    for (const key of keys) {
      const rest = data.entries[key].filter(e => e.seriesId !== item.seriesId);
      if (rest.length) data.entries[key] = rest; else delete data.entries[key];
    }
    save(); closeDialog(); renderAll();
  });
  $('repeatSelect').addEventListener('change', () => { $('repeatRow').hidden = $('repeatSelect').value === 'none'; });
  $('assigneeSelect').addEventListener('change', () => {
    if ($('assigneeSelect').value !== '__add') return;
    const name = addMemberPrompt(); fillAssigneeSelect(name); renderFilterBar();
  });
  $('renameMe').addEventListener('click', () => ensureAccountName(currentUser, true));
  $('mineToggle').addEventListener('click', () => { mineOnly = !mineOnly; writePref(MINE_ONLY_KEY, mineOnly ? '1' : '0'); renderAll(); });
  $('connectSupabase').addEventListener('click', connectSupabase);
  $('signUpSync').addEventListener('click', async () => {
    if (!supabaseClient) { syncStatus('เชื่อมต่อ Supabase ก่อนสมัครบัญชี'); return; }
    const email = $('syncEmail').value.trim(); const password = $('syncPassword').value;
    if (!email || password.length < 8) { syncStatus('ใส่อีเมลและรหัสผ่านอย่างน้อย 8 ตัวอักษร'); return; }
    const { data: result, error } = await supabaseClient.auth.signUp({ email, password, options: { emailRedirectTo: location.href } });
    if (error) { syncStatus(`สมัครไม่สำเร็จ: ${translateAuthError(error)}`); return; }
    if (!result.session) $('resendConfirm').hidden = false;
    syncStatus(result.session ? 'สมัครและเข้าสู่ระบบแล้ว' : 'สมัครแล้ว ตรวจอีเมลเพื่อยืนยันบัญชีก่อนเข้าสู่ระบบ');
  });
  // A real <form> submit lets the browser / iPhone Keychain offer to save and autofill the password.
  $('syncAccount').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!supabaseClient) { syncStatus('เชื่อมต่อ Supabase ก่อนเข้าสู่ระบบ'); return; }
    const email = $('syncEmail').value.trim(); const password = $('syncPassword').value;
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (!error) {
      try { localStorage.setItem('nursing-duty-last-email', email); } catch (_) {}
      if (window.PasswordCredential && navigator.credentials?.store) {
        try { await navigator.credentials.store(new PasswordCredential({ id: email, password, name: email })); } catch (_) {}
      }
      $('syncPassword').value = '';
    }
    $('resendConfirm').hidden = !(error && (error.code === 'email_not_confirmed' || /not confirmed/i.test(error.message)));
    syncStatus(error ? `เข้าสู่ระบบไม่สำเร็จ: ${translateAuthError(error)}` : 'เข้าสู่ระบบแล้ว');
  });
  $('forgotPassword').addEventListener('click', async () => {
    if (!supabaseClient) { syncStatus('เชื่อมต่อฐานข้อมูลก่อน'); return; }
    const email = $('syncEmail').value.trim();
    if (!email) { syncStatus('ใส่อีเมลก่อน แล้วกด "ลืมรหัสผ่าน" อีกครั้ง'); return; }
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] });
    syncStatus(error ? `ส่งลิงก์ไม่สำเร็จ: ${translateAuthError(error)}` : 'ส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่อีเมลแล้ว');
  });
  $('resendConfirm').addEventListener('click', async () => {
    if (!supabaseClient) return;
    const email = $('syncEmail').value.trim();
    if (!email) { syncStatus('ใส่อีเมลก่อน'); return; }
    const { error } = await supabaseClient.auth.resend({ type: 'signup', email, options: { emailRedirectTo: location.href.split('#')[0] } });
    syncStatus(error ? `ส่งไม่สำเร็จ: ${translateAuthError(error)}` : 'ส่งอีเมลยืนยันใหม่แล้ว ตรวจกล่องจดหมาย (รวมถึงสแปม)');
  });
  $('signOutSync').addEventListener('click', async () => {
    if (!supabaseClient) return;
    await supabaseClient.auth.signOut(); cloudScheduleId = null; localStorage.removeItem(SHARED_SCHEDULE_KEY);
    if (syncChannel) { await supabaseClient.removeChannel(syncChannel); syncChannel = null; }
    $('currentShareCode').hidden = true; $('copyShareCode').hidden = true; syncStatus('ออกจากระบบแล้ว; ข้อมูลในเครื่องยังอยู่');
  });
  $('createSharedSchedule').addEventListener('click', createSharedSchedule);
  $('joinSharedSchedule').addEventListener('click', joinSharedSchedule);
  $('enableNotifications').addEventListener('click', enablePushNotifications);
  $('disableNotifications').addEventListener('click', disablePushNotifications);
  $('testNotification').addEventListener('click', testPushNotification);
  $('reminderTime').addEventListener('change', onReminderSettingChange);
  ['syncStatus', 'notificationStatus'].forEach(id => new MutationObserver(updateStatusPill).observe($(id), { childList: true, characterData: true, subtree: true }));
  $('statusPill').addEventListener('click', () => {
    const target = !currentUser || !cloudScheduleId ? $('syncStatus').closest('.card') : $('notificationStatus').closest('.card');
    showTab('settings', target);
  });
  updateStatusPill();
  window.addEventListener('online', () => { updateOfflineBadge(); if (hasPending() && supabaseClient && cloudScheduleId) queueCloudSave(); else if (supabaseClient && currentUser) openAccountSchedule(currentUser); });
  window.addEventListener('offline', updateOfflineBadge);
  updateOfflineBadge();
  checkForUpdate();
  $('versionButton').textContent = `v${APP_VERSION} · เช็กอัปเดต`;
  $('versionButton').addEventListener('click', () => checkForUpdate(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
  try { const lastEmail = localStorage.getItem('nursing-duty-last-email'); if (lastEmail && !$('syncEmail').value) $('syncEmail').value = lastEmail; } catch (_) {}
  $('reminderOffset').addEventListener('change', onReminderSettingChange);
  $('morningTime').addEventListener('change', onReminderSettingChange);
  $('morningMessage').addEventListener('change', onReminderSettingChange);
  $('rainAlertOn').addEventListener('change', () => { $('workEnd').disabled = !$('rainAlertOn').checked; onReminderSettingChange(); });
  $('workEnd').addEventListener('change', onReminderSettingChange);
  $('morningOn').addEventListener('change', () => { $('morningTime').disabled = !$('morningOn').checked; onReminderSettingChange(); });
  try { const pref = JSON.parse(localStorage.getItem(REMINDER_PREF_KEY) || 'null'); if (pref) { applyReminderPref(pref.time, pref.offset, pref.morning === undefined ? '07:30' : pref.morning); if (typeof pref.message === 'string') $('morningMessage').value = pref.message; if (typeof pref.rain === 'boolean') $('rainAlertOn').checked = pref.rain; if (pref.workEnd) $('workEnd').value = pref.workEnd; if (typeof pref.supply === 'boolean') $('supplyAlertOn').checked = pref.supply; } } catch (_) {}
  $('copyShareCode').addEventListener('click', async () => {
    const code = $('currentShareCode').textContent.replace(/^รหัสเชิญ:\s*/, '');
    try { await navigator.clipboard.writeText(code); syncStatus('คัดลอกรหัสเชิญแล้ว'); }
    catch (_) { syncStatus(`คัดลอกรหัสนี้ไปส่งให้ผู้ร่วมงาน: ${code}`); }
  });
  $('exportBackup').addEventListener('click', () => {
    const backup = { format: 'nursing-duty-calendar', version: 1, exportedAt: new Date().toISOString(), ...data };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url;
    link.download = `nursing-duty-backup-${dateKey(new Date())}.json`;
    document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  });
  $('importBackupButton').addEventListener('click', () => $('importBackupFile').click());
  $('importBackupFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      if (!validateBackup(backup)) { alert('ไฟล์นี้ไม่ใช่ข้อมูลสำรองตารางเวรที่รองรับ'); return; }
      if (!confirm('นำเข้าข้อมูลนี้แทนตารางที่บันทึกไว้ในเบราว์เซอร์นี้หรือไม่?')) return;
      data = { duties: [...new Set(backup.duties)], entries: backup.entries, colors: backup.colors || {}, templates: backup.templates || {}, members: Array.isArray(backup.members) ? backup.members.filter(item => typeof item === 'string') : [], notes: backup.notes && typeof backup.notes === 'object' && !Array.isArray(backup.notes) ? backup.notes : {}, supplies: Array.isArray(backup.supplies) ? backup.supplies : [] };
      for (const entries of Object.values(data.entries)) if (Array.isArray(entries)) entries.forEach(entry => { entry.done = Boolean(entry.done); });
      save(); renderDutyList(); renderAll(); alert('นำเข้าข้อมูลสำรองแล้ว');
    } catch (_) { alert('อ่านไฟล์ไม่สำเร็จ กรุณาเลือกไฟล์สำรอง JSON ที่ถูกต้อง'); }
  });
  $('addDutyForm').addEventListener('submit', (event) => {
    event.preventDefault(); const input = $('newDuty'); const duty = input.value.trim();
    if (!duty) { input.focus(); return; }
    if (data.duties.some(item => item.toLocaleLowerCase() === duty.toLocaleLowerCase())) { input.value = ''; input.placeholder = 'มีรายการนี้แล้ว'; return; }
    data.duties.push(duty); input.value = ''; input.placeholder = 'เพิ่มหน้าที่ใหม่'; save(); renderDutyList();
  });
  $('entryForm').addEventListener('submit', (event) => {
    event.preventDefault(); if (!selectedKey) return;
    const duties = pickedDuties();
    if (!duties.length) { $('copyStatus').textContent = 'เลือกหน้าที่อย่างน้อย 1 อย่าง'; return; }
    const entries = data.entries[selectedKey] || [];
    const assignee = $('assigneeSelect').value === '__add' ? '' : $('assigneeSelect').value;
    const mode = $('repeatSelect').value; let added = 0; let skipped = 0;
    const editing = editIndex < entries.length;
    duties.forEach(duty => {
      const entry = { duty, note: $('noteInput').value.trim(), done: $('doneInput').checked };
      if (assignee) entry.assignee = assignee;
      const previous = editing ? entries[editIndex] : null;
      if (mode !== 'none') entry.seriesId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      else if (previous?.seriesId) entry.seriesId = previous.seriesId;
      if (editing) entries[editIndex] = entry;
      else if (entries.some(item => item.duty === duty && (item.assignee || '') === (assignee || ''))) { skipped++; return; }
      else entries.push(entry);
      if (mode !== 'none' && $('repeatUntil').value) {
        for (const key of repeatDates(selectedKey, mode, $('repeatUntil').value)) {
          const list = data.entries[key] || [];
          if (list.some(item => item.duty === entry.duty && (item.assignee || '') === (entry.assignee || ''))) continue;
          list.push({ ...entry, done: false }); data.entries[key] = list; added++;
        }
      }
    });
    if (entries.length) data.entries[selectedKey] = entries;
    save(); closeDialog(); renderAll();
    const notes = [];
    if (mode !== 'none') notes.push(added ? `เพิ่มหน้าที่ซ้ำอีก ${added} รายการแล้ว` : 'ไม่มีวันที่ต้องเพิ่มเพิ่มเติม');
    if (skipped) notes.push(`ข้าม ${skipped} หน้าที่ที่มีอยู่แล้วในวันนี้`);
    if (notes.length) alert(notes.join('\n'));
  });
  $('deleteEntry').addEventListener('click', () => {
    if (!selectedKey) return;
    const entries = data.entries[selectedKey] || []; entries.splice(editIndex, 1);
    if (entries.length) data.entries[selectedKey] = entries; else delete data.entries[selectedKey];
    save(); closeDialog(); renderAll();
  });
  $('copyPrevious').addEventListener('click', () => {
    if (!selectedKey) return;
    const [year, month, day] = selectedKey.split('-').map(Number);
    const previousDate = new Date(year, month - 1, day);
    previousDate.setDate(previousDate.getDate() - 1);
    const previousKey = dateKey(previousDate);
    const previousEntry = data.entries[previousKey]?.[0];
    if (!previousEntry) {
      $('copyStatus').textContent = 'วันก่อนหน้ายังไม่มีหน้าที่ให้คัดลอก';
      return;
    }
    const select = $('dutySelect');
    if (![...select.options].some(option => option.value === previousEntry.duty)) {
      const option = document.createElement('option'); option.value = previousEntry.duty; option.textContent = previousEntry.duty; select.append(option);
    }
    select.value = previousEntry.duty;
    $('dutyPicker').querySelectorAll('.duty-pick').forEach(button => { if (button.dataset.duty === previousEntry.duty) button.setAttribute('aria-pressed', 'true'); });
    $('noteInput').value = previousEntry.note || '';
    $('copyStatus').textContent = 'คัดลอกแล้ว ตรวจดูแล้วกดบันทึกได้เลย';
  });
  $('closeDialog').addEventListener('click', closeDialog);
  $('cancelDialog').addEventListener('click', closeDialog);
  $('overlay').addEventListener('click', event => { if (event.target === $('overlay')) closeDialog(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDialog(); });
  // Keep all data in one simple local browser record.
  const empty = document.createElement('div'); empty.id = 'emptyState'; empty.className = 'empty-state'; empty.textContent = 'ยังไม่มีรายการหน้าที่';
  $('dutyList').after(empty);
  renderDutyList(); renderAll();
  try {
    const config = JSON.parse(localStorage.getItem(SYNC_CONFIG_KEY) || 'null');
    $('supabaseUrl').value = config?.url || DEFAULT_SUPABASE_URL;
    $('supabaseAnonKey').value = config?.key || DEFAULT_SUPABASE_KEY;
    $('vapidPublicKey').value = config?.vapidPublicKey || DEFAULT_VAPID_PUBLIC_KEY;
  } catch (_) { /* Ignore an invalid local sync configuration. */ }
  // Connect automatically so users only need email + password.
  if ($('supabaseUrl').value && $('supabaseAnonKey').value) connectSupabase();
  else { $('supabaseUrl').closest('details').open = true; }
  if (window.isSecureContext && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then(registration => { serviceWorkerRegistration = registration; })
      .catch(() => { /* Push setup will show a user-facing error when requested. */ });
  }
})();
