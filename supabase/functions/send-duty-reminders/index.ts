import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'

type PushSubscriptionRow = {
  id: string
  schedule_id: string
  endpoint: string
  subscription: { endpoint: string; keys: { auth: string; p256dh: string } }
  reminder_time: string
  reminder_offset: 'day_before' | 'same_day'
  timezone: string
  last_sent_for_date: string | null
  member_name: string | null
  morning_time: string | null
  last_morning_for_date: string | null
  morning_message: string | null
  weather_lat: number | null
  weather_lon: number | null
  rain_alert: boolean | null
  work_end: string | null
  last_rain_alert_for_date: string | null
  supply_alert: boolean | null
  last_supply_alert_for_date: string | null
}

function localClock(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now)
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? ''
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    minuteOfDay: Number(part('hour')) * 60 + Number(part('minute'))
  }
}

function addDate(dateKey: string, offset: number) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + offset))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' }
})

Deno.serve(async request => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const cronSecret = Deno.env.get('CRON_SECRET')
  if (!cronSecret || request.headers.get('x-cron-secret') !== cronSecret) return json({ error: 'Unauthorized' }, 401)

  const projectUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY')
  const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY')
  const vapidSubject = Deno.env.get('VAPID_SUBJECT')
  if (!projectUrl || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    return json({ error: 'Server notification secrets are incomplete' }, 500)
  }

  try {
    const subject = vapidSubject.trim()
    webpush.setVapidDetails(/^(mailto:|https:)/.test(subject) ? subject : `mailto:${subject}`, vapidPublicKey.trim(), vapidPrivateKey.trim())
  } catch (vapidError) {
    // Message names the bad field (e.g. subject/key length) without revealing secret values.
    return json({ error: `Invalid VAPID settings: ${(vapidError as Error).message}` }, 500)
  }
  const supabase = createClient(projectUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
  const { data: subscriptions, error: subscriptionError } = await supabase
    .from('push_subscriptions')
    .select('id,schedule_id,endpoint,subscription,reminder_time,reminder_offset,timezone,last_sent_for_date,member_name,morning_time,last_morning_for_date,morning_message,weather_lat,weather_lon,rain_alert,work_end,last_rain_alert_for_date,supply_alert,last_supply_alert_for_date')
    .eq('enabled', true)
    .limit(500)

  if (subscriptionError) return json({ error: 'Unable to load notification subscriptions' }, 500)
  if (!subscriptions?.length) return json({ checked: 0, sent: 0 })

  const scheduleIds = [...new Set((subscriptions as PushSubscriptionRow[]).map(row => row.schedule_id))]
  const { data: schedules, error: scheduleError } = await supabase
    .from('schedule_data')
    .select('schedule_id,payload')
    .in('schedule_id', scheduleIds)
  if (scheduleError) return json({ error: 'Unable to load shared schedules' }, 500)

  const scheduleById = new Map((schedules ?? []).map(row => [row.schedule_id, row.payload]))
  const now = new Date()
  let sent = 0
  let expired = 0
  let failed = 0

  const thaiDate = (key: string) => {
    const [y, m, d] = key.split('-').map(Number)
    return new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)))
  }
  const inWindow = (clockMinute: number, time: string) => {
    const [hour, minute] = time.slice(0, 5).split(':').map(Number)
    const target = hour * 60 + minute
    // Cron runs every minute; this small grace window tolerates scheduler jitter.
    return clockMinute >= target && clockMinute < target + 5
  }
  const dutiesFor = (row: PushSubscriptionRow, dateKey: string) => {
    const schedule = scheduleById.get(row.schedule_id) as { entries?: Record<string, Array<{ duty: string; done?: boolean; assignee?: string }>> } | undefined
    // Only this account's own duties, plus duties nobody has been assigned to.
    const me = row.member_name?.trim() || ''
    return (schedule?.entries?.[dateKey] ?? [])
      .filter(entry => entry)
      .filter(entry => !me || !entry.assignee || entry.assignee === me)
      .map(entry => entry.duty)
  }

  // ---- Weather (Open-Meteo, free, no key). Cached per location for this run. ----
  type Weather = { max: number; min: number; rainMax: number; uv: number; rainHours: Array<{ h: number; p: number }>; pmMax: number | null }
  const weatherCache = new Map<string, Promise<Weather | null>>()
  // day: 0 = today, 1 = tomorrow (local to the location)
  const getWeather = (lat: number, lon: number, day = 0) => {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)},${day}`
    if (!weatherCache.has(key)) weatherCache.set(key, (async () => {
      try {
        const base = `latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=2`
        const [fc, aq] = await Promise.all([
          fetch(`https://api.open-meteo.com/v1/forecast?${base}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max&hourly=precipitation_probability`).then(res => res.json()),
          fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${base}&hourly=pm2_5`).then(res => res.json()).catch(() => null)
        ])
        const dayKey = fc.daily.time[day]
        const rainHours = (fc.hourly?.time ?? []).map((t: string, i: number) => ({ t, h: Number(t.slice(11, 13)), p: fc.hourly.precipitation_probability[i] ?? 0 }))
          .filter((x: { t: string }) => x.t.startsWith(dayKey)).map(({ h, p }: { h: number; p: number }) => ({ h, p }))
        const pm = ((aq?.hourly?.time ?? []) as string[]).map((t, i) => (t.startsWith(dayKey) ? aq.hourly.pm2_5[i] : null)).filter((v: number | null) => typeof v === 'number') as number[]
        return { max: fc.daily.temperature_2m_max[day], min: fc.daily.temperature_2m_min[day], rainMax: fc.daily.precipitation_probability_max[day] ?? 0, uv: fc.daily.uv_index_max?.[day] ?? 0, rainHours, pmMax: pm.length ? Math.round(Math.max(...pm)) : null }
      } catch (_) { return null }
    })())
    return weatherCache.get(key)!
  }
  const weatherLine = (w: Weather) => {
    const parts = [`🌡️ ${Math.round(w.max)}°/${Math.round(w.min)}°`]
    const wet = w.rainHours.find(x => x.h >= 7 && x.h <= 20 && x.p >= 50)
    if (w.rainMax >= 50) parts.push(`☂️ ฝน ${w.rainMax}%${wet ? ` ช่วง ${String(wet.h).padStart(2, '0')}:00` : ''} พกร่มนะ`)
    else if (w.rainMax >= 25) parts.push(`🌂 อาจมีฝน ${w.rainMax}%`)
    if (w.uv >= 8) parts.push(`🔆 UV ${Math.round(w.uv)} สูงมาก ทาครีมกันแดดนะ`)
    if (w.pmMax !== null && w.pmMax > 37.5) parts.push(`😷 PM2.5 ${w.pmMax} ใส่หน้ากากนะ`)
    return parts.join(' · ')
  }

  for (const row of subscriptions as PushSubscriptionRow[]) {
    try {
      const clock = localClock(now, row.timezone || 'Asia/Bangkok')
      const jobs: Array<{ date: string; title?: string; body: string; mark: Record<string, string> }> = []
      const me = row.member_name?.trim()

      // Regular reminder (evening before, or same day) at reminder_time.
      if (inWindow(clock.minuteOfDay, row.reminder_time)) {
        const date = row.reminder_offset === 'day_before' ? addDate(clock.date, 1) : clock.date
        const duties = row.last_sent_for_date === date ? [] : dutiesFor(row, date)
        if (duties.length) {
          const lead = row.reminder_offset === 'day_before' ? 'พรุ่งนี้' : 'วันนี้'
          const w = row.weather_lat != null && row.weather_lon != null ? await getWeather(row.weather_lat, row.weather_lon, row.reminder_offset === 'day_before' ? 1 : 0) : null
          const wx = w ? `
