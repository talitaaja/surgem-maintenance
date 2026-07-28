# SurGem — Login Admin Hanya dengan Kata Sandi

## Hasil akhir

- Admin hanya melihat satu kolom **Kata sandi admin**.
- Kedua admin memakai `JTTforSFO26`.
- Tidak ada email yang perlu diketik.
- Tidak ada `server.js`, `.bat`, localhost, komputer utama, atau Wi-Fi yang sama.
- GitHub Pages menjadi frontend dan Supabase menjadi database/login online.

## Pengaturan Supabase sekali saja

1. Buka **Authentication → Users → Add user**.
2. Buat **satu akun internal**:
   - Email: `talitaadzra0117@gmail.com`
   - Password: `JTTforSFO26`
   - Aktifkan **Auto Confirm User**.
3. Akun `baihakhi31@gmail.com` tidak perlu dibuat. Kedua orang menggunakan akun internal yang sama melalui kolom password.
4. Buka **Authentication → Providers → Email**, lalu matikan **Allow new users to sign up**.
5. Buka **SQL Editor → New query**.
6. Tempel seluruh isi `SQL_SETUP_SUPABASE.sql` lalu klik **Run**.

## Memasang file website

Timpa file proyek dengan file dari paket ini:

- `admin.html`
- `index.html`
- `peta.html`
- `stat.html`
- `tentang.html`
- `data-perbaikan.js`
- `supabase-config.js`
- `admin.css`
- `data-perbaikan.css`

Pertahankan file data, CSS utama, logo, dan GeoJSON milik proyek yang sudah ada.

File berikut tidak digunakan lagi:

- `server.js`
- `BUKA_SURGEM_WINDOWS.bat`
- `BUKA_SURGEM_LINUX_MAC.command`
- `package.json`
- `.env`
- `data/user-repairs.json`

## Publikasi GitHub Pages

Upload seluruh proyek ke repository GitHub. Pada **Settings → Pages**, pilih:

- Source: `Deploy from a branch`
- Branch: `main`
- Folder: `/(root)`

Setelah situs aktif, buka `admin.html`, masukkan `JTTforSFO26`, lalu lakukan satu input uji.
Data tersebut otomatis digunakan oleh Peta, Statistik, Home, dan Tentang.
