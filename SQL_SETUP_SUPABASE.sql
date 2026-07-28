-- =============================================================
-- SURGEM MAINTENANCE — DATABASE SUPABASE
-- Jalankan seluruh file ini melalui Supabase > SQL Editor > Run.
-- =============================================================

create table if not exists public.sfo_perbaikan (
    id uuid primary key default gen_random_uuid(),
    tanggal_pelaksanaan date not null,
    sta_dari_m integer not null check (sta_dari_m >= 0),
    sta_sampai_m integer not null,
    jalur text not null check (jalur in ('A', 'B')),
    lajur text not null check (lajur in ('L1', 'L2', 'L3')),
    keterangan text not null check (length(trim(keterangan)) > 0),
    petugas text,
    dokumentasi_url text,
    dokumentasi_nama text,
    dokumentasi_path text,
    dibuat_oleh uuid default auth.uid(),
    dibuat_pada timestamptz not null default now(),
    diubah_pada timestamptz not null default now(),
    constraint sfo_rentang_sta_valid check (sta_sampai_m > sta_dari_m)
);

create or replace function public.perbarui_waktu_sfo()
returns trigger
language plpgsql
as $$
begin
    new.diubah_pada = now();
    return new;
end;
$$;

drop trigger if exists trigger_perbarui_waktu_sfo on public.sfo_perbaikan;
create trigger trigger_perbarui_waktu_sfo
before update on public.sfo_perbaikan
for each row execute function public.perbarui_waktu_sfo();

create index if not exists idx_sfo_tanggal
on public.sfo_perbaikan (tanggal_pelaksanaan desc);

create index if not exists idx_sfo_lokasi
on public.sfo_perbaikan (jalur, lajur, sta_dari_m, sta_sampai_m);

grant select on public.sfo_perbaikan to anon, authenticated;
grant insert, update, delete on public.sfo_perbaikan to authenticated;

alter table public.sfo_perbaikan enable row level security;

drop policy if exists "Publik membaca data SFO" on public.sfo_perbaikan;
drop policy if exists "Admin menambah data SFO" on public.sfo_perbaikan;
drop policy if exists "Admin mengubah data SFO" on public.sfo_perbaikan;
drop policy if exists "Admin menghapus data SFO" on public.sfo_perbaikan;

create policy "Publik membaca data SFO"
on public.sfo_perbaikan
for select
to anon, authenticated
using (true);

create policy "Admin menambah data SFO"
on public.sfo_perbaikan
for insert
to authenticated
with check ((select auth.uid()) is not null);

create policy "Admin mengubah data SFO"
on public.sfo_perbaikan
for update
to authenticated
using ((select auth.uid()) is not null)
with check ((select auth.uid()) is not null);

create policy "Admin menghapus data SFO"
on public.sfo_perbaikan
for delete
to authenticated
using ((select auth.uid()) is not null);

-- Aktifkan Realtime hanya jika tabel belum terdaftar.
do $$
begin
    if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'sfo_perbaikan'
    ) then
        execute 'alter publication supabase_realtime add table public.sfo_perbaikan';
    end if;
end
$$;

-- Bucket dokumentasi publik, maksimum 5 MB per file.
insert into storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
)
values (
    'sfo-dokumentasi',
    'sfo-dokumentasi',
    true,
    5242880,
    array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Admin upload dokumentasi SFO" on storage.objects;
drop policy if exists "Admin ubah dokumentasi SFO" on storage.objects;
drop policy if exists "Admin hapus dokumentasi SFO" on storage.objects;

create policy "Admin upload dokumentasi SFO"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'sfo-dokumentasi');

create policy "Admin ubah dokumentasi SFO"
on storage.objects
for update
to authenticated
using (bucket_id = 'sfo-dokumentasi')
with check (bucket_id = 'sfo-dokumentasi');

create policy "Admin hapus dokumentasi SFO"
on storage.objects
for delete
to authenticated
using (bucket_id = 'sfo-dokumentasi');
