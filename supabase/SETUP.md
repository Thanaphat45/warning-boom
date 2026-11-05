# เปิดใช้ตารางร่วมกันข้ามเครื่อง

ส่วนซิงก์ใน `index.html` รองรับ Supabase แต่ยังต้องใช้ Supabase project ของเจ้าของเว็บก่อน บัญชี Gmail ใช้เป็นอีเมลสมัคร Supabase ได้

## ตั้งค่า Supabase

1. สร้าง Supabase project แล้วเปิด **Authentication → Providers → Email**
2. ใน **SQL Editor** รันไฟล์ [`schema.sql`](schema.sql) ทั้งไฟล์
3. ใน **Database → Publications → supabase_realtime** เปิดการส่งการเปลี่ยนแปลงของตาราง `schedule_data` เพื่อให้หน้าของผู้ร่วมงานอัปเดตตามกัน
4. จากหน้า Project Settings คัดลอก Project URL และ publishable/anon key
5. ตั้ง Site URL และ Redirect URLs ของ Auth ให้รวม URL เว็บไซต์ที่เผยแพร่แล้ว เพื่อให้ลิงก์ยืนยันอีเมลกลับมาที่เว็บได้
6. เปิดเว็บ กางหัวข้อ **ใช้ร่วมกันหลายเครื่อง** วาง URL กับ public key แล้วกด **เชื่อมต่อฐานข้อมูล**
7. แต่ละคนสมัครบัญชีด้วยอีเมลของตัวเองและยืนยันอีเมล จากนั้นเข้าสู่ระบบ
8. เจ้าของตารางกดสร้างตาราง ระบบจะถามก่อนส่งข้อมูลในเบราว์เซอร์ขึ้นฐานข้อมูล จากนั้นส่งรหัสเชิญให้ผู้ร่วมงาน
9. ผู้ร่วมงานเข้าสู่ระบบบนเครื่องของตัวเอง วางรหัสเชิญ แล้วเข้าร่วมตาราง

ใครก็ตามที่มีรหัสเชิญและบัญชีที่ยืนยันแล้วสามารถเข้าร่วมตารางนั้นได้ จึงส่งรหัสให้เฉพาะผู้ที่ต้องการแชร์ด้วยเท่านั้น

## เปิดการแจ้งเตือนบนโทรศัพท์

การแจ้งเตือนทำงานเมื่อเว็บเผยแพร่บน HTTPS, ผู้ใช้เข้าสู่ระบบและอยู่ในตารางร่วมกันแล้ว และยอมรับสิทธิ์แจ้งเตือนบนอุปกรณ์นั้น โดยค่าเริ่มต้นระบบเตือนเวลา 20:00 น. ของคืนก่อนวันที่มีหน้าที่; ผู้ใช้ปรับเวลาและเลือกเตือนวันเดียวกันได้

1. สร้าง VAPID key pair บนเครื่องที่มี Node.js: `npx web-push generate-vapid-keys`. เก็บ private key ไว้เป็นความลับ ห้ามใส่ใน `index.html`, Git หรือแชต
2. เพิ่ม Edge Function secrets ใน Supabase (แทนค่าด้วย key ของคุณ):

   ```sh
   supabase secrets set VAPID_PUBLIC_KEY="<public-key>" VAPID_PRIVATE_KEY="<private-key>" VAPID_SUBJECT="mailto:<อีเมลผู้ดูแล>" CRON_SECRET="<ค่าสุ่มยาวอย่างน้อย 32 ตัวอักษร>"
   ```

   Public key ไม่ใช่ความลับ: วางค่านั้นในช่อง **VAPID public key** ในหน้าเว็บ กด **เชื่อมต่อฐานข้อมูล** อีกครั้งบนอุปกรณ์แต่ละเครื่องเพื่อบันทึกค่า
