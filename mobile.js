(function () {
    "use strict";
    const toggleBtn = document.querySelector(".mobile-menu-toggle");
    const sidebar = document.querySelector(".mobile-sidebar");
    const overlay = document.querySelector(".mobile-sidebar-overlay");
    if (!toggleBtn || !sidebar || !overlay) return;

    function syncHeaderOffset() {
        const header = document.querySelector(".jm-header");
        if (!header) return;
        const height = header.getBoundingClientRect().height;
        document.documentElement.style.setProperty("--jm-header-h", height + "px");
    }

    function openSidebar() {
        sidebar.classList.add("open");
        overlay.classList.add("open");
        toggleBtn.classList.add("open");
        sidebar.setAttribute("aria-hidden", "false");
        toggleBtn.setAttribute("aria-expanded", "true");
        document.body.classList.add("mobile-sidebar-open");
    }

    function closeSidebar() {
        sidebar.classList.remove("open");
        overlay.classList.remove("open");
        toggleBtn.classList.remove("open");
        sidebar.setAttribute("aria-hidden", "true");
        toggleBtn.setAttribute("aria-expanded", "false");
        document.body.classList.remove("mobile-sidebar-open");
    }

    window.toggleMobileSidebar = function () {
        if (sidebar.classList.contains("open")) {
            closeSidebar();
        } else {
            syncHeaderOffset();
            openSidebar();
        }
    };
    window.closeMobileSidebar = closeSidebar;

    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") closeSidebar();
    });

    window.addEventListener("resize", syncHeaderOffset, { passive: true });

    syncHeaderOffset();
})();