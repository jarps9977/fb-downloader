# Facebook Video Downloader Pro

รองรับ SD / HD (720p) / Full HD (1080p) / 4K ผ่าน DASH + ffmpeg

## Requirements
- Node.js v16+
- ffmpeg ติดตั้งแล้วใน PATH

### ติดตั้ง ffmpeg
**Windows:** https://ffmpeg.org/download.html → copy ffmpeg.exe ไว้ใน C:\Windows\System32\
**Mac:** `brew install ffmpeg`
**Ubuntu:** `sudo apt install ffmpeg`

## วิธีรัน
```bash
npm install
node server.js
# เปิด browser → http://localhost:3000
```

## 2 โหมดการใช้งาน

### โหมด 1: วาง URL อัตโนมัติ (แท็บซ้าย)
- วาง Facebook URL → กด "ดึงข้อมูลวิดีโอ"
- Server จะ fetch page source ให้อัตโนมัติ
- ใช้ได้กับวิดีโอ Public หรือวิดีโอที่ไม่ต้อง login

### โหมด 2: Paste Source (แท็บขวา) — สำหรับ Private
- เปิดหน้าวิดีโอใน browser ที่ login Facebook อยู่แล้ว
- กด Ctrl+U → Ctrl+A → Ctrl+C
- Paste ในช่องแล้วกด "ค้นหาวิดีโอ"

## หมายเหตุ
- ใช้สำหรับวิดีโอของตัวเองเท่านั้น
- CDN URL ของ Facebook มีอายุจำกัด ควร download ทันที
- DASH merge ใช้เวลาขึ้นกับขนาดไฟล์และ internet speed
