(function (global) {
    "use strict";

    /*
     * Konfigurasi publik untuk GitHub Pages.
     * Publishable key aman berada di frontend selama tabel dilindungi RLS.
     * Email di bawah hanya menjadi identitas internal Supabase dan tidak
     * ditampilkan atau diminta pada halaman Admin.
     */
    global.SURGEM_SUPABASE = Object.freeze({
        url: "https://bolgbqaihhrfojbpoqlo.supabase.co",
        publishableKey: "sb_publishable_hV63TVGolR9Xvz_-VD2XDg_orFsT0de",
        adminEmail: "talitaadzra0117@gmail.com",
        tableName: "sfo_perbaikan",
        storageBucket: "sfo-dokumentasi"
    });
})(window);