${lead}: ${weatherLine(w)}` : ''
          jobs.push({ date, body: `${lead} (${thaiDate(date)}) ${me ? me + ' ' : ''}มีหน้าที่: ${duties.join(', ')}${wx}`, mark: { last_sent_for_date: date } })
        }
      }
      // Morning summary of today's duties at morning_time.
      if (row.morning_time && inWindow(clock.minuteOfDay, row.morning_time) && row.last_morning_for_date !== clock.date) {
        const duties = dutiesFor(row, clock.date)
        // One encouragement line per day, picked from the user's list (stable for the whole day).
        const lines = (row.morning_message || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
        const dayNumber = Math.floor(Date.parse(`${clock.date}T00:00:00Z`) / 86400000)
        // Generic greetings only — the personal messages stay hidden in the app's envelope.
        const greetings = ['☀️ อรุณสวัสดิ์นะ', '🌤️ เช้านี้สู้ๆ นะ', '🌸 สวัสดีตอนเช้า', '💪 วันใหม่มาแล้ว', '🌞 ตื่นมาเจอวันดีๆ นะ', '🍀 ขอให้วันนี้เป็นวันที่ดี', '✨ เช้าแล้วนะคนเก่ง']
        const pool = lines.length ? lines : greetings
        const cheer = pool[dayNumber % pool.length]
        const hasNote = true // every day has a love note (custom or one of the 90 rotating messages)
        const noteLine = hasNote ? ' · 💌 มีข้อความรอเปิดอ่านในแอป' : ''
        const w = row.weather_lat != null && row.weather_lon != null ? await getWeather(row.weather_lat, row.weather_lon) : null
        const wx = w ? `\n${weatherLine(w)}` : ''
        if (duties.length || hasNote) jobs.push({ date: clock.date, title: cheer || 'ตารางหน้าที่พยาบาล', body: (duties.length ? `☀️ วันนี้ (${thaiDate(clock.date)}) มีหน้าที่: ${duties.join(', ')}${noteLine}` : `☀️ วันนี้ (${thaiDate(clock.date)}) ไม่มีหน้าที่${noteLine}`) + wx, mark: { last_morning_for_date: clock.date } })
      }

      // Medical supply expiry alert: once a day at the morning time (or 08:00), only when an item
      // reaches 30/14/7/3/1/0 days left, or is expired (repeated weekly until it is removed).
      const supplyTime = row.morning_time || '08:00'
      if (row.supply_alert !== false && row.last_supply_alert_for_date !== clock.date && inWindow(clock.minuteOfDay, supplyTime)) {
        const payload = scheduleById.get(row.schedule_id) as { supplies?: Array<{ name: string; expiry: string; qty?: number | string; unit?: string }> } | undefined
        const today = Date.parse(`${clock.date}T00:00:00Z`)
        const due = (payload?.supplies ?? [])
          .filter(item => item && typeof item.expiry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.expiry))
          .map(item => ({ ...item, days: Math.round((Date.parse(`${item.expiry}T00:00:00Z`) - today) / 86400000) }))
          .filter(item => [30, 14, 7, 3, 1, 0].includes(item.days) || (item.days < 0 && -item.days % 7 === 0))
          .sort((a, b) => a.days - b.days)
        if (due.length) {
          const label = (d: number) => d < 0 ? `หมดแล้ว ${-d} วัน` : d === 0 ? 'หมดวันนี้' : d === 1 ? 'หมดพรุ่งนี้' : `อีก ${d} วัน`
          // Flag the lot to use first when the same supply has other, later-expiring entries.
          const key = (n: string) => n.trim().toLowerCase().replace(/\s+/g, ' ')
          const all = (payload?.supplies ?? []).filter(i => i && typeof i.expiry === 'string')
          const usesFirst = (item: { name: string; expiry: string; days: number }) => item.days >= 0 &&
            all.some(o => key(o.name) === key(item.name) && o.expiry > item.expiry) &&
            !all.some(o => key(o.name) === key(item.name) && o.expiry < item.expiry && o.expiry >= clock.date)
          const lines = due.slice(0, 6).map(item => `${item.name} (${label(item.days)})${usesFirst(item) ? ' ⭐ใช้ตัวนี้ก่อน' : ''}`)
          if (due.length > 6) lines.push(`และอีก ${due.length - 6} รายการ`)
          const expired = due.some(item => item.days <= 0)
          jobs.push({ date: clock.date, title: expired ? '💊 มีเวชภัณฑ์หมดอายุ' : '💊 เวชภัณฑ์ใกล้หมดอายุ', body: lines.join(' · '), mark: { last_supply_alert_for_date: clock.date } })
        }
      }

      // Rain alert one hour before leaving work, only on days with duties (= working days).
      if (row.rain_alert !== false && row.work_end && row.weather_lat != null && row.weather_lon != null && row.last_rain_alert_for_date !== clock.date) {
        const [eh, em] = row.work_end.slice(0, 5).split(':').map(Number)
        const endMinute = eh * 60 + em
        const alertAt = Math.max(0, endMinute - 60)
        const alertTime = `${String(Math.floor(alertAt / 60)).padStart(2, '0')}:${String(alertAt % 60).padStart(2, '0')}`
        if (inWindow(clock.minuteOfDay, alertTime) && dutiesFor(row, clock.date).length) {
          const w = await getWeather(row.weather_lat, row.weather_lon)
          const commute = (w?.rainHours ?? []).filter(x => x.h >= eh - 1 && x.h <= eh + 2)
          const worst = commute.reduce((a, b) => (b.p > a.p ? b : a), { h: eh, p: 0 })
          if (worst.p >= 50) jobs.push({ date: clock.date, title: '☔ ใกล้เลิกงานแล้ว ฝนอาจตก', body: `โอกาสฝน ${worst.p}% ช่วง ${String(worst.h).padStart(2, '0')}:00 เตรียมร่มหรือเรียกรถไว้นะ`, mark: { last_rain_alert_for_date: clock.date } })
        }
      }

      for (const job of jobs) {
        try {
          await webpush.sendNotification(row.subscription, JSON.stringify({
            title: job.title || 'ตารางหน้าที่พยาบาล', body: job.body, url: './', tag: `nursing-duty-${job.date}-${Object.keys(job.mark)[0]}`
          }), { TTL: 600, urgency: 'high' })
          const { error: updateError } = await supabase.from('push_subscriptions')
            .update({ ...job.mark, updated_at: now.toISOString() }).eq('id', row.id)
          if (updateError) failed++
          else sent++
        } catch (pushError) {
          const statusCode = (pushError as { statusCode?: number }).statusCode
          if (statusCode === 404 || statusCode === 410) {
            await supabase.from('push_subscriptions').delete().eq('id', row.id)
            expired++
            break
          } else failed++
        }
      }
    } catch (_) { failed++ }
  }

  return json({ checked: subscriptions.length, sent, expired, failed })
})
