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

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey)
  const supabase = createClient(projectUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
  const { data: subscriptions, error: subscriptionError } = await supabase
    .from('push_subscriptions')
    .select('id,schedule_id,endpoint,subscription,reminder_time,reminder_offset,timezone,last_sent_for_date')
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

  for (const row of subscriptions as PushSubscriptionRow[]) {
    try {
      const clock = localClock(now, row.timezone || 'Asia/Bangkok')
      const [hour, minute] = row.reminder_time.slice(0, 5).split(':').map(Number)
      const reminderMinute = hour * 60 + minute
      // Cron runs every minute; this small grace window tolerates scheduler jitter.
      if (clock.minuteOfDay < reminderMinute || clock.minuteOfDay >= reminderMinute + 5) continue

      const targetDate = row.reminder_offset === 'day_before' ? addDate(clock.date, 1) : clock.date
      if (row.last_sent_for_date === targetDate) continue
      const schedule = scheduleById.get(row.schedule_id) as { entries?: Record<string, Array<{ duty: string; done?: boolean }>> } | undefined
      const duties = (schedule?.entries?.[targetDate] ?? []).filter(entry => entry && !entry.done).map(entry => entry.duty)
      if (!duties.length) continue

      const lead = row.reminder_offset === 'day_before' ? 'พรุ่งนี้' : 'วันนี้'
      const body = `${lead} ${targetDate} มีหน้าที่: ${duties.join(', ')}`
      try {
        await webpush.sendNotification(row.subscription, JSON.stringify({
          title: 'ตารางหน้าที่พยาบาล', body, url: './', tag: `nursing-duty-${targetDate}`
        }), { TTL: 600, urgency: 'high' })
        const { error: updateError } = await supabase.from('push_subscriptions')
          .update({ last_sent_for_date: targetDate, updated_at: now.toISOString() }).eq('id', row.id)
        if (updateError) failed++
        else sent++
      } catch (pushError) {
        const statusCode = (pushError as { statusCode?: number }).statusCode
        if (statusCode === 404 || statusCode === 410) {
          await supabase.from('push_subscriptions').delete().eq('id', row.id)
          expired++
        } else failed++
      }
    } catch (_) { failed++ }
  }

  return json({ checked: subscriptions.length, sent, expired, failed })
})
