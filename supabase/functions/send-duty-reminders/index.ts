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
    .select('id,schedule_id,endpoint,subscription,reminder_time,reminder_offset,timezone,last_sent_for_date,member_name,morning_time,last_morning_for_date,morning_message')
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
          jobs.push({ date, body: `${lead} (${thaiDate(date)}) ${me ? me + ' ' : ''}มีหน้าที่: ${duties.join(', ')}`, mark: { last_sent_for_date: date } })
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
        if (duties.length || hasNote) jobs.push({ date: clock.date, title: cheer || 'ตารางหน้าที่พยาบาล', body: duties.length ? `☀️ วันนี้ (${thaiDate(clock.date)}) มีหน้าที่: ${duties.join(', ')}${noteLine}` : `☀️ วันนี้ (${thaiDate(clock.date)}) ไม่มีหน้าที่${noteLine}`, mark: { last_morning_for_date: clock.date } })
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