3. ติดตั้ง Supabase CLI แล้วเชื่อมโฟลเดอร์นี้กับ project ของคุณด้วย `supabase login` และ `supabase link --project-ref <project-ref>`
4. Deploy ฟังก์ชันที่ตรวจ secret ของ Cron เอง: `supabase functions deploy send-duty-reminders --no-verify-jwt`
5. ใน Supabase Dashboard เปิดส่วนขยาย **pg_cron**, **pg_net** และ **Vault** (Database → Extensions). ใน Vault เพิ่ม:
   - `nurse_reminder_project_url` = `https://<project-ref>.supabase.co`
   - `nurse_reminder_cron_secret` = ค่าเดียวกับ `CRON_SECRET` ในข้อ 2
6. รัน [`cron.sql`](cron.sql) ใน SQL Editor เพื่อตั้งงานตรวจการแจ้งเตือนทุกนาที
7. เปิดเว็บผ่าน HTTPS, เข้าร่วมตารางร่วมกัน แล้วกด **เปิดแจ้งเตือนบนโทรศัพท์** และอนุญาตการแจ้งเตือน

บน iPhone/iPad ต้องเพิ่มเว็บลง **หน้าจอโฮม** แล้วเปิดเว็บจากไอคอนนั้นก่อนจึงจะรับ Web Push ได้ (iOS/iPadOS 16.4 ขึ้นไป). ปุ่มทดสอบในเว็บทดสอบการแสดง notification ในเครื่อง; การส่งจริงจาก server ต้องทำครบข้อ 1–7. Cron และ Edge Functions ใช้โควตาตามแพ็กเกจ Supabase และ Free project อาจพักเมื่อไม่มีการใช้งาน จึงไม่ควรถือเป็นระบบเตือนฉุกเฉินหรือระบบที่รับประกันการส่งตรงเวลา

## เผยแพร่เว็บไซต์

GitHub Pages เผยแพร่ไฟล์ HTML จาก repository เป็นเว็บไซต์ให้เปิดผ่านลิงก์ได้ โดยหน้าเว็บนี้เป็น static site และไม่ต้อง build เพิ่ม ดูขั้นตอนที่ [GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site) ก่อนเผยแพร่

เปิด Realtime ของ `schedule_data` ตามขั้นตอนใน [Supabase Realtime documentation](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes) เพื่อให้การแก้ตารางจากอีกเครื่องส่งมาถึงทันที

ให้เพิ่ม Project URL และ public anon key ในหัวข้อซิงก์ของทุกอุปกรณ์; ค่านี้เป็น public client key และ RLS ใน [`schema.sql`](schema.sql) เป็นตัวจำกัดการเข้าถึงข้อมูล ห้ามวาง `service_role` key ในเว็บหรือส่งผ่านแชต

## ขอบเขตการซิงก์

- ข้อมูลใน localStorage ยังอยู่บนเครื่องจนกว่าจะเลือกสร้างหรือเข้าร่วมตารางร่วมกัน
- การสร้างตารางอัปโหลดข้อมูล local ที่ยืนยันแล้ว; การเข้าร่วมจะแทนข้อมูล local หลังยืนยัน
- เมื่อมีการแก้ไข ข้อมูลจะบันทึกขึ้น cloud และอัปเดตให้ผู้ร่วมงานผ่าน Supabase Realtime
- หากผู้ใช้สองคนแก้ข้อมูลเดียวกันในเวลาใกล้กัน รายการที่บันทึกล่าสุดจะชนะ ควรหลีกเลี่ยงการแก้วันเดียวกันพร้อมกัน
- การแชร์นี้ใช้ร่วมกันได้ทั้งข้อมูลเวร แม่แบบ และสถานะเสร็จแล้ว
- ระบบ push ส่งเฉพาะชื่อเวรที่ยังไม่ติ๊กเสร็จและวันที่; การยกเลิกการแจ้งเตือนลบ subscription ของอุปกรณ์นั้นจากฐานข้อมูล
